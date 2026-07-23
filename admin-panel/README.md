# Chatter Admin Panel

Next.js control panel for a self-hosted Chatter server. The panel is intentionally a UI-only service: it never receives the Docker socket, reads host files, or executes system commands directly. All privileged operations go through the authenticated [`chatter-manager`](../chatter-manager/README.md).

## Architecture

```text
Browser -> Caddy (HTTPS) -> chatter-manager -> admin-panel
                                  |-> private config files
                                  |-> Docker Compose
                                  `-> backend internal API
```

- Caddy exposes the installation on `https://SERVER_IP` and manages the IP certificate.
- `chatter-manager` authenticates the administrator, proxies the panel, validates mutations, and performs a fixed set of management operations.
- `admin-panel` calls same-origin `/api/*` routes. It does not need to know the manager's internal address.
- `backend-api` does not receive the Docker socket.

### How API calls reach backend-api

**The admin panel never talks to `backend-api` directly.** Every `/api/*` request from the browser first hits `chatter-manager`, which:

1. Authenticates the admin via the `chatter_admin_session` cookie.
2. Either handles the request itself (e.g. `/api/settings`, `/api/services/*`), or forwards it to `backend-api` using an internal bearer token stored in `backend.env` (`BACKEND_INTERNAL_TOKEN`).
3. The forwarded calls go to `backend-api`'s `/internal/*` routes — these are protected by `internalAuth` middleware (simple bearer token), **not** by JWT `adminMiddleware`.

This means each new admin endpoint requires three coordinated pieces:

| Layer | File | What to add |
|-------|------|-------------|
| Backend route | `backend-api/src/server.ts` | `app.get('/internal/admin/<name>', internalAuth, ...)` |
| Manager proxy | `chatter-manager/server.js` | `if (pathname === '/api/<name>') return sendJson(res, 200, await backendInternalRequest('/internal/admin/<name>'));` |
| Frontend call | `admin-panel/components/.../*.tsx` | `api('/api/<name>')` |

**Forget any one of the three and the browser will see `{ error: 'not_found' }`** (from chatter-manager's catch-all 404) or `{ error: 'unauthorized' }` (from backend's `internalAuth`).

Path conventions in current code:
- Frontend → Manager: `/api/<resource>` (no version prefix), e.g. `/api/users/123`, `/api/plan-limits`.
- Manager → Backend: `/internal/admin/<resource>` for admin-only operations, `/internal/<resource>` for general operations.
- Direct backend routes under `/api/v1/*` (JWT-protected) are **not reachable from the browser** through chatter-manager. They exist for first-party clients (Desktop, Telegram bot) that authenticate with their own JWTs.

## Model Billing & Provider Routing

The Models page lets each model card carry an API-provider type, an optional concrete OpenRouter upstream, and per-million token prices. All of this lives inside the existing `ModelListEditor` / `ManualModelListEditor` cards — there is **no** separate billing tab or settings section.

### Card fields

- **API provider** — `OpenRouter` | `DeepSeek` | `Xiaomi` | `Custom`. Selecting one pins the URL (read-only for known providers; editable for `Custom`).
- **Model** — for OpenRouter, an autocomplete that searches `/api/openrouter/models?q=` (debounced 400 ms, min 2 chars). For DeepSeek/Xiaomi, a preset dropdown with an **Other…** option that reveals a free-text input. For `Custom`, a plain text input.
- **OpenRouter provider** — shown only when the API provider is `openrouter`. `Auto` lets OpenRouter pick the endpoint; picking a concrete upstream pins it via `provider.only` + `allow_fallbacks: false` at runtime.
- **Input / Output / Cached $/1M** — for OpenRouter, auto-filled from the model's `/endpoints` response with a **Refresh prices** button. For other providers, manual entry. Source is labelled (`openrouter_auto`, `openrouter_endpoint`, `preset`, `manual`).

### Shared override hook

