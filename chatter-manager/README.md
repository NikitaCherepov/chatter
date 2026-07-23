# Chatter Manager

Small authenticated control API for a self-hosted Chatter installation. The
public UI is the separate Next.js `admin-panel`; this service proxies that UI so
the browser only needs one address.

Manager settings are stored in a private host directory. Docker operations are
restricted to a fixed service list: `backend`, `telegram-bot`, `webapp-notes`,
and `voice`. The main backend never receives access to the Docker socket.

On first start the installer provides the generated password through the
one-use `/config/admin.bootstrap` file. Manager stores only its scrypt hash in
`/config/auth.json` and immediately deletes the bootstrap file. The password is
never placed in the container environment.

The Docker socket gives this service host-level privileges. Keep the manager
small, authenticated and behind TLS. Never add arbitrary shell-command routes.

## Request routing

The manager is the browser's single entry point. It serves two kinds of routes:

1. **Panel assets** — anything that does not start with `/api/` is piped to the
   Next.js admin-panel container at `http://admin-panel:3000`.
2. **API routes** — everything under `/api/` is handled here. The manager
   authenticates the admin via the `chatter_admin_session` cookie, then either:
   - serves the request itself (e.g. `/api/settings`, `/api/services/*`,
     `/api/server-update`); or
   - forwards it to `backend-api` via `backendInternalRequest()`.

`backendInternalRequest()` reads `BACKEND_INTERNAL_TOKEN` from `backend.env`
and calls `backend-api` at `/internal/*` with `Authorization: Bearer <token>`.
Backend routes under `/internal/*` use `internalAuth` middleware (constant-time
token comparison), not the JWT-based `authMiddleware` used by `/api/v1/*`.

### Adding a new admin endpoint

Three coordinated changes are required:

| Layer | File | What to add |
|-------|------|-------------|
| Backend route | `backend-api/src/server.ts` | `app.get('/internal/admin/<name>', internalAuth, ...)` |
| Manager proxy | `chatter-manager/server.js` (in `handleRequest`) | `if (pathname === '/api/<name>') return sendJson(res, 200, await backendInternalRequest('/internal/admin/<name>'));` |
| Frontend call | `admin-panel/components/.../*.tsx` | `api('/api/<name>')` |

If you forget the manager proxy, the browser sees `{ error: 'not_found' }`
(manager's catch-all 404). If you forget the backend route, the manager sees
`backend_http_404` from `backendInternalRequest()`.

### Why not a universal proxy?

The manager intentionally rewrites paths and validates bodies for many routes
(e.g. `/api/users/:id/plan` checks that `plan ∈ {free, standart, pro}` before
forwarding). This keeps backend's `/internal/*` surface trustable: every call
has already been vetted by the manager. A pass-through proxy would lose that
defence. See `admin-panel/README.md` for the same discussion from the UI side.

### OpenRouter model & billing proxy

These routes let the admin panel browse OpenRouter models and configure per-model
pricing. The OpenRouter Models and Endpoints APIs are **public** — they require
no `Authorization` header — so the manager calls them server-side and caches the
JSON for 30 minutes.

| Route | Method | Upstream | Purpose |
|---|---|---|---|
| `/api/openrouter/models?q=` | GET | `openrouter.ai/api/v1/models?q=` | Search models by id/name. Min 2 chars, returns 400 on shorter queries. |
| `/api/openrouter/models/:author/:slug/endpoints` | GET | `openrouter.ai/api/v1/models/:author/:slug/endpoints` | List upstream providers for a model and their per-token pricing. |
| `/api/models/:modelId/billing` | GET, PUT | `/internal/admin/models/:modelId/billing` | Read/write the provider-kind, OpenRouter slug, and $/1M prices stored in `model_overrides`. |

Implementation notes:

- The cache (`openRouterCache`, 30 min TTL) is keyed by `GET:<pathname>` and lives in process memory; it is not shared with other services.
- `/api/models/:modelId/billing` is forwarded to backend-api via `backendInternalRequest()` with the manager's internal bearer token, exactly like other admin routes.
- `:modelId` in the billing route is URL-decoded before forwarding, because ids can contain `:` and other characters that need percent-encoding.



