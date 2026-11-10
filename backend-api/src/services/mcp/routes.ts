import express from 'express';
import { syncLocalConnections } from './local.js';
import type { WsClient } from '../../ws-clients.js';
export function syncDesktopMcp(client: WsClient, input: unknown) {
  const count = syncLocalConnections(client, input);
  cancelForbiddenCalls();
  return count;
}
type RequestHandler = (req: any, res: any) => any;
const Router = express.Router;
import {
  allServers,
  adminServers,
  connections,
  publicConnection,
  policy,
  savePolicy,
  accessSettings,
  saveAccessSettings,
  saveServer,
  deleteServer,
  saveConnection,
  deleteConnection,
} from './store.js';
import {
  refreshTools,
  beginOAuth,
  finishOAuth,
  cancelCall,
  cancelForbiddenCalls,
} from './client.js';
import { notifyMcpSettingsUpdated } from '../../ws-clients.js';
import { registryCatalog } from './catalog.js';

const route =
  (action: (req: any, res: any) => any): RequestHandler =>
  async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await action(req, res);
    } catch (error: any) {
      const code = String(error?.message || '');
      const safe = /^mcp_[a-z_]+$/.test(code) ? code : 'mcp_request_failed';
      const status = /not_allowed|disabled|catalog_hidden/.test(safe)
        ? 403
        : /not_found/.test(safe)
          ? 404
          : /busy|already_exists/.test(safe)
            ? 409
            : 400;
      res.status(status).json({ error: safe });
    }
  };
const id = (value: any) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('mcp_invalid_id');
  return n;
};
export const oauthCallback: RequestHandler = route(async (req, res) => {
  await finishOAuth(
    String(req.query.state || ''),
    String(req.query.code || ''),
    String(req.query.error || ''),
  );
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res
    .type('html')
    .send(
      '<!doctype html><meta charset="utf-8"><title>Chatter MCP</title><p>MCP connected. You can close this tab and return to Chatter.</p>',
    );
});
export function userMcpRouter(account: (req: any) => number) {
  const router = Router();
  router.get(
    '/',
    route((req, res) => {
      const userId = account(req);
      res.json({
        policy: policy(userId),
        servers:
          policy(userId).enabled && policy(userId).show_catalog
            ? allServers().filter((server) => server.allowed)
            : [],
        connections: connections(userId).map(publicConnection),
      });
    }),
  );
  router.get(
    '/catalog',
    route(async (req, res) => {
      const userId = account(req);
      const allowed = () => {
        const access = policy(userId);
        if (!access.enabled) throw new Error('mcp_disabled');
        if (!access.show_catalog) throw new Error('mcp_catalog_hidden');
        return access;
      };
      const access = allowed();
      const search = String(req.query.search || '').trim();
      if (search.length > 120) throw new Error('mcp_invalid_catalog_query');
      if (access.allow_custom) {
        const result = await registryCatalog(search, String(req.query.cursor || ''));
        if (allowed().allow_custom) {
          res.json(result);
          return;
        }
      }
      const words = search.toLowerCase().split(/\s+/).filter(Boolean);
      const items = allServers().filter(
        (server) =>
          server.allowed &&
          words.every((word) =>
            (server.name + ' ' + server.description + ' ' + server.url)
              .toLowerCase()
              .includes(word),
          ),
      );
      res.json({ items, next_cursor: null });
    }),
  );
  router.post(
    '/connections',
    route((req, res) => {
      const userId = account(req),
        connection = saveConnection(userId, req.body);
      notifyMcpSettingsUpdated(userId);
      res.status(201).json({ connection });
    }),
  );
  router.patch(
    '/connections/:id',
    route((req, res) => {
      const userId = account(req),
        connectionId = id(req.params.id);
      const connection = saveConnection(userId, req.body, connectionId);
      cancelCall(userId, connectionId);
      notifyMcpSettingsUpdated(userId);
      res.json({ connection });
    }),
  );
  router.delete(
    '/connections/:id',
    route((req, res) => {
      const userId = account(req),
        connectionId = id(req.params.id);
      cancelCall(userId, connectionId);
      deleteConnection(userId, connectionId);
      notifyMcpSettingsUpdated(userId);
      res.json({ ok: true });
    }),
  );
  router.post(
    '/connections/:id/refresh',
    route(async (req, res) => {
      const userId = account(req),
        connectionId = id(req.params.id);
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.on('close', abort);
      try {
        res.json({ tools: await refreshTools(userId, connectionId, controller.signal) });
      } finally {
        res.off('close', abort);
      }
    }),
  );
  router.post(
    '/connections/:id/oauth',
    route(async (req, res) =>
      res.json(await beginOAuth(account(req), id(req.params.id), req.body?.callback_url)),
    ),
  );
  router.post(
    '/connections/:id/cancel',
    route((req, res) => res.json(cancelCall(account(req), id(req.params.id)))),
  );
  return router;
}
export function adminMcpRouter() {
  const router = Router();
  router.get(
    '/',
    route((_req, res) => res.json({ policy: policy(), servers: adminServers() })),
  );
  router.get(
    '/access',
    route((_req, res) => res.json({ access: accessSettings() })),
  );
  router.put(
    '/access',
    route((req, res) => {
      const access = saveAccessSettings(req.body);
      cancelForbiddenCalls();
      notifyMcpSettingsUpdated(undefined, true);
      res.json({ access });
    }),
  );
  router.put(
    '/policy',
    route((req, res) => {
      const value = savePolicy(req.body);
      cancelForbiddenCalls();
      notifyMcpSettingsUpdated(undefined, true);
      res.json({ policy: value });
    }),
  );
  router.post(
    '/servers',
    route((req, res) => {
      const server = saveServer(req.body);
      notifyMcpSettingsUpdated(undefined, true);
      res.status(201).json({ server });
    }),
  );
  router.patch(
    '/servers/:id',
    route((req, res) => {
      const server = saveServer(req.body, id(req.params.id));
      cancelForbiddenCalls();
      notifyMcpSettingsUpdated(undefined, true);
      res.json({ server });
    }),
  );
  router.delete(
    '/servers/:id',
    route((req, res) => {
      deleteServer(id(req.params.id));
      cancelForbiddenCalls();
      notifyMcpSettingsUpdated(undefined, true);
      res.json({ ok: true });
    }),
  );
  router.get(
    '/users/:id',
    route((req, res) =>
      res.json({
        policy: policy(id(req.params.id)),
        connections: connections(id(req.params.id)).map(publicConnection),
      }),
    ),
  );
  router.put(
    '/users/:id',
    route((req, res) => {
      const userId = id(req.params.id);
      const value = savePolicy(req.body, userId);
      cancelForbiddenCalls();
      notifyMcpSettingsUpdated(userId, true);
      res.json({ policy: value });
    }),
  );
  router.get(
    '/catalog',
    route(async (req, res) =>
      res.json(
        await registryCatalog(String(req.query.search || ''), String(req.query.cursor || '')),
      ),
    ),
  );
  return router;
}