[`lib/useModelCoefficients.ts`](./lib/useModelCoefficients.ts) loads both `coefficients` and `overrides` maps from `/api/model-coefficients`. The override map is keyed by the stable `uniqueId`, so renaming a model or changing its URL does **not** break cost accounting. New helpers: `getOverride(uniqueId)`, `saveOverride(uniqueId, patch)`.

### New UI components

- [`components/ui/ModelInput/OpenRouterModelInput.tsx`](./components/ui/ModelInput/OpenRouterModelInput.tsx) — searchable OpenRouter model picker backed by the manager proxy.
- [`components/ui/ModelInput/PresetModelInput.tsx`](./components/ui/ModelInput/PresetModelInput.tsx) — preset dropdown + custom mode for DeepSeek/Xiaomi. The custom toggle is local React state, so clicking **Other…** reliably reveals the free-text input.
- [`components/ui/Select/Select.tsx`](./components/ui/Select/Select.tsx) — extended with `onSearchChange` (parent-owned filtering) and `valueFallbackLabel` (display a value not present in `options`).

### Manager proxy endpoints

In [`chatter-manager/server.js`](../chatter-manager/server.js):

- `GET /api/openrouter/models?q=` — public OpenRouter Models API, cached 30 min, min 2 chars. **No API key is sent to the browser.**
- `GET /api/openrouter/models/:author/:slug/endpoints` — upstream providers + per-endpoint pricing.
- `GET/PUT /api/models/:modelId/billing` — forwards to `/internal/admin/models/:modelId/billing`.



## Implemented Pages

- **Overview** — service health and start, stop, or restart controls.
- **Users** — filtering, connection status, usage totals, account details, roles, approval/ban state, and plan duration.
- **Access keys** — create and revoke server access keys used by Desktop clients.
- **Models** — ordered PRO and LITE fallback chains, one Vision model, and manually selectable models.
- **Integrations** — Pinecone/embeddings, web search, web reader, cloud TTS, and OpenRouter image generation.
- **Services** — independent Telegram, Notes, and Voice configuration. Remote Voice is displayed but is not enabled yet.
- **System** — host metrics, database/upload sizes, manual and scheduled backups, import/download/restore/delete, and server Docker-image updates.
- **Logs** — selectable live Docker logs.
- **Security** — administrator credentials.

## Internationalization (i18n)

All UI text lives in translation dictionaries; no hardcoded strings appear in components. The supported language list lives in a single file — [`i18n/languages.ts`](./i18n/languages.ts) — picked up automatically by the language selector, i18next config, and the translation script.

### How it works

