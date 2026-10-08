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

## Server secret rotation

Security → Server secrets provides three password-confirmed operations:
`API_JWT_SECRET`, `BACKEND_INTERNAL_TOKEN`, and `ENCRYPTION_KEY`. Values are
generated server-side and never returned to the browser. Rebuild **backend,
manager and admin-panel** together before testing; old backend images do not
contain the offline migration helper/startup gate and fail preflight.

The manager checks free space, environment overrides, **actual container secrets**
(not merely `compose config`), and read-only decryption of stored credentials before
stopping anything. A mismatch fails without importing or replacing secrets.
It drains new generations
(an active generation causes a refusal), then stops the running backend,
Telegram and Notes services. It creates a database/configuration backup before
changing anything. Only previously running services are recreated, without
pulling images. JWT rotation invalidates user access/refresh tokens, not admin
panel sessions. Internal-token rotation updates both backend.env and telegram.env.

Encryption rotation uses a staged database and one SQLite transaction. It covers
the API vault, mail passwords/OAuth tokens, ChatGPT credentials, smart-home tokens,
DevOps passwords/SSH keys, and map coordinates. IDs and other data are unchanged.
Existing independent DevOps/map keys remain unchanged; shared-key fallback data
is re-encrypted. Corrupt ciphertext aborts the operation. Keys travel to the
offline helper over stdin, never command-line arguments or logs.

A fsynced journal plus `/data/.secret-rotation-maintenance` protect interrupted
operations. Before the durable commit, recovery restores matching old DB/env;
after commit it retries service startup without restoring old data. The backend
Docker startup wrapper waits while the marker exists. Admin mutations/bootstrap
and scheduled backups are blocked while recovery is pending. Recovery is tried
on manager startup and can be retried from the panel with the admin password.

Backups contain **plaintext configuration secrets** and use private permissions.
Keep them private; old database-only backups need their original encryption key.
Protected `.secret-rotation-<id>` recovery snapshots are retained in the config
directory as well. Do not manually change env files, restart services with custom
commands that bypass the startup gate, or delete a recovery marker mid-operation.
A corrupt/missing journal requires operator recovery from a matching DB/config
backup with all data services stopped; the manager does not guess the right key.
Rotating encryption does not revoke leaked provider API keys or OAuth credentials.

For a local checkout running the manager, point host Compose at the same config
directory. For the default `.chatter` directory, put these path overrides in the
root `.env` (preserve its other values):

```dotenv
BACKEND_ENV_FILE=./.chatter/backend.env
TELEGRAM_ENV_FILE=./.chatter/telegram.env
```

Do not copy a newly generated encryption key over an existing database's key.
Align with the key that actually decrypts that database. The installer already
sets corresponding paths in its `compose.env` on standard server deployments.

Tests (synthetic data only):

```sh
node --test backend-api/tests/encryption-rotation.test.cjs chatter-manager/secret-rotation.test.cjs chatter-manager/secret-rotation-api.test.cjs
```

## Sessions

Successful logins create a random session token stored in the `chatter_admin_session`
cookie and mirrored to `sessions.json`, so sessions survive manager restarts. The
session lifetime is 14 days by default and can be overridden with the `SESSION_TTL_MS`
environment variable (milliseconds) in `manager.env`. Each authenticated request
slides the server-side expiry, but the cookie `Max-Age` is fixed at login, so the
browser drops the session at most 14 days after the last login.

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
