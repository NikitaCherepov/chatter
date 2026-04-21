# chatter backend-api

Backend для веб/бот-клиентов с JWT API (`/api/v1/*`) и internal API (`/internal/*`).

## Быстрый старт

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

## ENV (минимум)

- `TELEGRAM_TOKEN` - обязателен для Telegram auth проверки.
- `BACKEND_INTERNAL_TOKEN` - обязателен для всех `/internal/*`.
- `BACKEND_API_PORT` - по умолчанию `3050`.
- `API_JWT_SECRET` - опционально, иначе берется `TELEGRAM_TOKEN`.
- `API_DB_PATH` или `NOTES_DB_PATH` - опционально. По умолчанию используется `chatter.db` в корне проекта.
- `TIMEWEB_*` и другие AI ключи - для AI/voice/photo.
- `ENCRYPTION_KEY` - для mail (шифрование паролей).
- `BROWSERLESS_TOKEN` (+ `BROWSERLESS_BASE_URL` опционально) - для `/internal/tools/read_url`.

## Типы авторизации

- JWT API: `Authorization: Bearer <access_token>` для `/api/v1/*` (кроме `/api/v1/auth/*`).
- Internal API: `Authorization: Bearer <BACKEND_INTERNAL_TOKEN>` для `/internal/*`.

## Быстрая проверка (ввод/вывод)

1. Health

```bash
curl -s http://127.0.0.1:3050/health
```

```json
{"ok":true,"service":"backend-api","now":1710000000}
```

2. Регистрация пользователя (JWT)

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

3. Сообщение в AI (JWT)

```bash
curl -s -X POST http://127.0.0.1:3050/api/v1/chat/send \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"text":"Привет, что умеешь?"}'
```

```json
{
  "reply":"...",
  "message_id":456,
  "chat_id":1
}
```

4. Создание pending-пользователя (internal, бот-сценарий)

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

## Эндпоинты (ввод/вывод)

### Public JWT API

- `POST /api/v1/auth/register`
  - Ввод: `{ login, password, name? }`
  - Вывод: `{ access_token, refresh_token, access_expires_in, refresh_expires_in, user }`
- `POST /api/v1/auth/login`
  - Ввод: `{ login, password }`
  - Вывод: `{ access_token, refresh_token, access_expires_in, refresh_expires_in, user }`
- `POST /api/v1/auth/telegram`
  - Ввод: `{ initData }`
  - Вывод: `{ access_token, refresh_token, access_expires_in, refresh_expires_in, user }`
- `POST /api/v1/auth/refresh`
  - Ввод: `{ refresh_token }`
  - Вывод: `{ access_token, refresh_token, access_expires_in, refresh_expires_in }`
- `GET /api/v1/chats`
  - Ввод: без body
  - Вывод: `{ chats, active_chat_id }`
- `POST /api/v1/chats`
  - Ввод: `{ title? }`
  - Вывод: `{ chat_id }`
- `POST /api/v1/chats/:id/activate`
  - Ввод: path `:id`
  - Вывод: `{ ok: true, active_chat_id }`
- `GET /api/v1/chats/:id/messages?limit=&offset=`
  - Ввод: path/query
  - Вывод: `{ messages, limit, offset }`
- `POST /api/v1/chat/send`
  - Ввод: `{ text, chat_id? }`
  - Вывод: AI-ответ (`reply`, ids и метрики в зависимости от сервиса AI)
- `GET /api/v1/notes?query=&limit=&offset=`
  - Ввод: query
  - Вывод: `{ notes, total, limit, offset }`
- `POST /api/v1/notes`
  - Ввод: `{ title?, content }`
  - Вывод: `{ note_id }`
- `GET /api/v1/notes/:id`
  - Ввод: path `:id`
  - Вывод: `{ note }`
- `DELETE /api/v1/notes/:id`
  - Ввод: path `:id`
  - Вывод: `{ ok: true }`
- `GET /api/v1/tasks?status=&limit=`
  - Ввод: query (`status`: `pending|done|error|all`)
  - Вывод: `{ tasks }`
- `POST /api/v1/tasks`
  - Ввод: `{ execute_at, task_type, payload, recurrence_type?, recurrence_weekday?, timezone_offset?, notify_mode?, notify_condition? }`
  - Вывод: `{ task_id }`
- `DELETE /api/v1/tasks/:id`
  - Ввод: path `:id`
  - Вывод: `{ ok: true }`

### Vector Memory (JWT, feature-flag)

- Нужно `BACKEND_VECTOR_MEMORY_API_ENABLED=1`.
- `POST /api/v1/vector-memory/chunks` -> ввод `{ text, source? }`, вывод: созданный chunk.
- `POST /api/v1/vector-memory/search` -> ввод `{ query, top_k? }`, вывод: найденные chunk.
- `DELETE /api/v1/vector-memory/chunks/:id` -> вывод `{ ok: true, ... }`.
- `DELETE /api/v1/vector-memory/chunks?all=1` -> вывод `{ ok: true, ... }`.

