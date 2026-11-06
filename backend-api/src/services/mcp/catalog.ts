import { mcpHttp, mcpUrl } from './network.js';
const cache = new Map<string, { expires: number; value: any }>();
function link(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
export async function registryCatalog(search = '', cursor = '') {
  search = search.trim();
  if (search.length > 120 || (search.length > 0 && search.length < 3) || cursor.length > 1000)
    throw new Error('mcp_invalid_catalog_query');
  const key = JSON.stringify([search, cursor]),
    hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers');
  url.searchParams.set('limit', '30');
  url.searchParams.set('version', 'latest');
  if (search) url.searchParams.set('search', search);
  if (cursor) url.searchParams.set('cursor', cursor);
  const response = await mcpHttp.fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('mcp_registry_unavailable');
  const data = (await response.json()) as any;
  const items: any[] = [];
  const seen = new Set<string>();
  for (const entry of data.servers || []) {
    const server = entry.server || entry,
      official = entry._meta?.['io.modelcontextprotocol.registry/official'] || {};
    if (official.isLatest === false || (official.status && official.status !== 'active')) continue;
    const name = String(server.name || '').slice(0, 160),
      version = String(server.version || '').slice(0, 100);
    if (!name) continue;
    for (const pkg of server.packages || []) {
      if (
        !['npm', 'pypi'].includes(pkg.registryType) ||
        pkg.transport?.type !== 'stdio' ||
        typeof pkg.identifier !== 'string' ||
        JSON.stringify(pkg).length > 64000
      )
        continue;
      const key = name + '\n' + pkg.identifier + '\n' + String(pkg.version || '');
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        name,
        title: String(server.title || name).slice(0, 160),
        description: String(server.description || '').slice(0, 1500),
        url: '',
        transport: 'stdio',
        version: String(pkg.version || version),
        publisher: name.split('/')[0],
        package: pkg,
        repository_url: link(server.repository?.url),
        website_url: link(server.websiteUrl),
        registry_url:
          'https://registry.modelcontextprotocol.io/v0.1/servers/' +
          encodeURIComponent(name) +
          '/versions/' +
          encodeURIComponent(version || 'latest'),
      });
    }
    for (const remote of server.remotes || []) {
      if (remote.type !== 'streamable-http') continue;
      try {
        const endpoint = mcpUrl(remote.url).href,
          key = name + '\n' + endpoint;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          name,
          title: String(server.title || server.name || '').slice(0, 160),
          description: String(server.description || '').slice(0, 1500),
          url: endpoint,
          version,
          publisher: name.split('/')[0],
          transport: 'streamable-http',
          repository_url: link(server.repository?.url),
          website_url: link(server.websiteUrl),
          registry_url:
            'https://registry.modelcontextprotocol.io/v0.1/servers/' +
            encodeURIComponent(name) +
            '/versions/' +
            encodeURIComponent(version || 'latest'),
          published_at: typeof official.publishedAt === 'string' ? official.publishedAt : undefined,
          updated_at: typeof official.updatedAt === 'string' ? official.updatedAt : undefined,
        });
      } catch {
        /* unsupported or private endpoint */
      }
    }
  }
  const value = {
    items,
    next_cursor: typeof data.metadata?.nextCursor === 'string' ? data.metadata.nextCursor : null,
  };
  if (cache.size >= 50) cache.delete(cache.keys().next().value!);
  cache.set(key, { value, expires: Date.now() + 600_000 });
  return value;
}
