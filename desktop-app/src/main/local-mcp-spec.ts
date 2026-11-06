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
  registryType: 'npm';
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
    command: string | undefined;
  const pkg = input.package;
  if (pkg) {
    if (
      pkg.registryType !== 'npm' ||
      pkg.transport?.type !== 'stdio' ||
      pkg.runtimeArguments?.length ||
      (pkg.registryBaseUrl &&
        !['https://registry.npmjs.org', 'https://registry.npmjs.org/'].includes(
          pkg.registryBaseUrl,
        ))
    )
      throw new Error('mcp_unsupported_package');
    npm = npmSpec(pkg.identifier + (pkg.version ? '@' + pkg.version : ''));
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
      command = json.command;
      args = json.args || [];
      env = { ...json.env, ...env };
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
    !npm &&
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
  return { name: String(input.name || npm || command).slice(0, 120), npm, command, args, env };
}
