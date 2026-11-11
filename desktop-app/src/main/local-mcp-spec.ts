export type PackageField = {
  name?: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  default?: string;
  value?: string;
  type?: string;
  isRepeated?: boolean;
  variables?: Record<string, PackageField>;
};
export type NpmMcpPackage = {
  registryType: 'npm' | 'pypi';
  identifier: string;
  version?: string;
  transport?: { type: string };
  environmentVariables?: PackageField[];
  packageArguments?: PackageField[];
  runtimeArguments?: unknown[];
  registryBaseUrl?: string;
};
export type LocalMcpInput = {
  description?: string;
  name?: string;
  source?: string;
  package?: NpmMcpPackage;
  catalog_id?: number;
  reuse_existing?: boolean;
  values?: Record<string, string>;
  env?: Record<string, string>;
};
export type LocalMcpManifest = {
  package: NpmMcpPackage;
  values: Record<string, string>;
};
export type LocalMcpConfig = {
  name: string;
  npm?: string;
  pypi?: string;
  git?: string;
  git_commit?: string;
  git_generation?: string;
  package_generation?: string;
  installed_version?: string;
  python?: string;
  tool?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
  user_env?: Record<string, string>;
  managed_env?: Record<string, string>;
  manifest?: LocalMcpManifest;
};
export type LocalMcpInstallPhase = 'installing' | 'connecting';

export function splitCommand(source: string): string[] {
  const out: string[] = [];
  let value = '',
    quote = '',
    started = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && source[i + 1] === quote) {
        value += quote;
        i++;
      } else value += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) {
        out.push(value);
        value = '';
        started = false;
      }
    } else {
      if (/[|&;<>\x60]/.test(c)) throw new Error('mcp_command_requires_direct_executable');
      value += c;
      started = true;
    }
  }
  if (quote) throw new Error('mcp_invalid_command');
  if (started) out.push(value);
  return out;
}
export function npmSpec(source: string): string {
  if (source.startsWith('https://')) {
    const url = new URL(source);
    if (!['www.npmjs.com', 'npmjs.com'].includes(url.hostname) || url.username || url.password)
      throw new Error('mcp_use_npm_url_or_command');
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (parts.shift() !== 'package') throw new Error('mcp_use_npm_url_or_command');
    const name = parts[0]?.startsWith('@') ? parts.splice(0, 2).join('/') : parts.shift();
    source = String(name) + (parts[0] === 'v' && parts[1] ? '@' + parts[1] : '');
  }
  source = source.replace(/^npm:/, '');
  if (
    !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9][a-zA-Z0-9._+~-]*)?$/.test(
      source,
    )
  )
    throw new Error('mcp_invalid_npm_package');
  return source;
}
export function pypiSpec(source: string): string {
  if (source.startsWith('https://')) {
    const url = new URL(source);
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (
      url.hostname !== 'pypi.org' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts[0] !== 'project' ||
      parts.length < 2 ||
      parts.length > 3
    )
      throw new Error('mcp_invalid_python_package');
    source = parts[1] + (parts[2] ? '==' + parts[2] : '');
  }
  source = source
    .replace(/^pypi:/, '')
    .replace(/@latest$/, '')
    .replace(/@([\w.+!-]+)$/, '==$1');
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\[[a-zA-Z0-9._-]+(?:,[a-zA-Z0-9._-]+)*\])?(?:==[a-zA-Z0-9][a-zA-Z0-9.+!_-]*)?$/.test(
      source,
    )
  )
    throw new Error('mcp_invalid_python_package');
  return source;
}
export function gitPythonSpec(source: string): string {
  if (
    source.length > 2048 ||
    !/^git\+https:\/\/[a-z0-9.-]+(?::\d+)?\/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*(?:@[a-z0-9_./-]+)?$/i.test(
      source,
    ) ||
    /(?:^|\/)\.{1,2}(?:\/|@|$)|@-/.test(source)
  )
    throw new Error('mcp_invalid_git_package');
  try {
    new URL(source.slice(4));
  } catch {
    throw new Error('mcp_invalid_git_package');
  }
  return source;
}

