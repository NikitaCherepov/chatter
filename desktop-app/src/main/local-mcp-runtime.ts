import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitPythonSpec, pypiSpec } from './local-mcp-spec';
const exec = promisify(execFile);
let pending: Promise<{ node: string; npm: string }> | undefined;
async function download(url: string, maximum: number, uvAsset = false): Promise<Buffer> {
  const signal = AbortSignal.timeout(180_000);
  let response: Response | undefined;
  for (let redirects = 0; redirects < 6; redirects++) {
    const target = new URL(url);
    if (
      uvAsset &&
      (target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        ![
          'github.com',
          'release-assets.githubusercontent.com',
          'objects.githubusercontent.com',
          'releases.astral.sh',
        ].includes(target.hostname))
    )
      throw new Error('mcp_runtime_download_failed');
    response = await fetch(url, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!uvAsset || !location || redirects === 5) throw new Error('mcp_runtime_download_failed');
    url = new URL(location, url).href;
  }
  if (!response) throw new Error('mcp_runtime_download_failed');
  if (!response.ok || !response.body) throw new Error('mcp_runtime_download_failed');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const part of response.body as any) {
    size += part.length;
    if (size > maximum) throw new Error('mcp_runtime_download_too_large');
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}
export async function nodeRuntime(root: string) {
  const pointer = path.join(root, 'node-runtime.json');
  try {
    const saved = JSON.parse(await fs.readFile(pointer, 'utf8'));
    const base = path.resolve(root, saved.folder);
    if (path.dirname(base) !== path.resolve(root)) throw new Error();
    const node = path.join(base, process.platform === 'win32' ? 'node.exe' : 'bin/node'),
      npm = path.join(
        base,
        process.platform === 'win32'
          ? 'node_modules/npm/bin/npm-cli.js'
          : 'lib/node_modules/npm/bin/npm-cli.js',
      );
    await fs.access(node);
    await fs.access(npm);
    return { node, npm };
  } catch {}
  if (pending) return pending;
  pending = (async () => {
    await fs.mkdir(root, { recursive: true });
    const index = JSON.parse(
      (await download('https://nodejs.org/dist/index.json', 4_000_000)).toString(),
    ) as Array<{ version: string; lts: unknown }>;
    const version = index.find(
      (item) => item.lts && Number(item.version.slice(1).split('.')[0]) >= 24,
    )?.version;
    if (!version) throw new Error('mcp_runtime_version_unavailable');
    if (
      !['win32', 'darwin', 'linux'].includes(process.platform) ||
      !['x64', 'arm64'].includes(process.arch)
    )
      throw new Error('mcp_runtime_platform_unsupported');
    const base =
      'node-' +
      version +
      '-' +
      (process.platform === 'win32' ? 'win' : process.platform) +
      '-' +
      process.arch;
    const file = base + (process.platform === 'win32' ? '.zip' : '.tar.gz');
    const sums = (
      await download('https://nodejs.org/dist/' + version + '/SHASUMS256.txt', 100_000)
    ).toString();
    const expected = sums
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .find((parts) => parts[1] === file)?.[0];
    if (!expected) throw new Error('mcp_runtime_checksum_missing');
    const archive = await download('https://nodejs.org/dist/' + version + '/' + file, 100_000_000);
    if (crypto.createHash('sha256').update(archive).digest('hex') !== expected)
      throw new Error('mcp_runtime_checksum_mismatch');
    const archivePath = path.join(root, file);
    await fs.writeFile(archivePath, archive);
    try {
      await exec(
        process.platform === 'win32' ? 'tar.exe' : 'tar',
        ['-xf', archivePath, '-C', root],
        { windowsHide: true },
      );
    } finally {
      await fs.rm(archivePath, { force: true });
    }
    const folder = path.join(root, base),
      node = path.join(folder, process.platform === 'win32' ? 'node.exe' : 'bin/node'),
      npm = path.join(
        folder,
        process.platform === 'win32'
          ? 'node_modules/npm/bin/npm-cli.js'
          : 'lib/node_modules/npm/bin/npm-cli.js',
      );
    await fs.access(node);
    await fs.access(npm);
    await fs.writeFile(pointer, JSON.stringify({ folder: base }));
    return { node, npm };
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
export async function installNpm(root: string, directory: string, spec: string) {
  const runtime = await nodeRuntime(root);
  await exec(
    runtime.node,
    [
      runtime.npm,
      'install',
      '--prefix',
      directory,
      '--no-audit',
      '--no-fund',
      '--save-exact',
      '--engine-strict',
      '--',
      spec,
    ],
    {
      windowsHide: true,
      maxBuffer: 4_000_000,
      env: {
        ...process.env,
        PATH: path.dirname(runtime.node) + path.delimiter + (process.env.PATH || ''),
        ELECTRON_RUN_AS_NODE: '',
      },
    },
  );
  const pkgName = spec.replace(/@[^/]+$/, '');
  const packagePath = path.join(directory, 'node_modules', pkgName, 'package.json');
  const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'));
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin || {});
  if (bins.length !== 1 || typeof bins[0] !== 'string')
    throw new Error('mcp_package_requires_single_executable');
  const base = path.dirname(packagePath),
    entry = path.resolve(base, bins[0]);
  if (!entry.startsWith(base + path.sep)) throw new Error('mcp_invalid_package_executable');
  await fs.access(entry);
  return {
    command: runtime.node,
    entry,
    version: String(pkg.version || ''),
    path: path.dirname(runtime.node),
  };
}

const uvPending = new Map<string, Promise<string>>();
export async function uvRuntime(root: string): Promise<string> {
  root = path.resolve(root);
  const pointer = path.join(root, 'uv-runtime.json');
  try {
    const saved = JSON.parse(await fs.readFile(pointer, 'utf8'));
    if (!/^uv-[a-zA-Z0-9._-]+$/.test(saved.folder)) throw new Error();
    const base = path.join(root, saved.folder);
    const executable = path.resolve(base, saved.executable);
    if (!executable.startsWith(base + path.sep)) throw new Error();
    await fs.access(executable);
    return executable;
  } catch {}
  if (uvPending.has(root)) return uvPending.get(root)!;
  const operation = (async () => {
    const target =
      process.platform === 'win32'
        ? process.arch === 'arm64'
          ? 'aarch64-pc-windows-msvc'
          : 'x86_64-pc-windows-msvc'
        : process.platform === 'darwin'
          ? process.arch === 'arm64'
            ? 'aarch64-apple-darwin'
            : 'x86_64-apple-darwin'
          : process.arch === 'arm64'
            ? 'aarch64-unknown-linux-gnu'
            : 'x86_64-unknown-linux-gnu';
    if (
      !['win32', 'darwin', 'linux'].includes(process.platform) ||
      !['x64', 'arm64'].includes(process.arch)
    )
      throw new Error('mcp_runtime_platform_unsupported');
    const release = JSON.parse(
      (
        await download('https://api.github.com/repos/astral-sh/uv/releases/latest', 4_000_000)
      ).toString(),
    );
    if (!/^\d+\.\d+\.\d+$/.test(release.tag_name))
      throw new Error('mcp_runtime_version_unavailable');
    const file = 'uv-' + target + (process.platform === 'win32' ? '.zip' : '.tar.gz');
    const baseUrl = 'https://github.com/astral-sh/uv/releases/download/' + release.tag_name + '/';
    const checksum = (await download(baseUrl + file + '.sha256', 2000, true))
      .toString()
      .trim()
      .split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('mcp_runtime_checksum_missing');
    const archive = await download(baseUrl + file, 100_000_000, true);
    if (crypto.createHash('sha256').update(archive).digest('hex') !== checksum.toLowerCase())
      throw new Error('mcp_runtime_checksum_mismatch');
    const folder = 'uv-' + release.tag_name + '-' + target;
    const directory = path.join(root, folder);
    await fs.mkdir(directory, { recursive: true });
    const archivePath = path.join(directory, file);
    await fs.writeFile(archivePath, archive);
    try {
      await exec(
        process.platform === 'win32' ? 'tar.exe' : 'tar',
        ['-xf', archivePath, '-C', directory],
        { windowsHide: true },
      );
    } finally {
      await fs.rm(archivePath, { force: true });
    }
    const relative = process.platform === 'win32' ? 'uv.exe' : path.join('uv-' + target, 'uv');
    const executable = path.join(directory, relative);
    await fs.access(executable);
    await fs.writeFile(pointer, JSON.stringify({ folder, executable: relative }));
    return executable;
  })();
  uvPending.set(root, operation);
  try {
    return await operation;
  } finally {
    if (uvPending.get(root) === operation) uvPending.delete(root);
  }
}

export function mcpProcessError(message: string, diagnostics: string, env: Record<string, string>) {
  let detail = diagnostics.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const [key, value] of Object.entries(env)) {
    if (value && /key|token|secret|pass|credential|auth|cookie/i.test(key))
      detail = detail.split(value).join('[redacted]');
  }
  detail = detail
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .trim()
    .slice(-1800);
  return new Error(detail ? message + '\n' + detail : message);
}

async function installedGitCommit(toolDir: string) {
  // uv installs one environment named after the requested distribution.
  const environments = await fs.readdir(toolDir, { withFileTypes: true });
  for (const entry of environments) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const environment = path.join(toolDir, entry.name);
    const libraries =
      process.platform === 'win32'
        ? [path.join(environment, 'Lib')]
        : (await fs.readdir(path.join(environment, 'lib')))
            .filter((name) => /^python\d+\.\d+$/.test(name))
            .map((name) => path.join(environment, 'lib', name));
    const prefix = entry.name.replace(/[-.]+/g, '_').toLowerCase() + '-';
    for (const library of libraries) {
      const packages = path.join(library, 'site-packages');
      const metadata = (await fs.readdir(packages)).find(
        (name) => name.toLowerCase().startsWith(prefix) && name.endsWith('.dist-info'),
      );
      if (!metadata) continue;
      const origin = JSON.parse(
        await fs.readFile(path.join(packages, metadata, 'direct_url.json'), 'utf8'),
      );
      const commit = origin.vcs_info?.commit_id;
      if (
        origin.vcs_info?.vcs === 'git' &&
        typeof commit === 'string' &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)
      )
        return commit;
    }
  }
  throw new Error('mcp_git_commit_unavailable');
}

