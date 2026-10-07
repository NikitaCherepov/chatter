import http from 'node:http';
type Input = { apiBase: string; accessToken: string; serverKey: string; connectionId?: number };
export async function connectChatGptOnDesktop(input: Input, openExternal: (url: string) => Promise<void>) {
  const controller = new AbortController();
  const headers = { Authorization: 'Bearer ' + input.accessToken, 'X-Chatter-Server-Key': input.serverKey, 'Content-Type': 'application/json' };
  const request = async (path: string, body: unknown) => {
    const response = await fetch(input.apiBase + '/api/v1/admin/chatgpt/' + path, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
    });
    const json = await response.json() as any;
    if (!response.ok) throw new Error(typeof json.error === 'string' ? json.error : 'chatgpt_connection_failed');
    return json;
  };
  let expectedState = '';
  let started = false;
  let finish!: (value: any) => void;
  let fail!: (error: Error) => void;
  const result = new Promise<any>((resolve, reject) => { finish = resolve; fail = reject; });
  void result.catch(() => {});
  const listener = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/auth/callback' || !expectedState || url.searchParams.get('state') !== expectedState || started) {
      res.writeHead(400); res.end('Invalid or expired authorization attempt.'); return;
    }
    started = true;
    try {
      const connection = await request('complete', { state: expectedState, code: url.searchParams.get('code'), clientId: url.searchParams.get('client_id'), error: url.searchParams.get('error') || undefined });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('ChatGPT connected to Chatter. You can close this window.');
      finish(connection);
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Authorization failed. Return to Chatter and try again.');
      fail(error instanceof Error ? error : new Error('chatgpt_connection_failed'));
    }
  });
  // Start the loopback listener before requesting the authorization URL.
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => { controller.abort(); fail(new Error('chatgpt_authorization_timeout')); }, 5 * 60_000);
  try {
    const redirectUri = 'http://127.0.0.1:' + (listener.address() as any).port + '/auth/callback';
    const { state, authorizeUrl } = await request('begin', { redirectUri, connectionId: input.connectionId });
    const authorize = new URL(authorizeUrl);
    if (authorize.origin !== 'https://auth.openai.com' || authorize.pathname !== '/api/accounts/authorize' || typeof state !== 'string') throw new Error('chatgpt_invalid_authorization_url');
    expectedState = state;
    await openExternal(authorizeUrl);
    return await result;
  } finally {
    clearTimeout(timer); controller.abort(); listener.closeAllConnections(); listener.close();
    // Consume a timeout/rejection even when opening the browser or starting auth failed.
    result.catch(() => {});
  }
}