function pythonInvocation(args: string[]) {
  let python: string | undefined, from: string | undefined;
  while (args[0]?.startsWith('-')) {
    const flag = args.shift();
    if (flag === '--') break;
    if (flag === '--python' || flag === '-p') {
      python = args.shift();
      if (!python || !/^[0-9][0-9.*+<>=!, -]{0,100}$/.test(python))
        throw new Error('mcp_invalid_python_version');
    } else if (flag === '--from') {
      from = args.shift();
      if (!from) throw new Error('mcp_invalid_python_package');
    } else throw new Error('mcp_unsupported_uvx_option');
  }
  const command = args.shift();
  if (!command) throw new Error('mcp_invalid_python_package');
  const git = from?.startsWith('git+') ? gitPythonSpec(from) : undefined;
  const pypi = git ? undefined : pypiSpec(from || command);
  const tool = from || !pypi ? command : pypi.split('==')[0].split('[')[0];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tool)) throw new Error('mcp_invalid_python_executable');
  return { git, pypi, python, tool };
}
export function packageFromSource(source: string): NpmMcpPackage | undefined {
  try {
    const pkg = JSON.parse(source)?.package;
    if (!pkg || !['npm', 'pypi'].includes(pkg.registryType) || typeof pkg.identifier !== 'string')
      return;
    // The existing configuration form must remain usable for partially edited JSON.
    if (
      [pkg.environmentVariables, pkg.packageArguments].some(
        (fields) =>
          fields !== undefined &&
          (!Array.isArray(fields) ||
            fields.some(
              (field) =>
                !field ||
                typeof field !== 'object' ||
                (field.variables &&
                  Object.values(field.variables).some(
                    (value) => !value || typeof value !== 'object',
                  )),
            )),
      )
    )
      return;
    return pkg;
  } catch {
    return;
  }
}
export function packageFields(pkg: NpmMcpPackage) {
  const fields: Array<{
    key: string;
    label: string;
    secret: boolean;
    required: boolean;
    default: string;
  }> = [];
  for (const e of pkg.environmentVariables || [])
    fields.push({
      key: 'env:' + e.name,
      label: String(e.description || e.name || ''),
      secret: !!e.isSecret,
      required: !!e.isRequired,
      default: String(e.default || ''),
    });
  (pkg.packageArguments || []).forEach((arg, i) => {
    if (arg.variables)
      for (const [name, v] of Object.entries(arg.variables))
        fields.push({
          key: 'var:' + i + ':' + name,
          label: String(v.description || name),
          secret: !!v.isSecret,
          required: !!v.isRequired,
          default: String(v.default || ''),
        });
    if (arg.value === undefined)
      fields.push({
        key: 'arg:' + i,
        label: String(arg.description || arg.name || 'Argument ' + (i + 1)),
        secret: !!arg.isSecret,
        required: !!arg.isRequired,
        default: String(arg.default || ''),
      });
  });
  return fields;
}
export function resolveLocalInput(input: LocalMcpInput): LocalMcpConfig {
  if (!input || JSON.stringify(input).length > 100_000)
    throw new Error('mcp_invalid_install_input');
  let args: string[] = [],
    env: Record<string, string> = { ...input.env },
    npm: string | undefined,
    pypi: string | undefined,
    git: string | undefined,
    python: string | undefined,
    tool: string | undefined,
    command: string | undefined;
  const pkg = input.package;
  let manifest: LocalMcpManifest | undefined;
  if (pkg) {
    if (
      !['npm', 'pypi'].includes(pkg.registryType) ||
      pkg.transport?.type !== 'stdio' ||
      pkg.runtimeArguments?.length ||
      (pkg.registryBaseUrl &&
        !(
          pkg.registryType === 'npm'
            ? ['https://registry.npmjs.org', 'https://registry.npmjs.org/']
            : [
                'https://pypi.org',
                'https://pypi.org/',
                'https://pypi.org/simple',
                'https://pypi.org/simple/',
              ]
        ).includes(pkg.registryBaseUrl))
    )
      throw new Error('mcp_unsupported_package');
    if (pkg.registryType === 'pypi') {
      pypi = pypiSpec(pkg.identifier + (pkg.version ? '==' + pkg.version : ''));
    } else npm = npmSpec(pkg.identifier + (pkg.version ? '@' + pkg.version : ''));
    const values = input.values ?? {};
    if (
      typeof values !== 'object' ||
      Array.isArray(values) ||
      Object.values(values).some(
        (value) => typeof value !== 'string' || value.length > 16384 || value.includes('\u0000'),
      )
    )
      throw new Error('mcp_invalid_install_input');
    const resolvedValues: Record<string, string> = {};
    for (const field of packageFields(pkg)) {
      const value = values[field.key] ?? field.default;
      if (field.required && !value.trim()) throw new Error('mcp_required_configuration');
      resolvedValues[field.key] = value;
    }
    manifest = { package: pkg, values: resolvedValues };
    for (const e of pkg.environmentVariables || []) {
      if (!e.name) throw new Error('mcp_invalid_environment');
      env[e.name] = values['env:' + e.name] ?? String(e.default || '');
    }
    (pkg.packageArguments || []).forEach((arg, i) => {
      let value = arg.value ?? values['arg:' + i] ?? arg.default ?? '';
      value = String(value).replace(/\{([^}]+)\}/g, (_, name) => {
        const key = 'var:' + i + ':' + name;
        const value = values[key] ?? arg.variables?.[name]?.default ?? env[name] ?? '';
        if (Object.prototype.hasOwnProperty.call(resolvedValues, key)) resolvedValues[key] = value;
        return value;
      });
      if (!value && !arg.isRequired) return;
      if (arg.type === 'named') {
        if (!arg.name) throw new Error('mcp_invalid_package_argument');
        args.push(arg.name);
      }
      args.push(...(arg.isRepeated ? value.split(/\r?\n/).filter(Boolean) : [value]));
    });
  } else {
    const source = String(input.source || '').trim();
    if (source.startsWith('{')) {
      const json = JSON.parse(source);
      if (json.package)
        return resolveLocalInput({
          ...json,
          name: input.name || json.name,
          values: { ...json.values, ...input.values },
          env: { ...json.env, ...env },
        });
      command = json.command;
      args = json.args || [];
      env = { ...json.env, ...env };
    } else if (source.startsWith('pypi:') || source.startsWith('https://pypi.org/')) {
      pypi = pypiSpec(source);
    } else if (
      source.startsWith('https://') ||
      source.startsWith('npm:') ||
      (!/\s/.test(source) && !/[\\:]/.test(source))
    ) {
      npm = npmSpec(source);
    } else {
      args = splitCommand(source);
      command = args.shift();
    }
  }
  args = [...validateLocalMcpArguments(args)];
  if (command === 'npx' || (command === 'pnpm' && args[0] === 'dlx')) {
    if (command === 'pnpm') args.shift();
    while (args[0] === '-y' || args[0] === '--yes') args.shift();
    npm = npmSpec(args.shift() || '');
    command = undefined;
  }
  if (
    command === 'uvx' ||
    command === 'uvx.exe' ||
    ((command === 'uv' || command === 'uv.exe') && args[0] === 'tool' && args[1] === 'run')
  ) {
    if (command === 'uv' || command === 'uv.exe') args.splice(0, 2);
    const parsed = pythonInvocation(args);
    pypi = parsed.pypi;
    git = parsed.git;
    python = parsed.python;
    tool = parsed.tool;
    command = undefined;
  }
  if (
    !npm &&
    !pypi &&
    !git &&
    (typeof command !== 'string' ||
      !command ||
      command.length > 2048 ||
      /[\r\n\u0000]/.test(command))
  )
    throw new Error('mcp_invalid_command');
  env = validateLocalMcpEnvironment(env);
  return {
    name: String(input.name || npm || pypi || (git && tool) || command).slice(0, 120),
    npm,
    pypi,
    git,
    python,
    tool,
    command,
    args,
    env,
    ...(manifest && { manifest }),
  };
}