### Admin JWT API (только admin)

- `GET /api/v1/admin/users?filter=all|pending|banned&limit=&offset=` -> `{ users, total, filter, limit, offset }`
- `GET /api/v1/admin/users/:id` -> `{ user, ban }`
- `PUT /api/v1/admin/users/:id/status` (ввод `{ status }`) -> `{ ok: true, status }`
- `PUT /api/v1/admin/users/:id/role` (ввод `{ role }`) -> `{ ok: true, role }`
- `PUT /api/v1/admin/users/:id/name` (ввод `{ name }`) -> `{ ok: true, name }`
- `DELETE /api/v1/admin/users/:id` -> `{ ok: true }`
- `POST /api/v1/admin/users/:id/plan` (ввод `{ plan, duration? }`, duration: `forever|day|week|month|year`) -> `{ ok: true, plan, ends_at }`
- `POST /api/v1/admin/users/:id/ban` (ввод `{ reason? }`) -> `{ ok: true, reason }`
- `DELETE /api/v1/admin/users/:id/ban` -> `{ ok: true, status: "none" }`
- `POST /api/v1/admin/sync-plan-limits` -> `{ ok: true }`

### Internal API (для бота/сервисов)

- Все эндпоинты ниже требуют `Authorization: Bearer <BACKEND_INTERNAL_TOKEN>`.
- AI:
  - `POST /internal/ai/send` -> `{ user_id, text, chat_id?, options? }`
  - `POST /internal/ai/admin-outreach` -> `{ target_user_id, admin_instruction }`
  - `POST /internal/messages/bind-telegram` -> `{ user_id, message_id, telegram_chat_id?, telegram_message_id? }`
- Voice/photo:
  - `POST /internal/voice/turn` (`BACKEND_VOICE_API_ENABLED=1`)
  - `POST /internal/photo/analyze` (`BACKEND_PHOTO_API_ENABLED=1`)
- URL tool:
  - `POST /internal/tools/read_url` -> `{ url }` -> `{ ok, url, text }`
- Prompts:
  - `GET /internal/prompts`, `GET /internal/prompts/:id`
  - `POST /internal/prompts` -> `{ name, description?, content, is_default? }`
  - `PUT /internal/prompts/:id/name|description|content|default`
  - `DELETE /internal/prompts/:id`
  - `POST /internal/prompts/reset-users` -> `{ prompt_id }`
- User prompt/timezone/context/mail:
  - `POST /internal/user/prompt/select` -> `{ user_id, prompt_id }`
  - `PUT /internal/user/prompt/custom` -> `{ user_id, content }`
  - `POST /internal/user/timezone` -> `{ user_id, timezone_offset }`
  - `POST /internal/user/context-window` -> `{ user_id, context_window, is_admin? }`
  - `POST /internal/mail/setup|use`, `PUT /internal/mail/limit`, `DELETE /internal/mail/account`
- User lifecycle/plan/ban:
  - `POST /internal/users/upsert-telegram` -> `{ tg_id, name, role?, status?, tg_username?, default_prompt_id? }`
  - `POST /internal/users/create-pending` -> `{ tg_id, name?, tg_username?, default_prompt_id? }`
  - `GET /internal/users/:id`
  - `PUT /internal/users/:id/tg-username` -> `{ user_id?, tg_username }`
  - `GET /internal/users?filter=all|pending|banned&limit=&offset=`
  - `PUT /internal/users/:id/status|role|name`
  - `DELETE /internal/users/:id`
  - `POST /internal/users/:id/plan` -> `{ plan }`
  - `POST /internal/sync-plan-limits`
  - `POST /internal/users/:id/ban` -> `{ reason?, banned_by? }`
  - `DELETE /internal/users/:id/ban`
  - `GET /internal/users/:id/ban`
  - `POST /internal/users/:id/prompt/select`
  - `PUT /internal/users/:id/prompt/custom`
- Сервисные:
  - `POST /internal/daily-reset` -> `{ ok: true }`

## Типовые ошибки

- `400` - плохой ввод (`bad_*`, `*_required`).
- `401` - неверный токен (`unauthorized`, `unauthorized_internal`).
- `403` - доступ запрещен (`access_not_approved`, `forbidden_admin_only`).
- `404` - сущность не найдена (`user_not_found`, `note_not_found` и т.д.).
- `409` - конфликт (`name_already_exists`, `login_already_exists`).
- `422` - бизнес-ограничение (`notes_limit`, `cannot_delete_default_prompt`, `cannot_ban_admin_from_env`).
- `429` - лимиты (`daily_message_limit_reached`).
- `500` - внутренняя ошибка (`internal_error`/`*_failed`).