export type PythonInstallOptions = { python?: string; tool?: string; env?: Record<string, string> };
export async function installPython(
  root: string,
  directory: string,
  requested: string,
  options: PythonInstallOptions = {},
) {
  const git = requested.startsWith('git+');
  const spec = git ? gitPythonSpec(requested) : pypiSpec(requested);
  const [withExtras, requestedVersion] = spec.split('==');
  const name = withExtras.split('[')[0];
  // Read package requirements before choosing Python, rather than assuming that
  // the interpreter bundled on a user's PC is suitable for this MCP.
  const metadata = git
    ? undefined
    : JSON.parse(
        (
          await download(
            'https://pypi.org/pypi/' +
              encodeURIComponent(name) +
              (requestedVersion ? '/' + encodeURIComponent(requestedVersion) : '') +
              '/json',
            8_000_000,
          )
        ).toString(),
      );
  const version = String(metadata?.info?.version || '');
  if (!git && (!version || !/^[a-zA-Z0-9.+!_-]+$/.test(version)))
    throw new Error('mcp_invalid_python_package');
  const requirement = options.python || String(metadata?.info?.requires_python || '');
  if (requirement.length > 256 || (requirement && !/^[0-9.*+<>=!,\s-]+$/.test(requirement)))
    throw new Error('mcp_invalid_python_version');
  const uv = await uvRuntime(root);
  const managedEnv = {
    UV_TOOL_DIR: path.join(directory, 'tools'),
    UV_TOOL_BIN_DIR: path.join(directory, 'bin'),
    UV_CACHE_DIR: path.join(directory, 'cache'),
    UV_PYTHON_INSTALL_DIR: path.join(root, 'python'),
    UV_PYTHON_BIN_DIR: path.join(root, 'python-bin'),
    UV_PYTHON_INSTALL_BIN: 'false',
    UV_PYTHON_INSTALL_REGISTRY: 'false',
    UV_MANAGED_PYTHON: 'true',
    UV_PYTHON_DOWNLOADS: 'automatic',
    UV_NO_CONFIG: 'true',
    UV_NO_PROGRESS: 'true',
    ELECTRON_RUN_AS_NODE: '',
  };
  const env = { ...process.env, ...options.env, ...managedEnv, GIT_TERMINAL_PROMPT: '0' };
  try {
    await exec(
      uv,
      [
        'tool',
        'install',
        '--managed-python',
        '--no-config',
        ...(requirement ? ['--python', requirement] : []),
        '--',
        git ? spec : withExtras + '==' + version,
      ],
      { windowsHide: true, cwd: directory, env, timeout: 900_000, maxBuffer: 4_000_000 },
    );
  } catch (cause) {
    const failure = cause as { stderr?: string; code?: string | number; killed?: boolean };
    const message = failure.killed
      ? 'mcp_python_install_timeout'
      : 'mcp_python_package_install_failed';
    const exit = typeof failure.code === 'number' ? ' (' + failure.code + ')' : '';
    throw mcpProcessError(message + exit, failure.stderr || '', env);
  }
  const bin = env.UV_TOOL_BIN_DIR;
  const entries = (await fs.readdir(bin)).filter(
    (file) => process.platform !== 'win32' || file.toLowerCase().endsWith('.exe'),
  );
  const preferred = (options.tool || name) + (process.platform === 'win32' ? '.exe' : '');
  const selected =
    entries.find((file) => file.toLowerCase() === preferred.toLowerCase()) ||
    (!options.tool && entries.length === 1 ? entries[0] : undefined);
  if (!selected) throw new Error('mcp_package_requires_single_executable');
  const command = path.join(bin, selected);
  await fs.access(command);
  const commit = git ? await installedGitCommit(managedEnv.UV_TOOL_DIR) : undefined;
  return { command, version, commit, path: bin, env: managedEnv };
}