type McpSource = { key: string; version?: string };
const pythonName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');

export function validateLocalMcpArguments(args: unknown): string[] {
  if (
    !Array.isArray(args) ||
    args.length > 100 ||
    args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\u0000'))
  )
    throw new Error('mcp_invalid_arguments');
  return args;
}

export function localMcpLaunchArgs(config: LocalMcpConfig): string[] {
  if (!config.pypi || config.args.length) return config.args;
  const [packageName, pinnedVersion] = config.pypi.split('==');
  if (
    pythonName(packageName.split('[')[0]) !== 'windows-mcp' ||
    (config.tool && pythonName(config.tool) !== 'windows-mcp')
  )
    return config.args;
  const version = /^(\d+)\.(\d+)\.(\d+)/.exec(config.installed_version || pinnedVersion || '');
  if (!version) return config.args;
  const [, major, minor, patch] = version.map(Number);
  // Windows-MCP's manifest omits the serve subcommand required by its newer CLI.
  return major > 0 || minor > 8 || (minor === 8 && patch >= 1) ? ['serve'] : config.args;
}

export function localMcpSource(
  config: Partial<Pick<LocalMcpConfig, 'pypi' | 'npm' | 'git' | 'tool' | 'command' | 'args'>>,
): McpSource | undefined {
  if (config.pypi) {
    const [withExtras, version] = config.pypi.split('==');
    const name = pythonName(withExtras.split('[')[0]);
    const tool = config.tool && pythonName(config.tool) !== name ? config.tool : name;
    return { key: JSON.stringify(['pypi', name, tool]), version };
  }
  if (config.npm) {
    const match = config.npm.match(/@([^/@]+)$/);
    return {
      key: JSON.stringify(['npm', match ? config.npm.slice(0, match.index) : config.npm]),
      version: match?.[1],
    };
  }
  if (config.git) {
    const url = new URL(config.git.slice(4));
    const repo = url.pathname.split('@')[0].replace(/\.git$/i, '');
    return {
      key: JSON.stringify([
        'git',
        url.origin + (url.hostname === 'github.com' ? repo.toLowerCase() : repo),
        config.tool,
      ]),
    };
  }
  const command = config.command?.replace(/\\/g, '/');
  if (!command) return;
  const executable = command
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/\.exe$/, '');
  const args = config.args || [];
  if (executable === 'uvx' || (executable === 'uv' && args[0] === 'tool' && args[1] === 'run')) {
    try {
      return localMcpSource(pythonInvocation(args.slice(executable === 'uv' ? 2 : 0)));
    } catch {
      return;
    }
  }
  if (!/^(?:[a-z]:\/|\/)/i.test(command)) return;
  // A launcher alone cannot identify the script or server it starts.
  if (/\/(?:node|python\d*(?:\.\d+)?|uvx?|cmd|pwsh|powershell|bash|sh)(?:\.exe)?$/i.test(command))
    return;
  return {
    key: JSON.stringify([
      'executable',
      /^[a-z]:\//i.test(command) ? command.toLowerCase() : command,
    ]),
  };
}