- **Runtime:** [`i18next`](https://www.i18next.com/) with [`react-i18next`](https://react.i18next.com/) hooks (`useTranslation`) in every component.
- **Auto-detection:** `i18next-browser-languagedetector` picks the language from `navigator.language`. Falls back to Russian when the detected language is not in the supported list.
- **Bundling:** All locale catalogs are imported at build time in [`i18n/index.ts`](./i18n/index.ts). Empty `{}` catalogs for untranslated languages simply fall through to the fallback.

```
admin-panel/i18n/
  languages.ts              # Single source of truth: SUPPORTED_LANGUAGES + labels
  index.ts                  # i18next init + dynamic locale imports
  locales/
    ru/translation.json     # Source dictionary (Russian)
    en/translation.json     # English
    de/translation.json     # …remaining locales filled by script
    …
```

### Adding a new translation key

1. Add the key to `locales/ru/translation.json` (source).
2. Add the English value to `locales/en/translation.json`.
3. Use `const { t } = useTranslation()` in the component and reference the key: `t('namespace.key')`.

Key format: nested JSON objects, dot-separated in code (`overview.quickSetup.title`). Interpolation uses `{{variable}}` placeholders.

### Translating to other languages

The shared translation script at [`scripts/translate-i18n.mjs`](../scripts/translate-i18n.mjs) sends missing strings to an LLM API for translation:

```bash
# Single locale (ru → en by default)
npm run i18n:translate:admin

# All locales (en → every other language)
npm run i18n:translate:admin:all

# Dry-run (print missing keys without API calls)
npm run i18n:translate:admin -- --dry-run

# Everything (bot + desktop + api + notes + admin)
npm run i18n:translate:all
```

The script requires an `.env.i18n` file with `I18N_TRANSLATE_API_KEY` (OpenAI or compatible endpoint). It preserves `{{placeholders}}`, URLs, and product names. Existing translations are never overwritten — only missing keys are translated.

### Adding a new language

1. Add the language code and native label to [`i18n/languages.ts`](./i18n/languages.ts) — this is the only place to register a language.
2. Run `npm run i18n:translate:admin -- --to <code>` — the script creates `admin-panel/i18n/locales/<code>/translation.json` and fills the catalog.

## Configuration and Secrets

The browser never receives saved secret values. API responses return empty secret fields plus flags such as `hasApiKey`; leaving a secret input empty preserves the existing value.

The installer stores private state outside the repository, under `/var/lib/chatter` by default:

```text
/var/lib/chatter/
  auth.json          # scrypt password hash
  backend.env        # model and integration secrets
  telegram.env       # Telegram configuration
  voice.env          # Voice configuration
  manager.env        # manager runtime settings
  compose.env        # Compose paths/image settings
  tls.crt / tls.key
  backups/
```

These files must not be committed. The initial administrator password is generated by `install.sh`, consumed once by the manager, hashed into `auth.json`, and removed from the bootstrap file.

## Installation

The supported deployment path is the root [`install.sh`](../install.sh). It installs Docker when necessary, configures UFW for the active SSH port plus ports 80/443, downloads prebuilt GHCR images, creates private configuration, and starts Backend, Manager, Admin Panel, and Caddy.

From a repository checkout:

```bash
sudo bash install.sh
```

After installation, open `https://SERVER_IP`. Provider-level firewalls must also allow TCP 80 and 443.

Do not run `npm install` or build Next.js on the target server for a normal installation. GitHub Actions builds the production images; the server pulls them.

## Local Development

The panel can be built independently:

```bash
cd admin-panel
npm install
npm run typecheck
npm run build
```

`npm run dev` starts only the UI on port 3000. Management calls will not work unless they are served through `chatter-manager`. For an integrated local environment, prepare the Compose env files and run:

```bash
docker compose --profile admin up -d --build backend admin-panel chatter-manager
```

## Applying Settings

`PUT /api/settings` updates the private env files and reconciles the selected Compose profiles. Telegram and Notes are independent services. Existing secret values are retained when their form fields are left empty.

Service operations are restricted to known Compose services. Never add an arbitrary command-execution endpoint to Manager: access to `/var/run/docker.sock` is effectively host-level access.

## Backups

Backups are `.tar.gz` archives. The database is always included; uploaded media is optional because it may be large. The panel supports:

- immediate backup creation;
- automatic schedules managed by Manager (no host cron required);
- retention count;
- upload/import of an existing archive;
- download, restore, and delete.

Restoring data is destructive and should require an explicit UI confirmation.

## Server Updates

The System page compares the digests of the currently running server images with the latest GHCR images. Checking downloads image metadata/layers but does not restart services. Applying an update pulls changed images and recreates only affected server containers. Release notes come from the localized `server-changelog.json` image label.

## Useful Diagnostics

On an installed server:

```bash
sudo docker compose -p chatter --env-file /var/lib/chatter/compose.env --profile admin ps -a
sudo docker compose -p chatter --env-file /var/lib/chatter/compose.env --profile admin logs -f --tail=200 chatter-manager admin-panel backend
```

Manager health endpoint:

```bash
curl -k https://SERVER_IP/health
```

## Relevant Files

- [`app/page.tsx`](./app/page.tsx) — session bootstrap and top-level page routing.
- [`components/`](./components) — pages and reusable UI components.
- [`lib/api.ts`](./lib/api.ts) — same-origin JSON client.
- [`lib/types.ts`](./lib/types.ts) — settings and service contracts.
- [`../chatter-manager/server.js`](../chatter-manager/server.js) — authenticated management API.
- [`../docker-compose.yml`](../docker-compose.yml) — service topology and profiles.
- [`../install.sh`](../install.sh) — server bootstrap.
