import { mcpHttp, mcpUrl } from './network.js';
const cache = new Map<string, { expires: number; value: any }>();
export async function registryCatalog(search = '', cursor = '') {
  if (search.length > 120 || cursor.length > 1000) throw new Error('mcp_invalid_catalog_query');
  const key = JSON.stringify([search, cursor]),
    hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
  url.searchParams.set('limit', '30');
  if (search) url.searchParams.set('search', search);
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await mcpHttp.fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('mcp_registry_unavailable');
  const data = (await response.json()) as any;
  const items = (data.servers || []).flatMap((entry: any) => {
    const server = entry.server || entry;
    return (server.remotes || [])
      .filter((remote: any) => remote.type === 'streamable-http')
      .flatMap((remote: any) => {
        try {
          const url = mcpUrl(remote.url).href;
          return [
            {
              name: String(server.name || '').slice(0, 160),
              description: String(server.description || '').slice(0, 1500),
              url,
              version: String(server.version || ''),
            },
          ];
        } catch {
          return [];
        }
      });
  });
  const value = { items, next_cursor: data.metadata?.nextCursor || null };
  if (cache.size >= 50) cache.delete(cache.keys().next().value!);
  cache.set(key, { value, expires: Date.now() + 600_000 });
  return value;
}