export function localMcpInputSource(input: LocalMcpInput): McpSource | undefined {
  try {
    const pkg = input.package || packageFromSource(input.source || '');
    if (pkg?.registryType === 'pypi')
      return localMcpSource({
        pypi: pypiSpec(pkg.identifier + (pkg.version ? '==' + pkg.version : '')),
      });
    if (pkg?.registryType === 'npm')
      return localMcpSource({
        npm: npmSpec(pkg.identifier + (pkg.version ? '@' + pkg.version : '')),
      });
    return localMcpSource(resolveLocalInput(input));
  } catch {
    return;
  }
}

export function githubMcpRepository(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return;
  const match = value
    .trim()
    .match(/^https:\/\/github\.com\/([a-z0-9-]{1,39})\/([a-z0-9_.-]{1,100})\/?$/i);
  if (!match) return;
  const repo = match[2].replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') return;
  return { owner: match[1], repo, url: 'https://github.com/' + match[1] + '/' + repo };
}

export function normalizeMcpEndpoint(value: string) {
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
}

export type McpApprovalPolicy = { allow_all: boolean; tools: string[]; resources: string[] };
export const emptyMcpApproval = (): McpApprovalPolicy => ({
  allow_all: false,
  tools: [],
  resources: [],
});
export function normalizeMcpApproval(value: any): McpApprovalPolicy {
  if (
    !value ||
    typeof value.allow_all !== 'boolean' ||
    !Array.isArray(value.tools) ||
    value.tools.length > 200 ||
    value.tools.some((x: any) => typeof x !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(x)) ||
    !Array.isArray(value.resources) ||
    value.resources.length > 500 ||
    value.resources.some(
      (x: any) => typeof x !== 'string' || !x || x.length > 4096 || /[\u0000-\u001f]/.test(x),
    )
  )
    throw new Error('mcp_invalid_approval_policy');
  return {
    allow_all: value.allow_all,
    tools: [...new Set<string>(value.tools)],
    resources: [...new Set<string>(value.resources)],
  };
}

export function validateLocalMcpEnvironment(env: unknown): Record<string, string> {
  if (
    !env ||
    typeof env !== 'object' ||
    Array.isArray(env) ||
    Object.entries(env).length > 100 ||
    Object.entries(env).some(
      ([k, v]) =>
        !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(k) ||
        typeof v !== 'string' ||
        v.length > 16384 ||
        v.includes('\u0000'),
    )
  )
    throw new Error('mcp_invalid_environment');
  return env as Record<string, string>;
}
export function parseLocalMcpEnvironment(source: string): Record<string, string> {
  return validateLocalMcpEnvironment(JSON.parse(source.trim() || '{}'));
}
