# chatter backend-api

[English](README.md) | [Русский](README_RU.md)

Backend for web/bot clients with JWT API (`/api/v1/*`) and internal API (`/internal/*`).

## Quick Start

```bash
npm run dev:api
```

```bash
npm run build:api
```

```bash
npm run start:api
npm run logs:api
```

## Model Billing & Provider Routing

Each model now carries an API-provider type (`openrouter` | `deepseek` | `xiaomi` | `custom`), an optional concrete OpenRouter upstream, and per-million token prices. This is layered on top of the existing coefficient system — coefficients and weekly quotas are **not** changed.

### Schema

`model_overrides` (extended):
- `provider_kind`, `openrouter_provider_slug`, `pricing_mode` (`auto` | `manual`)
- `input_price_per_million`, `output_price_per_million`, `cache_read_price_per_million`
- `pricing_source`, `pricing_updated_at`

`user_token_usage` (extended, immutable snapshot per request):
- `upstream_provider_slug`, `input_price_per_million`, `output_price_per_million`, `cache_read_price_per_million`
- `estimated_cost_usd`, `actual_cost_usd`, `pricing_source`

Migrations are idempotent (`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`), so old databases upgrade in place and the existing `coefficient` column keeps its meaning.

### Cost snapshot

Pricing is snapshotted at charge time from `model_overrides`, so changing a model's price later does **not** reprice historical rows. Estimated cost formula (see `services/token-quota.ts` → `calculateEstimatedCostUsd`):

```
uncachedInputCost = cacheMissTokens * inputPricePerMillion        / 1_000_000
cachedInputCost   = cacheHitTokens  * cacheReadPricePerMillion    / 1_000_000
outputCost        = completionTokens * outputPricePerMillion      / 1_000_000
estimatedCost     = uncachedInputCost + cachedInputCost + outputCost
```

- `reasoning_tokens` are **not** added on top — they are already part of `completion_tokens`.
- If `cache_read_price` is unknown, falls back to `input_price` and the row is flagged `estimated`.
- `coefficient = 0` keeps zeroing weekly quota, but cost is still recorded.
- If OpenRouter returns `usage.cost`, it is stored in `actual_cost_usd` alongside the estimate.

### Usage accuracy

Main-agent calls are grouped by `(uniqueId || model) + provider` (same as subagents) before charging, so each distinct model in a fallback chain gets its own `user_token_usage` row with its own coefficient and price snapshot. Subagents remain a separate collection with `route = 'subagent:<name>'`.

### Runtime routing

In `services/ai.ts` → `adaptRequestBodyForProvider`, the OpenRouter upstream is pinned only when a concrete slug is configured:

```ts
if (openRouterProviderSlug) {
  body.provider = { only: [openRouterProviderSlug], allow_fallbacks: false };
}
```

For Auto, `provider` is omitted entirely and OpenRouter chooses the endpoint itself. The model fallback loop in `createCompletionWithModelFallback` iterates by index (not `indexOf`), so duplicate models in the chain no longer pull the wrong override.

### Internal endpoints

- `GET /internal/admin/model-coefficients` — returns `{ coefficients, overrides }`.
- `PUT /internal/admin/model-coefficients/:modelId` — backward-compatible: coefficient-only, or full provider/pricing update.
- `GET/PUT /internal/admin/models/:modelId/billing` — read/write the provider + pricing override.

## Backend Localization

Tool status messages and automatic chat titles are translated once in `backend-api` and sent to Desktop and Telegram as ready-to-display text. Clients do not translate tool status keys themselves.

The supported language list lives in a single file — [`src/i18n/languages.ts`](./src/i18n/languages.ts) — picked up automatically by i18next, the `/languages` API endpoint, and the translation script. Per-language strings (including the default chat title `chat.defaultTitle`) live in the JSON catalogs, not in code.

Translation resources live in `src/i18n/locales/<locale>/translation.json`. English is the source locale and the fallback for missing translations.

Ordinary main-agent tool statuses use the tool's system name automatically:

```text
search_web -> toolStatus.search_web
read_file  -> toolStatus.read_file
```

Subagent tool statuses follow the same convention in their own namespace:

```text
convert_video -> subagents.toolStatus.convert_video
```

Messages that require runtime values, such as a dice notation, subagent name, task, or desktop action, are handled explicitly in `services/ai.ts`. Subagent tool statuses fall back to `subagents.toolStatus.runningTool` when a specific key is missing.

When adding an ordinary tool, add its English key to the backend catalog; no mapping in `services/ai.ts` or client-side localization is required. To update other locale catalogs, run from the repository root:

```bash
npm run i18n:translate:api
npm run i18n:translate:api:all
```

### Adding a new language

1. Add the language code to `SUPPORTED_LANGUAGES` in [`src/i18n/languages.ts`](./src/i18n/languages.ts) — this registers it everywhere (i18next, `/languages` endpoint, translation script).
2. Run `npm run i18n:translate:api -- --to <code>` — the script creates `src/i18n/locales/<code>/translation.json` and fills it (including `chat.defaultTitle`).

## ENV (minimum)

- `TELEGRAM_TOKEN` — required for Telegram auth verification.
- `BACKEND_INTERNAL_TOKEN` — required for all `/internal/*`.
- `BACKEND_API_PORT` — defaults to `3050`.
- `API_JWT_SECRET` — mandatory separate secret for signing access/refresh JWTs.
- `API_DB_PATH` or `NOTES_DB_PATH` — optional. Defaults to `chatter.db` in the project root.
- `TIMEWEB_*` and other AI keys — for AI/voice/photo.
- `ENCRYPTION_KEY` — for mail (password encryption).
- `MAP_PINS_ENCRYPTION_KEY` — for encrypting map pin coordinates (falls back to `ENCRYPTION_KEY`).
- `DEVOPS_ENCRYPTION_KEY` — for encrypting SSH server credentials (passwords, keys, sudo password). Falls back to `ENCRYPTION_KEY`.
- `BROWSERLESS_TOKEN` (+ `BROWSERLESS_BASE_URL` optionally) — for `/internal/tools/read_url`.
- `OPENROUTER_API_KEY` — OpenRouter key for image generation.
- `OPENROUTER_BASE_URL` — OpenRouter base URL (default `https://openrouter.ai/api/v1`).
- `IMAGE_GEN_MODEL` — generation model (default `x-ai/grok-imagine-image-quality`).
- `IMAGE_GEN_MAX_RESOLUTION` — maximum requested Grok resolution: `1K` or `2K` (default `2K`).
- `CARTESIA_API_KEY` — Cartesia.ai API key (required for cloud TTS, format `sk_car_...`).
- `CARTESIA_MODEL_ID` — Cartesia TTS model (default `sonic-3.5`).

### Image Generation

Generation lives in `services/image-generation.ts` and uses OpenRouter with Grok Imagine:

```text
POST {OPENROUTER_BASE_URL}/images
Authorization: Bearer {OPENROUTER_API_KEY}

{ "model": "...", "prompt": "...", "resolution": "2K", "input_references": [...] }
→ response.data[0].b64_json
```

### TTS Cartesia (cloud voiceover)

Cloud voiceover via Cartesia.ai. The API key lives only on the server — clients never see it.

**Endpoints:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/tts/voices` | GET | List of voices (en, ru, de, fr) for the selector |
| `/api/v1/tts/generate` | POST | Generate audio + bind to a message |
| `/api/v1/tts/preview` | GET | Voice preview (cached in `tts_voice_previews`) |
| `/api/v1/audio/:filename` | GET | Serve audio file (owner-only) |

**Key files:**
- `services/tts-cartesia.ts` — proxy to Cartesia API (generation + voice list)
- `services/audio-storage.ts` — saves MP3 to `uploads/audio/`
- `tts_voice_previews` (table) — cache of preview phrases by `voice_id`

**Data flow on message voiceover:**
```text
POST /tts/generate { text, voice_id, message_id }
  → Cartesia API: POST /tts/bytes (MP3)
  → saveTtsAudio() → uploads/audio/abc123.mp3
  → updateChatMessageAudio() → chat_messages.audio = { url, tts_type, voice_id }
  → replay → GET /api/v1/audio/abc123.mp3 (without re-generating)
```

### AI Providers (main)

- `TIMEWEB_BASE_URL` + `TIMEWEB_API_KEY` — PRO provider (default).
- `TIMEWEB_MODEL` — comma-separated PRO model chain (fallback).
- `TIMEWEB_LITE_BASE_URL` + `TIMEWEB_LITE_API_KEY` — LITE provider.
- `TIMEWEB_LITE_MODEL` — LITE model chain.
- `TIMEWEB_LITE_ROUTER_ENABLED` — `0` to skip the LITE router and send all text requests directly to PRO (enabled by default).
- `TIMEWEB_PRO_ENDPOINTS` — additional PRO endpoints (format: `base_url|api_key|models;...`).
- `TIMEWEB_LITE_ENDPOINTS` — additional LITE endpoints (same format).

### Manual Model Selection (optional)

Allows the user to choose a specific model instead of auto-routing. Independent of PRO/LITE providers.

- `MODELS_MANUAL` — list of models for manual selection. Format: `base_url|api_key|api_model_name|display_name|description|unique_id|supports_vision|admin_only;...`
  - Example: `https://api.timeweb.com|sk-xxx|gpt-4o|GPT-4o (Timeweb)|Reliable and fast|tw-gpt4o|1;https://api.deepseek.com|sk-yyy|deepseek-chat|DeepSeek|Cheap but slow|ds-chat|0`
  - `api_model_name` — the real model name for API requests
  - `unique_id` — unique identifier for the client (may differ from `api_model_name`)
  - `supports_vision` — optional, `1` or `0` (default `0`). If `1` — photos are sent directly to the model. If `0` — the `describe_image` tool is available (via a vision provider)
  - `admin_only` — optional, `1`/`true` or `0`/`false` (default `0`). Admin-only models are hidden and rejected for non-admin users
  - If not set — the model selector is not displayed
- `preferred_model` (in the `users` table) — `NULL` = auto, `"tw-gpt4o"` = specific model
- If the selected model is unavailable — fallback to auto-routing + user notification

### Reasoning Level (model thinking depth)

Allows the user to control the model's reasoning/thinking depth. Stored in `users.reasoning_level` (`NULL` = auto). Propagated through the entire call stack and applied in `adaptRequestBodyForProvider` — an adapter that determines the provider by `baseURL` and translates the level to the native parameter.

**Supported providers:**

| Provider (by `baseURL`) | Native parameter | Levels | Mapping |
|---|---|---|---|
| OpenRouter (`openrouter.ai`) | `reasoning: { effort: level }` | `none, minimal, low, medium, high, xhigh` | 1:1 |
| DeepSeek direct (`deepseek.com`) | `reasoning_effort` / `thinking` | `none, high, xhigh` | `none`→`thinking:{type:"disabled"}`, `high`→`reasoning_effort:"high"`, `xhigh`→`reasoning_effort:"max"` |
| Others (Timeweb, vLLM) | — | — | Not touched, current logic (`thinking`/`clear_thinking`) |

**Behavior in modes:**
- **Auto (`NULL`)** — the adapter does not add reasoning parameters, the provider uses its default behavior.
- **LITE-router / `callLiteAi`** — always `'none'`, not user-controlled.
- **PRO main/final completion** — user's level (or `NULL` = auto).
- **Manual model** — user's level is applied if the model's `baseURL` supports it.

**Capability API:** `GET /api/v1/models` returns `reasoning_levels` for each manual model (by `baseURL`) and `auto_reasoning_levels` for auto mode. If `reasoning_levels = null` — the slider is hidden.

**Endpoints:**
- `GET /api/v1/user/reasoning-level` → `{ reasoning_level: string | null }`
- `PUT /api/v1/user/reasoning-level` ← `{ reasoning_level: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|null }`

### Subagent Model & Reasoning Level

The model and reasoning level for subagents are configured by the user separately from the main agent.

- `subagent_mode` (in the `users` table) — `NULL` or `'auto'` = inherits the main agent's model, or a specific model ID from the catalog (`GET /api/v1/models`). If the selected model is unavailable — fallback to auto.
- `subagent_reasoning_level` — reasoning depth for subagents (`NULL` = auto, same levels as for the main agent: `none, minimal, low, medium, high, xhigh`).

Propagated through `SubagentContext` in `runner.ts` → `runCompletion()`. Effect on the provider is the same as for the main reasoning level (see above).

**Endpoints:**
- `GET /api/v1/user/subagent-model` → `{ subagent_model: string | null }`
- `PUT /api/v1/user/subagent-model` ← `{ model_id: string | null }`
- `GET /api/v1/user/subagent-reasoning-level` → `{ reasoning_level: string | null }`
- `PUT /api/v1/user/subagent-reasoning-level` ← `{ reasoning_level: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|null }`

### Model Settings (generation parameters)

Allows the user to configure generation parameters (temperature, top_p, top_k, frequency_penalty, presence_penalty, repetition_penalty, max_tokens) for each manual model individually. Stored in `users.model_settings` (a JSON object keyed by model `unique_id`). Applied only to manual models (not auto-routing, not LITE mode).

**Parameters (`MODEL_SETTINGS_RANGES`):**

| Parameter | min | max | step | Description |
|---|---|---|---|---|
| `temperature` | 0 | 2 | 0.05 | Generation temperature |
| `top_p` | 0 | 1 | 0.05 | Nucleus sampling |
| `top_k` | 0 | 500 | 1 | Top-K sampling |
| `frequency_penalty` | -2 | 2 | 0.1 | Frequency penalty |
| `presence_penalty` | -2 | 2 | 0.1 | Presence penalty |
| `repetition_penalty` | 0 | 2 | 0.05 | Repetition penalty |
| `max_tokens` | 1 | 65536 | 1 | Output token limit |

A `null` value for a parameter = auto (not sent to the provider API).

