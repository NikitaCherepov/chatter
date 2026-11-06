import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { installNpm, installPython } from './local-mcp-runtime';
import {
  resolveLocalInput,
  emptyMcpApproval,
  normalizeMcpApproval,
  type McpApprovalPolicy,
  type LocalMcpInput,
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
  private sessions = new Map<string, { client: Client; transport: StdioClientTransport }>();
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
  private pythonDirectory(scope: string, id: string) {
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
    return target;
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
        (record.config.pypi ? 'uvx ' + record.config.pypi : '') ||
        path.basename(record.config.command || ''),
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
    return {
      env: this.environment(record).user,
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
  async install(scope: string, input: LocalMcpInput) {
    if (this.installing.has(scope)) throw new Error('mcp_install_busy');
    this.installing.add(scope);
    try {
      const config = resolveLocalInput(input);
      config.user_env = { ...config.env };
      if ((await this.list(scope)).length >= 20) throw new Error('mcp_connection_limit');
      const record: RecordData = {
        id: crypto.randomUUID(),
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
      const dir = this.directory(scope, record.id);
      await this.write(record);
      if (config.npm) {
        try {
          const installed = await this.npmInstaller(
            path.join(this.root, 'runtime'),
            dir,
            config.npm,
          );
          config.command = installed.command;
          config.args = [installed.entry, ...config.args];
          config.managed_env = { PATH: installed.path + path.delimiter + (process.env.PATH || '') };
          config.env = { ...config.user_env, ...config.managed_env };
        } catch {
          await this.remove(scope, record.id);
          throw new Error('mcp_package_install_failed');
        }
      }
      if (config.pypi) {
        try {
          const pythonDir = this.pythonDirectory(scope, record.id);
          await fs.mkdir(pythonDir, { recursive: true });
          const installed = await this.pythonInstaller(
            path.join(this.root, 'runtime'),
            pythonDir,
            config.pypi,
            {
              python: config.python,
              tool: config.tool,
              env: config.env,
            },
          );
          config.command = installed.command;
          config.managed_env = {
            ...installed.env,
            PATH: installed.path + path.delimiter + (process.env.PATH || ''),
          };
          config.env = { ...config.user_env, ...config.managed_env };
        } catch (error) {
          await this.remove(scope, record.id);
          throw error;
        }
      }
      record.enabled = true;
      await this.write(record);
      try {
        await this.discoverRecord(record);
      } catch (error: any) {
        record.error = String(error?.message || 'mcp_discovery_failed').slice(0, 300);
        await this.write(record);
      }
      return this.public(record);
    } finally {
      this.installing.delete(scope);
    }
  }
  private async connect(record: RecordData) {
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
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'chatter-desktop', version: '2.0.0' }, { capabilities: {} });
    const entry = { client, transport };
    this.sessions.set(record.id, entry);
    client.onclose = () => {
      if (this.sessions.get(record.id) === entry) this.sessions.delete(record.id);
    };
    try {
      await client.connect(transport, { timeout: 30_000 });
      return client;
    } catch (error) {
      await this.stop(record.id);
      throw error;
    }
  }
  private async discoverRecord(record: RecordData, signal?: AbortSignal) {
    // Older direct uvx configurations may have been saved before managed Python
    // support existed. Refresh capabilities prepares them through the same installer.
    if (
      !record.config.pypi &&
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
      if (config.pypi) {
        config.user_env = this.environment(record).user;
        const pythonDir = this.pythonDirectory(record.scope, record.id);
        await fs.mkdir(pythonDir, { recursive: true });
        const installed = await this.pythonInstaller(
          path.join(this.root, 'runtime'),
          pythonDir,
          config.pypi,
          { python: config.python, tool: config.tool, env: config.env },
        );
        signal?.throwIfAborted();
        config.command = installed.command;
        config.managed_env = {
          ...installed.env,
          PATH: installed.path + path.delimiter + (process.env.PATH || ''),
        };
        config.env = { ...config.user_env, ...config.managed_env };
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
    const client = await this.connect(record),
      cap = client.getServerCapabilities() || {};
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
    const discovered: Metadata = {
      tools: cap.tools ? await pages('tools', 200) : [],
      resources: cap.resources ? await pages('resources', 500) : [],
      resource_templates: cap.resources ? await pages('templates', 200) : [],
      capabilities: { tools: !!cap.tools, resources: !!cap.resources, prompts: !!cap.prompts },
      server_info: client.getServerVersion() || null,
    };
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
    let environmentChanged = false;
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
    if (patch.env !== undefined) {
      if (!patch.env || typeof patch.env !== 'object' || Array.isArray(patch.env))
        throw new Error('mcp_invalid_environment');
      const env = resolveLocalInput({
        source: JSON.stringify({
          command: record.config.command,
          args: record.config.args,
          env: patch.env,
        }),
      }).env;
      const previous = this.environment(record);
      const sorted = (value: Record<string, string>) =>
        JSON.stringify(Object.entries(value).sort());
      environmentChanged = sorted(env) !== sorted(previous.user);
      if (environmentChanged) {
        record.config_revision = crypto.randomUUID();
        record.metadata = empty();
        record.error = undefined;
        record.config.user_env = env;
        record.config.managed_env = previous.managed;
        record.config.env = { ...env, ...previous.managed };
        await this.stop(id);
      }
    }
    if (!record.enabled) await this.stop(id);
    await this.write(record);
    return { summary: this.public(record), restart: environmentChanged && record.enabled };
  }
  async control(scope: string, payload: any, progress?: () => void) {
    const id = payload.local_id,
      record = await this.read(scope, id);
    if (!record.enabled) throw new Error('mcp_connection_disabled');
    if ('config_revision' in payload && payload.config_revision !== record.config_revision)
      throw new Error('mcp_connection_changed');
    if (this.busy.has(id)) throw new Error('mcp_connection_busy');
    const controller = new AbortController(),
      requestId = payload.request_id || crypto.randomUUID();
    this.busy.add(id);
    this.requests.set(requestId, { id, controller });
    try {
      if (payload.action === 'discover')
        return await this.discoverRecord(record, controller.signal);
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
        result = await client.callTool(
          { name: payload.tool, arguments: payload.arguments },
          undefined,
          options,
        );
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
      const pythonTarget = this.pythonDirectory(scope, id);
      await fs.rm(pythonTarget, { recursive: true, force: true });
      await fs.rm(target, { recursive: true, force: true });
    });
  }
  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }
}
