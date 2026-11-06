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
  values?: Record<string, string>;
  env?: Record<string, string>;
};
export type LocalMcpConfig = {
  name: string;
  npm?: string;
  pypi?: string;
  python?: string;
  tool?: string;
  command?: string;
  args: string[];
  env: Record<string, string>;
};
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
  const spec = pypiSpec(from || command);
  const tool = from ? command : spec.split('==')[0].split('[')[0];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tool)) throw new Error('mcp_invalid_python_executable');
  return { spec, python, tool };
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
      label: e.description || e.name || '',
      secret: !!e.isSecret,
      required: !!e.isRequired,
      default: String(e.default || ''),
    });
  (pkg.packageArguments || []).forEach((arg, i) => {
    if (arg.variables)
      for (const [name, v] of Object.entries(arg.variables))
        fields.push({
          key: 'var:' + i + ':' + name,
          label: v.description || name,
          secret: !!v.isSecret,
          required: !!v.isRequired,
          default: String(v.default || ''),
        });
    if (arg.value === undefined)
      fields.push({
        key: 'arg:' + i,
        label: arg.description || arg.name || 'Argument ' + (i + 1),
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
    python: string | undefined,
    tool: string | undefined,
    command: string | undefined;
  const pkg = input.package;
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
    const values = input.values || {};
    for (const field of packageFields(pkg))
      if (field.required && !(values[field.key] ?? field.default).trim())
        throw new Error('mcp_required_configuration');
    for (const e of pkg.environmentVariables || []) {
      if (!e.name) throw new Error('mcp_invalid_environment');
      env[e.name] = values['env:' + e.name] ?? String(e.default || '');
    }
    (pkg.packageArguments || []).forEach((arg, i) => {
      let value = arg.value ?? values['arg:' + i] ?? arg.default ?? '';
      value = String(value).replace(
        /\{([^}]+)\}/g,
        (_, name) =>
          values['var:' + i + ':' + name] ?? arg.variables?.[name]?.default ?? env[name] ?? '',
      );
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
          values: input.values || json.values,
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
      const parts = splitCommand(source);
      command = parts.shift();
      if (command === 'npx' || (command === 'pnpm' && parts[0] === 'dlx')) {
        if (command === 'pnpm') parts.shift();
        while (parts[0] === '-y' || parts[0] === '--yes') parts.shift();
        npm = npmSpec(parts.shift() || '');
        command = undefined;
        args = parts;
      } else args = parts;
    }
  }
  if (
    command === 'uvx' ||
    command === 'uvx.exe' ||
    ((command === 'uv' || command === 'uv.exe') && args[0] === 'tool' && args[1] === 'run')
  ) {
    if (command === 'uv' || command === 'uv.exe') args.splice(0, 2);
    const parsed = pythonInvocation(args);
    pypi = parsed.spec;
    python = parsed.python;
    tool = parsed.tool;
    command = undefined;
  }
  if (
    !npm &&
    !pypi &&
    (typeof command !== 'string' ||
      !command ||
      command.length > 2048 ||
      /[\r\n\u0000]/.test(command))
  )
    throw new Error('mcp_invalid_command');
  if (
    !Array.isArray(args) ||
    args.length > 100 ||
    args.some((a) => typeof a !== 'string' || a.length > 8192 || a.includes('\u0000'))
  )
    throw new Error('mcp_invalid_arguments');
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
  return {
    name: String(input.name || npm || pypi || command).slice(0, 120),
    npm,
    pypi,
    python,
    tool,
    command,
    args,
    env,
  };
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