**Provider-based filtering (`PROVIDER_SUPPORTED_PARAMS`):**

Not all providers support all parameters. Filtering happens in `adaptRequestBodyForProvider`:

| Provider (by `baseURL`) | Supported parameters |
|---|---|
| OpenRouter (`openrouter.ai`) | All 7 parameters |
| DeepSeek direct (`deepseek.com`) | All except `top_k`, `repetition_penalty` |
| Others (Timeweb, vLLM) | All except `top_k`, `repetition_penalty` |

The `getProviderSupportedParams(baseURL)` function returns a Set of supported parameters. `applyModelSettingsToBody()` merges only allowed parameters into the request body.

**`supported_params` in the model catalog:**

`GET /api/v1/models` returns `supported_params` for each model (an array of strings). The client uses this to display only relevant sliders in settings.

**Behavior in modes:**
- **Auto-routing (PRO/LITE)** — model settings are not applied.
- **LITE mode** — model settings are not applied (`null` is passed).
- **Manual model** — settings are applied in `adaptRequestBodyForProvider`.

**Data flow:**
1. `sendMessageThroughAi` reads `user.model_settings` (JSON), finds settings for `preferredModelId`.
2. Passes `resolvedModelSettings` to `runCompletion` → `createCompletionWithModelFallback`.
3. `adaptRequestBodyForProvider` calls `applyModelSettingsToBody(requestBody, baseURL, settings)`.
4. The request body is merged with settings (filtered by provider).

**Endpoints:**
- `GET /api/v1/user/model-settings` → `{ settings: { [modelId]: { temperature?: number, ... } } }`
- `PUT /api/v1/user/model-settings` ← `{ model_id, settings: { temperature?, top_p?, ... } }` (merge with existing settings for the model)
- `DELETE /api/v1/user/model-settings/:modelId` → `{ ok: true }`

### AI Providers (vision, optional)

Vision requests (photo analysis) can use separate models/keys. If not set — fallback to the main PRO/LITE providers.

- `TIMEWEB_VISION_BASE_URL` — defaults to `TIMEWEB_BASE_URL`.
- `TIMEWEB_VISION_API_KEY` — defaults to `TIMEWEB_API_KEY`.
- `TIMEWEB_VISION_MODEL` — defaults to the first of `TIMEWEB_MODEL`.
- `TIMEWEB_LITE_VISION_BASE_URL` — defaults to `TIMEWEB_LITE_BASE_URL`.
- `TIMEWEB_LITE_VISION_API_KEY` — defaults to `TIMEWEB_LITE_API_KEY`.
- `TIMEWEB_LITE_VISION_MODEL` — defaults to `TIMEWEB_VISION_MODEL`.

### Vision support for auto-routing

Determines whether the main model natively supports receiving images. If yes — the photo is sent directly to the model. If no — the model uses the `describe_image` tool (via a vision provider).

- `TIMEWEB_MODEL_SUPPORTS_VISION` — `1`/`true` if the PRO model supports vision (default `false`).
- `TIMEWEB_LITE_MODEL_SUPPORTS_VISION` — `1`/`true` if the LITE model supports vision (default `false`).

For manual models, the vision flag is set in `MODELS_MANUAL` (7th field `supports_vision`).

**Capability API:** `GET /api/v1/models` returns `supports_vision` for each manual model and `auto_supports_vision: { pro: boolean, lite: boolean }` for auto mode. The client uses these flags to display a "Vision" badge in the model selector.

### Image System

Images (user photos and generated) are handled differently depending on the model type:

**Vision model** (`supports_vision=1`):
- The photo is sent directly to the model as `image_url` (base64) — the model sees the image natively
- In history (on the next message), the photo is restored from disk and passed again as `image_url`
- Generated images are also included in history

**Non-vision model** (`supports_vision=0`):
- A marker `[Images attached N: /api/v1/images/xxx.webp]` is added to the message text
- The model can call the `describe_image({ question, image_url?, image_index? })` tool for analysis via a vision provider
- `image_url` allows analyzing any photo from history (file is read from disk)
- The tool is always available in the tool list (static list, does not depend on photo presence)

**Storage:**
- DB: `images` column (JSON `[{ url, type }]`), `content` remains plain text
- Disk: `uploads/xxx_thumb.webp`, resized to 1920×1080, quality 80
- History format is built dynamically in `getHistoryForAi(supportsVision)` — the DB does not store markers

**Image token counting:**
- When saving a message (`appendChatMessage`), the weight of each image is estimated using a tile-based algorithm (OpenAI standard)
- `sharp.metadata()` reads file dimensions → `estimateImageTokens(width, height)` counts 512×512 tiles: `(tiles × 170) + 85`
- A 1920×1080 photo ≈ 1105 tokens, a small screenshot ≈ 250 tokens
- Fallback: 1000 tokens if the file can't be read
- The result is written to `token_count` once; `trimUserHistoryByChat` uses it for archiving
- `appendChatMessage` — async (due to `sharp.metadata()`)

## Authorization Types

- JWT API: `Authorization: Bearer <access_token>` for `/api/v1/*` (except `/api/v1/auth/*`).
- Internal API: `Authorization: Bearer <BACKEND_INTERNAL_TOKEN>` for `/internal/*`.

## Account and Login Identity Architecture

The backend now separates the **account that owns data** from the **ways used to sign in to that account**.

```text
users (one canonical account and data owner)
└── id = account_id
    ├── chats, messages, images, prompts, settings, counters, ...
    └── account_identities
        ├── password: provider_subject = desktop login
        └── telegram: provider_subject = Telegram user ID

old/merged account ID
└── account_redirects ────────────────> canonical users.id
```

`users.id` is the canonical `account_id`. Domain tables continue to use their existing `user_id` columns, but those values must point to the canonical account, not to a Telegram ID or login identity by assumption.

`account_identities` contains authentication methods:

- `provider = "password"` stores the login in `provider_subject` and the password salt/hash in the identity row.
- `provider = "telegram"` stores the numeric Telegram user ID as text in `provider_subject`.
- An account may have several identities. Telegram is currently the only external identity exposed in clients, but the schema supports additional providers.
- `is_admin`, status, plan, settings, limits, and user data belong to the canonical `users` row, not to an individual identity.

### Account tables

| Table | Purpose |
|---|---|
| `users` | One row per canonical account; owns profile, settings, limits, counters, and all data referenced through `user_id`. |
| `account_identities` | Login methods attached to an account (`password`, `telegram`, future providers). `(provider, provider_subject)` is unique. |
| `account_redirects` | Maps an old merged account ID to the current canonical account and preserves enough auth state to resolve legacy JWT subjects safely. A redirect is not a second active account. |
| `account_namespace_migrations` | Tracks Pinecone namespace moves from merged account IDs to the canonical account ID. |
| `telegram_link_codes` | Short-lived one-time codes used by the Desktop → Telegram linking flow. |

### ID resolution

- Desktop/API JWTs resolve their token subject through `getAuthPrincipal()` and `resolveAccountId()`.
- Every internal endpoint that accepts `user_id`, `actor_user_id`, `banned_by`, or an `:id` path parameter accepts a canonical account ID only. Redirects are followed, but Telegram IDs are never guessed from these values.
- Telegram IDs are accepted only by explicitly Telegram-scoped boundaries such as `upsert-telegram`, `create-pending`, link/unlink verification, and `GET /internal/users/by-telegram/:telegramId`.
- Internal user DTOs always expose the canonical ID in both `id` and `account_id`. Telegram identity data is separate: `telegram_id`, `telegram_username`, and `identities`.
- Runtime code must never compare a Telegram ID with `users.id` or use one as a fallback for the other.

### Linking Desktop and Telegram

1. Desktop creates a one-time code through `POST /api/v1/link/generate`.
2. The user sends `/link` to the Telegram bot and enters the code.
3. The bot calls `POST /internal/link/verify`.
4. The Desktop account is merged into the existing Telegram account, whose current canonical ID is retained.
5. Password and Telegram identities end up on the same canonical account.

During the merge:

- chats, messages, images referenced by messages, notes, tasks, prompts, macros, map pins, DevOps data, PC policies, subscriptions, and other owned rows are transferred to the canonical account;
- additive usage counters are summed;
- explicit Desktop personal settings win on conflicts, while Telegram identity/status remain on the retained account;
- admin access is preserved if either side was an admin;
- the old Desktop `users` row is removed and replaced by an `account_redirects` entry;
- the FTS index is rebuilt;
- the Pinecone namespace migration is queued.

An old JWT whose subject is the merged source ID can be resolved through the redirect until its token version is revoked.

### Unlinking Telegram

Unlinking is an account split, not data deletion. It requires the canonical account to have both a Telegram identity and at least one password identity.

The caller chooses `data_owner: "desktop" | "telegram"`:

- the selected side keeps the current canonical account and **all existing data**;
- the other side receives a newly allocated empty `users` row;
- only identities are moved during the split: choosing Desktop moves the Telegram identity to the empty account, while choosing Telegram moves password identities to the empty account;
- chats, images, prompts, settings, counters, files, and Pinecone memory are not moved or deleted during unlink;
- old JWTs for the canonical account and redirect-backed legacy subjects are revoked;
- the public Desktop endpoint returns fresh Desktop access/refresh tokens and the resulting user.

### Account architecture after the completed migration

The legacy account schema has been retired. The backend no longer discovers or converts `api_accounts`, `linked_tg_id`, merge-log rows, or duplicated Telegram usernames during startup. Every supported database must already use the canonical account schema described above.

`account_identities`, `account_redirects`, canonical ID resolution, unlink splitting, and namespace migration handling are permanent runtime architecture. Pinecone namespace migrations are also used by future account merges: until a namespace is copied successfully, vector-memory searches read both the canonical and source namespaces, and failed passes remain retryable.

## Quick Check (input/output)

1. Health

```bash
curl -s http://127.0.0.1:3050/health
```

```json
{"ok":true,"service":"backend-api","now":1710000000}
```

2. User registration (JWT)

```bash
curl -s -X POST http://127.0.0.1:3050/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"login":"demo_user","password":"strongpass123","name":"Demo"}'
```

```json
{
  "access_token":"...",
  "refresh_token":"...",
  "access_expires_in":3600,
  "refresh_expires_in":2592000,
  "user":{"id":123,"name":"Demo","username":null,"role":"user","is_admin":0,"plan":"free"}
}
```

3. AI message (JWT)

```bash
curl -s -X POST http://127.0.0.1:3050/api/v1/chat/send \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello, what can you do?"}'
```

```json
{
  "reply":"...",
  "message_id":456,
  "chat_id":1
}
```

4. Create pending user (internal, bot scenario)

```bash
curl -s -X POST http://127.0.0.1:3050/internal/users/create-pending \
  -H "Authorization: Bearer <BACKEND_INTERNAL_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"tg_id":777000111,"name":"Ivan","tg_username":"ivan","default_prompt_id":1}'
```

```json
{
  "ok":true,
  "user":{"id":777000111,"status":"none","role":"user","plan":"free"}
}
```

## Endpoints (input/output)

### Public JWT API

- `POST /api/v1/auth/register`
  - Input: `{ login, password, name? }`
  - Output: `{ access_token, refresh_token, access_expires_in, refresh_expires_in, user }`
- `POST /api/v1/auth/login`
  - Input: `{ login, password }`
  - Output: `{ access_token, refresh_token, access_expires_in, refresh_expires_in, user }`
- `POST /api/v1/auth/telegram`
  - Input: `{ initData }`
  - Output: `{ access_token, refresh_token, access_expires_in, refresh_expires_in, user }`
- `POST /api/v1/auth/refresh`
  - Input: `{ refresh_token }`
  - Output: `{ access_token, refresh_token, access_expires_in, refresh_expires_in }`
- `POST /api/v1/auth/logout`
  - Requires an access JWT and revokes all previously issued access/refresh tokens for the account.
- `GET /api/v1/link/status`
  - Returns the linked Telegram identity and whether it can be unlinked.
- `POST /api/v1/link/generate`
  - Creates a one-time Telegram link code.
- `POST /api/v1/link/unlink`
  - Input: `{ data_owner: "desktop" | "telegram" }`.
  - Keeps all existing chats, images, prompts, settings, and vector memory on the selected side. The other identity is moved to a new empty account.
  - Revokes old access/refresh tokens and returns fresh Desktop tokens plus the resulting user.
- `GET /api/v1/chats?limit=&offset=`
  - Input: query `limit` defaults to 50, max 100; `offset` defaults to 0
  - Output: `{ chats, active_chat_id, limit, offset }`
- `GET /api/v1/chats/search?q=&limit=`
  - Full-text search across messages (FTS5). Returns chats that have matches, with a snippet of the found text.
  - Minimum query length: 3 characters. `limit` defaults to 20, max 50.
  - Output: `{ results: [{ chat_id, chat_title, snippet, rank }] }`
  - `snippet` contains text around the match; the match is wrapped in `<< >>`.
  - Results are grouped by chat, sorted by relevance (`rank`).
- `POST /api/v1/chats`
  - Input: `{ title? }`
  - Output: `{ chat_id }`
