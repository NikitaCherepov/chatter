import crypto from 'node:crypto';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import {
  availableConnections,
  allServers,
  requireConnection,
  type McpConnection,
} from './store.js';
import { refreshTools, readRemoteResource } from './client.js';
import { wrapUntrustedContent } from '../web-reader.js';

export type McpResource = {
  uri?: string;
  uriTemplate?: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};
export function connectionResources(row: McpConnection) {
  return {
    resources: JSON.parse(row.resources_json || '[]') as McpResource[],
    templates: JSON.parse(row.templates_json || '[]') as McpResource[],
  };
}
function wordsMatch(query: string, text: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
export async function browseMcp(userId: number, args: any, signal?: AbortSignal) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (
    (args.query !== undefined && typeof args.query !== 'string') ||
    (args.refresh !== undefined && typeof args.refresh !== 'boolean') ||
    query.length > 300 ||
    (args.cursor !== undefined && typeof args.cursor !== 'string')
  )
    throw new Error('mcp_invalid_browse');
  const id = args.connection_id === undefined ? undefined : Number(args.connection_id);
  if (id !== undefined && (!Number.isSafeInteger(id) || id <= 0)) throw new Error('mcp_invalid_id');
  const kind = args.kind || (id || query ? 'all' : 'servers');
  if (!['servers', 'tools', 'resources', 'all'].includes(kind))
    throw new Error('mcp_invalid_browse');
  if (args.refresh && !id) throw new Error('mcp_refresh_requires_connection');
  if (id) {
    const row = requireConnection(userId, id);
    if (args.refresh || !row.capabilities_json) await refreshTools(userId, id, signal);
  }
  const rows = availableConnections(userId).filter((row) => id === undefined || row.id === id);
  const approved = allServers();
  const items: any[] = [];
  for (const row of rows) {
    const info = JSON.parse(row.server_info_json || 'null');
    const description = String(
      info?.description ||
        approved.find((server) => server.id === row.server_id)?.description ||
        '',
    ).slice(0, 1500);
    const selected = JSON.parse(row.selected_tools) as string[] | null;
    const tools = (JSON.parse(row.tools_json) as any[]).filter(
      (tool) => selected === null || selected.includes(tool.name),
    );
    const { resources, templates } = connectionResources(row);
    const capabilities = JSON.parse(row.capabilities_json || 'null');
    if (kind === 'servers') {
      if (wordsMatch(query, row.name + ' ' + description + ' ' + row.url))
        items.push({
          kind: 'server',
          connection_id: row.id,
          name: row.name,
          description,
          url: row.url,
          mode: row.mode,
          capabilities,
          metadata_ready: !!capabilities,
          tool_count: capabilities ? tools.length : null,
          resource_count: capabilities ? resources.length : null,
          resource_template_count: capabilities ? templates.length : null,
        });
      continue;
    }
    if (kind === 'all' || kind === 'tools')
      for (const tool of tools) {
        if (wordsMatch(query, row.name + ' ' + tool.name + ' ' + (tool.description || '')))
          items.push({
            kind: 'tool',
            connection_id: row.id,
            server: row.name,
            name: tool.name,
            description: String(tool.description || '').slice(0, 3000),
            inputSchema: tool.inputSchema,
            call_with: 'call_mcp_tool',
          });
      }
    if (kind === 'all' || kind === 'resources') {
      for (const resource of resources)
        if (
          wordsMatch(
            query,
            row.name +
              ' ' +
              resource.name +
              ' ' +
              (resource.title || '') +
              ' ' +
              (resource.description || '') +
              ' ' +
              resource.uri,
          )
        )
          items.push({
            kind: 'resource',
            connection_id: row.id,
            server: row.name,
            ...resource,
            read_with: 'read_mcp_resource',
          });
      for (const resource of templates)
        if (
          wordsMatch(
            query,
            row.name +
              ' ' +
              resource.name +
              ' ' +
              (resource.title || '') +
              ' ' +
              (resource.description || '') +
              ' ' +
              resource.uriTemplate,
          )
        )
          items.push({
            kind: 'resource_template',
            connection_id: row.id,
            server: row.name,
            ...resource,
            read_with: 'read_mcp_resource',
          });
    }
  }
  const limit = args.limit === undefined ? 10 : Number(args.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new Error('mcp_invalid_browse');
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ userId, id, query, kind, items }))
    .digest('hex')
    .slice(0, 24);
  let offset = 0;
  if (args.cursor) {
    try {
      if (args.cursor.length > 2000) throw new Error();
      const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString());
      if (cursor.fingerprint !== fingerprint) throw new Error('mcp_cursor_stale');
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > items.length)
        throw new Error();
      offset = cursor.offset;
    } catch (error: any) {
      throw new Error(
        error?.message === 'mcp_cursor_stale' ? 'mcp_cursor_stale' : 'mcp_invalid_cursor',
      );
    }
  }
  const page: any[] = [];
  let bytes = 0;
  for (const item of items.slice(offset, offset + limit)) {
    const size = JSON.stringify(item).length;
    if (bytes + size > 100_000) break;
    page.push(item);
    bytes += size;
  }
  if (!page.length && offset < items.length) throw new Error('mcp_catalog_item_too_large');
  const next = offset + page.length;
  return wrapUntrustedContent(
    JSON.stringify({
      items: page,
      total: items.length,
      next_cursor:
        next < items.length
          ? Buffer.from(JSON.stringify({ offset: next, fingerprint })).toString('base64url')
          : null,
      needs_refresh:
        kind === 'servers'
          ? []
          : rows
              .filter((row) => !row.capabilities_json)
              .map((row) => ({ connection_id: row.id, name: row.name })),
    }),
  );
}
export async function prepareMcpResource(userId: number, args: any, signal?: AbortSignal) {
  const id = Number(args.connection_id),
    uri = args.uri;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('mcp_invalid_id');
  if (typeof uri !== 'string' || uri.length > 4096 || /[\u0000-\u001f]/.test(uri))
    throw new Error('mcp_invalid_resource_uri');
  const offset = args.offset === undefined ? 0 : Number(args.offset),
    limit = args.max_chars === undefined ? 24000 : Number(args.max_chars);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 48000
  )
    throw new Error('mcp_invalid_resource_range');
  let row = requireConnection(userId, id);
  if (!row.capabilities_json) {
    await refreshTools(userId, id, signal);
    row = requireConnection(userId, id);
  }
  const { resources, templates } = connectionResources(row);
  // URIs are opaque MCP identifiers. Never fetch an HTTP URI or open a file on Chatter's host.
  const allowed =
    resources.some((item) => item.uri === uri) ||
    templates.some((item) => {
      try {
        return new UriTemplate(item.uriTemplate!).match(uri) !== null;
      } catch {
        return false;
      }
    });
  if (!allowed) throw new Error('mcp_resource_not_allowed');
  return { row, uri, offset, limit, definition: { uri, resources, templates } };
}
export async function readMcpResource(
  userId: number,
  args: any,
  signal?: AbortSignal,
  onProgress?: () => void,
  imageSink?: { items: Array<{ base64: string; mimeType: string; question: string }> },
) {
  const { row, uri, offset, limit } = await prepareMcpResource(userId, args, signal);
  const id = row.id;
  const response = await readRemoteResource(userId, id, uri, signal, onProgress);
  requireConnection(userId, id);
  const parts = (response.contents || []) as any[];
  const contents: any[] = [];
  let skip = offset,
    remaining = limit,
    total = 0,
    consumed = 0,
    binaryCount = 0,
    truncated = false;
  for (const part of parts) {
    if (typeof part.text === 'string') {
      const text = part.text;
      total += text.length;
      if (skip >= text.length) {
        skip -= text.length;
        continue;
      }
      if (contents.length >= 100) {
        truncated = true;
        continue;
      }
      const clipped = text.slice(skip, skip + remaining);
      skip = 0;
      remaining -= clipped.length;
      consumed += clipped.length;
      if (clipped) contents.push({ uri: part.uri, mimeType: part.mimeType, text: clipped });
    } else if (offset === 0 && binaryCount < 4) {
      binaryCount++;
      contents.push({ uri: part.uri, mimeType: part.mimeType, binary: true });
      if (
        imageSink &&
        /^image\/(png|jpeg|webp|gif)$/.test(part.mimeType || '') &&
        typeof part.blob === 'string' &&
        imageSink.items.length < 4
      ) {
        imageSink.items.push({
          base64: part.blob,
          mimeType: part.mimeType,
          question: 'MCP resource: ' + uri,
        });
      }
    }
  }
  if (JSON.stringify(contents).length > 150_000) throw new Error('mcp_resource_response_too_large');
  return JSON.stringify({
    status: 'success',
    result: wrapUntrustedContent(
      JSON.stringify({
        uri,
        contents: contents.slice(0, 100),
        offset,
        text_length: total,
        next_offset: offset + consumed < total ? offset + consumed : null,
        truncated,
      }),
    ),
  });
}
