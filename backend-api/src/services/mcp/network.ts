import dns from 'node:dns/promises';
import { Agent, fetch as httpFetch } from 'undici';
import ipaddr from 'ipaddr.js';

export function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function mcpUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('mcp_invalid_url');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('mcp_https_required');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    (ipaddr.isValid(host) && !publicAddress(host))
  )
    throw new Error('mcp_private_address');
  return url;
}
export async function resolveMcpAddress(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address)))
    throw new Error('mcp_private_address');
  return addresses;
}
/** DNS is validated and pinned in the actual socket lookup. Redirects never forward secrets. */
export const safeMcpFetch: typeof fetch = async (input, init) => {
  const url = mcpUrl(input instanceof Request ? input.url : String(input));
  const addresses = await resolveMcpAddress(url);
  const agent = new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: {
      timeout: 15_000,
      lookup: (_host, options: any, callback: any) => {
        const matches = addresses.filter(
          (item) => !options.family || item.family === options.family,
        );
        if (!matches.length) return callback(new Error('mcp_dns_family'));
        if (options.all) callback(null, matches);
        else callback(null, matches[0].address, matches[0].family);
      },
    },
  });
  try {
    const response = await httpFetch(url, {
      ...(init as any),
      dispatcher: agent,
      redirect: 'error',
    });
    if (!response.body) {
      void agent.close();
      return new Response(null, { status: response.status, headers: [...response.headers] });
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const close = () => {
      void agent.close();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            controller.close();
            close();
            return;
          }
          bytes += part.value.byteLength;
          if (bytes > 8 * 1024 * 1024) throw new Error('mcp_response_too_large');
          controller.enqueue(part.value);
        } catch (error) {
          controller.error(error);
          await reader.cancel().catch(() => {});
          void agent.destroy();
        }
      },
      async cancel() {
        await reader.cancel().catch(() => {});
        void agent.destroy();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
    });
  } catch (error) {
    void agent.destroy();
    throw error;
  }
};

/** Shared HTTP dependency; tests can substitute a local protocol server without disabling URL policy. */
export const mcpHttp = { fetch: safeMcpFetch };