- `POST /api/v1/chats/:id/fork`
  - Input: `{ from_message_id, title? }` — creates a new chat and copies all messages from the original chat from the beginning through `from_message_id` inclusive
  - Output: `{ chat_id, forked_messages }` — the new chat becomes active
  - See [Chat Fork (dialog branch)](#chat-fork-dialog-branch)
- `POST /api/v1/chats/:id/activate`
  - Input: path `:id`
  - Output: `{ ok: true, active_chat_id }`
- `GET /api/v1/chats/:id/messages?limit=&offset=`
  - Input: path/query
  - Output: `{ messages, limit, offset }`
- `PUT /api/v1/chats/:chatId/messages/:messageId`
  - Input: `{ content }`
  - Output: `{ ok, token_count }` — edit message text (user or assistant). Recalculates `token_count`, updates the FTS index.
- `POST /api/v1/chat/send`
  - Input: `{ text, chat_id? }`
  - Output: AI response (`reply_text`, ids, `reasoning_content?`, `tool_calls?`, `generated_images?` and metrics depending on the AI service)
- `GET /api/v1/notes?query=&limit=&offset=`
  - Input: query
  - Output: `{ notes, total, limit, offset }`
- `POST /api/v1/notes`
  - Input: `{ title?, content }`
  - Output: `{ note_id }`
- `GET /api/v1/notes/:id`
  - Input: path `:id`
  - Output: `{ note }`
- `DELETE /api/v1/notes/:id`
  - Input: path `:id`
  - Output: `{ ok: true }`
- `GET /api/v1/tasks?status=&limit=`
  - Input: query (`status`: `pending|done|error|all`)
  - Output: `{ tasks }`
- `POST /api/v1/tasks`
  - Input: `{ execute_at, task_type, payload, recurrence_type?, recurrence_weekday?, timezone_offset?, notify_mode?, notify_condition? }`
  - Output: `{ task_id }`
- `DELETE /api/v1/tasks/:id`
  - Input: path `:id`
  - Output: `{ ok: true }`
- `GET /api/v1/map-pins`
  - Input: no body
  - Output: `{ pins: [{ id, lat, lng, label, created_at, updated_at }] }` (coordinates are decrypted)
- `POST /api/v1/map-pins`
  - Input: `{ lat, lng, label? }`
  - Output: `{ pin_id }` (coordinates are encrypted before saving)
- `PUT /api/v1/map-pins/:id`
  - Input: `{ lat?, lng?, label? }` (lat+lng only together)
  - Output: `{ ok: true }`
- `DELETE /api/v1/map-pins/:id`
  - Input: path `:id`
  - Output: `{ ok: true }`
- `GET /api/v1/macros`
  - Input: no body
  - Output: `{ macros: [{ id, title, description, commands, enabled, pinned, return_output, created_at, updated_at }] }`
- `POST /api/v1/macros`
  - Input: `{ title, description?, commands: string[], enabled?, pinned?, return_output? }`
  - Output: `{ id }` (201) or error (400/429/422)
- `PUT /api/v1/macros/:id`
  - Input: `{ title?, description?, commands?, enabled?, pinned?, return_output? }`
  - Output: `{ ok: true }`
- `DELETE /api/v1/macros/:id`
  - Input: path `:id`
  - Output: `{ ok: true }`
- `POST /api/v1/macro/explain`
  - Input: `{ commands: string[] }`
  - Output: `{ explanation: string }` — AI explains what the commands do (lightweight LITE request)
- `POST /api/v1/macro/describe`
  - Input: `{ commands: string[], current_title?, current_description? }`
  - Output: `{ title: string, description: string }` — AI suggests a title/description (lightweight LITE request)
- `GET /api/v1/models`
  - Output: `{ models: [{ id, name, description, supported_params? }], preferred_model }` — model catalog for manual selection + the user's current model. `supported_params` — array of generation parameters supported by the model's provider (see [Model Settings](#model-settings-generation-parameters)).
- `PUT /api/v1/user/preferred-model`
  - Input: `{ model_id: string | null }` (null = auto)
  - Output: `{ ok, preferred_model }`
- `GET /api/v1/user/model-settings`
  - Output: `{ settings: { [modelId]: { temperature?, top_p?, top_k?, frequency_penalty?, presence_penalty?, repetition_penalty?, max_tokens? } } }` — generation parameters per model
- `PUT /api/v1/user/model-settings`
  - Input: `{ model_id: string, settings: { temperature?, ... } }` — merge with existing model settings
  - Output: `{ ok: true, settings }`
- `DELETE /api/v1/user/model-settings/:modelId`
  - Output: `{ ok: true }` — deletes settings for a specific model

### DevOps Agent Runtime (JWT)

Manage SSH servers, auto-approve policies, and runbooks. Available to desktop clients and Telegram (via SSE streaming and inline confirmation buttons).

**Servers:**

- `GET /api/v1/devops/servers` — list of user's servers (no passwords/keys)
- `POST /api/v1/devops/servers` — add a server (`{ name, host, port, username, password?, private_key?, sudo_password?, default_ssh_key_id?, use_ssh_key_for_login? }`)
- `GET /api/v1/devops/servers/:id` — server info
- `PUT /api/v1/devops/servers/:id` — update server (partial update). Fields: `{ name?, host?, port?, username?, password?, private_key?, sudo_password?, default_ssh_key_id?, use_ssh_key_for_login? }`
- `DELETE /api/v1/devops/servers/:id` — delete server
- `POST /api/v1/devops/servers/:id/test` — test SSH connection
- `POST /api/v1/devops/servers/:id/exec` — execute a command on the server (internal calls only, not from AI)

**Policies (auto-approve commands):**

- `GET /api/v1/devops/servers/:id/policies` — list policies for a server
- `POST /api/v1/devops/servers/:id/policies` — create a policy (`{ pattern, auto_approve }`). `pattern` — regex for the command.
- `DELETE /api/v1/devops/policies/:id` — delete a policy

**Command confirmation (HitL):**

- `POST /api/v1/devops/approve` — approve/reject command execution (`{ confirmation_id, approved: boolean, sudo_password?, save_sudo_password?, new_password? }`)
- `POST /api/v1/email/approve` — approve/reject email sending (`{ confirmation_id, approved: boolean }`). Resolves the pending Promise; on approve — calls `runEmailSend`.

**Runbooks:**

- `GET /api/v1/devops/runbooks` — list of user's runbooks
- `POST /api/v1/devops/runbooks` — create a runbook (`{ title, content, commands? }`)
- `PUT /api/v1/devops/runbooks/:id` — update a runbook
- `DELETE /api/v1/devops/runbooks/:id` — delete a runbook
- `POST /api/v1/devops/runbooks/extract-commands` — extract shell commands from runbook text via AI (`{ content }`)
- `POST /api/v1/devops/runbooks/review-commands` — review command safety via AI (`{ commands: string[] }`)

**Attaching runbooks to servers:**

- `POST /api/v1/devops/servers/:id/attach-runbook` — attach a runbook to a server (`{ runbook_id }`). Creates auto-approve policies for each command in the runbook.

### Subagent System (desktop-only, `isDesktop`)

A system of nested agents (subagents). The main AI agent can delegate tasks to subagents in two ways:

1. **Specialized subagents** (`invoke_subagent`) — from a static registry (preconfigured prompts and tools).
2. **Ad-hoc subagents** (`spawn_subagent`) — created by the model on the fly with a custom prompt, selected tools, and an iteration limit.

Each subagent has its own system prompt, its own set of tools, and a separate agent loop.

**Architecture:**

```
Main agent (ai.ts)
  ├── invoke_subagent(agent, task, context)         — static registry
  ├── spawn_subagent(task, system_prompt, tools)    — ad-hoc, dynamic
  │     └── buildAdhocSubagent() → runSubagent()
  │           ├── Own tools (ownTools) — executed directly
  │           └── Shared tools (sharedTools) — via main agent's runTool
  └── Return result (answer, summary, toolCallsHistory)
```

**Parallel execution:** if the model returns multiple `spawn_subagent` calls in the same iteration, they execute in parallel (up to `MAX_PARALLEL_SPAWN_SUBAGENTS = 3` concurrently). Other tools execute sequentially, as before.

**Integration:**
- `invoke_subagent` — added to `executionTools` only if `isDesktop=true` and the registry has registered subagents
- `spawn_subagent` — added only if `isDesktop=true` and the `disable_adhoc_subagents` flag is not set. Dynamically generates a list of **all** runtime tools (base + serverOnlyTools + desktopOnlyTools + macros), excluding `spawn_subagent` and `invoke_subagent` (recursive spawning is prohibited). The list is passed via `availableToolDefs` → `ctx.runtimeToolDefs` in the runner
- `initSubagentRunner()` — called at server startup (`server.ts`), passes references to `runCompletion`, `runTool`, `toolDefinitions` to break circular dependencies
- The subagent uses the same `AbortSignal` as the main request — stopping generation (`chat_stop`) also stops the subagent (soft-abort — returns a partial result)
- Subagent model: the user selects in settings `subagent_mode` (`auto` = inherits main agent's model, or a specific model from the catalog). Reasoning level is also configured separately via `subagent_reasoning_level`
- **Subagent trace** is stored separately in `chat_messages.subagents_json` (not in `tool_calls_json`) to avoid polluting the AI context. Only the `spawn_subagent` call + a brief result go into `tool_calls_json`. The full trace (prompt, task, tool list, step-by-step tool calls, answer) is available for UI display

**File structure:**

```
services/subagents/
  types.ts          — types: SubagentConfig, SubagentTool, SubagentContext, SubagentResult, SubagentMode, SubagentTraceEntry
  registry.ts       — subagent registry: REGISTRY, getSubagent(), buildSubagentListDescription(), buildAdhocSubagent()
  runner.ts         — agent loop: runSubagent(), initSubagentRunner(), soft-abort
  prompts/
  tools/
```

**How to add a new subagent:**
1. Create tools in `tools/<name>-tools.ts`
2. Create a prompt in `prompts/<name>.md`
3. Add an entry to `REGISTRY` in `registry.ts`

**Ad-hoc subagents (`buildAdhocSubagent`):**

Created by the model via `spawn_subagent` without registration in `REGISTRY`. Parameters:
- `systemPrompt` — direct prompt text (not from a file), 16KB limit. If the model doesn't provide one — a default general assistant prompt is used.
- `sharedTools` — array of tool names from the full runtime set (base `toolDefinitions` + dynamic `serverOnlyTools` / `desktopOnlyTools` / macros) that the subagent can use. Validated on the backend — unknown names are discarded. The runner gets definitions via `ctx.runtimeToolDefs`.
- `maxLoops` — iteration limit (1–50, default 20).
- Has no `ownTools` — only shared tools from the main agent.

**Agent loop (runner.ts):**
- Iteration limit: `maxLoops` from config (default 50 for static, default 20 for ad-hoc, hard cap 50)
- 2 iterations before the limit — nudge "finish the task"
- Debug: `DEBUG_AI_RAW_SUBAGENT=1` — logs full model responses
- `setMaxListeners(100)` on signal — prevents `MaxListenersExceededWarning` during long loops
- **Soft-abort:** on interruption (`AbortSignal`), the subagent doesn't throw an exception but returns a partial result — the last assistant content and accumulated tool calls. The result is marked `aborted: true`.

### Vector Memory (JWT, feature-flag)

- Requires `BACKEND_VECTOR_MEMORY_API_ENABLED=1`.
- `POST /api/v1/vector-memory/chunks` → input `{ text, source? }`, output: created chunk.
- `POST /api/v1/vector-memory/search` → input `{ query, top_k? }`, output: found chunks.
- `DELETE /api/v1/vector-memory/chunks/:id` → output `{ ok: true, ... }`.
- `DELETE /api/v1/vector-memory/chunks?all=1` → output `{ ok: true, ... }`.

### Admin JWT API (admin only)

- `GET /api/v1/admin/users?filter=all|pending|banned&limit=&offset=` → `{ users, total, filter, limit, offset }`
- `GET /api/v1/admin/users/:id` → `{ user, ban }`
- `PUT /api/v1/admin/users/:id/status` (input `{ status }`) → `{ ok: true, status }`
- `PUT /api/v1/admin/users/:id/role` (input `{ role }`) → `{ ok: true, role }`
- `PUT /api/v1/admin/users/:id/name` (input `{ name }`) → `{ ok: true, name }`
- `DELETE /api/v1/admin/users/:id` → `{ ok: true }`
- `POST /api/v1/admin/users/:id/plan` (input `{ plan, duration? }`, duration: `forever|day|week|month|year`) → `{ ok: true, plan, ends_at }`
- `POST /api/v1/admin/users/:id/ban` (input `{ reason? }`) → `{ ok: true, reason }`
- `DELETE /api/v1/admin/users/:id/ban` → `{ ok: true, status: "none" }`
- `POST /api/v1/admin/sync-plan-limits` → `{ ok: true }`

### Internal API (for bot/services)

- All endpoints below require `Authorization: Bearer <BACKEND_INTERNAL_TOKEN>`.
- Telegram account linking:
  - `POST /internal/link/verify` → `{ code, tg_id, tg_username? }` → `{ ok, account_id, tg_id, tg_username }`; validates the approved Telegram identity and merges the Desktop account referenced by the one-time code.
  - `POST /internal/link/unlink` → `{ tg_id, data_owner: "desktop" | "telegram" }` → `{ ok, split }`.
  - For Telegram-originated endpoints, `user_id` may be the Telegram ID; the backend resolves it through `account_identities` to the canonical account.
- AI:
  - `POST /internal/ai/send` → `{ user_id, text, chat_id?, options?, documents? }` → `{ reply_text, chat_id, message_id, reasoning_content?, tool_calls?, model_fallback_notice?, tool_user_messages?, generated_images?, usage }`
  - `POST /internal/ai/stream` → SSE streaming for Telegram: `{ user_id, text, chat_id?, options?, documents? }`
    - `documents[]` — optional array of `{ filename, base64 }`, parsed and saved identically to `/api/v1/chat/send` (see [Document Attachments](#document-attachments)).
    - Events: `intermediate`, `tool_status`, `display_state`, `desktop_action`, `done`, `error` (see [SSE Streaming](#sse-streaming-and-dual-delivery-of-confirmations))
    - Passes `onIntermediateMessage`, `onToolStatus`, `onDesktopAction` callbacks to `sendMessageThroughAi`
  - `POST /internal/ai/lite` → `{ text }` → `{ reply_text }` — LITE AI for command safety checks
  - `POST /internal/ai/admin-outreach` → `{ target_user_id, admin_instruction }`
  - `POST /internal/ai/generate-image` → `{ user_id, prompt }` → `{ ok: true, image_base64, prompt_used }` (requires `OPENROUTER_API_KEY`)
  - `POST /internal/messages/bind-telegram` → `{ user_id, message_id, telegram_chat_id?, telegram_message_id? }`
- Voice/photo:
  - `POST /internal/voice/turn` (`BACKEND_VOICE_API_ENABLED=1`)
  - `POST /internal/photo/analyze` → `{ user_id, image_base64, image_mime_type?, caption?, chat_id?, extra_images?, options? }` → `{ reply_text, message_id, chat_id, usage, ... }`
    - `extra_images` — array of additional images; up to 50 images share a 32 MB decoded-payload limit: `[{ base64, mime_type? }]`
    - The first image (required) is passed in `image_base64`, the rest via `extra_images`
    - The plan controls whether image attachments are allowed; documents are available on every plan
    - Errors: `images_not_allowed_for_plan`, `too_many_images_max_50`, `image_too_large`, `image_payload_too_large`
- URL tool:
  - `POST /internal/tools/read_url` → `{ url }` → `{ ok, url, text }`
- Prompts:
  - `GET /internal/prompts`, `GET /internal/prompts/:id`
  - `POST /internal/prompts` → `{ name, description?, content, is_default? }`
  - `PUT /internal/prompts/:id/name|description|content|default`
  - `DELETE /internal/prompts/:id`
  - `POST /internal/prompts/reset-users` → `{ prompt_id }`
- User prompt/timezone/context/mail:
  - `POST /internal/user/prompt/select` → `{ user_id, prompt_id }`
  - `PUT /internal/user/prompt/custom` → `{ user_id, content }`
  - `POST /internal/user/timezone` → `{ user_id, timezone_offset }`
  - `POST /internal/mail/setup|use`, `PUT /internal/mail/limit`, `DELETE /internal/mail/account`
- User lifecycle/plan/ban:
  - `POST /internal/users/upsert-telegram` → `{ tg_id, name, role?, status?, tg_username?, default_prompt_id? }`
  - `POST /internal/users/create-pending` → `{ tg_id, name?, tg_username?, default_prompt_id? }`
  - `GET /internal/users/by-telegram/:telegramId` — explicit Telegram identity lookup; returns a canonical account DTO
  - `GET /internal/users/:id` — canonical account ID only
  - `PUT /internal/users/:id/tg-username` → `{ user_id?, tg_username }`
  - `GET /internal/users?filter=all|pending|banned&limit=&offset=`
  - `PUT /internal/users/:id/status|role|name`
  - `DELETE /internal/users/:id`
  - `POST /internal/users/:id/plan` → `{ plan }`
  - `POST /internal/sync-plan-limits`
  - `POST /internal/users/:id/ban` → `{ reason?, banned_by? }`
  - `DELETE /internal/users/:id/ban`
  - `GET /internal/users/:id/ban`
  - `POST /internal/users/:id/prompt/select`
  - `PUT /internal/users/:id/prompt/custom`
- Service:
  - `POST /internal/daily-reset` → `{ ok: true }`
  - `POST /internal/reset-daily-counters` → `{ ok: true }` — manual reset of all users' daily counters
- Models (manual selection):
  - `GET /internal/models` → `{ models: [{ id, name, description }] }`
  - `GET /internal/users/:id/preferred-model` → `{ models, preferred_model }`
  - `PUT /internal/users/:id/preferred-model` → `{ model_id: string | null }` → `{ ok, preferred_model }`
- PC Command confirmation (for TG bot):
  - `POST /internal/pc-commands/approve` → `{ confirmation_id, approved, user_id }` → `{ ok, status, result? }`
  - `POST /internal/pc-commands/policies` → `{ user_id, pattern }` → `{ ok, id }` — create auto-approve policy
- DevOps SSH confirmation (for TG bot):
  - `POST /internal/devops/approve` → `{ confirmation_id, approved, user_id, sudo_password?, new_password? }` → `{ ok, status, result? }`
  - `POST /internal/devops/servers/:id/policies` → `{ user_id, pattern, auto_approve }` → `{ id }` — create SSH auto-approve policy
- Email Send confirmation (for TG bot):
  - `POST /internal/email/approve` → `{ confirmation_id, approved, user_id }` → `{ ok, status, result? }`

## Plan Limits

Defined in `PLAN_LIMITS` in `services/plan-limits.ts`, applied on user creation, plan change, and `/sync-plan-limits`.

| Parameter | free | standart | pro |
|---|---|---|---|
| `daily_web_search_limit` | 0 | 5 | 20 |
| `daily_image_gen_limit` | 0 | 2 | 5 |
| `image_attachments_allowed` | false | true | true |
| `max_context_tokens` | 30,000 | 60,000 | 1,000,000 |

Message count and notes are not restricted by subscription plan. Admins (`is_admin = 1`) bypass the remaining daily web-search and image-generation limits.

### Image Storage

User-generated and AI-generated images are saved on the server. Without this, base64 would be lost and images wouldn't display in chat history.

**Service:** `services/image-storage.ts` (`sharp` dependency):
- `saveUserImageThumbnail()` — resizes to 512px, converts to webp, saves to `uploads/`.
- `saveGeneratedImage()` — saves PNG without compression.
- Download API `GET /api/v1/images/:filename?token=<access_token>` — owner-only. There is no static `/uploads/` route.

**DB:**
- `images TEXT` column in `chat_messages` — JSON array `[{ "url": "/api/v1/images/abc.webp", "type": "user_photo" | "generated" }]`.
- `appendChatMessage` accepts an `images[]` parameter. `getChatMessages` parses and returns `images` in the response.

**AI tokens:**
- Images are not re-sent in context — the AI only sees the text `[Photo]caption`. In `getHistoryForAi()`, this is ensured by selecting only `content` for user messages (without `images`).
- Separation: "history for AI" = text + expanded tool calls trace (see [Tool calls trace](#tool-calls-trace-and-ai-context)), "history for display" = text + images[] + flat projection of tool_calls.

**Data flows:**
- **Desktop sends photo:** base64 → server resizes + saves thumbnail → original to AI vision → DB: `images: [{ url, type: "user_photo" }]`.
- **Image generation:** AI calls `generate_image` → b64 saved to disk → `image_url` returned → DB assistant message: `images: [{ url, type: "generated" }]`.
- **Telegram photo:** bot downloads photo → `/internal/photo/analyze` → thumbnail saved → DB user message.

**Types:**
- `MessageImage` — `{ url: string; type: 'user_photo' | 'generated' }`.
- `GeneratedImage` — added `image_url` field.
- `ChatSendResponse` — added `generated_images` field.

### Document Attachments

Users can attach text documents to messages. Unlike photos, documents are **injected into the AI context every time** as text blocks (rather than shown once via vision).

**Supported formats:**
- Text: txt, md, json, csv, log, xml, yaml, ini, toml, code (py, js, ts, go, rs, java, c, cpp, cs, php, sh, sql, html, css, etc.)
- DOCX (via `mammoth`)
- PDF (via `pdf-parse`)
- RTF

**Limits:**
- Raw file size: **5 MB** (`MAX_RAW_FILE_SIZE`)
- Extracted text is trimmed to **500,000 characters** (`MAX_EXTRACTED_TEXT_CHARS`) — head + tail are preserved
- Token budget for documents: `attachment_max_tokens` (user setting). `0` = auto (90% of `max_context_tokens`). The limit can be changed in settings (slider, 0 = Auto).

**Services:**
- `services/document-parser.ts` — text extraction (`parseDocument`), MIME types (`guessMimeType`)
- `services/attachment-storage.ts` — save/delete files (`saveUserDocument`, `resolveAttachmentFile`, `deleteAttachmentFile`)

**DB:**
- `attachments TEXT` column in `chat_messages` — JSON array `[MessageAttachment]`.
- `attachment_max_tokens INTEGER NOT NULL DEFAULT 0` column in `users`.
- `MessageAttachment`: `{ name, size_bytes, mime_type, extracted_text, url, filename }`.

**File storage:**
- Files are saved as `<id>_<sanitized_name>` in `uploads/` (alongside images).
- Download API `GET /api/v1/attachments/:filename?token=<access_token>` — owner-only (verified via JSON `attachments LIKE`).
- Deletion via `DELETE /api/v1/chats/:chatId/messages/:messageId/attachments/:filename` — deletes file from disk, removes from JSON, recalculates `token_count`.

**Injection into AI context:**
- `injectAttachments()` formats each document as:
  ```
  [User attached file: server_logs.txt]
  --- FILE START ---
  <content>
  --- FILE END ---
  ```
- `getHistoryForAi()` injects attachments for each user message in history.
- The current request (`sendMessageThroughAi`) injects attachments into `userMessageContent`.
- The `attachmentMaxTokens` budget is passed to `getHistoryForAi()` to limit injection volume.

**Token accounting:**
- `appendChatMessage()` calculates `token_count` including injected attachments for user messages.
- `getChatAttachments(userId, chatId)` — list of all attachments in a chat for the ToolsPanel.

**Data flow:**
- **Desktop:** drag-and-drop/file selection → base64 → POST `/api/v1/chat/send` (`documents[]`) or WS `chat_send` → server parses, saves file, saves extracted_text → injects into AI.
- **Telegram:** files are downloaded by the TG bot → base64 → POST `/internal/ai/send` or `/internal/ai/stream` with the same `documents[]` field → same processing. Supports: single file (with/without caption), albums (`media_group_id`).
- **Deletion:** ToolsPanel → DELETE → file from disk + JSON in DB → token recalculation → injection stops.

**API:**

| Endpoint | Method | Description |
|---|---|---|
| `/api/v1/attachments/:filename` | GET | Download file (owner-only) |
| `/api/v1/chats/:chatId/attachments` | GET | List all attachments in a chat |
| `/api/v1/chats/:chatId/messages/:messageId/attachments/:filename` | DELETE | Delete attachment (file + DB + injection) |
| `/api/v1/user/attachment-tokens-limit` | GET | Current document token limit |
| `/api/v1/user/attachment-tokens-limit` | PUT | Set limit (0 = Auto) |

### Message Archiving (soft delete)

When the active chat context exceeds `max_context_tokens`, older messages are **not deleted** but marked as archived:

- Columns `chat_messages.archived` (INTEGER, 0/1) and `chat_messages.archived_at` (DATETIME).
- `trimUserHistoryByChat()` performs `UPDATE ... SET archived = 1` instead of `DELETE` for messages that fall outside the token budget.
- `getHistoryForAi()` selects only `archived = 0` — archived messages are not sent to the AI context. The expanded tool_calls trace from non-archived assistant messages is included in the context (see [Tool calls trace](#tool-calls-trace-and-ai-context)).
- `getChatMessages()` returns **all** messages (including archived) with an `archived: boolean` field — desktop shows the full history.
- FTS search continues to work on archived messages (the `AFTER DELETE` trigger doesn't fire on UPDATE, so records remain in `messages_fts`).
- Deleting a chat (`deleteUserChat`) and deleting a specific message (`deleteUserMessage`) perform a physical `DELETE` — this is unrelated to archiving.
- Index `idx_chat_messages_active` for efficient filtering by `archived = 0`.
- Desktop displays archived messages with reduced opacity (0.55) and an "archived" label.

### Token Accounting

Local estimation of message and context size via `gpt-tokenizer` (BPE `o200k_base`, pure JS — no WASM dependencies). Provider usage anchors the total context estimate; local token counts are the fallback and the per-message weights used to choose old rows for archiving.

**DB:**

| Column | Type | Description |
|---|---|---|
| `chat_messages.token_count` | INTEGER NOT NULL DEFAULT 0 | Message tokens in AI context (excluding `reasoning_content`) |
| `chat_messages.reasoning_tokens` | INTEGER NOT NULL DEFAULT 0 | `reasoning_content` tokens (assistant only, separate counter) |

**When calculated:**

- **On message save** (`appendChatMessage` in `services/chats.ts`):
  - **user**: `countMessageTokens('user', content)` — text only, no images (they don't go into context).
  - **assistant**: tokens of the expanded trace via `expandAssistantMessage()` — the same helper used by `getHistoryForAi()`. Counts `content`, `tool_calls`, and `tool results` of each iteration. `reasoning_content` **excluded**.
  - **reasoning_tokens**: separate counter from `reasoning_content`.
- **Backfill on server startup** (`backfillMessageTokens`): in batches of 1000 rows via `setImmediate`, to avoid blocking the event loop. Log: `[tokens] backfill complete: N messages updated`.
- **Dynamic system prompt** is not cached in the DB — calculated on the fly in `getChatContextTokens()`.

**Service:** `services/tokenizer.ts` — `countTokens()`, `countMessageTokens()`, `countToolCallTokens()`, `countToolResultTokens()`.

**System prompt assembly** (`services/system-prompt.ts`):
- `buildBaseSystemPromptForUser()` — base prompt without voice/avatar/image additions.
- Includes: selected prompt + core memory + cold memory hint + tool usage rules + temporal context + pinned macros.
- Extracted into a separate module to avoid the `ai.ts ↔ chats.ts` circular dependency.
- In `ai.ts` (`sendMessageThroughAi`) — full prompt with additions (`voicePromptHint`, `avatarPromptHint`, images hint).

**API:**

- `GET /api/v1/chats/:id/context-tokens` — total chat context tokens:
  ```json
  {
    "messages_tokens": 12345,
    "reasoning_tokens": 678,
    "archived_tokens": 910,
    "active_messages": 15,
    "archived_messages": 3,
    "system_prompt_tokens": 1876
  }
  ```
  - `messages_tokens` — sum of `token_count` for non-archived messages (excluding reasoning).
  - `system_prompt_tokens` — estimate of the base system prompt (dynamic, without voice/avatar). **Not added** to `messages_tokens`.
  - Full AI request context ≈ `messages_tokens + system_prompt_tokens` (+ additions).
- `MessageDto` (`GET /api/v1/chats/:id/messages`) includes `token_count` and `reasoning_tokens`.
- `AiSendResult` (WS/SSE `done`, `/api/v1/chat/send`) includes `token_count` and `reasoning_tokens` for the assistant response, as well as `user_token_count` for the new user message (if one was saved).

**Desktop display:**
- `Ntk` badge on each message in the metaRow (gray, right side).
- `reasoning_tokens` — in the "Reasoning" button: `Reasoning · 1234tk`.
- Compact badge in the top bar on the right: `12 345tk · 1 876pk` (messages + prompt).

**What is NOT counted:**
- `reasoning_content` in `token_count` (it doesn't go into AI context).
- `usage` from providers (unstable with streaming/tool calls/fallback).
- System prompt additions for voice/avatar/images in `/context-tokens` (they only appear for specific request types).
- Images in user messages (only text `[Photo]caption` goes into context).

## AI Tools

Tools are available to the AI via tool calling. Defined in `services/ai.ts` in `toolDefinitions`.

The agent loop is limited by constants in `services/ai.ts`: `MAX_TOOL_LOOPS = 80`, `MAX_TOOL_LOOPS_VOICE = 10`. This is a limit on "model → tool calls → model" iterations, not a strict limit on the number of individual tool calls: the model can return multiple tool calls in a single iteration.

### Reasoning and tool-call metadata

`sendMessageThroughAi()` saves additional assistant response metadata in two different formats: **flat** (for UI/clients) and **trace** (for AI context).

- `reasoning_content` — human-readable reasoning/thinking, if the provider returned it. Extracted from `message.reasoning_content` (DeepSeek/vLLM), `message.reasoning` (OpenRouter/vLLM), Anthropic-style `content[]` blocks with `type: "thinking"`, and from `response.output[]` items with `type: "reasoning"` for Responses-like format.
- `tool_calls` (in `AiSendResult` / `ChatSendResponse` / WS/SSE `done`) — **flat** list of `{ id, name, arguments, result_preview? }`, collected in parallel with the trace in `toolCallsHistory`. `result_preview` contains up to 250 characters of the tool response (via `formatToolResultPreview`) — for the desktop popover only.
- `tool_calls_json` (in DB) — **trace** format (array of `ToolIteration`), see [Tool calls trace and AI context](#tool-calls-trace-and-ai-context).
- `reasoning_content` **is not sent** back into the AI context (one-way model output).

DB:

- `chat_messages.reasoning_content TEXT` — concatenated reasoning across response steps.
- `chat_messages.tool_calls_json TEXT` — JSON in trace format (array of `ToolIteration`). Old records (flat array without the `step` field) are supported as a fallback on read.
- `chat_messages.subagents_json TEXT` — JSON array of full ad-hoc subagent traces (`SubagentTraceEntry[]`). Stored separately from `tool_calls_json`, **not sent** into the AI context (the model only sees the brief `spawn_subagent` result in `tool_calls_json`). Contains: task, system_prompt, tools, tools_used, answer, summary, aborted, trace (step-by-step tool calls).

Desktop shows these fields as expandable popover buttons on the assistant message. If reasoning or tool calls are missing, the corresponding button is not displayed. `getChatMessages()` expands the trace format back into a flat array with `result_preview` (trimmed to `slice(0, 250)`) on read.

### Tool calls trace and AI context

So that the model "remembers" the results of called tools on subsequent requests in the chat, the **full trace** of the agent loop by iterations is saved in `tool_calls_json` (type `ToolIteration` in `services/ai.ts`):

```ts
type ToolIteration = {
  step: number;        // marker of the new format + iteration number
  content: string;     // intermediate model text in this iteration (can be "")
  tool_calls: Array<{ id?: string; name: string; arguments: any }>;
  results: Array<{ id?: string; name: string; content: string }>;  // full runTool results (up to TOOL_RESULT_FULL_MAX = 10000 chars)
  is_final?: boolean;  // true on the final iteration without tool_calls (text only)
};
```

The marker of the new format is the `step` field on the first element of the array. Old records (flat `[{id, name, arguments, result_preview}]`) are identified by its absence.

**Trace collection in `sendMessageThroughAi()`:**

- On each iteration of the `while` loop, a `currentIteration` is created after `runCompletion`.
- `currentIteration.tool_calls` is filled from `message.tool_calls` (in the order returned by the model).
- After each `runTool()`, the full result (`toolContent`, trimmed to 10000 chars with a marker) is added to `currentIteration.results` in call order.
- The iteration is pushed to `iterations[]` after the full tool_calls cycle (if there was no abort/escalation to PRO).
- The final iteration without tool_calls is marked `is_final: true`.
- On LITE→PRO escalation (`escalate_to_pro`), the current iteration **is not saved** — history is rebuilt from scratch.

**Expansion in `getHistoryForAi()` (`services/chats.ts`):**

- SELECT added the `tool_calls_json` field.
- For user messages — `{role, content}` as before.
- For assistant messages with the new trace format — each iteration is expanded into the correct sequence of OpenAI-compatible messages:
  ```
  assistant(content: intermediate_text | null, tool_calls: [...])
    → tool(tool_call_id, name, content: full result) for each call
    → ... (next iteration)
    → assistant(content: final text)  ← iteration without tool_calls
  ```
- `content` for assistant(tool_calls) = the iteration's `intermediate content`, or `null` (when the model only called tools without text). OpenAI-compatible APIs require exactly `null`, not an empty string.
- If a tool_call has no `id` (some providers) — a stable fallback `call_{step}_{name}` is generated.
- For assistant messages with the **old flat format** or without `tool_calls_json` — fallback `{role: 'assistant', content}`. Tool context is lost (as before), but the chat doesn't break.

**Why this approach:**

- Solves model "amnesia" — it sees the full chain: which tools it called, what they returned, what intermediate text was between them.
- Doesn't require DB migrations: the same `tool_calls_json TEXT` column is used, just with different JSON inside.
- Reasoning is intentionally excluded — it's a one-way model output, not meant for contextual memory.
- Desktop is unaffected: the UI popover still works with the flat projection reconstructed from the trace in `getChatMessages()`.

**Size:** `results.content` is limited to `TOOL_RESULT_FULL_MAX = 10000` chars with a truncation marker. For typical chats this is sufficient; for extreme DevOps sessions with 50+ iterations — `MAX_TOOL_LOOPS` caps the trace length.

### Message Regeneration

Desktop can send `regenerate_from_history: true` along with `skip_user_history`.

- The backend removes trailing assistant messages from the working history, extracts the last user message, and adds it back exactly once as the current user request.
- `regenerate_hint` is appended to the current user request and is not saved as a new user message.

### Chat Fork (dialog branch)

Creates a new chat as a branch of an existing one — copies all messages from the original chat from the beginning through the specified message inclusive. The user can continue the conversation in the branch from the same context, without touching the original.

**Endpoint:** `POST /api/v1/chats/:sourceChatId/fork` ← `{ from_message_id, title? }` → `{ chat_id, forked_messages }`

**Behavior:**
- A new chat is created via the standard `createUserChat` and **becomes active**.
- **All** message columns are copied: `content`, `images`, `audio`, `reasoning_content`, `tool_calls_json`, `token_count`, `reasoning_tokens`, `attachments`, `subagents_json`, `archived`.
- `telegram_chat_id` / `telegram_message_id` are zeroed — the branch has no TG binding.
- `token_count` / `reasoning_tokens` are copied as-is (they are deterministic for the same content, no recomputation needed).
- The FTS index is updated automatically by the `trg_chat_messages_fts_ai` trigger.
- Archival (`archived`) is preserved as in the original; `trimUserHistoryByChat` will recalculate on the first new AI response in the branch.

**Default title (if no custom title is provided):**

A numeric prefix `[N]` is added:
- `"Report"` → `"[2] Report"`
- `"[2] Report"` → `"[3] Report"` (index is incremented)
- `"[5] [important] letter"` → `"[2] [5] [important] letter"` (new `[2]` at the front, other brackets are not touched)
- `"[note] text"` → `"[2] [note] text"` (inside brackets is not a number — not counted)

**Files (attachments vs images/audio):**

| Resource | Strategy | Reason |
|---|---|---|
| **Attachments** | **Physically copied** (`copyAttachmentFile`, new 24-hex random) | Deleting an attachment in one chat shouldn't break the other. Text is extracted once — `extracted_text` is copied as-is. |
| **Images** | Shared references (no copying) | There is no image deletion endpoint today — a shared reference is safe. When photo deletion is added — a "is this filename used in another chat" check will be needed. |
| **Audio** | Shared reference | There are no audio deletions in the code. |

**Orphan reference protection:** if the source attachment file was deleted from disk (but remains in JSON), `copyAttachmentFile` returns null and that entry is **omitted** from the new message's JSON — the UI won't show a broken tile.

**Service:** `forkChat()` in `services/chats.ts`. Copy helper: `copyAttachmentFile()` in `services/attachment-storage.ts`.

| Tool | Description |
|---|---|
| `search_web` | Web search (Tavily) |
| `read_webpage` | Read webpage text by URL |
| `control_smart_home` | Control a smart home device by device_id (call `get_smart_devices` first) |
| `get_smart_devices` | Returns a list of devices, rooms, and their IDs from the DB |
| `schedule_task` | Create a timed task/reminder. Types: `message` (reminder), `smart_home` (smart home command), `ai_instruction` (AI instruction — search, check email, analyze, etc., AI calls the needed tools itself). For `ai_instruction`, supports `target_chat_id` (which chat to save the result to) and `create_new_chat` (create a new chat). |
| `get_my_tasks` | List user's tasks |
| `delete_my_task` | Delete a task |
| `set_user_timezone` | Set timezone |
| `check_emails` | Search emails |
| `read_email_content` | Read email content |
| `send_email` | Send email (requires user confirmation — HitL `email_confirmation` card) |
| `save_note` | Save a note |
| `list_my_notes` | List notes |
| `read_note` | Read a note |
| `delete_note` | Delete a note |
| `update_core_memory` | Update static user profile |
| `search_cold_memory` | Search the vector archive |
| `save_to_cold_memory` | Save to the vector archive |
| `delete_from_cold_memory` | Delete from the vector archive |
| `random_roll` | Coin/dice roll |
| `generate_image` | Generate an image through OpenRouter and Grok Imagine. Automatically routed through PRO. |
| `get_exchange_rates` | Central Bank of Russia exchange rates with change dynamics. Returns USD and EUR by default. |

### Client Tools (desktop + Telegram)

Most tools are available both from desktop and from Telegram via SSE streaming. The split into `serverOnlyTools` and `desktopOnlyTools` is described in [Tool availability split](#tool-availability-split).

**Desktop-only (not available from TG):** `desktop_action` (desktop UI control), `invoke_subagent` (specialized subagents), `spawn_subagent` (ad-hoc subagents).

### Smart Home

Architecture: DB-driven, provider-agnostic (Yandex is currently implemented, foundation laid for Zigbee2MQTT).

**Two AI tools:**
- `get_smart_devices` — returns a JSON array of devices from the DB (`id`, `name`, `room`, `type`, `capabilities`). AI calls this first.
- `control_smart_home` — controls a device by `device_id` (obtained from `get_smart_devices`). Actions: `on`, `off`, `set_color`, `set_brightness`.

**Flow:** `get_smart_devices()` → AI selects a device → `control_smart_home({ device_id, action })` → `POST api.iot.yandex.net/v1.0/devices/actions`.

**DB tables:**
- `smart_home_settings` — provider OAuth token (AES-256-CBC encryption via `ENCRYPTION_KEY`), `synced_at`.
- `smart_devices` — flat list of devices: groups and individual devices. Groups take priority — devices inside groups are not duplicated. Fields: `id` (`yandex_group_*` / `yandex_device_*`), `name`, `room_name`, `provider`, `is_group`, `target_ids` (JSON array of real UUIDs for the API), `capabilities`.

**API endpoints:**
- `GET /api/v1/smart-home/settings` — status (whether token exists, `synced_at`)
- `GET /api/v1/smart-home/devices` — device list
- `POST /api/v1/smart-home/token` — save token `{ token }`
- `DELETE /api/v1/smart-home/token` — delete token + devices
- `POST /api/v1/smart-home/sync` — sync with Yandex (request `/user/info` → parse → upsert to DB)

**Sync:** the parser takes Yandex groups as priority entities. Devices that are part of groups are not added separately — this prevents duplication for the AI.

**AI routing:** Smart Home goes through the LITE router (cheap-route `SMART_HOME`), doesn't require a PRO model.

### Feature Flags (tool restrictions)

The system allows the user to selectively disable AI tools via checkboxes in the desktop app settings. Flags are stored in the DB (`users.feature_flags`, JSON) and applied by the server on every AI request.

**API:**

- `GET /api/v1/user/feature-flags` — returns current flags `{ flags: { ... } }`
- `PUT /api/v1/user/feature-flags` — saves flags `{ flags: { ... } }` (validated against a whitelist)

**Flags (JSON keys):**

| Key | UI name | Disabled tools |
|---|---|---|
| `disable_memory_write` | Disable data writing | `save_to_cold_memory`, `delete_from_cold_memory`, `save_note`, `delete_note` |
| `disable_pc_control_lite` | Limited mode | `execute_ssh_command`, `list_devops_servers`, `list_devops_runbooks`, `read_devops_runbook`, `suggest_devops_runbook`, `install_ssh_public_key`, `suggest_server_creds_update`, `create_server_user`, `change_server_user_password`, `execute_macro`, `suggest_macro`, `list_my_macros`, `send_email`, `schedule_task`, `delete_my_task` |
| `disable_pc_commands` | No PC commands | `execute_pc_command`, `get_file_info`, `read_file`, `search_file_keywords`, `write_file`, `edit_file_lines` |
| `disable_pc_control_full` | Full lockdown | Everything from lite + `execute_pc_command`, `get_file_info`, `read_file`, `search_file_keywords`, `write_file`, `edit_file_lines` + `control_smart_home`, `get_smart_devices`, `check_emails`, `read_email_content`, `get_my_tasks`, `explore_fs`, `desktop_action`, `map_control`, `get_map_pins`, `find_transit_route`, `search_nearby` |
| `disable_internet` | No internet & generation | `search_web`, `read_webpage`, `generate_image` |
| `disable_personal` | Guest mode | `update_core_memory`, `search_cold_memory`, `save_to_cold_memory`, `delete_from_cold_memory`, `save_note`, `list_my_notes`, `read_note`, `delete_note`, `schedule_task`, `get_my_tasks`, `delete_my_task` + hide prompt and hot memory from system prompt |
| `disable_specialized_subagents` | No specialized subagents | `invoke_subagent` |
| `disable_adhoc_subagents` | No subagent creation | `spawn_subagent` |

**How it works (ai.ts):**

1. All 3 handlers (TG internal `/internal/ai/send`, SSE `/api/v1/chat/send`, WS `chat_send`) load `feature_flags` from the user record via `parseFeatureFlags(user)`
2. Flags are passed to `sendMessageThroughAi({ featureFlags })`
3. In `sendMessageThroughAi`, a `disabledToolSet` (Set<string>) is built based on active flags
4. **Double protection:**
   - `executionTools.filter()` — tools are removed from the schema (the AI doesn't know they exist)
   - Guard before `runTool()` — even if the model hallucinates a tool call, `runTool` returns `"Tool disabled"` instead of executing
5. LITE router: if a cheap-route contains a disabled tool — PRO is forced
6. Guest mode (`disable_personal`): additionally clears `core_memory`, `custom_prompt`, and `pinned_macros` from the system prompt

**How to add a new flag:**

1. Add the key to `VALID_FLAG_KEYS` in `server.ts`
2. Add the key to the `FeatureFlags` type in `desktop-app/src/renderer/lib/api.ts`
3. Add tools to the corresponding `if (flags?.new_flag)` block in `ai.ts` (in `sendMessageThroughAi`)
4. Add a checkbox in `SettingsModal.tsx` (desktop)

**How to add a new tool that respects flags:**

A new tool will automatically be filtered if its `function.name` matches a name added to `disabledToolSet`. You need to add the tool name to the corresponding flag block in `ai.ts` (section `// ── Feature flags → disabled tools ──`).

### UI Settings

UI settings (desktop display) are stored in the canonical account row (`users.ui_settings`, JSON). They are shared by every identity attached to that account. The client applies them; the server only stores them.

The `parseUiSettings(user)` helper parses the JSON column, filters invalid keys/types, returns an object. On the client, `user?.ui_settings?.show_tokens !== false` means "enabled by default".

**Keys:**

| Key | Type | Default | Description |
|---|---|---|---|
| `show_tokens` | boolean | `true` | Show token counters (message badges, reasoning badge, top-bar context) |
| `dice_roll_enabled` | boolean | `false` | Dice d20 mode (roleplay). On each message, the backend rolls a d20 and injects the result into the bot's system prompt, affecting only the narrative tone of the response (not tool call execution). The roll result is pushed to clients via a separate `dice_roll` event immediately after the roll. See [Dice Roll Mode](#dice-roll-mode-d20). |

**API:**

- `GET /api/v1/user/ui-settings` — `{ settings: { show_tokens: true, dice_roll_enabled: false } }` (merged with defaults)
- `PUT /api/v1/user/ui-settings` — `{ settings: { show_tokens: false, dice_roll_enabled: true } }` (validated against whitelist `VALID_UI_KEYS`, merged with existing)
- The `ui_settings` field is also included in `/api/v1/auth/me` (via `toAuthUserDto`)

### Dice Roll Mode (d20)

A "dice" mode for roleplay fun. Enabled via a checkbox in the "Application" settings tab (`dice_roll_enabled` in `users.ui_settings`). The flag is server-side — applied for all clients (desktop + Telegram).

**Roll flow:**

1. The user sends a message.
2. `sendMessageThroughAi` reads `ui_settings.dice_roll_enabled` (via `parseUiSettings`), passed as `diceRollMode: true`.
3. If enabled — the server, **before starting the LLM request**, rolls `Math.floor(Math.random() * 20) + 1` (1..20). If the client sent `dice_mode: 'always_one' | 'always_twenty'` in the body, the server forces the result (1 or 20) via `diceRollForceValue` (helper `resolveDiceForceValue`). The mode is stored only on the client (desktop localStorage); the backend is stateless regarding the mode.
4. Immediately after the roll, `onDiceRoll(roll)` is called — the client gets the result instantly, without waiting for the AI response.
5. The result is injected at the beginning of `proSystemPrompt` via `buildDiceRollPrompt(roll)` (see full hint text in `services/ai.ts`).
6. After generation completes, `dice_roll` is duplicated in the `done` payload (as a fallback in case the realtime event is lost).

**Dice hint prompt:**

```text
[DICE ROLL MODE: ACTIVE]
The user rolled a d20 for this specific message.
Dice Roll Result: {roll} out of 20.

You MUST adapt the outcome and narrative tone of your response based strictly on this result:
- 1 (Critical Failure): spectacular failure with severe or unexpected consequences appropriate to the scene
- 2–9 (Failure): meaningful obstacles, complications, or unintended consequences
- 10–19 (Success): a capable and convincing success appropriate to the strength of the roll
- 20 (Critical Success): exceptional success with an impressive advantage, unexpected benefit, or memorable outcome

CRITICAL SYSTEM RULE: required tool calls are always executed normally. The dice affects the narrative interpretation, consequences, and tone, but never fabricates, alters, hides, or sabotages real tool results.
```

**`dice_roll` event (WS + SSE):**

| Channel | Format |
|---|---|
| WS (`chat_send` response) | `{ type: 'dice_roll', roll: number }` |
| SSE `/api/v1/chat/send` | `event: dice_roll\ndata: { "roll": 13 }` |
| SSE `/internal/ai/stream` (TG) | `event: dice_roll\ndata: { "roll": 13 }` |

The `dice_roll` field is also included in `AiSendResult` (`done` payload) for recovery in case the realtime event is lost.

**`diceRollMode` propagation points:**
- `/api/v1/chat/send` (SSE desktop) — `parseUiSettings(rawUserRecord).dice_roll_enabled`
- WS `chat_send` — same
- `/internal/ai/send` and `/internal/ai/stream` (TG) — `parseUiSettings(tgUser).dice_roll_enabled`

### Client Tools — continued

| Tool | Description |
|---|---|
| `set_display_state` | Control the pixel avatar. Enum values (moods/reactions) are taken from `display_manifest` — an array passed by the client in the body. If no manifest (Telegram) — the tool is not added. |
| `desktop_action` | Unified router for desktop app UI control. Actions: `open_widget`, `close_widget`, `set_widget_data`, `open_note`, `read_widget_state`, `toggle_panel`. Targets: `notebook`, `tasks`. Allows the bot to open/close widgets, create note drafts, open specific notes by ID, read state. |
| `map_control` | Control the map in the desktop. Actions: `show_place` (geocoding via Nominatim), `draw_route` (routing via OSRM). Result is sent as an SSE `event: map_update`. |
| `get_map_pins` | Get the user's saved map pins. Returns decrypted coordinates + labels. |
| `find_transit_route` | Search public transit routes (bus, share_taxi, trolleybus, tram) via Overpass API. Accepts coordinates of point A and B, optionally `radius_meters` (default 500). Auto-retry with radius expansion if nothing is found. Returns a text description of routes (available to all clients) + sends visuals to the map via SSE (desktop-only). |
| `search_nearby` | Search establishments and objects (POI) near a point by name via Overpass API. Accepts coordinates, a query text (`query`), and `radius_meters` (default 3000). Searches by `name` (regex, case-insensitive) among nodes and ways. Returns a list of places with address/hours (available to all clients) + sends markers to the map via SSE (desktop-only). Auto-retry with radius expansion. |
| `list_my_macros` | Shows the user's enabled macros (id, title, description, commands). Lazy loading — the AI calls the tool when a pinned macro is mentioned or the user asks to run a macro. |
| `execute_macro` | Runs a macro by `macro_id` (number) or `macro_name` (string). If `return_output: true` and the desktop is connected via WS — waits for the result (stdout). Otherwise — fire-and-forget via `desktop_action` (SSE/WS). Also available from Telegram: if the desktop is online — commands are pushed via WS. |
| `explore_fs` | Read a directory on the user's PC. If the desktop is connected via WS — returns a listing (name, type, size) as a tool response for the AI. Otherwise — fire-and-forget (result unavailable to the AI). Also available from Telegram when the desktop is connected. |
| `get_file_info` | Returns path metadata on the PC without reading content: `exists`, type, `size_bytes`, timestamps, name, and extension. Parameter `include_line_count=true` additionally counts lines by streaming through the file and returns `line_count`; use only when the line count is actually needed. Requires `fs_scan_enabled`, same as `explore_fs`. |
| `execute_pc_command` | Executes a command on the user's PC via desktop IPC. Parameters: `command` and optional `background`. For GUI/open scenarios (`notepad`, `code`, browser, open file/folder), where stdout/stderr is not needed, the AI should set `background: true`: the desktop launches the command detached and immediately returns a result. Regular commands with output go with `background=false`/no parameter. Non-auto-approved commands require a HitL `pc_command_confirmation` card; the pending is registered before sending the card, and the card itself goes through the current WS callback of the active `chat_send`. The AI receives the last 15k characters of stdout/stderr (`PC_COMMAND_OUTPUT_MAX`). |
| `read_file` | Reads a file on the user's PC natively via Node.js fs (bypassing the terminal). Parameters: `file_path`, `start_line` (default 1), `max_lines` (default 500, max 2000), `line_numbers` (default false). With `line_numbers=true`, each line has a line number prefix (`cat -n` format). Returns UTF-8 content with pagination. Supports `.docx` via mammoth. If `file_read_enabled=true` — executes immediately; otherwise requires a HitL `file_action_confirmation` card. |
| `search_file_keywords` | Searches for keywords/phrases in a specific file on the PC and returns only matching lines with line numbers. Parameters: `file_path`, `query`, `max_matches` (default 100, max 500). Convenient for large files before a targeted `read_file`. |
| `write_file` | Writes a file on the user's PC natively via Node.js fs. Parameters: `file_path`, `content`, `mode` (`overwrite`/`append`). Supports `.docx` — generates a valid Word document (each line = paragraph, `overwrite` only). **Always requires a HitL `file_action_confirmation` card** (ignores auto-approve). Content limit: 5 MB. Writing to system directories (`C:\Windows`, `/etc`, `/usr`, `/bin`) is blocked. |
| `edit_file_lines` | Surgically replaces lines in a file via `Array.splice`. Parameters: `file_path`, `start_line`, `end_line`, `new_content`. Supports replace, insert (`end_line = start_line - 1`), and delete (`new_content = ""`). Before HitL, the backend reads the old lines for a diff preview. **Always requires a HitL `edit_file_lines_confirmation` card** with a visual diff (red/green). Does not support `.docx`. |
| `suggest_macro` | Suggests the user save a new macro. The AI generates `title, description, commands` → SSE `desktop_action` with `action: suggest_macro` → the desktop client renders a "Save/Reject" card. Can be called multiple times in a single response (multiple cards). |
| `invoke_subagent` | Delegates a task to a specialized subagent from the static registry. Dynamically generated from `services/subagents/registry.ts`. Added only when `isDesktop=true` and there are registered subagents. |
| `spawn_subagent` | Creates an ad-hoc subagent on the fly: the model defines a task, optional system prompt, a set of tools, and an iteration limit (1–50). **All** runtime tools are available (except `spawn_subagent` / `invoke_subagent`). Multiple calls in the same iteration run in parallel (up to `MAX_PARALLEL_SPAWN_SUBAGENTS = 3`). Added only when `isDesktop=true`. The full trace is saved in `subagents_json` separately from `tool_calls_json`. |

HitL rejections (`pc_command_confirmation`, file/email/devops confirmations) can pass a `rejection_comment`. The backend forwards it into the tool response as `user_comment`, so the model can understand what the user wants changed.

### DevOps Agent Runtime — continued

A system for remote SSH command execution on user servers with Human-in-the-Loop (HitL) confirmation. Available from desktop and Telegram.

**AI tools (desktop + Telegram via SSE):**

| Tool | Description |
|---|---|
| `list_devops_servers` | Shows the user's server list (id, name, host, port, username). No passwords/keys. |
| `execute_ssh_command` | Executes an SSH command on a server. First checks auto-approve policies → if there's a match, executes immediately. Otherwise — sends a confirmation card to desktop (HitL), blocks the tool call until the user responds. |
| `list_devops_runbooks` | Shows the user's runbook list (id, title, updated_at). |
| `read_devops_runbook` | Reads runbook content by id (title, content). |
| `suggest_devops_runbook` | Suggests the user save a runbook. The AI generates `title, content, commands` → a card in chat with "Save"/"Check"/"Reject" buttons. |
| `install_ssh_public_key` | Installs a public SSH key into the selected user's `authorized_keys`. If `key_id` is not specified, the server's default key is used. |
| `create_server_user` | Creates a Linux user with a sudo group. The new user's password is taken from the server's `sudo_password`; if not saved, the user enters it in the confirmation card. `nopasswd_sudo` defaults to `false`. |
| `change_server_user_password` | Changes an existing Linux user's password. The new password is entered by the user in the confirmation card and is not passed in the tool call arguments. |
| `suggest_server_creds_update` | Suggests updating server credentials: `username`, `use_ssh_key_for_login`, optionally clear the plain SSH `password`. Blocks the tool call until user confirmation. |

**Security architecture:**

- **Encryption:** all credentials (SSH password, private key, sudo password) are encrypted with AES-256-CBC and stored in `devops_servers`. Decryption only happens in-memory at the moment of command execution.
- **Human-in-the-Loop:** every SSH command (except auto-approved) requires user confirmation. A card with command info is sent simultaneously to desktop (WS `desktop_action`) and Telegram (SSE `desktop_action` → inline buttons). Buttons: "Allow" / "Always allow" / "? Check" / "Reject".
- **Auto-approve policies:** regex patterns for automatic command approval. Created manually or when attaching a runbook to a server. Exact match example: `^systemctl restart nginx$`.
- **Dangerous commands:** blocked at the SSH-executor level (`rm -rf /`, `mkfs`, `dd of=/dev/`, `shutdown`, `init 0/6`, `chmod 000 /`, `chown` of root directories).
- **Sudo:** if the command contains `sudo` and the server settings specify a sudo password — the password is passed via stdin stream (`sudo -S`), not visible in the process list.
- **Buffer:** stdout/stderr is limited to 1MB, execution timeout — 30 seconds.

**SSH/password fields:**

- `password` — regular SSH login password. Not used if `use_ssh_key_for_login=true`.
- `private_key` / `default_ssh_key_id` — keys for login/installation. The default key can be stored on the server and installed for users via `install_ssh_public_key`.
- `use_ssh_key_for_login` — explicit checkbox for login method. If `true`, the backend logs in with the default SSH key; if the key doesn't work, no password fallback.
- `sudo_password` — password for `sudo -S` and the password used in `create_server_user` if the new user needs a password.
- `change_server_user_password` doesn't use `sudo_password` as the new password: the new password is entered separately in the confirmation card as `new_password`.

**Command execution flow:**

```
AI: execute_ssh_command(server_id, command)
  → ai.ts: check isAutoApproved()
    → Yes: direct call execSshCommand() → stdout/stderr/exitCode
    → No: dual-delivery of confirmation card:
        ├─ TG (SSE): inline buttons Allow / Always allow / Check / Reject
        └─ Desktop (WS): desktop_action { action: 'devops_confirmation' }
      → ai.ts: block on Promise (waiting for response from either source)
      → Allow: POST /internal/devops/approve { approved: true }
      → Always allow: creates policy + approve
      → Check: POST /internal/ai/lite (LITE AI safety analysis)
      → Reject: POST /internal/devops/approve { approved: false }
      → Promise resolves → execSshCommand() → result to AI
```

**Runbooks:**

Universal step-by-step guides (Markdown) with a set of shell commands. Not tied to a specific server.

- The AI can suggest saving a runbook (`suggest_devops_runbook`) — a card in chat
- The AI can extract commands from text (`POST /api/v1/devops/runbooks/extract-commands`, LITE AI)
- The AI can review command safety (`POST /api/v1/devops/runbooks/review-commands`, LITE AI)
- The "Attach runbook" button in server settings creates auto-approve policies for each command

**DB tables:**

| Table | Description |
|---|---|
| `devops_servers` | SSH servers (name, host, port, username, password_enc, private_key_enc, sudo_password_enc, default_ssh_key_id, use_ssh_key_for_login) |
| `devops_policies` | Auto-approve policies (server_id, pattern, auto_approve) |
| `devops_runbooks` | Runbooks (user_id, title, content, commands JSON) |

**Confirmations (in-memory):**

Pending confirmations are stored in a `Map<string, PendingDevopsConfirmation>` in `services/devops-confirmations.ts`. Auto-cleanup every 30 seconds, TTL — 5 minutes.

### Macro System

Macros are user-defined sets of console commands that the AI can run on the desktop client.

**Storage:** `macros` table in SQLite (`services/macros.ts`):
- `id INTEGER` (auto-increment), `user_id`, `title`, `description`, `commands` (JSON), `enabled`, `pinned`, `return_output`, `created_at`, `updated_at`
- Limit: 50 macros per user
- Commands stored as a JSON array of strings, max 30 commands per macro

**Macro fields:**
| Field | Type | Description |
|---|---|---|
| `title` | string | Name (up to 100 characters) |
| `description` | string | Description (up to 500 characters), can be AI-generated |
| `commands` | string[] | Array of console commands |
| `enabled` | boolean | Enabled/disabled |
| `pinned` | boolean | Pinned — the name is added to the system prompt as a hint for the AI |
| `return_output` | boolean | If `true` — the bot waits for command stdout from the desktop (requires WS connection). If the desktop is not connected — fire-and-forget |

**AI macro visibility architecture:**
1. **Pinned hint** — if a macro has `pinned: true`, its name is added to the system prompt: `[PINNED MACROS] The user has ... "Macro 1", "Macro 2". If a request matches — call list_my_macros.`
2. **Lazy loading** — the AI calls `list_my_macros` to see the full list with commands, then `execute_macro` to run a specific macro
3. Macros are loaded from the DB (`getEnabledMacros(userId)`) on every request, not passed by the client
4. Macros are available from all clients (desktop, Telegram), not just desktop

**TG→Desktop push (running a macro from Telegram):**
- The `/internal/ai/send` endpoint passes `activeMacros` to `sendMessageThroughAi`
- If the AI calls `execute_macro` (fire-and-forget), the result is written to `desktopActionSink`
- After `sendMessageThroughAi` returns, server.ts checks `result.desktop_action` and `isDesktopOnline(userId)`
- If the desktop is connected via WS — `desktop_action` is pushed via WebSocket
- The desktop client, upon receiving `desktop_action` with `action === 'execute_macro'`, executes the commands via `electronAPI.executeCommands()`
- Requirement: the canonical account must have both Telegram and password identities, and the Desktop client for that account must be connected through WebSocket.

**Macro execution flow:**
1. The AI sees a pinned hint or the user asks to run a macro
2. The AI calls `list_my_macros` → gets the list (id, title, description, commands)
3. The AI calls `execute_macro` with `macro_id` or `macro_name`
4. The backend finds the macro in `activeMacros`, builds an SSE payload: `{ action: 'execute_macro', target: '<macro_id>', value: { macro_name, commands } }`
5. The server sends an SSE `event: desktop_action` → the desktop client receives the payload
6. `handleDesktopAction()` in `tools.ts` extracts `commands` from the payload and calls `window.electronAPI.executeCommands(commands)`
7. Electron IPC `execute-commands` executes the commands sequentially via `child_process.exec` with blocking of dangerous commands

**AI macro assistants (lightweight LITE requests via `callLiteAi`):**
- `POST /api/v1/macro/explain` — AI explains what the commands do
- `POST /api/v1/macro/describe` — AI suggests a better title and description (sends current `current_title`/`current_description` for improvement)

**Macro suggestion (`suggest_macro`):**
1. The AI decides to suggest the user save a macro → calls `suggest_macro` with `title, description, commands`
2. SSE `desktop_action` with `action: 'suggest_macro'` → the client renders a card
3. The user clicks "Save" → POST `/api/v1/macros` → the macro is saved to the DB
4. Multiple cards can exist simultaneously (array `pendingMacros`)

**Limitations (current):**
- Dangerous commands are blocked at the IPC level (`rm -rf /`, `format`, `shutdown`, etc.)
- `return_output` and `explore_fs` require a WS-connected desktop; without WS — fire-and-forget
1. The AI calls the `desktop_action` tool → `runTool` parses action/target/value → writes to `desktopActionSink`
2. The server sends an SSE `event: desktop_action` with the payload to the client
3. The client (`handleDesktopAction`) executes the command: opens a panel, toggles a widget, fills a draft, etc.
4. The result is also returned in the `done` event as `desktop_action`

**`map_control` flow:**
1. The AI calls the `map_control` tool → `runTool` geocodes the address (Nominatim) or builds a route (OSRM)
2. The result is written to `mapUpdateSink` → the server sends an SSE `event: map_update` with `{ action, lat, lng, label, from?, to?, route? }`
3. The client catches `onMapUpdate` → opens MapTool, updates the map (flyTo / fitBounds / polyline)
4. Route coordinates are converted from OSRM [lng,lat] to Leaflet [lat,lng]

**`find_transit_route` flow:**
1. The AI calls the `find_transit_route` tool with coordinates `from_lat, from_lon, to_lat, to_lon`, optionally `radius_meters` (default 500)
2. `runTool` calls `services/transit.ts` → Overpass API query finds OSM route relations (bus, share_taxi, trolleybus, tram). Auto-retry with radius expansion if nothing is found
3. Parse response: `members` with `role=stop|platform` → stops, `type=way` → route geometry (polyline)
4. For each route: haversine distance → nearest stops to point A (pickup) and B (dropoff) → trim stops/path to the segment between them → scoring by min walking distance
5. The best option is sent to `mapUpdateSink` with `action: 'transit_route'` → SSE `event: map_update` with `{ action, routeName, path (sliced), stops (sliced) }`
6. The AI gets JSON with `pickupStop`, `dropoffStop`, `stopsToRideList`, `totalWalkingMeters` — formulates the response (available to all clients)
7. On the desktop client, MapTool renders a green polyline (only the ride segment) + orange stop markers + fitBounds

**`search_nearby` flow:**
1. The AI calls `search_nearby` with `latitude, longitude, query, radius_meters?`
2. `runTool` calls `services/transit.ts` → Overpass searches nodes/ways with `name~"query"` in the specified radius
3. The response is parsed: coordinates, name, address, opening hours, category are extracted
4. The result is written to `mapUpdateSink` with `action: 'poi_search'` → SSE `event: map_update` with `{ action, lat, lng, query, places }`
5. The tool returns a textual JSON with a list of found places — the AI formulates the response (available to all clients)
6. On the desktop client, MapTool renders purple POI markers + flyTo the first result
7. Auto-retry: if the search in the specified radius is empty, the backend expands the radius and retries

**Pin storage:**
- `map_pins` table: `id, user_id, lat_enc, lng_enc, label, created_at, updated_at`
- Coordinates are encrypted via `aes-256-cbc` with the key from `MAP_PINS_ENCRYPTION_KEY` (fallback to `ENCRYPTION_KEY`)
- The bot gets decrypted coordinates via the `get_map_pins` tool
- The client manages via REST API `/api/v1/map-pins`

## Common Errors

- `400` — bad input (`bad_*`, `*_required`).
- `401` — invalid token (`unauthorized`, `unauthorized_internal`).
- `403` — access denied (`access_not_approved`, `forbidden_admin_only`).
- `404` — entity not found (`user_not_found`, `note_not_found`, etc.).
- `409` — conflict (`name_already_exists`, `login_already_exists`).
- `422` — business restriction (`cannot_delete_default_prompt`, `cannot_ban_admin`).
- `429` — rate limits.
- `500` — internal error (`internal_error`/`*_failed`).

## Full-Text Search (FTS5)

Message search uses the built-in SQLite full-text index (FTS5). The `messages_fts` table is created automatically on first startup and populated from existing `chat_messages`.

### How It Works

- **Index:** virtual table `messages_fts USING fts5(content, user_id UNINDEXED, chat_id UNINDEXED, message_id UNINDEXED, tokenize="unicode61")`. The `unicode61` tokenizer supports Cyrillic out of the box.
- **Auto-update:** triggers on INSERT/DELETE in `chat_messages` automatically add/remove records from FTS.
- **Fallback:** on every server startup, the presence of triggers is checked. If at least one is missing — both are recreated, and FTS is fully rebuilt from `chat_messages`. This guarantees index completeness after failures.
- **Search:** prefix-based (`word*`) — searches by word part. Results are grouped by `chat_id`, sorted by relevance (`rank`). For each chat, a `snippet()` is returned — a fragment of text with the match highlighted.

### Security

- Search is scoped by `user_id` — the user only sees their own messages.
- Minimum query length: 3 characters.
- Results are limited by `LIMIT` (default 20, max 50).
- The client uses debounce (300 ms) — no more than ~3 requests/sec.

## Currency Rates (Central Bank of Russia)

Automatic currency rate updates from the Central Bank of Russia. Free, no auth keys required.

### Architecture

- **Source:** `https://www.cbr.ru/scripts/XML_daily.asp` — XML with all currency rates.
- **Parser:** `fast-xml-parser`. Caveat: the CBR returns values with a comma (`89,1234`) → `.replace(',', '.')` → `parseFloat`.
- **Storage:** `currency_rates` table — `code` (PK), `name`, `value`, `prev_value`, `nominal`, `updated_at`. On update, the old `value` flows into `prev_value`.
- **Updates:** the scheduler fetches the API on startup, then every day at ~14:00 MSK (11:00 UTC) — the CBR updates rates around that time.
- **Service:** `services/currency.ts` — `fetchAndSaveCurrencyRates()`, `getCurrencyRates()`, `formatRateForAi()`.

### AI Tool

- `get_exchange_rates` — returns rates with dynamics. If no code is specified — defaults to USD and EUR.
- Response format: `USD (US Dollar): 89.5000 RUB (-0.5000)`

## WebSocket Transport

WebSocket server on the same port (3050), path `/ws`, authenticated via JWT access token in the query parameter. The desktop client connects on app startup, auto-reconnect (exponential backoff 1s → 30s). The `POST /api/v1/chat/send` endpoint works via SSE (Server-Sent Events) and is used as a fallback (if WS is not connected). Event format: `intermediate`, `tool_status`, `display_state`, `done`, `error`. Image validation remains a regular HTTP error (before switching to SSE).

### Architecture

- `ws-clients.ts` — general connection registry (`wsClients` Map), `sendIpcToDesktop()`, `sendToDesktop()`, `isDesktopOnline()`. For each connection, `connectionId`, `connectedAt`, `lastMessageAt`, `lastPingAt`, `lastPongAt`, `missedPongs` are stored. The online check requires `WebSocket.OPEN` and a fresh `lastPongAt` (grace window 75s), so a stale socket is not considered working.
- `server.ts` — `WebSocketServer` on `/ws`, handlers for `chat_send` / `ipc_result` / `ping` / `pong`. Server heartbeat every 25s sends `{ type: 'ping' }`; if `pong` doesn't arrive within the grace window, the connection is `terminate()`-ed, and pending IPC is rejected. Realtime callbacks (`desktop_action`, `tool_status`, `execute_ipc`) are sent with callback-error handling on `ws.send`.
- `ai.ts` — `execute_macro`, `explore_fs`, and `execute_pc_command` use desktop IPC for requests awaiting a result; `execute_pc_command` with HitL sends confirmation via the callback of the current `chat_send`.
- IPC diagnostics write logs `[pc_command] ...` and `[ipc] ...` (dispatch, write complete, `ipc_result`, timeout, resolve/reject), linked by `request_id`.

### Unlocked Features (via IPC)

- `explore_fs` — the AI gets a directory listing as a tool response (previously fire-and-forget).
- `execute_macro` with `return_output: true` — the AI gets command stdout (previously didn't work).
- Reverse channel: the server sends `execute_ipc` with a `request_id` → the desktop executes IPC → responds with `ipc_result`.

### WS Message Protocol (JSON `{ type, ...data }`)

| Client → Server | Description |
|---|---|
| `chat_send` | Send a message to AI |
| `chat_stop` | Stop the current AI generation for the user |
| `ipc_result` | IPC command result |
| `ping` | Keepalive |
| `pong` | Response to server heartbeat `ping` |

| Server → Client | Description |
|---|---|
| `intermediate` | Intermediate AI text (between tool-call iterations) |
| `stream_token` | Real-time text chunk from the model (token-by-token, ~20 FPS) |
| `reasoning_token` | Reasoning chunk (DeepSeek `reasoning_content`, OpenRouter `reasoning`) |
| `display_state` | Avatar state |
| `desktop_action` | UI command / macro |
| `tool_status` | Tool execution status |
| `map_update` | Map data |
| `dice_roll` | d20 roll result in Dice Roll Mode (arrives immediately after the roll, before `done`) |
| `task_result` | Scheduler task execution result: `{ chat_id, text, is_new_chat }`. If the chat is open — desktop reloads messages; if a different chat — the unread badge is incremented. |
| `done` | Final response |
| `error` | Error |
| `execute_ipc` | Request to execute IPC and return result |
| `ping` | Server heartbeat; desktop must respond with `pong` |
| `pong` | Response to client `ping` |

### Stopping Generation (`chat_stop` / `/api/v1/chat/stop`)

- For each `sendMessageThroughAi`, one `AbortController` is created and immediately registered in `activeGenerations` by `userId`.
- `chat_stop` via WS and `POST /api/v1/chat/stop` do the same thing: find the user's controller and call `abort()`.
- The normal request flow doesn't change: `sendMessageThroughAi` → `runCompletion` → `runTool` → final `runCompletion`. The `AbortSignal` is only propagated to waiting points.
- The signal is listened to by OpenAI requests, retry pauses, tool waiting via `withAbort`, desktop IPC (`sendIpcToDesktop`), and Tavily web-search transport via `fetch(..., { signal })`.
- `finally` removes the controller from `activeGenerations` only if it's the same controller, so an old completed request doesn't clear the new request's controller.

## SSE Streaming and Dual-Delivery of Confirmations

### Scheduler (scheduled tasks)

The scheduler executes deferred tasks. Lives in `services/scheduler.ts`, runs via `setInterval` (default every 30 sec, configurable via `BACKEND_SCHEDULER_INTERVAL_MS`). Enabled via `BACKEND_SCHEDULER_ENABLED=1`.

**Task types:**

| task_type | What it does |
|---|---|
| `message` | Returns the payload as a reminder, saves to chat as an assistant message |
| `smart_home` | Controls a device via `runSmartHomeControl()`, saves the result to chat |
| `ai_instruction` | Calls `sendMessageThroughAi()` with the instruction from the payload. The AI calls the needed tools itself (`search_web`, `check_emails`, etc.). Saves the full response (including tool_calls, reasoning) to chat. |

**`ai_instruction` parameters in payload:**
- `_target_chat_id` — chat ID for the result. If not specified — the active chat is used.
- `_create_new_chat` — `true` creates a new chat. `_target_chat_id` is ignored.

**Auto-reject HitL (automatic confirmation rejection):**

Tasks run in auto mode — confirmations (HitL) are automatically rejected if the command doesn't pass auto-approve. Implemented via the `autoRejectHitl: true` flag in `sendMessageThroughAi`, which is passed to `runTool`. The check is placed before every `registerPending*` call (10 points). Auto-approve policies (`auto_approve_all`, regex patterns) fire as usual — before the `autoRejectHitl` check.

**Result delivery (`deliverTaskResult`):**
- If the desktop is online — push via WS: `{ type: 'task_result', chat_id, text, is_new_chat }`
- Always — send to Telegram via `sendTelegramMessage()` (Rich HTML when `TG_USE_RICH_MESSAGES=1` or compatible `TG_USE_RICH_STREAMING=1`, fallback to Markdown/plain, splitting long texts)

**Isolation from regular chat:**
- The `isBackgroundTask: true` flag — a scheduler task is not registered in `activeGenerations`, and a regular user message doesn't cancel it.
- `forcePro: true` — uses the PRO model. Scheduled runs are not counted as user messages.

**General Telegram send utility:** `services/telegram-send.ts` — `sendTelegramMessage()`, `markdownToTelegramRichHtml()`, `splitTextForTelegram()`, `formatForTelegram()`. Used by the scheduler and the `send-to-telegram` endpoint.

- `sendMessageToTelegram` from desktop calls `POST /api/v1/messages/:id/send-to-telegram`.
- Text-only messages and remaining text after media caption go via `sendTelegramMessage(..., { strict: true, preferRich: true })`.
- This is not streaming: the endpoint sends a single final `sendRichMessage`, without `sendRichMessageDraft`.
- On rich send, Markdown is converted to Telegram Rich HTML via `marked` with a custom renderer; if `sendRichMessage` is unavailable or fails, the sender falls back to the old `sendMessage`.
- The endpoint checks `sendPhoto` / `sendMediaGroup` / `sendMessage` responses and returns `telegram_send_failed` if the Telegram API actually refused, so desktop doesn't show a false success.

### SSE Streaming

Streaming AI responses for the TG bot (instead of the regular JSON `/internal/ai/send`). Passes `onIntermediateMessage`, `onToolStatus`, `onDesktopAction` callbacks to `sendMessageThroughAi`, allowing the TG bot to get the AI's progress in real time.

**SSE events:**

| Event | Payload | Description |
|---|---|---|
| `intermediate` | `{ text }` | Intermediate AI text |
| `tool_status` | `{ text }` | Tool status |
| `display_state` | `{ state, ... }` | Avatar state |
| `desktop_action` | `{ action, target?, value? }` | Confirmation card / macro |
| `dice_roll` | `{ roll }` | d20 roll result (only if `dice_roll_enabled` is on), arrives immediately after the roll |
| `done` | `{ reply_text, chat_id, message_id, dice_roll?, ... }` | Final AI response |
| `error` | `{ error }` | Error |

### Dual-Delivery of Confirmations

Confirmation cards (`pc_command_confirmation`, `devops_confirmation`, `suggest_server_creds_update`, `create_server_user`, `change_server_user_password`, `email_confirmation`) are delivered via **one** of two channels: either via the `onDesktopAction` callback (if one is passed — SSE for TG or WS for desktop), or via `sendToDesktop` directly (fallback if no callback). If both TG (via SSE) and desktop (via WS) are online simultaneously — the card goes to both channels; whoever responds first resolves the Promise, the second is ignored. Deduplication by `confirmation_id` on the client side protects against potential duplicates.

### Tool availability split

Tools are divided into two groups:

- **`serverOnlyTools`** (always available, without `isDesktop`): SSH, DevOps, PC commands, maps, transit.
- **`desktopOnlyTools`** (only `isDesktop=true`): `desktop_action` (UI control).
- `invoke_subagent` — only `isDesktop=true`.
- `spawn_subagent` — only `isDesktop=true`.

### Intermediate content: `fullDbHistory`

`sendMessageThroughAi` always returns `fullDbHistory` (accumulated text across the entire cycle), not `finalAnswer` (the last chunk). This ensures the desktop `done` handler doesn't overwrite intermediate content with the last chunk. Previously, if the AI generated text + a tool call simultaneously, the text went via `onIntermediateMessage`, and `done` contained only the last chunk.

**Real-time callbacks in `sendMessageThroughAi`:**
- `onIntermediateMessage` — text generated on intermediate steps (text + tool call simultaneously).
- `onStateChange` — instant avatar state changes when `set_display_state` is called.
- `onToolStatus` — statuses like "Searching for information..." in real time.
- `onStreamToken` — text tokens from the model in real time (token-by-token streaming).
- `onReasoningStream` — reasoning tokens (DeepSeek `reasoning_content`, OpenRouter `reasoning`) in real time.

### Token-by-token streaming

Character-by-character streaming of the AI response (like ChatGPT) instead of chunks after tool-call iterations.

**Architecture — "stream and assemble" strategy:**

The `streamAndAssemble()` helper in `services/ai.ts` enables `stream: true` in the request to the provider, reads the stream chunk by chunk, simultaneously:
1. **Assembles** the message (`content`, `reasoning_content`, `tool_calls`) in memory.
2. **Propagates** tokens to `onToken`/`onReasoningToken` callbacks (throttled by time).

Returns an object of the same format as `client.chat.completions.create()` — `{ choices: [{ message }] }`. The agent loop, `runTool`, scheduler, vision — none of them notice.

**Throttling:**
- **Backend:** `STREAM_FLUSH_INTERVAL_MS = 50` in `services/ai.ts` (~20 FPS). This is the main speed limit for incoming `stream_token` / `reasoning_token` in WS/SSE. Buffers accumulate, flush on timer. Guaranteed final flush in `try/catch` — tokens are not lost on provider error.
- **Desktop:** `requestAnimationFrame` throttle. Buffers accumulate between frames, one `setState` per frame. Flush before `onDone`/`onError`/`onIntermediate`.

**Callback cascade:**
```
streamAndAssemble (throttle 50ms)
  → StreamCallbacks.onToken / onReasoningToken
    → createCompletionWithModelFallback
      → createCompletionWithProProviderFallback / Lite
        → runCompletion (streamCallbacks parameter)
          → sendMessageThroughAi (options.onStreamToken / onReasoningStream)
            → WS { type: 'stream_token' } / SSE event: stream_token
              → desktop api.ts → ChatPage streamAppenderRef
```

**What is NOT streamed:**
- Vision requests (`vision-pro`, `vision-lite`) — photo analysis, not a dialog.
- Lite router (intent classification) — a fast single request.
- Scheduler tasks (background) — nowhere to push the stream.
- Subagents — may be added later.

**Assembling `tool_calls` from deltas:**
OpenAI/DeepSeek send tool_calls fragmented — by index. The helper assembles via `Map<index, { id, type, function: { name, arguments } }>`, appending `function.arguments` piece by piece. At the end, sorted by index.

**Reasoning fields:**
Both variants are supported:
- `delta.reasoning_content` (DeepSeek R1, native vLLM)
- `delta.reasoning` (OpenRouter for some providers)

**Abort:**
- `signal` is passed in `create()` options → the SDK itself calls `stream.controller.abort()`.
- Additionally — manual `signal?.aborted` check in the loop with `throw new AbortError`.

**WS/SSE events:**

| Event | Channel | Payload | Description |
|---|---|---|---|
| `stream_token` | WS / SSE | `{ text }` | Text chunk (throttled ~20 FPS) |
| `reasoning_token` | WS / SSE | `{ text }` | Reasoning chunk |

`intermediate` events (text between tool-call iterations) and `stream_token` (character-by-character text within an iteration) **do not conflict** — on the desktop side, `flushNow()` is called before `onIntermediate` to separate steps.

**Desktop UI during streaming:**
- `reasoning_token` creates a temporary assistant message just like `stream_token`, so the reasoning button appears immediately and can be expanded during generation.
- While there is reasoning but no regular content text yet, the temporary assistant message bubble shows animated typing dots instead of an empty tile.
- The `Reasoning...` button uses the same toggle control as regular `Reasoning`, so the popover opens/closes without waiting for `done`.

**Model fallback during streaming:**
If the first model crashes mid-stream, the user sees partial text. The fallback cascade (`createCompletionWithModelFallback`) catches the error and tries the next model. Streaming starts anew. This is currently acceptable — fallback rarely triggers.

### Soft Abort (stopping generation with preservation)

When generation is stopped (`chat_stop` / `POST /api/v1/chat/stop`), the bot **does not delete** what was already generated. Instead:

1. The tool-calls loop is interrupted (`break` instead of `throw AbortError`) — even a partial iteration is saved.
2. All accumulated artifacts (`answer`, `reasoningParts`, `iterations`, `toolCallsHistory`, `subagentTraces`) are declared outside the `try` block, so `catch` has access to them.
3. An assistant message is saved to the DB with all accumulated content: `reasoning_content`, `tool_calls_json`, `subagents_json`.
4. The response is marked `aborted: true` and `_⏹ Generation stopped by user_` is appended to the end of the text.
5. Subagents within the loop also get a soft-abort — they return a partial result with `aborted: true`.

Client behavior (desktop): on `res.aborted`, the temporary message is finalized with the real `message_id` and all accumulated content, instead of being deleted.
