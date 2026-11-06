import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
let pending: Promise<{ node: string; npm: string }> | undefined;
async function download(url: string, maximum: number): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
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
