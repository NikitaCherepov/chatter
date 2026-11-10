import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installNpm, installPython, mcpProcessError } from './local-mcp-runtime';
import {
  resolveLocalInput,
  packageFields,
  localMcpSource,
  npmSpec,
  pypiSpec,
  validateLocalMcpEnvironment,
  emptyMcpApproval,
  normalizeMcpApproval,
  type McpApprovalPolicy,
  type LocalMcpInput,
  type LocalMcpInstallPhase,
  type LocalMcpConfig,
} from './local-mcp-spec';
type Metadata = {
  tools: any[];
  resources: any[];
  resource_templates: any[];
  capabilities: { tools: boolean; resources: boolean; prompts: boolean } | null;
  server_info: any;
};
type RecordData = {
  id: string;
  catalog_id?: number;
  scope: string;
  name: string;
  description?: string;
  enabled: boolean;
  mode: 'search' | 'eager';
  timeout_seconds: number;
  selected_tools: string[] | null;
  approval_policy?: McpApprovalPolicy;
  config_revision?: string;
  config: LocalMcpConfig;
  metadata: Metadata;
  error?: string;
};
const empty = (): Metadata => ({
  tools: [],
  resources: [],
  resource_templates: [],
  capabilities: null,
  server_info: null,
});
export class LocalMcpManager {
  private sessions = new Map<string, { client: Client; stderr: string }>();
  private requests = new Map<string, { id: string; controller: AbortController }>();
  private busy = new Set<string>();
  private installing = new Set<string>();
  private writes = new Map<string, Promise<unknown>>();
  private async serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(id) || Promise.resolve(),
      next = previous.catch(() => {}).then(action);
    this.writes.set(id, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(id) === next) this.writes.delete(id);
    }
  }
  constructor(
    private root: string,
    private encrypt: (text: string) => Buffer,
    private decrypt: (data: Buffer) => string,
    private npmInstaller = installNpm,
    private pythonInstaller = installPython,
  ) {}
  private account(scope: string) {
    if (typeof scope !== 'string' || !scope || scope.length > 2048)
      throw new Error('mcp_invalid_account_scope');
    return path.join(
      path.resolve(this.root),
      'accounts',
      crypto.createHash('sha256').update(scope).digest('hex'),
    );
  }
  private directory(scope: string, id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('mcp_invalid_local_id');
    const base = this.account(scope),
      target = path.resolve(base, id);
    if (path.dirname(target) !== base) throw new Error('mcp_invalid_local_path');
    return target;
  }
  private packageDirectory(scope: string, id: string, generation?: string) {
    this.directory(scope, id); // Reuse the account/id validation before deriving a deletion target.
    const base = path.resolve(this.root, 'py');
    const target = path.join(
      base,
      crypto
        .createHash('sha256')
        .update(scope + ':' + id)
        .digest('hex')
        .slice(0, 24),
    );
    if (path.dirname(target) !== base) throw new Error('mcp_invalid_local_path');
    if (generation === undefined) return target;
    if (!/^[0-9a-f]{8}$/.test(generation)) throw new Error('mcp_invalid_local_path');
    return path.join(target, generation);
  }
  private async removePackageGeneration(scope: string, id: string, generation: string) {
    const directory = this.packageDirectory(scope, id, generation);
    const base = path.resolve(this.root, 'py');
    const resolvedBase = await fs.realpath(base);
    const resolved = await fs.realpath(directory);
    if (path.relative(resolvedBase, resolved) !== path.relative(base, directory))
      throw new Error('mcp_invalid_local_path');
    await fs.rm(directory, { recursive: true, force: true });
  }
  private async read(scope: string, id: string): Promise<RecordData> {
    const record = JSON.parse(
      this.decrypt(await fs.readFile(path.join(this.directory(scope, id), 'config.bin'))),
    );
    if (record.scope !== scope || record.id !== id) throw new Error('mcp_local_account_mismatch');
    return record;
  }
  private async write(record: RecordData) {
    const encrypted = this.encrypt(JSON.stringify(record));
    const dir = this.directory(record.scope, record.id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.tmp'), encrypted);
    await fs.rename(path.join(dir, 'config.tmp'), path.join(dir, 'config.bin'));
  }
  private public(record: RecordData) {
    const source = localMcpSource(record.config);
    const pinnedVersion = source?.version;
    const legacyVersion =
      record.config.pypi ||
      (pinnedVersion && /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(pinnedVersion))
        ? pinnedVersion
        : undefined;
    return {
      id: record.id,
      approval_policy: record.approval_policy || emptyMcpApproval(),
      config_revision: record.config_revision,
      name: record.name,
      enabled: record.enabled,
      mode: record.mode,
      timeout_seconds: record.timeout_seconds,
      selected_tools: record.selected_tools,
      source:
        record.config.npm ||
        record.config.git ||
        (record.config.pypi ? 'uvx ' + record.config.pypi : '') ||
        path.basename(record.config.command || ''),
      git_commit: record.config.git_commit,
      source_key: source?.key,
      catalog_id: record.catalog_id,
      installed_version: record.config.installed_version || legacyVersion,
      updatable: !!(record.config.git || record.config.npm || record.config.pypi),
      running: this.sessions.has(record.id),
      error: record.error,
      ...record.metadata,
      server_info: {
        ...record.metadata.server_info,
        description: record.description || record.metadata.server_info?.description || '',
      },
    };
  }
  private environment(record: RecordData) {
    const managed =
      record.config.managed_env ||
      Object.fromEntries(
        Object.entries(record.config.env).filter(
          ([key]) =>
            (record.config.npm || record.config.pypi) &&
            (key === 'PATH' ||
              key === 'ELECTRON_RUN_AS_NODE' ||
              [
                'UV_TOOL_DIR',
                'UV_TOOL_BIN_DIR',
                'UV_CACHE_DIR',
                'UV_PYTHON_INSTALL_DIR',
                'UV_PYTHON_BIN_DIR',
                'UV_PYTHON_INSTALL_BIN',
                'UV_PYTHON_INSTALL_REGISTRY',
                'UV_MANAGED_PYTHON',
                'UV_PYTHON_DOWNLOADS',
                'UV_NO_CONFIG',
                'UV_NO_PROGRESS',
              ].includes(key)),
        ),
      );
    const user =
      record.config.user_env ||
      Object.fromEntries(Object.entries(record.config.env).filter(([key]) => !(key in managed)));
    return { user, managed };
  }
  // Sensitive settings are read only by the trusted local renderer, never list/sync.
  async settings(scope: string, id: string) {
    const record = await this.read(scope, id);
    const env = this.environment(record).user;
    const manifest = record.config.manifest;
    const values = manifest && { ...manifest.values };
    if (manifest && values)
      for (const field of manifest.package.environmentVariables || [])
        if (field.name) values['env:' + field.name] = env[field.name] ?? '';
    return {
      env,
      ...(manifest && values && { manifest: { package: manifest.package, values } }),
      config_revision: record.config_revision,
      mode: record.mode,
      timeout_seconds: record.timeout_seconds,
    };
  }
  async list(scope: string) {
    let entries: string[];
    try {
      entries = await fs.readdir(this.account(scope));
    } catch (error: any) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const result = [];
    for (const id of entries.filter((name) => /^[a-f0-9-]{36}$/.test(name)))
      result.push(this.public(await this.read(scope, id)));
    return result;
  }
  private async preparePython(scope: string, id: string, config: LocalMcpConfig) {
    const source = config.git || config.pypi;
    if (!source) throw new Error('mcp_invalid_python_package');
    const directory = this.packageDirectory(
      scope,
      id,
      config.package_generation ?? config.git_generation,
    );
    await fs.mkdir(directory, { recursive: true });
    const installed = await this.pythonInstaller(
      path.join(this.root, 'runtime'),
      directory,
      source,
      {
        python: config.python,
        tool: config.tool,
        env: config.user_env || config.env,
      },
    );
    config.command = installed.command;
    config.git_commit = installed.commit;
    config.installed_version = installed.version || undefined;
    config.managed_env = {
      ...installed.env,
      PATH: installed.path + path.delimiter + (process.env.PATH || ''),
    };
    config.env = { ...config.user_env, ...config.managed_env };
  }
  private async prepareNpm(scope: string, id: string, config: LocalMcpConfig) {
    const directory = this.packageDirectory(scope, id, config.package_generation);
    await fs.mkdir(directory, { recursive: true });
    const installed = await this.npmInstaller(
      path.join(this.root, 'runtime'),
      directory,
      config.npm!,
    );
    config.command = installed.command;
    config.args = [installed.entry, ...config.args];
    config.installed_version = installed.version || undefined;
    config.managed_env = { PATH: installed.path + path.delimiter + (process.env.PATH || '') };
    config.env = { ...config.user_env, ...config.managed_env };
  }
  async install(
    scope: string,
    input: LocalMcpInput,
    progress?: (phase: LocalMcpInstallPhase) => void,
  ) {
    if (this.installing.has(scope)) throw new Error('mcp_install_busy');
    this.installing.add(scope);
    try {
      const config = resolveLocalInput(input);
      config.user_env = { ...config.env };
      const entries = await this.list(scope);
      const source = localMcpSource(config);
      if (input.reuse_existing && source) {
        const existing = entries.find((entry) => entry.source_key === source.key);
        if (existing) return existing;
      }
      if (entries.length >= 20) throw new Error('mcp_connection_limit');
      if (config.git || config.npm || config.pypi)
        config.package_generation = crypto.randomBytes(4).toString('hex');
      const record: RecordData = {
        id: crypto.randomUUID(),
        ...(Number.isSafeInteger(input.catalog_id) && Number(input.catalog_id) > 0
          ? { catalog_id: input.catalog_id }
          : {}),
        config_revision: crypto.randomUUID(),
        approval_policy: emptyMcpApproval(),
        scope,
        name: config.name,
        description: String(input.description || '').slice(0, 1500),
        enabled: false,
        mode: 'search',
        timeout_seconds: 300,
        selected_tools: null,
        config,
        metadata: empty(),
      };
      await this.write(record);
      if (config.npm) {
        progress?.('installing');
        try {
          await this.prepareNpm(scope, record.id, config);
        } catch {
          await this.remove(scope, record.id);
          throw new Error('mcp_package_install_failed');
        }
      }
      if (config.pypi || config.git) {
        progress?.('installing');
        try {
          await this.preparePython(scope, record.id, config);
        } catch (error) {
          await this.remove(scope, record.id);
          throw error;
        }
      }
      progress?.('connecting');
      record.enabled = true;
      await this.write(record);
      try {
        await this.discoverRecord(record);
      } catch (error: any) {
        record.error = String(error?.message || 'mcp_discovery_failed').slice(0, 2000);
        await this.write(record);
      }
      return this.public(record);
    } finally {
      this.installing.delete(scope);
    }
  }
  private diagnosticsEnv(record: RecordData) {
    const env = { ...record.config.env };
    const manifest = record.config.manifest;
    if (manifest)
      for (const field of packageFields(manifest.package))
        if (field.secret)
          env['secret:' + field.key] = field.key.startsWith('env:')
            ? (env[field.key.slice(4)] ?? '')
            : (manifest.values[field.key] ?? '');
    return env;
  }
  private async connect(record: RecordData, showDiagnostics = false) {
    const existing = this.sessions.get(record.id);
    if (existing) return existing.client;
    const transport = new StdioClientTransport({
      command: record.config.command!,
      args: record.config.args,
      env: record.config.env,
      cwd: this.directory(record.scope, record.id),
      stderr: 'pipe',
      maxBufferSize: 8_000_000,
    });
    const client = new Client({ name: 'chatter-desktop', version: '2.0.0' }, { capabilities: {} });
    const entry = { client, stderr: '' };
    transport.stderr?.on('data', (chunk: Buffer) => {
      entry.stderr = (entry.stderr + chunk.toString()).slice(-16000);
    });
    this.sessions.set(record.id, entry);
    client.onclose = () => {
      if (this.sessions.get(record.id) === entry) this.sessions.delete(record.id);
    };
    try {
      await client.connect(transport, { timeout: 30_000 });
      return client;
    } catch (error) {
      await this.stop(record.id);
      if (!showDiagnostics || !entry.stderr.trim()) throw error;
      throw mcpProcessError(
        error instanceof Error ? error.message : String(error),
        entry.stderr,
        this.diagnosticsEnv(record),
      );
    }
  }
  private async discoverRecord(record: RecordData, signal?: AbortSignal, showDiagnostics = true) {
    // Older direct uvx configurations may have been saved before managed Python
    // support existed. Refresh capabilities prepares them through the same installer.
    if (
      !record.config.pypi &&
      !record.config.git &&
      ['uvx', 'uvx.exe', 'uv', 'uv.exe'].includes(record.config.command || '')
    ) {
      const config = resolveLocalInput({
        name: record.name,
        source: JSON.stringify({
          command: record.config.command,
          args: record.config.args,
          env: record.config.env,
        }),
      });
      if (config.pypi || config.git) {
        config.user_env = this.environment(record).user;
        if (config.git) config.git_generation = crypto.randomBytes(4).toString('hex');
        try {
          await this.preparePython(record.scope, record.id, config);
        } catch (error) {
          if (config.git_generation)
            await this.removePackageGeneration(
              record.scope,
              record.id,
              config.git_generation,
            ).catch(() => {});
          if (!showDiagnostics && error instanceof Error)
            throw new Error(error.message.split('\n', 1)[0]);
          throw error;
        }
        signal?.throwIfAborted();
        await this.serialized(record.id, async () => {
          const latest = await this.read(record.scope, record.id);
          if (latest.config_revision !== record.config_revision)
            throw new Error('mcp_connection_changed');
          latest.config = config;
          latest.config_revision = crypto.randomUUID();
          latest.metadata = empty();
          await this.write(latest);
          Object.assign(record, latest);
        });
      }
    }
    const discovered = await this.discoverMetadata(record, signal, showDiagnostics);
    return this.serialized(record.id, async () => {
      signal?.throwIfAborted();
      const latest = await this.read(record.scope, record.id);
      if (latest.config_revision !== record.config_revision)
        throw new Error('mcp_connection_changed');
      latest.metadata = discovered;
      latest.error = undefined;
      await this.write(latest);
      Object.assign(record, latest);
      return discovered;
    });
  }
  private async discoverMetadata(
    record: RecordData,
    signal?: AbortSignal,
    showDiagnostics = true,
  ): Promise<Metadata> {
    const client = await this.connect(record, showDiagnostics);
    const session = this.sessions.get(record.id);
    const cap = client.getServerCapabilities() || {};
    const pages = async (kind: 'tools' | 'resources' | 'templates', max: number) => {
      const values: any[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        if (seen.has(cursor || '') || seen.size >= 20) throw new Error('mcp_invalid_catalog');
        seen.add(cursor || '');
        const params = cursor ? { cursor } : {},
          options = { signal, timeout: 30_000 };
        let page: any;
        try {
          page =
            kind === 'tools'
              ? await client.listTools(params, options)
              : kind === 'resources'
                ? await client.listResources(params, options)
                : await client.listResourceTemplates(params, options);
        } catch (error: any) {
          if (kind !== 'tools' && error.code === -32601) return [];
          throw error;
        }
        values.push(...page[kind === 'templates' ? 'resourceTemplates' : kind]);
        if (values.length > max || JSON.stringify(values).length > 512_000)
          throw new Error('mcp_catalog_too_large');
        cursor = page.nextCursor;
      } while (cursor);
      return values;
    };
    try {
      return {
        tools: cap.tools ? await pages('tools', 200) : [],
        resources: cap.resources ? await pages('resources', 500) : [],
        resource_templates: cap.resources ? await pages('templates', 200) : [],
        capabilities: { tools: !!cap.tools, resources: !!cap.resources, prompts: !!cap.prompts },
        server_info: client.getServerVersion() || null,
      };
    } catch (error) {
      if (!showDiagnostics || !session?.stderr.trim() || signal?.aborted) throw error;
      throw mcpProcessError(
        error instanceof Error ? error.message : String(error),
        session.stderr,
        this.diagnosticsEnv(record),
      );
    }
  }
  async update(
    scope: string,
    id: string,
    progress?: (phase: LocalMcpInstallPhase) => void,
    version?: string,
  ) {
    return this.serialized(id, async () => {
      const current = await this.read(scope, id);
      const config = current.config;
      if (!config.git && !config.npm && !config.pypi)
        throw new Error('mcp_package_update_unsupported');
      if (
        version !== undefined &&
        (typeof version !== 'string' ||
          !/^[a-zA-Z0-9][a-zA-Z0-9.+!_~-]*$/.test(version) ||
          version.length > 100 ||
          config.git)
      )
        throw new Error('mcp_invalid_package_version');
      if (version && config.installed_version === version) return this.public(current);
      const npm = config.npm
        ? npmSpec(config.npm.replace(/@[^/@]+$/, '') + (version ? '@' + version : ''))
        : undefined;
      const pypi = config.pypi
        ? pypiSpec(config.pypi.split('==')[0] + (version ? '==' + version : ''))
        : undefined;
      if (this.busy.has(id)) throw new Error('mcp_connection_busy');
      this.busy.add(id);
      const generation = crypto.randomBytes(4).toString('hex');
      const candidate: RecordData = {
        ...current,
        config_revision: crypto.randomUUID(),
        config: {
          ...config,
          npm,
          pypi,
          args: config.npm ? config.args.slice(1) : config.args,
          user_env: this.environment(current).user,
          package_generation: generation,
          git_generation: undefined,
        },
        error: undefined,
      };
      let connecting = false;
      try {
        progress?.('installing');
        if (npm) await this.prepareNpm(scope, id, candidate.config);
        else await this.preparePython(scope, id, candidate.config);
        progress?.('connecting');
        await this.stop(id);
        connecting = true;
        candidate.metadata = await this.discoverMetadata(candidate);
        if (!candidate.enabled) await this.stop(id);
        await this.write(candidate);
      } catch (error) {
        if (connecting) await this.stop(id);
        await this.removePackageGeneration(scope, id, generation).catch(() => {});
        current.error = String(error instanceof Error ? error.message : error).slice(0, 2000);
        await this.write(current);
        return this.public(current);
      } finally {
        this.busy.delete(id);
      }
      const previousGeneration = config.package_generation ?? config.git_generation;
      if (previousGeneration)
        await this.removePackageGeneration(scope, id, previousGeneration).catch(() => {});
      return this.public(candidate);
    });
  }
  async configure(scope: string, id: string, patch: any) {
    const { summary, restart } = await this.serialized(id, () =>
      this.configureRecord(scope, id, patch),
    );
    if (!restart) return summary;
    // Discovery also serializes metadata writes; run it outside the write queue.
    try {
      await this.control(scope, {
        local_id: id,
        action: 'discover',
        config_revision: summary.config_revision,
      });
    } catch (error: any) {
      await this.serialized(id, async () => {
        const current = await this.read(scope, id);
        if (current.config_revision !== summary.config_revision)
          throw new Error('mcp_connection_changed');
        current.error = String(error?.message || 'mcp_discovery_failed').slice(0, 1000);
        await this.write(current);
      });
    }
    return this.public(await this.read(scope, id));
  }
  private async configureRecord(scope: string, id: string, patch: any) {
    const record = await this.read(scope, id);
    let launchConfigChanged = false;
    if ('expected_revision' in patch && patch.expected_revision !== record.config_revision)
      throw new Error('mcp_connection_changed');
    if (patch.approval_policy !== undefined)
      record.approval_policy = normalizeMcpApproval(patch.approval_policy);
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new Error('mcp_invalid_connection');
      record.enabled = patch.enabled;
    }
    if (patch.mode !== undefined) {
      if (!['search', 'eager'].includes(patch.mode)) throw new Error('mcp_invalid_connection');
      record.mode = patch.mode;
    }
    if (patch.timeout_seconds !== undefined) {
      if (
        !Number.isInteger(patch.timeout_seconds) ||
        patch.timeout_seconds < 10 ||
        patch.timeout_seconds > 3600
      )
        throw new Error('mcp_invalid_connection');
      record.timeout_seconds = patch.timeout_seconds;
    }
    if (patch.selected_tools !== undefined) {
      if (
        patch.selected_tools !== null &&
        (!Array.isArray(patch.selected_tools) ||
          patch.selected_tools.some((x: any) => typeof x !== 'string') ||
          patch.selected_tools.length > 200)
      )
        throw new Error('mcp_invalid_tools');
      record.selected_tools = patch.selected_tools;
    }
    if (patch.env !== undefined || patch.manifest_values !== undefined) {
      const previous = this.environment(record);
      let env = patch.env === undefined ? previous.user : validateLocalMcpEnvironment(patch.env);
      let { args, manifest } = record.config;
      if (patch.manifest_values !== undefined) {
        if (
          !manifest ||
          !patch.manifest_values ||
          typeof patch.manifest_values !== 'object' ||
          Array.isArray(patch.manifest_values)
        )
          throw new Error('mcp_invalid_install_input');
        const resolved = resolveLocalInput({
          package: manifest.package,
          values: {
            ...manifest.values,
            ...Object.fromEntries(
              (manifest.package.environmentVariables || [])
                .filter((field) => field.name)
                .map((field) => ['env:' + field.name, previous.user[field.name!] ?? '']),
            ),
            ...patch.manifest_values,
          },
          env,
        });
        env = resolved.env;
        args = record.config.npm ? [args[0], ...resolved.args] : resolved.args;
        manifest = resolved.manifest;
      }
      const sorted = (value: Record<string, string>) =>
        JSON.stringify(Object.entries(value).sort());
      launchConfigChanged =
        sorted(env) !== sorted(previous.user) ||
        JSON.stringify(args) !== JSON.stringify(record.config.args);
      const valuesChanged =
        sorted(manifest?.values || {}) !== sorted(record.config.manifest?.values || {});
      if (launchConfigChanged || valuesChanged) {
        record.config_revision = crypto.randomUUID();
        record.config.manifest = manifest;
      }
      if (launchConfigChanged) {
        record.metadata = empty();
        record.error = undefined;
        record.config.args = args;
        record.config.user_env = env;
        record.config.managed_env = previous.managed;
        record.config.env = { ...env, ...previous.managed };
        await this.stop(id);
      }
    }
    if (!record.enabled) await this.stop(id);
    await this.write(record);
    return { summary: this.public(record), restart: launchConfigChanged && record.enabled };
  }
  async control(scope: string, payload: any, progress?: () => void) {
    const id = payload.local_id;
    if (this.busy.has(id)) throw new Error('mcp_connection_busy');
    const controller = new AbortController();
    const requestId = payload.request_id || crypto.randomUUID();
    this.busy.add(id);
    this.requests.set(requestId, { id, controller });
    try {
      const record = await this.read(scope, id);
      controller.signal.throwIfAborted();
      if (!record.enabled) throw new Error('mcp_connection_disabled');
      if ('config_revision' in payload && payload.config_revision !== record.config_revision)
        throw new Error('mcp_connection_changed');
      if (payload.action === 'discover')
        return await this.discoverRecord(record, controller.signal, !payload.request_id);
      const client = await this.connect(record);
      const options = {
        signal: controller.signal,
        timeout: record.timeout_seconds * 1000,
        resetTimeoutOnProgress: true,
        onprogress: () => progress?.(),
      };
      let result: any;
      if (payload.action === 'call') {
        if (
          !record.metadata.tools.some(
            (t) =>
              t.name === payload.tool &&
              (record.selected_tools === null || record.selected_tools.includes(t.name)),
          )
        )
          throw new Error('mcp_tool_not_allowed');
        result = await client
          .callTool({ name: payload.tool, arguments: payload.arguments }, undefined, options)
          .catch((error: unknown) => {
            if (controller.signal.aborted || !(error instanceof McpError)) throw error;
            if (error.code === ErrorCode.ConnectionClosed) throw new Error('mcp_connection_closed');
            if (error.code === ErrorCode.RequestTimeout) throw new Error('mcp_request_timeout');
            // Some servers use JSON-RPC errors for tool validation failures.
            // Preserve them as ordinary tool errors, through the existing result pipeline.
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'mcp_tool_failed',
                    code: error.code,
                    message: error.message.slice(0, 12000),
                  }),
                },
              ],
            };
          });
      } else if (payload.action === 'read_resource') {
        result = await client.readResource({ uri: payload.uri }, options);
      } else throw new Error('mcp_invalid_local_action');
      if (JSON.stringify(result).length > 8_000_000) throw new Error('mcp_result_too_large');
      return result;
    } finally {
      this.busy.delete(id);
      this.requests.delete(requestId);
    }
  }
  async cancel(requestId: string) {
    const request = this.requests.get(requestId);
    if (!request) return;
    request.controller.abort(new Error('mcp_cancelled'));
    await this.stop(request.id);
  }
  private async stop(id: string) {
    for (const request of this.requests.values())
      if (request.id === id) request.controller.abort(new Error('mcp_cancelled'));
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) await session.client.close().catch(() => {});
  }
  async remove(scope: string, id: string) {
    return this.serialized(id, async () => {
      await this.read(scope, id);
      await this.stop(id);
      const target = this.directory(scope, id);
      const pythonTarget = this.packageDirectory(scope, id);
      await fs.rm(pythonTarget, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    });
  }
  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
