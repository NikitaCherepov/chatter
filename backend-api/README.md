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
- `MAP_PINS_ENCRYPTION_KEY` - для шифрования координат меток карты (fallback на `ENCRYPTION_KEY`).
- `DEVOPS_ENCRYPTION_KEY` - для шифрования учётных данных SSH серверов (пароли, ключи, sudo-пароль). Fallback на `ENCRYPTION_KEY`.
- `BROWSERLESS_TOKEN` (+ `BROWSERLESS_BASE_URL` опционально) - для `/internal/tools/read_url`.
- `IMAGE_GEN_PROVIDER` — провайдер генерации: `proxyapi` (по умолчанию) или `openrouter`.
- `PROXYAPI_KEY` - ключ ProxyAPI (provider=proxyapi).
- `PROXYAPI_BASE_URL` - базовый URL ProxyAPI (по умолчанию `https://api.proxyapi.ru/openai/v1`).
- `OPENROUTER_API_KEY` - ключ OpenRouter (provider=openrouter).
- `OPENROUTER_BASE_URL` - базовый URL OpenRouter (по умолчанию `https://openrouter.ai/api/v1`).
- `IMAGE_GEN_MODEL` - модель генерации (по умолчанию `gpt-image-1.5` для proxyapi, `x-ai/grok-imagine-image-quality` для openrouter).
- `IMAGE_GEN_QUALITY` - качество: `low`/`medium`/`high` (по умолчанию `low`, только proxyapi).
- `IMAGE_GEN_SIZE` - размер: `1024x1024` (по умолчанию `1024x1024`, только proxyapi).
- `CARTESIA_API_KEY` — API-ключ Cartesia.ai (обязательно для облачной озвучки, формат `sk_car_...`).
- `CARTESIA_MODEL_ID` — модель TTS Cartesia (по умолчанию `sonic-3.5`).

### Генерация изображений

Генерация живёт в `services/image-generation.ts`. Провайдер выбирается через `IMAGE_GEN_PROVIDER`:

**provider=proxyapi** (по умолчанию) — OpenAI-compatible `/images/generations`:

```text
POST {PROXYAPI_BASE_URL}/images/generations
Authorization: Bearer {PROXYAPI_KEY}

{ "model": "...", "prompt": "...", "quality": "...", "size": "..." }
→ response.data[0].b64_json
```

**provider=openrouter** — chat completion с image modality:

```text
POST {OPENROUTER_BASE_URL}/chat/completions
Authorization: Bearer {OPENROUTER_API_KEY}

{ "model": "...", "messages": [{ "role": "user", "content": "..." }], "modalities": ["image"] }
→ response.choices[0].message.images[0].image_url.url → download → base64
```

Для добавления нового провайдера — создать функцию `generateXxx()` и добавить case в switch `runImageGeneration`.

### TTS Cartesia (облачная озвучка)

Облачная озвучка через Cartesia.ai. API-ключ живёт только на сервере — клиенты никогда его не видят.

**Эндпоинты:**

| Эндпоинт | Метод | Описание |
|---|---|---|
| `/api/v1/tts/voices` | GET | Список голосов (en, ru, de, fr) для селектора |
| `/api/v1/tts/generate` | POST | Генерация аудио + привязка к сообщению |
| `/api/v1/tts/preview` | GET | Превью голоса (кешируется в `tts_voice_previews`) |
| `/api/v1/audio/:filename` | GET | Отдача аудиофайла (owner-only) |

**Ключевые файлы:**
- `services/tts-cartesia.ts` — прокси к Cartesia API (генерация + список голосов)
- `services/audio-storage.ts` — сохранение MP3 в `uploads/audio/`
- `tts_voice_previews` (таблица) — кеш превью-фраз по `voice_id`

**Поток данных при озвучке сообщения:**
```text
POST /tts/generate { text, voice_id, message_id }
  → Cartesia API: POST /tts/bytes (MP3)
  → saveTtsAudio() → uploads/audio/abc123.mp3
  → updateChatMessageAudio() → chat_messages.audio = { url, tts_type, voice_id }
  → повторный play → GET /api/v1/audio/abc123.mp3 (без повторной генерации)
```

### AI-провайдеры (основные)

- `TIMEWEB_BASE_URL` + `TIMEWEB_API_KEY` - PRO-провайдер (по умолчанию).
- `TIMEWEB_MODEL` - цепочка моделей PRO (через запятую, fallback).
- `TIMEWEB_LITE_BASE_URL` + `TIMEWEB_LITE_API_KEY` - LITE-провайдер.
- `TIMEWEB_LITE_MODEL` - цепочка моделей LITE.
- `TIMEWEB_LITE_ROUTER_ENABLED` - `0`, чтобы не вызывать LITE-router и сразу отправлять все текстовые запросы в PRO (по умолчанию включен).
- `TIMEWEB_PRO_ENDPOINTS` - дополнительные PRO-эндпоинты (формат: `base_url|api_key|models;...`).
- `TIMEWEB_LITE_ENDPOINTS` - дополнительные LITE-эндпоинты (аналогично).

### Ручной выбор модели (опционально)

Позволяет юзеру выбирать конкретную модель вместо авто-роутинга. Независимо от PRO/LITE провайдеров.

- `MODELS_MANUAL` - список моделей для ручного выбора. Формат: `base_url|api_key|api_model_name|display_name|description|unique_id;...`
  - Пример: `https://api.timeweb.com|sk-xxx|gpt-4o|GPT-4o (Timeweb)|Надёжная и быстрая|tw-gpt4o;https://api.deepseek.com|sk-yyy|deepseek-chat|DeepSeek|Дешёвая, но медленная|ds-chat`
  - `api_model_name` — реальное имя модели для API-запроса
  - `unique_id` — уникальный идентификатор для клиента (может не совпадать с api_model_name)
  - Если не задан — селектор моделей не отображается
- `preferred_model` (в таблице `users`) — `NULL` = авто, `"tw-gpt4o"` = конкретная модель
- Если выбранная модель недоступна — fallback на авто-роутинг + уведомление юзеру

### Reasoning level (глубина размышления модели)

Позволяет юзеру управлять глубиной reasoning/thinking модели. Хранится в `users.reasoning_level` (`NULL` = авто). Прокидывается через весь стек вызовов и применяется в `adaptRequestBodyForProvider` — адаптере, который определяет провайдера по `baseURL` и транслирует уровень в нативный параметр.

**Поддерживаемые провайдеры:**

| Провайдер (по `baseURL`) | Нативный параметр | Уровни | Маппинг |
|---|---|---|---|
| OpenRouter (`openrouter.ai`) | `reasoning: { effort: level }` | `none, minimal, low, medium, high, xhigh` | 1:1 |
| DeepSeek direct (`deepseek.com`) | `reasoning_effort` / `thinking` | `none, high, xhigh` | `none`→`thinking:{type:"disabled"}`, `high`→`reasoning_effort:"high"`, `xhigh`→`reasoning_effort:"max"` |
| Прочие (Timeweb, vLLM) | — | — | Не трогается, текущая логика (`thinking`/`clear_thinking`) |

**Поведение в режимах:**
- **Авто (`NULL`)** — адаптер не добавляет reasoning-параметры, провайдер использует поведение по умолчанию.
- **LITE-router / `callLiteAi`** — всегда `'none'`, юзер не контролирует.
- **PRO main/final completion** — уровень юзера (или `NULL` = авто).
- **Ручная модель** — уровень юзера применяется, если `baseURL` модели поддерживается.

**Capability API:** `GET /api/v1/models` возвращает `reasoning_levels` для каждой ручной модели (по `baseURL`) и `auto_reasoning_levels` для auto-режима. Если `reasoning_levels = null` — ползунок скрыт.

**Эндпоинты:**
- `GET /api/v1/user/reasoning-level` → `{ reasoning_level: string | null }`
- `PUT /api/v1/user/reasoning-level` ← `{ reasoning_level: 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|null }`

### Model Settings (параметры генерации)

Позволяет юзеру настраивать параметры генерации (temperature, top_p, top_k, frequency_penalty, presence_penalty, repetition_penalty, max_tokens) для каждой ручной модели индивидуально. Хранится в `users.model_settings` (JSON-объект, ключ — `unique_id` модели). Применяется только для ручных моделей (не для авто-роутинга и не для LITE-режима).

**Параметры (`MODEL_SETTINGS_RANGES`):**

| Параметр | min | max | step | Описание |
|---|---|---|---|---|
| `temperature` | 0 | 2 | 0.05 | Температура генерации |
| `top_p` | 0 | 1 | 0.05 | Nucleus sampling |
| `top_k` | 0 | 500 | 1 | Top-K sampling |
| `frequency_penalty` | -2 | 2 | 0.1 | Штраф за частоту |
| `presence_penalty` | -2 | 2 | 0.1 | Штраф за присутствие |
| `repetition_penalty` | 0 | 2 | 0.05 | Штраф за повторения |
| `max_tokens` | 1 | 65536 | 1 | Лимит выходных токенов |

Значение `null` для параметра = авто (не отправляется в API провайдера).

**Фильтрация по провайдеру (`PROVIDER_SUPPORTED_PARAMS`):**

Не все провайдеры поддерживают все параметры. Фильтрация происходит в `adaptRequestBodyForProvider`:

| Провайдер (по `baseURL`) | Поддерживаемые параметры |
|---|---|
| OpenRouter (`openrouter.ai`) | Все 7 параметров |
| DeepSeek direct (`deepseek.com`) | Все, кроме `top_k`, `repetition_penalty` |
| Прочие (Timeweb, vLLM) | Все, кроме `top_k`, `repetition_penalty` |

Функция `getProviderSupportedParams(baseURL)` возвращает Set поддерживаемых параметров. `applyModelSettingsToBody()` мержит только разрешённые параметры в тело запроса.

**`supported_params` в каталоге моделей:**

`GET /api/v1/models` возвращает `supported_params` для каждой модели (массив строк). Клиент использует его для отображения только релевантных слайдеров в настройках.

**Поведение в режимах:**
- **Авто-роутинг (PRO/LITE)** — настройки модели не применяются.
- **LITE-режим** — настройки модели не применяются (передаётся `null`).
- **Ручная модель** — настройки применяются в `adaptRequestBodyForProvider`.

**Поток данных:**
1. `sendMessageThroughAi` читает `user.model_settings` (JSON), находит настройки для `preferredModelId`.
2. Передаёт `resolvedModelSettings` в `runCompletion` → `createCompletionWithModelFallback`.
3. `adaptRequestBodyForProvider` вызывает `applyModelSettingsToBody(requestBody, baseURL, settings)`.
4. Тело запроса мержится с настройками (отфильтрованными по провайдеру).

**Эндпоинты:**
- `GET /api/v1/user/model-settings` → `{ settings: { [modelId]: { temperature?: number, ... } } }`
- `PUT /api/v1/user/model-settings` ← `{ model_id, settings: { temperature?, top_p?, ... } }` (merge с существующими настройками для модели)
- `DELETE /api/v1/user/model-settings/:modelId` → `{ ok: true }`

### AI-провайдеры (vision, опционально)

Vision-запросы (анализ фото) могут использовать отдельные модели/ключи. Если не заданы — fallback на основные PRO/LITE провайдеры.

- `TIMEWEB_VISION_BASE_URL` - по умолчанию `TIMEWEB_BASE_URL`.
- `TIMEWEB_VISION_API_KEY` - по умолчанию `TIMEWEB_API_KEY`.
- `TIMEWEB_VISION_MODEL` - по умолчанию первая из `TIMEWEB_MODEL`.
- `TIMEWEB_LITE_VISION_BASE_URL` - по умолчанию `TIMEWEB_LITE_BASE_URL`.
- `TIMEWEB_LITE_VISION_API_KEY` - по умолчанию `TIMEWEB_LITE_API_KEY`.
- `TIMEWEB_LITE_VISION_MODEL` - по умолчанию `TIMEWEB_VISION_MODEL`.

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
- `GET /api/v1/chats/search?q=&limit=`
  - Полнотекстовый поиск по сообщениям (FTS5). Возвращает чаты, в которых есть совпадения, со сниппетом найденного текста.
  - Минимальная длина запроса: 3 символа. `limit` по умолчанию 20, максимум 50.
  - Вывод: `{ results: [{ chat_id, chat_title, snippet, rank }] }`
  - `snippet` содержит текст вокруг совпадения, совпадение обёрнуто в `<< >>`.
  - Результаты сгруппированы по чатам, отсортированы по релевантности (`rank`).
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
  - Вывод: AI-ответ (`reply_text`, ids, `reasoning_content?`, `tool_calls?`, `generated_images?` и метрики в зависимости от сервиса AI)
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
- `GET /api/v1/map-pins`
  - Ввод: без body
  - Вывод: `{ pins: [{ id, lat, lng, label, created_at, updated_at }] }` (координаты расшифровываются)
- `POST /api/v1/map-pins`
  - Ввод: `{ lat, lng, label? }`
  - Вывод: `{ pin_id }` (координаты шифруются перед сохранением)
- `PUT /api/v1/map-pins/:id`
  - Ввод: `{ lat?, lng?, label? }` (lat+lng только вместе)
  - Вывод: `{ ok: true }`
- `DELETE /api/v1/map-pins/:id`
  - Ввод: path `:id`
  - Вывод: `{ ok: true }`
- `GET /api/v1/macros`
  - Ввод: без body
  - Вывод: `{ macros: [{ id, title, description, commands, enabled, pinned, return_output, created_at, updated_at }] }`
- `POST /api/v1/macros`
  - Ввод: `{ title, description?, commands: string[], enabled?, pinned?, return_output? }`
  - Вывод: `{ id }` (201) или ошибка (400/429/422)
- `PUT /api/v1/macros/:id`
  - Ввод: `{ title?, description?, commands?, enabled?, pinned?, return_output? }`
  - Вывод: `{ ok: true }`
- `DELETE /api/v1/macros/:id`
  - Ввод: path `:id`
  - Вывод: `{ ok: true }`
- `POST /api/v1/macro/explain`
  - Ввод: `{ commands: string[] }`
  - Вывод: `{ explanation: string }` — ИИ объясняет что делают команды (лёгкий LITE-запрос)
- `POST /api/v1/macro/describe`
  - Ввод: `{ commands: string[], current_title?, current_description? }`
  - Вывод: `{ title: string, description: string }` — ИИ предлагает название/описание (лёгкий LITE-запрос)
- `GET /api/v1/models`
  - Вывод: `{ models: [{ id, name, description, supported_params? }], preferred_model }` — каталог моделей для ручного выбора + текущая модель юзера. `supported_params` — массив параметров генерации, поддерживаемых провайдером модели (см. [Model Settings](#model-settings-параметры-генерации)).
- `PUT /api/v1/user/preferred-model`
  - Ввод: `{ model_id: string | null }` (null = авто)
  - Вывод: `{ ok, preferred_model }`
- `GET /api/v1/user/model-settings`
  - Вывод: `{ settings: { [modelId]: { temperature?, top_p?, top_k?, frequency_penalty?, presence_penalty?, repetition_penalty?, max_tokens? } } }` — параметры генерации по моделям
- `PUT /api/v1/user/model-settings`
  - Ввод: `{ model_id: string, settings: { temperature?, ... } }` — merge с существующими настройками модели
  - Вывод: `{ ok: true, settings }`
- `DELETE /api/v1/user/model-settings/:modelId`
  - Вывод: `{ ok: true }` — удаляет настройки для конкретной модели

### DevOps Agent Runtime (JWT)

Управление SSH-серверами, политиками авто-разрешения и инструкциями (runbooks). Доступно desktop-клиентам и Telegram (через SSE-стриминг и inline-кнопки подтверждения).

**Серверы:**

- `GET /api/v1/devops/servers` — список серверов пользователя (без паролей/ключей)
- `POST /api/v1/devops/servers` — добавить сервер (`{ name, host, port, username, password?, private_key?, sudo_password?, default_ssh_key_id?, use_ssh_key_for_login? }`)
- `GET /api/v1/devops/servers/:id` — информация о сервере
- `PUT /api/v1/devops/servers/:id` — обновить сервер (частичное обновление). Поля: `{ name?, host?, port?, username?, password?, private_key?, sudo_password?, default_ssh_key_id?, use_ssh_key_for_login? }`
- `DELETE /api/v1/devops/servers/:id` — удалить сервер
- `POST /api/v1/devops/servers/:id/test` — проверить SSH-подключение
- `POST /api/v1/devops/servers/:id/exec` — выполнить команду на сервере (только для внутренних вызовов, не из AI)

**Политики (авто-разрешение команд):**

- `GET /api/v1/devops/servers/:id/policies` — список политик для сервера
- `POST /api/v1/devops/servers/:id/policies` — создать политику (`{ pattern, auto_approve }`). `pattern` — regex для команды.
- `DELETE /api/v1/devops/policies/:id` — удалить политику

**Подтверждение команд (HitL):**

- `POST /api/v1/devops/approve` — подтвердить/отклонить выполнение команды (`{ confirmation_id, approved: boolean, sudo_password?, save_sudo_password?, new_password? }`)

**Инструкции (runbooks):**

- `GET /api/v1/devops/runbooks` — список инструкций пользователя
- `POST /api/v1/devops/runbooks` — создать инструкцию (`{ title, content, commands? }`)
- `PUT /api/v1/devops/runbooks/:id` — обновить инструкцию
- `DELETE /api/v1/devops/runbooks/:id` — удалить инструкцию
- `POST /api/v1/devops/runbooks/extract-commands` — извлечь shell-команды из текста инструкции через AI (`{ content }`)
- `POST /api/v1/devops/runbooks/review-commands` — проверить безопасность команд через AI (`{ commands: string[] }`)

**Привязка инструкций к серверам:**

- `POST /api/v1/devops/servers/:id/attach-runbook` — привязать инструкцию к серверу (`{ runbook_id }`). Создаёт авто-разрешающие политики для каждой команды инструкции.

### Subagent System (desktop-only, `isDesktop`)

Система специализированных вложенных агентов (субагентов). Главный AI-агент делегирует узкоспециализированные задачи субагентам через инструмент `invoke_subagent`. Каждый субагент имеет свой системный промпт, собственный набор инструментов и отдельный агентский цикл.

**Архитектура:**

```
Главный агент (ai.ts)
  ├── invoke_subagent(agent, task, context)
  │     └── runner.ts: загрузка промпта + инструментов
  │           ├── Собственные инструменты (ownTools) — выполняются напрямую
  │           └── Разделяемые инструменты (sharedTools) — через runTool главного агента
  └── Возврат результата (answer, summary, toolCallsHistory)
```

**Интеграция:**
- `invoke_subagent` — динамически генерируемый инструмент, добавляется в `executionTools` только если `isDesktop=true` и в реестре есть зарегистрированные субагенты
- `initSubagentRunner()` — вызывается при старте сервера (`ai.ts`), передаёт ссылки на `runCompletion`, `runTool`, `toolDefinitions` для разрыва циклических зависимостей
- Субагент использует тот же `AbortSignal` что и основной запрос — остановка генерации (`chat_stop`) останавливает и субагента

**Структура файлов:**

```
services/subagents/
  types.ts          — типы: SubagentConfig, SubagentTool, SubagentContext, SubagentResult
  registry.ts       — реестр субагентов: REGISTRY, getSubagent(), buildSubagentListDescription()
  runner.ts         — агентский цикл: runSubagent(), initSubagentRunner()
  prompts/
  tools/
```

**Как добавить новый субагент:**
1. Создать инструменты в `tools/<name>-tools.ts`
2. Создать промпт в `prompts/<name>.md`
3. Добавить entry в `REGISTRY` в `registry.ts`

**Реестр (REGISTRY):**

| Имя | Описание | mode | maxLoops | sharedTools |
|---|---|---|---|---|

**Агентский цикл (runner.ts):**
- Лимит итераций: `maxLoops` из конфига (default 50)
- За 2 итерации до лимота — nudge "заверши задачу"
- Debug: `DEBUG_AI_RAW_SUBAGENT=1` — логирует полные ответы модели
- `setMaxListeners(100)` на signal — предотвращает `MaxListenersExceededWarning` при длинных циклах

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
  - `POST /internal/ai/send` -> `{ user_id, text, chat_id?, options? }` -> `{ reply_text, chat_id, message_id, reasoning_content?, tool_calls?, model_fallback_notice?, tool_user_messages?, generated_images?, usage }`
  - `POST /internal/ai/stream` -> SSE-стриминг для Telegram: `{ user_id, text, chat_id?, options? }`
    - События: `intermediate`, `tool_status`, `display_state`, `desktop_action`, `done`, `error` (см. [SSE-стриминг](#sse-striing-i-dual-delivery-podtverzhdeniy))
    - Передаёт `onIntermediateMessage`, `onToolStatus`, `onDesktopAction` колбэки в `sendMessageThroughAi`
  - `POST /internal/ai/lite` -> `{ text }` -> `{ reply_text }` — LITE AI для проверки безопасности команд
  - `POST /internal/ai/admin-outreach` -> `{ target_user_id, admin_instruction }`
  - `POST /internal/ai/generate-image` -> `{ user_id, prompt }` -> `{ ok: true, image_base64, prompt_used }` (требует `PROXYAPI_KEY`)
  - `POST /internal/messages/bind-telegram` -> `{ user_id, message_id, telegram_chat_id?, telegram_message_id? }`
- Voice/photo:
  - `POST /internal/voice/turn` (`BACKEND_VOICE_API_ENABLED=1`)
  - `POST /internal/photo/analyze` (`BACKEND_PHOTO_API_ENABLED=1`) -> `{ user_id, image_base64, image_mime_type?, caption?, chat_id?, extra_images?, options? }` -> `{ reply_text, message_id, chat_id, usage, ... }`
    - `extra_images` - массив дополнительных изображений (до лимита плана): `[{ base64, mime_type? }]`
    - Первое изображение (обязательное) передаётся в `image_base64`, остальные через `extra_images`
    - Лимит зависит от плана пользователя (см. таблицу ниже)
    - Ошибки: `images_not_allowed_for_plan` (free), `too_many_images_max_N`
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
  - `POST /internal/reset-daily-counters` -> `{ ok: true }` — ручной сброс дневных счётчиков всех пользователей
- Models (ручной выбор):
  - `GET /internal/models` -> `{ models: [{ id, name, description }] }`
  - `GET /internal/users/:id/preferred-model` -> `{ models, preferred_model }`
  - `PUT /internal/users/:id/preferred-model` -> `{ model_id: string | null }` -> `{ ok, preferred_model }`
- PC Command confirmation (для TG-бота):
  - `POST /internal/pc-commands/approve` -> `{ confirmation_id, approved, user_id }` -> `{ ok, status, result? }`
  - `POST /internal/pc-commands/policies` -> `{ user_id, pattern }` -> `{ ok, id }` — создание auto-approve policy
- DevOps SSH confirmation (для TG-бота):
  - `POST /internal/devops/approve` -> `{ confirmation_id, approved, user_id, sudo_password?, new_password? }` -> `{ ok, status, result? }`
  - `POST /internal/devops/servers/:id/policies` -> `{ user_id, pattern, auto_approve }` -> `{ id }` — создание SSH auto-approve policy

## Лимиты по планам

Задаются в `PLAN_LIMITS` в `services/chats.ts`, применяются при создании пользователя, смене плана и `/sync_plan_limits`.

| Параметр | free | standart | pro |
|---|---|---|---|
| `context_window_max` | 10 | 20 | 50 |
| `daily_message_limit` | 10 | 20 | 50 |
| `daily_web_search_limit` | 0 | 5 | 20 |
| `daily_image_gen_limit` | 0 | 3 | 10 |
| `max_images_per_request` | 0 | 5 | 10 |

Админы (`is_admin = 1`) обходят дневные лимиты.

### Хранение изображений

Пользовательские и сгенерированные изображения сохраняются на сервере. Без этого base64 терялся, в истории чата картинки не отображались.

**Сервис:** `services/image-storage.ts` (зависимость `sharp`):
- `saveUserImageThumbnail()` — ресайзит до 512px, конвертирует в webp, сохраняет в `uploads/`.
- `saveGeneratedImage()` — сохраняет PNG без сжатия.
- API скачивания `GET /api/v1/images/:filename?token=<access_token>` — только для владельца. Статического роута `/uploads/` нет.

**БД:**
- Колонка `images TEXT` в `chat_messages` — JSON-массив `[{ "url": "/api/v1/images/abc.webp", "type": "user_photo" | "generated" }]`.
- `appendChatMessage` принимает параметр `images[]`. `getChatMessages` парсит и возвращает `images` в ответе.

**Токены AI:**
- Картинки не отправляются повторно в контексте — AI видит только текст `[Фото]caption`. В `getHistoryForAi()` это обеспечивается тем, что для user-сообщений выбирается только `content` (без `images`).
- Разделение: "история для AI" = текст + развёрнутый trace tool calls (см. [Tool calls trace](#tool-calls-trace-и-контекст-для-ai)), "история для отображения" = текст + images[] + плоская проекция tool_calls.

**Потоки данных:**
- **Desktop отправляет фото:** base64 → сервер ресайзит + сохраняет thumbnail → оригинал в AI vision → в БД: `images: [{ url, type: "user_photo" }]`.
- **Генерация изображения:** AI вызывает `generate_image` → b64 сохраняется на диск → возвращается `image_url` → в БД assistant-сообщения: `images: [{ url, type: "generated" }]`.
- **Telegram фото:** бот скачивает фото → `/internal/photo/analyze` → thumbnail сохраняется → в БД user-сообщения.

**Типы:**
- `MessageImage` — `{ url: string; type: 'user_photo' | 'generated' }`.
- `GeneratedImage` — добавлено поле `image_url`.
- `ChatSendResponse` — добавлено поле `generated_images`.

### Архивация сообщений (soft delete)

Когда количество активных сообщений в чате превышает `context_window_max`, старые сообщения **не удаляются**, а помечаются как архивные:

- Колонки `chat_messages.archived` (INTEGER, 0/1) и `chat_messages.archived_at` (DATETIME).
- `trimUserHistoryByChat()` выполняет `UPDATE ... SET archived = 1` вместо `DELETE` для сообщений, выходящих за пределы context window.
- `getHistoryForAi()` выбирает только `archived = 0` — архив не отправляется в AI-контекст. Развёрнутый trace tool_calls из неархивных assistant-сообщений попадает в контекст (см. [Tool calls trace](#tool-calls-trace-и-контекст-для-ai)).
- `getChatMessages()` возвращает **все** сообщения (включая архивные) с полем `archived: boolean` — десктоп показывает полную историю.
- FTS-поиск продолжает работать по архивным сообщениям (триггер `AFTER DELETE` не срабатывает при UPDATE, поэтому записи остаются в `messages_fts`).
- Удаление чата (`deleteUserChat`) и удаление конкретного сообщения (`deleteUserMessage`) выполняют физический `DELETE` — это не связано с архивацией.
- Индекс `idx_chat_messages_active` для эффективной фильтрации по `archived = 0`.
- Desktop отображает архивные сообщения с пониженной прозрачностью (opacity 0.55) и меткой «архив».

### Подсчёт токенов (token accounting)

Локальная оценка размера сообщений и контекста через `gpt-tokenizer` (BPE `o200k_base`, чистый JS — без WASM-зависимостей). Используется для отображения, **не влияет на архивацию** (пока что).

**БД:**

| Колонка | Тип | Описание |
|---|---|---|
| `chat_messages.token_count` | INTEGER NOT NULL DEFAULT 0 | Токены сообщения в AI-контексте (без `reasoning_content`) |
| `chat_messages.reasoning_tokens` | INTEGER NOT NULL DEFAULT 0 | Токены `reasoning_content` (только для assistant, отдельный счётчик) |

**Когда считается:**

- **При сохранении сообщения** (`appendChatMessage` в `services/chats.ts`):
  - **user**: `countMessageTokens('user', content)` — только текст, без images (они не уходят в контекст).
  - **assistant**: токены развёрнутого trace через `expandAssistantMessage()` — тот же хелпер, что использует `getHistoryForAi()`. Считаются `content`, `tool_calls` и `tool results` каждой итерации. `reasoning_content` **исключён**.
  - **reasoning_tokens**: отдельный счётчик из `reasoning_content`.
- **Backfill при старте сервера** (`backfillMessageTokens`): порциями по 1000 строк через `setImmediate`, чтобы не блокировать event loop. Лог: `[tokens] backfill complete: N messages updated`.
- **Динамический системный промпт** не кешируется в БД — считается на лету в `getChatContextTokens()`.

**Сервис:** `services/tokenizer.ts` — `countTokens()`, `countMessageTokens()`, `countToolCallTokens()`, `countToolResultTokens()`.

**Сборка системного промпта** (`services/system-prompt.ts`):
- `buildBaseSystemPromptForUser()` — базовый промпт без надбавок за голос/аватар/изображения.
- Включает: выбранный промпт + core memory + cold memory hint + tool usage rules + временной контекст + pinned macros.
- Вынесен в отдельный модуль, чтобы избежать цикла `ai.ts ↔ chats.ts`.
- В `ai.ts` (`sendMessageThroughAi`) — полный промпт с надбавками (`voicePromptHint`, `avatarPromptHint`, images hint).

**API:**

- `GET /api/v1/chats/:id/context-tokens` — суммарные токены контекста чата:
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
  - `messages_tokens` — сумма `token_count` неархивных сообщений (без reasoning).
  - `system_prompt_tokens` — оценка базового системного промпта (динамический, без голоса/аватара). **Не плюсуется** в `messages_tokens`.
  - Полный контекст запроса к AI ≈ `messages_tokens + system_prompt_tokens` (+ надбавки).
- `MessageDto` (`GET /api/v1/chats/:id/messages`) включает `token_count` и `reasoning_tokens`.
- `AiSendResult` (WS/SSE `done`, `/api/v1/chat/send`) включает `token_count` и `reasoning_tokens` для assistant-ответа.

**Desktop отображение:**
- Бейдж `Ntk` у каждого сообщения в metaRow (серый, справа).
- `reasoning_tokens` — в кнопке «Рассуждение»: `Рассуждение · 1234tk`.
- Compact-бейдж в top bar справа: `12 345tk · 1 876pk` (сообщения + промпт).

**Что НЕ считается:**
- `reasoning_content` в `token_count` (он не уходит в контекст AI).
- `usage` от провайдеров (нестабилен при streaming/tool calls/fallback).
- Надбавки системного промпта за голос/аватар/изображения в `/context-tokens` (они появляются только при конкретных типах запросов).
- Images в user-сообщениях (в контекст уходит только текст `[Фото]caption`).

## AI-инструменты

Инструменты доступны AI через tool calling. Определены в `services/ai.ts` в `toolDefinitions`.

Агентский цикл ограничен константами в `services/ai.ts`: `MAX_TOOL_LOOPS = 80`, `MAX_TOOL_LOOPS_VOICE = 10`. Это лимит итераций "модель → tool calls → модель", а не строгий лимит количества отдельных tool calls: за одну итерацию модель может вернуть несколько вызовов инструментов.

### Reasoning и tool-call metadata

`sendMessageThroughAi()` сохраняет дополнительную метаинформацию assistant-ответа в двух разных форматах: **плоский** (для UI/клиентов) и **trace** (для AI-контекста).

- `reasoning_content` — человекочитаемое reasoning/thinking, если провайдер его вернул. Извлекается из `message.reasoning_content` (DeepSeek/vLLM), `message.reasoning` (OpenRouter/vLLM), Anthropic-style `content[]` blocks с `type: "thinking"`, а также из `response.output[]` items с `type: "reasoning"` для Responses-like формата.
- `tool_calls` (в `AiSendResult` / `ChatSendResponse` / WS/SSE `done`) — **плоский** список `{ id, name, arguments, result_preview? }`, собирается параллельно с trace в `toolCallsHistory`. `result_preview` содержит до 250 символов tool response (через `formatToolResultPreview`) — только для popover десктопа.
- `tool_calls_json` (в БД) — **trace**-формат (массив `ToolIteration`), см. [Tool calls trace и контекст для AI](#tool-calls-trace-и-контекст-для-ai).
- `reasoning_content` **не отправляется** обратно в AI-контекст (односторонний вывод модели).

БД:

- `chat_messages.reasoning_content TEXT` — склеенный reasoning по шагам ответа.
- `chat_messages.tool_calls_json TEXT` — JSON в trace-формате (массив `ToolIteration`). Старые записи (плоский массив без поля `step`) поддерживаются как fallback при чтении.

Desktop показывает эти поля как раскрывающиеся popover-кнопки у assistant-сообщения. Если reasoning или tool calls отсутствуют, соответствующая кнопка не отображается. `getChatMessages()` при чтении разворачивает trace-формат обратно в плоский массив с `result_preview` (обрезка `slice(0, 250)`).

### Tool calls trace и контекст для AI

Чтобы модель «помнила» результаты вызванных инструментов на следующих запросах в чате, в `tool_calls_json` сохраняется **полный trace** агентского цикла по итерациям (тип `ToolIteration` в `services/ai.ts`):

```ts
type ToolIteration = {
  step: number;        // маркер нового формата + номер итерации
  content: string;     // промежуточный текст модели на этой итерации (может быть "")
  tool_calls: Array<{ id?: string; name: string; arguments: any }>;
  results: Array<{ id?: string; name: string; content: string }>;  // полные результаты runTool (до TOOL_RESULT_FULL_MAX = 10000 символов)
  is_final?: boolean;  // true у финальной итерации без tool_calls (только текст)
};
```

Маркер нового формата — поле `step` у первого элемента массива. Старые записи (плоский `[{id, name, arguments, result_preview}]`) определяются по его отсутствию.

**Сбор trace в `sendMessageThroughAi()`:**

- На каждой итерации `while`-цикла создаётся `currentIteration` после `runCompletion`.
- Из `message.tool_calls` заполняется `currentIteration.tool_calls` (в порядке, как вернула модель).
- После каждого `runTool()` полный результат (`toolContent`, с обрезкой до 10000 символов и пометкой) добавляется в `currentIteration.results` в порядке вызовов.
- Итерация push'ится в `iterations[]` после полного цикла tool_calls (если не было abort/escalation в PRO).
- Финальная итерация без tool_calls помечается `is_final: true`.
- При эскалации LITE→PRO (`escalate_to_pro`) текущая итерация **не сохраняется** — история пересоздаётся с нуля.

**Разворот в `getHistoryForAi()` (`services/chats.ts`):**

- SELECT добавлено поле `tool_calls_json`.
- Для user-сообщений — `{role, content}` как раньше.
- Для assistant с новым trace-форматом — каждая итерация разворачивается в корректную последовательность OpenAI-совместимых сообщений:
  ```
  assistant(content: intermediate_text | null, tool_calls: [...])
    → tool(tool_call_id, name, content: полный результат) для каждого вызова
    → ... (следующая итерация)
    → assistant(content: финальный текст)  ← итерация без tool_calls
  ```
- `content` у assistant(tool_calls) = `intermediate content` итерации, либо `null` (когда модель только вызывала тулзы без текста). OpenAI-совместимые API требуют именно `null`, не пустую строку.
- Если у tool_call нет `id` (некоторые провайдеры) — генерируется стабильный fallback `call_{step}_{name}`.
- Для assistant со **старым плоским форматом** или без `tool_calls_json` — fallback `{role: 'assistant', content}`. Tool-context теряется (как было раньше), но чат не ломается.

**Почему так:**

- Решает «амнезию» модели — она видит всю цепочку: какие тулзы вызвала, что они вернули, какой промежуточный текст был между ними.
- Не требует миграций БД: используется та же колонка `tool_calls_json TEXT`, просто другой JSON внутри.
- Reasoning намеренно исключён — это односторонний вывод модели, не предназначенный для контекстуальной памяти.
- Десктоп не затронут: UI popover по-прежнему работает с плоской проекцией, реконструируемой из trace в `getChatMessages()`.

**Размер:** `results.content` ограничен `TOOL_RESULT_FULL_MAX = 10000` символов с пометкой об обрезке. Для типичных чатов этого достаточно; для экстремальных DevOps-сессий с 50+ итерациями — `MAX_TOOL_LOOPS` ограничивает длину trace сверху.

### Регенерация сообщений

Desktop может отправлять `regenerate_from_history: true` вместе с `skip_user_history`.

- Backend удаляет из рабочей истории хвостовые assistant-сообщения, вынимает последнее user-сообщение и добавляет его обратно ровно один раз как текущий user request.
- `regenerate_hint` дописывается в текущий user request и не сохраняется как новое пользовательское сообщение.

| Инструмент | Описание |
|---|---|
| `search_web` | Поиск в интернете (Tavily) |
| `read_webpage` | Чтение текста веб-страницы по URL |
| `control_smart_home` | Управление устройствами умного дома |
| `schedule_task` | Создание задачи/напоминания |
| `get_my_tasks` | Список задач пользователя |
| `delete_my_task` | Удаление задачи |
| `set_user_timezone` | Установка часового пояса |
| `check_emails` | Поиск писем в почте |
| `read_email_content` | Чтение содержимого письма |
| `send_email` | Отправка письма |
| `save_note` | Сохранение заметки |
| `list_my_notes` | Список заметок |
| `read_note` | Чтение заметки |
| `delete_note` | Удаление заметки |
| `update_core_memory` | Обновление статического профиля пользователя |
| `search_cold_memory` | Поиск по векторному архиву |
| `save_to_cold_memory` | Сохранение в векторный архив |
| `delete_from_cold_memory` | Удаление из векторного архива |
| `random_roll` | Бросок монетки/кубиков |
| `generate_image` | Генерация изображения (ProxyAPI, `b64_json`). Автоматически маршрутизируется через PRO. |
| `get_exchange_rates` | Курсы валют ЦБ РФ с динамикой изменения. По умолчанию возвращает USD и EUR. |

### Клиентские инструменты (desktop + Telegram)

Большинство инструментов доступно как из desktop, так и из Telegram через SSE-стриминг. Разделение на `serverOnlyTools` и `desktopOnlyTools` описано в [Tool availability split](#tool-availability-split).

**Desktop-only (не доступны из TG):** `desktop_action` (управление UI десктопа), `invoke_subagent` (субагенты).

### Feature Flags (ограничения инструментов)

Система позволяет пользователю выборочно отключать AI-инструменты через галочки в настройках десктоп-приложения. Флаги хранятся в БД (`users.feature_flags`, JSON) и применяются сервером при каждом запросе к AI.

**API:**

- `GET /api/v1/user/feature-flags` — возвращает текущие флаги `{ flags: { ... } }`
- `PUT /api/v1/user/feature-flags` — сохраняет флаги `{ flags: { ... } }` (валидация по whitelist)

**Флаги (ключи JSON):**

| Ключ | Название в UI | Отключаемые инструменты |
|---|---|---|
| `disable_memory_write` | Запрет записи данных | `save_to_cold_memory`, `delete_from_cold_memory`, `save_note`, `delete_note` |
| `disable_pc_control_lite` | Ограниченный режим | `execute_ssh_command`, `list_devops_servers`, `list_devops_runbooks`, `read_devops_runbook`, `suggest_devops_runbook`, `install_ssh_public_key`, `suggest_server_creds_update`, `create_server_user`, `change_server_user_password`, `execute_macro`, `suggest_macro`, `list_my_macros`, `send_email`, `schedule_task`, `delete_my_task` |
| `disable_pc_commands` | Без команд на ПК | `execute_pc_command` |
| `disable_pc_control_full` | Полная блокировка | Всё из lite + `execute_pc_command` + `control_smart_home`, `check_emails`, `read_email_content`, `get_my_tasks`, `explore_fs`, `desktop_action`, `map_control`, `get_map_pins`, `find_transit_route`, `search_nearby` |
| `disable_internet` | Без интернета и генерации | `search_web`, `read_webpage`, `generate_image` |
| `disable_personal` | Гостевой режим | `update_core_memory`, `search_cold_memory`, `save_to_cold_memory`, `delete_from_cold_memory`, `save_note`, `list_my_notes`, `read_note`, `delete_note`, `schedule_task`, `get_my_tasks`, `delete_my_task` + скрытие промпта и горячей памяти из system prompt |
| `disable_subagents` | Без субагентов | `invoke_subagent` |

**Как это работает (ai.ts):**

1. Все 3 обработчика (TG internal `/internal/ai/send`, SSE `/api/v1/chat/send`, WS `chat_send`) загружают `feature_flags` из записи пользователя через `parseFeatureFlags(user)`
2. Флаги передаются в `sendMessageThroughAi({ featureFlags })`
3. В `sendMessageThroughAi` формируется `disabledToolSet` (Set<string>) на основе активных флагов
4. **Двойная защита:**
   - `executionTools.filter()` — инструменты убираются из schema (AI не знает об их существовании)
   - Guard перед `runTool()` — даже если модель hallucinate tool call, `runTool` вернёт `"Инструмент отключён"` вместо выполнения
5. LITE-роутер: если cheap-маршрут содержит отключённый инструмент — форсируется PRO
6. Гостевой режим (`disable_personal`): дополнительно очищаются `core_memory`, `custom_prompt` и `pinned_macros` из system prompt

**Как добавить новый флаг:**

1. Добавить ключ в `VALID_FLAG_KEYS` в `server.ts`
2. Добавить ключ в тип `FeatureFlags` в `desktop-app/src/renderer/lib/api.ts`
3. Добавить инструменты в соответствующий блок `if (flags?.new_flag)` в `ai.ts` (в `sendMessageThroughAi`)
4. Добавить чекбокс в `SettingsModal.tsx` (desktop)

**Как добавить новый инструмент, который подчиняется флагам:**

Новый инструмент автоматически попадёт под фильтрацию если его `function.name` совпадает с именем, добавленным в `disabledToolSet`. Нужно добавить имя инструмента в соответствующий блок флага в `ai.ts` (секция `// ── Feature flags → disabled tools ──`).

### Клиентские инструменты — продолжение

| Инструмент | Описание |
|---|---|
| `set_display_state` | Управление пиксельным аватаром. Enum-значения (moods/reactions) берутся из `display_manifest` — массива, который клиент передаёт в body. Если манифеста нет (Telegram) — tool не добавляется. |
| `desktop_action` | Единый роутер управления интерфейсом десктопного приложения. Действия: `open_widget`, `close_widget`, `set_widget_data`, `open_note`, `read_widget_state`, `toggle_panel`. Цели: `notebook`, `tasks`. Позволяет боту открывать/закрывать виджеты, создавать черновики заметок, открывать конкретные записи по ID, читать состояние. |
| `map_control` | Управление картой в десктопе. Действия: `show_place` (геокодирование через Nominatim), `draw_route` (маршрут через OSRM). Результат отправляется как SSE `event: map_update`. |
| `get_map_pins` | Получить список сохранённых меток пользователя на карте. Возвращает расшифрованные координаты + названия. |
| `find_transit_route` | Поиск маршрутов общественного транспорта (автобус, маршрутка, троллейбус, трамвай) через Overpass API. Принимает координаты точки А и Б, опционально `radius_meters` (по умолчанию 500). Auto-retry с расширением радиуса если ничего не найдено. Возвращает текстовое описание маршрутов (доступно всем клиентам) + отправляет визуал на карту через SSE (desktop-only). |
| `search_nearby` | Поиск заведений и объектов (POI) рядом с точкой по названию через Overpass API. Принимает координаты, текст запроса (`query`) и `radius_meters` (по умолчанию 3000). Ищет по `name` (regex, case-insensitive) среди nodes и ways. Возвращает список мест с адресом/часами (доступно всем клиентам) + отправляет маркеры на карту через SSE (desktop-only). Auto-retry с расширением радиуса. |
| `list_my_macros` | Показывает список включённых макросов пользователя (id, title, description, commands). Lazy loading — AI вызывает инструмент, когда упоминается закреплённый макрос или пользователь просит выполнить макрос. |
| `execute_macro` | Запускает макрос по `macro_id` (number) или `macro_name` (string). Если `return_output: true` и десктоп подключён через WS — ожидает результат (stdout). Иначе — fire-and-forget через `desktop_action` (SSE/WS). Доступен и из Telegram: если десктоп онлайн — команды пушатся через WS. |
| `explore_fs` | Чтение директории на ПК пользователя. Если десктоп подключён через WS — возвращает listing (имя, тип, размер) как tool response для AI. Иначе — fire-and-forget (результат недоступен AI). Доступен и из Telegram при подключённом десктопе. |
| `execute_pc_command` | Выполняет команду на ПК пользователя через desktop IPC. Не-auto-approved команды требуют HitL-карточку `pc_command_confirmation`; pending регистрируется до отправки карточки, а сама карточка уходит через текущий WS callback активного `chat_send`. AI получает последние 15k символов stdout/stderr (`PC_COMMAND_OUTPUT_MAX`). |
| `suggest_macro` | Предлагает пользователю сохранить новый макрос. AI формирует `title, description, commands` → SSE `desktop_action` с `action: suggest_macro` → десктоп-клиент рендерит карточку «Сохранить/Отклонить». Может вызываться несколько раз за один ответ (множественные карточки). |
| `invoke_subagent` | Делегирует задачу специализированному субагенту. Динамически генерируется из реестра (`services/subagents/registry.ts`). Добавляется только при `isDesktop=true` и наличии зарегистрированных субагентов. |

### DevOps Agent Runtime — продолжение

Система удалённого выполнения SSH-команд на серверах пользователя с подтверждением через HitL (Human-in-the-Loop). Доступна из desktop и Telegram.

**AI-инструменты (desktop + Telegram через SSE):**

| Инструмент | Описание |
|---|---|
| `list_devops_servers` | Показывает список серверов пользователя (id, name, host, port, username). Без паролей/ключей. |
| `execute_ssh_command` | Выполняет SSH-команду на сервере. Сначала проверяет auto-approve политики → если есть совпадение, выполняет сразу. Иначе — отправляет карточку подтверждения на десктоп (HitL), блокирует tool call до ответа пользователя. |
| `list_devops_runbooks` | Показывает список инструкций пользователя (id, title, updated_at). |
| `read_devops_runbook` | Читает содержимое инструкции по id (title, content). |
| `suggest_devops_runbook` | Предлагает пользователю сохранить инструкцию. AI формирует `title, content, commands` → карточка в чате с кнопками «Сохранить»/«Проверить»/«Отклонить». |
| `install_ssh_public_key` | Устанавливает публичный SSH-ключ в `authorized_keys` выбранного пользователя. Если `key_id` не указан, берётся дефолтный ключ сервера. |
| `create_server_user` | Создаёт Linux-пользователя с sudo-группой. Пароль нового пользователя берётся из `sudo_password` сервера; если он не сохранён, пользователь вводит его в карточке подтверждения. `nopasswd_sudo` по умолчанию `false`. |
| `change_server_user_password` | Меняет пароль существующего Linux-пользователя. Новый пароль вводится пользователем в карточке подтверждения и не передаётся в аргументах tool call. |
| `suggest_server_creds_update` | Предлагает сменить credentials сервера: `username`, `use_ssh_key_for_login`, опционально очистить обычный SSH `password`. Блокирует tool call до подтверждения пользователя. |

**Архитектура безопасности:**

- **Шифрование:** все учётные данные (SSH пароль, приватный ключ, sudo-пароль) шифруются через AES-256-CBC и хранятся в `devops_servers`. Дешифровка только in-memory в момент выполнения команды.
- **Human-in-the-Loop:** каждая SSH-команда (кроме auto-approved) требует подтверждения пользователя. Карточка с информацией о команде отправляется одновременно на десктоп (WS `desktop_action`) и в Telegram (SSE `desktop_action` → inline-кнопки). Кнопки: «Разрешить» / «Разрешить всегда» / «? Проверить» / «Отклонить».
- **Auto-approve политики:** regex-паттерны для автоматического разрешения команд. Создаются вручную или при привязке инструкции к серверу. Точное совпадение: `^systemctl restart nginx$`.
- **Опасные команды:** блокируются на уровне SSH-executor (`rm -rf /`, `mkfs`, `dd of=/dev/`, `shutdown`, `init 0/6`, `chmod 000 /`, `chown` root-директорий).
- **Sudo:** если команда содержит `sudo` и в настройках сервера указан sudo-пароль — пароль передаётся через stdin stream (`sudo -S`), не виден в process list.
- **Буфер:** stdout/stderr ограничен 1MB, таймаут выполнения — 30 секунд.

**SSH/password поля:**

- `password` — обычный пароль для SSH-login. Не используется, если `use_ssh_key_for_login=true`.
- `private_key` / `default_ssh_key_id` — ключи для входа/установки. Дефолтный ключ можно хранить на сервере и ставить пользователям через `install_ssh_public_key`.
- `use_ssh_key_for_login` — явная галочка выбора способа входа. Если `true`, backend логинится по дефолтному SSH-ключу; если ключ не подходит, fallback на password не делается.
- `sudo_password` — пароль для `sudo -S` и пароль, который используется при `create_server_user`, если создаваемому пользователю нужен пароль.
- `change_server_user_password` не использует `sudo_password` как новый пароль: новый пароль вводится отдельно в confirmation card как `new_password`.

**Поток выполнения команды:**

```
AI: execute_ssh_command(server_id, command)
  → ai.ts: проверка isAutoApproved()
    → Да: прямой вызов execSshCommand() → stdout/stderr/exitCode
    → Нет: dual-delivery карточки подтверждения:
        ├─ TG (SSE): inline-кнопки Разрешить / Разрешить всегда / Проверить / Отклонить
        └─ Desktop (WS): desktop_action { action: 'devops_confirmation' }
      → ai.ts: блокировка на Promise (ожидание ответа из любого источника)
      → Разрешить: POST /internal/devops/approve { approved: true }
      → Разрешить всегда: создаёт политику + approve
      → Проверить: POST /internal/ai/lite (LITE AI анализ безопасности)
      → Отклонить: POST /internal/devops/approve { approved: false }
      → Promise резолвится → execSshCommand() → результат AI
```

**Инструкции (runbooks):**

Универсальные пошаговые руководства (Markdown) с набором shell-команд. Не привязаны к конкретному серверу.

- AI может предложить сохранить инструкцию (`suggest_devops_runbook`) — карточка в чате
- AI может извлечь команды из текста (`POST /api/v1/devops/runbooks/extract-commands`, LITE AI)
- AI может проверить безопасность команд (`POST /api/v1/devops/runbooks/review-commands`, LITE AI)
- Кнопка «Привязать инструкцию» в настройках сервера создаёт auto-approve политики для каждой команды

**Таблицы БД:**

| Таблица | Описание |
|---|---|
| `devops_servers` | SSH-серверы (name, host, port, username, password_enc, private_key_enc, sudo_password_enc, default_ssh_key_id, use_ssh_key_for_login) |
| `devops_policies` | Auto-approve политики (server_id, pattern, auto_approve) |
| `devops_runbooks` | Инструкции (user_id, title, content, commands JSON) |

**Подтверждения (in-memory):**

Ожидающие подтверждения хранятся в `Map<string, PendingDevopsConfirmation>` в `services/devops-confirmations.ts`. Авто-очистка каждые 30 секунд, TTL — 5 минут.

### Система макросов

Макросы — пользовательские наборы консольных команд, которые AI может запускать на десктоп-клиенте.

**Хранение:** таблица `macros` в SQLite (`services/macros.ts`):
- `id INTEGER` (автоинкремент), `user_id`, `title`, `description`, `commands` (JSON), `enabled`, `pinned`, `return_output`, `created_at`, `updated_at`
- Лимит: 50 макросов на пользователя
- Команды хранятся как JSON-массив строк, максимум 30 команд на макрос

**Поля макроса:**
| Поле | Тип | Описание |
|---|---|---|
| `title` | string | Название (до 100 символов) |
| `description` | string | Описание (до 500 символов), может генерироваться ИИ |
| `commands` | string[] | Массив консольных команд |
| `enabled` | boolean | Включён/выключен |
| `pinned` | boolean | Закреплён — название попадает в системный промпт как подсказка для AI |
| `return_output` | boolean | Если `true` — бот ожидает stdout команд от десктопа (требует WS-подключение). Если десктоп не подключён — fire-and-forget |

**Архитектура видимости макросов для AI:**
1. **Pinned-подсказка** — если у макроса `pinned: true`, его название добавляется в системный промпт: `[ЗАКРЕПЛЁННЫЕ МАКРОСЫ] У пользователя есть ... "Макрос 1", "Макрос 2". Если запрос совпадает — вызови list_my_macros.`
2. **Lazy loading** — AI вызывает `list_my_macros` чтобы увидеть полный список с командами, затем `execute_macro` для запуска конкретного макроса
3. Макросы загружаются из БД (`getEnabledMacros(userId)`) при каждом запросе, не передаются клиентом
4. Макросы доступны из всех клиентов (desktop, Telegram), а не только из desktop

**TG→Desktop push (запуск макроса из Telegram):**
- Эндпоинт `/internal/ai/send` передаёт `activeMacros` в `sendMessageThroughAi`
- Если AI вызывает `execute_macro` (fire-and-forget), результат записывается в `desktopActionSink`
- После возврата `sendMessageThroughAi`, server.ts проверяет `result.desktop_action` и `isDesktopOnline(userId)`
- Если десктоп подключён через WS — `desktop_action` пушится через WebSocket
- Десктоп-клиент при получении `desktop_action` с `action === 'execute_macro'` выполняет команды через `electronAPI.executeCommands()`
- Условие: TG-аккаунт должен быть привязан к desktop-аккаунту (через `linked_tg_id`)

**Поток выполнения макроса:**
1. AI видит pinned-подсказку или пользователь просит запустить макрос
2. AI вызывает `list_my_macros` → получает список (id, title, description, commands)
3. AI вызывает `execute_macro` с `macro_id` или `macro_name`
4. Бэкенд находит макрос в `activeMacros`, формирует SSE payload: `{ action: 'execute_macro', target: '<macro_id>', value: { macro_name, commands } }`
5. Сервер отправляет SSE `event: desktop_action` → десктоп-клиент получает payload
6. `handleDesktopAction()` в `tools.ts` извлекает `commands` из payload и вызывает `window.electronAPI.executeCommands(commands)`
7. Electron IPC `execute-commands` выполняет команды последовательно через `child_process.exec` с блокировкой опасных команд

**AI-помощники для макросов (лёгкие LITE-запросы через `callLiteAi`):**
- `POST /api/v1/macro/explain` — ИИ объясняет, что делают команды
- `POST /api/v1/macro/describe` — ИИ предлагает лучшее название и описание (отправляет текущие `current_title`/`current_description` для улучшения)

**Предложение макроса (`suggest_macro`):**
1. AI решает предложить пользователю сохранить макрос → вызывает `suggest_macro` с `title, description, commands`
2. SSE `desktop_action` с `action: 'suggest_macro'` → клиент рендерит карточку
3. Пользователь нажимает «Сохранить» → POST `/api/v1/macros` → макрос сохраняется в БД
4. Может быть несколько карточек одновременно (массив `pendingMacros`)

**Ограничения (текущие):**
- Опасные команды блокируются на уровне IPC (`rm -rf /`, `format`, `shutdown` и т.д.)
- `return_output` и `explore_fs` требуют WS-подключение десктопа; без WS — fire-and-forget
1. AI вызывает `desktop_action` tool → `runTool` парсит action/target/value → записывает в `desktopActionSink`
2. Сервер отправляет SSE `event: desktop_action` с payload на клиент
3. Клиент (`handleDesktopAction`) выполняет команду: открывает панель, переключает виджет, заполняет черновик и т.д.
4. Результат также возвращается в `done` событии как `desktop_action`

**Поток `map_control`:**
1. AI вызывает `map_control` tool → `runTool` геокодирует адрес (Nominatim) или строит маршрут (OSRM)
2. Результат записывается в `mapUpdateSink` → сервер отправляет SSE `event: map_update` с `{ action, lat, lng, label, from?, to?, route? }`
3. Клиент ловит `onMapUpdate` → открывает MapTool, обновляет карту (flyTo / fitBounds / polyline)
4. Координаты маршрута конвертируются из OSRM [lng,lat] в Leaflet [lat,lng]

**Поток `find_transit_route`:**
1. AI вызывает `find_transit_route` tool с координатами `from_lat, from_lon, to_lat, to_lon`, опционально `radius_meters` (default 500)
2. `runTool` вызывает `services/transit.ts` → Overpass API запрос находит OSM route relations (bus, share_taxi, trolleybus, tram). Auto-retry с расширением радиуса если ничего не найдено
3. Парсинг ответа: `members` с `role=stop|platform` → остановки, `type=way` → геометрия маршрута (polyline)
4. Для каждого маршрута: haversine distance → ближайшие остановки к точке А (pickup) и Б (dropoff) → обрезка stops/path до сегмента между ними → scoring по мин. пешему расстоянию
5. Лучший вариант отправляется в `mapUpdateSink` с `action: 'transit_route'` → SSE `event: map_update` с `{ action, routeName, path (sliced), stops (sliced) }`
6. AI получает JSON с `pickupStop`, `dropoffStop`, `stopsToRideList`, `totalWalkingMeters` — формулирует ответ (доступно для всех клиентов)
7. На desktop-клиенте MapTool рендерит зелёную polyline (только сегмент поездки) + оранжевые маркеры остановок + fitBounds

**Поток `search_nearby`:**
1. AI вызывает `search_nearby` с `latitude, longitude, query, radius_meters?`
2. `runTool` вызывает `services/transit.ts` → Overpass ищет nodes/ways с `name~"query"` в указанном радиусе
3. Ответ парсится: извлекаются координаты, название, адрес, часы работы, категория
4. Результат записывается в `mapUpdateSink` с `action: 'poi_search'` → SSE `event: map_update` с `{ action, lat, lng, query, places }`
5. Инструмент возвращает текстовый JSON со списком найденных мест — AI формулирует ответ (доступно для всех клиентов)
6. На desktop-клиенте MapTool рендерит фиолетовые маркеры POI + flyTo к первому результату
7. Auto-retry: если поиск в указанном радиусе пуст, бэкенд расширяет радиус и повторяет запрос

**Хранение меток:**
- Таблица `map_pins`: `id, user_id, lat_enc, lng_enc, label, created_at, updated_at`
- Координаты шифруются через `aes-256-cbc` с ключом из `MAP_PINS_ENCRYPTION_KEY` (fallback на `ENCRYPTION_KEY`)
- Бот получает расшифрованные координаты через `get_map_pins` tool
- Клиент управляет через REST API `/api/v1/map-pins`

## Типовые ошибки

- `400` - плохой ввод (`bad_*`, `*_required`).
- `401` - неверный токен (`unauthorized`, `unauthorized_internal`).
- `403` - доступ запрещен (`access_not_approved`, `forbidden_admin_only`).
- `404` - сущность не найдена (`user_not_found`, `note_not_found` и т.д.).
- `409` - конфликт (`name_already_exists`, `login_already_exists`).
- `422` - бизнес-ограничение (`notes_limit`, `cannot_delete_default_prompt`, `cannot_ban_admin_from_env`).
- `429` - лимиты (`daily_message_limit_reached`).
- `500` - внутренняя ошибка (`internal_error`/`*_failed`).

## Полнотекстовый поиск (FTS5)

Поиск по сообщениям использует встроенный в SQLite полнотекстовый индекс (FTS5). Таблица `messages_fts` создаётся автоматически при первом запуске и заполняется из существующих `chat_messages`.

### Как это работает

- **Индекс:** виртуальная таблица `messages_fts USING fts5(content, user_id UNINDEXED, chat_id UNINDEXED, message_id UNINDEXED, tokenize="unicode61")`. Токенайзер `unicode61` поддерживает кириллицу из коробки.
- **Автообновление:** триггеры на INSERT/DELETE в `chat_messages` автоматически добавляют/удаляют записи из FTS.
- **Fallback:** при каждом запуске сервер проверяет наличие триггеров. Если хотя бы один отсутствует -- оба пересоздаются, а FTS полностью перестраивается из `chat_messages`. Это гарантирует полноту индекса после сбоев.
- **Поиск:** префиксный (`word*`) -- ищет по части слова. Результаты сгруппированы по `chat_id`, отсортированы по релевантности (`rank`). Для каждого чата возвращается `snippet()` -- фрагмент текста с выделенным совпадением.

### Безопасность

- Поиск scoped по `user_id` -- юзер видит только свои сообщения.
- Минимальная длина запроса: 3 символа.
- Результаты ограничены `LIMIT` (по умолчанию 20, максимум 50).
- Клиент использует debounce (300 мс) -- не более ~3 запросов/сек.

## Курсы валют (ЦБ РФ)

Автоматическое обновление курсов валют с ЦБ РФ. Бесплатно, без ключей авторизации.

### Архитектура

- **Источник:** `https://www.cbr.ru/scripts/XML_daily.asp` — XML с курсами всех валют.
- **Парсер:** `fast-xml-parser`. Нюанс: ЦБ отдаёт значения с запятой (`89,1234`) → `.replace(',', '.')` → `parseFloat`.
- **Хранение:** таблица `currency_rates` — `code` (PK), `name`, `value`, `prev_value`, `nominal`, `updated_at`. При обновлении старое `value` перетекает в `prev_value`.
- **Обновление:** scheduler дергает API при старте, затем каждый день в ~14:00 МСК (11:00 UTC) — ЦБ обновляет курсы примерно в это время.
- **Сервис:** `services/currency.ts` — `fetchAndSaveCurrencyRates()`, `getCurrencyRates()`, `formatRateForAi()`.

### AI-инструмент

- `get_exchange_rates` — возвращает курсы с динамикой. Если код не указан — по умолчанию USD и EUR.
- Формат ответа: `USD (Доллар США): 89.5000 RUB (-0.5000)`

## WebSocket Transport

WebSocket сервер на том же порту (3050), путь `/ws`, аутентификация через JWT access token в query-параметре. Десктоп-клиент подключается при старте приложения, auto-reconnect (exponential backoff 1s → 30s). Эндпоинт `POST /api/v1/chat/send` работает через SSE (Server-Sent Events) и используется как fallback (если WS не подключён). Формат событий: `intermediate`, `tool_status`, `display_state`, `done`, `error`. Валидация изображений остаётся обычной HTTP-ошибкой (до переключения на SSE).

### Архитектура

- `ws-clients.ts` — общий реестр подключений (`wsClients` Map), `sendIpcToDesktop()`, `sendToDesktop()`, `isDesktopOnline()`. Проверяется `WebSocket.OPEN`, поэтому stale/closing сокеты не считаются рабочими. Импортируется и server.ts (регистрация), и ai.ts (IPC).
- `server.ts` — `WebSocketServer` на `/ws`, обработчики `chat_send` / `ipc_result` / `ping`. Realtime callbacks (`desktop_action`, `tool_status`, `execute_ipc`) отправляются с callback-ошибкой `ws.send`.
- `ai.ts` — `execute_macro`, `explore_fs` и `execute_pc_command` используют desktop IPC для запросов с ожиданием результата; `execute_pc_command` с HitL отправляет confirmation через callback текущего `chat_send`.
- Диагностика IPC пишет логи `[pc_command] ...` и `[ipc] ...` (dispatch, write complete, `ipc_result`, timeout, resolve/reject), связываемые по `request_id`.

### Разблокированные функции (через IPC)

- `explore_fs` — AI получает листинг директории как tool response (ранее fire-and-forget).
- `execute_macro` с `return_output: true` — AI получает stdout команд (ранее не работало).
- Обратный канал: сервер шлёт `execute_ipc` с `request_id` → десктоп выполняет IPC → отвечает `ipc_result`.

### Протокол WS-сообщений (JSON `{ type, ...data }`)

| Клиент → Сервер | Описание |
|---|---|
| `chat_send` | Отправить сообщение AI |
| `chat_stop` | Остановить текущую генерацию AI для пользователя |
| `ipc_result` | Результат IPC-команды |
| `ping` | Keepalive |

| Сервер → Клиент | Описание |
|---|---|
| `intermediate` | Промежуточный текст AI |
| `display_state` | Состояние аватара |
| `desktop_action` | Команда UI / макрос |
| `tool_status` | Статус выполнения инструмента |
| `map_update` | Данные карты |
| `done` | Финальный ответ |
| `error` | Ошибка |
| `execute_ipc` | Запрос выполнить IPC и вернуть результат |
| `pong` | Ответ на ping |

### Остановка генерации (`chat_stop` / `/api/v1/chat/stop`)

- На каждый `sendMessageThroughAi` создаётся один `AbortController`, который сразу регистрируется в `activeGenerations` по `userId`.
- `chat_stop` по WS и `POST /api/v1/chat/stop` делают одно и то же: находят controller пользователя и вызывают `abort()`.
- Обычный маршрут запроса не меняется: `sendMessageThroughAi` → `runCompletion` → `runTool` → финальный `runCompletion`. `AbortSignal` только прокидывается в места ожидания.
- Signal слушают OpenAI-запросы, retry-паузы, ожидание tool через `withAbort`, desktop IPC (`sendIpcToDesktop`) и web-search транспорт Tavily через `fetch(..., { signal })`.
- `finally` удаляет controller из `activeGenerations` только если это тот же controller, чтобы старый завершившийся запрос не снёс controller нового запроса.

## SSE-стриминг и Dual-Delivery подтверждений

### SSE-эндпоинт `/internal/ai/stream`

Потоковая передача AI-ответов для TG-бота (вместо обычного JSON `/internal/ai/send`). Передаёт `onIntermediateMessage`, `onToolStatus`, `onDesktopAction` колбэки в `sendMessageThroughAi`, позволяя TG-боту получать процесс работы AI в реалтайме.

**События SSE:**

| Событие | Payload | Описание |
|---|---|---|
| `intermediate` | `{ text }` | Промежуточный текст AI |
| `tool_status` | `{ text }` | Статус инструмента |
| `display_state` | `{ state, ... }` | Состояние аватара |
| `desktop_action` | `{ action, target?, value? }` | Карточка подтверждения / макрос |
| `done` | `{ reply_text, chat_id, message_id, ... }` | Финальный ответ AI |
| `error` | `{ error }` | Ошибка |

### Dual-Delivery подтверждений

Confirmation-карточки (`pc_command_confirmation`, `devops_confirmation`, `suggest_server_creds_update`, `create_server_user`, `change_server_user_password`) отправляются **одновременно** через SSE-колбэк (в TG inline-кнопки) и через WS (`sendToDesktop` в desktop_action). Кто первый ответил — резолвит Promise, второй канал игнорируется.

### Tool availability split

Инструменты разделены на две группы:

- **`serverOnlyTools`** (всегда доступны, без `isDesktop`): SSH, DevOps, PC commands, maps, transit.
- **`desktopOnlyTools`** (только `isDesktop=true`): `desktop_action` (UI-управление).
- `invoke_subagent` — только `isDesktop=true`.

### Intermediate content: `fullDbHistory`

`sendMessageThroughAi` всегда возвращает `fullDbHistory` (аккумулированный текст за весь цикл), а не `finalAnswer` (последний чанк). Это гарантирует что desktop `done` handler не затирает промежуточный контент последним чанком. Раньше если AI генерировал текст + tool call одновременно, текст уходил через `onIntermediateMessage`, а `done` содержал только последний чанк.

**Колбэки real-time в `sendMessageThroughAi`:**
- `onIntermediateMessage` — текст, сгенерированный на промежуточных шагах (текст + tool call одновременно).
- `onStateChange` — мгновенная передача изменений аватара при вызове `set_display_state`.
- `onToolStatus` — статусы типа "Ищу информацию..." в реалтайме.

## Система обновлений (Admin)

Кастомный механизм обновлений desktop-клиента. Сервер хранит `version.json` и payload-файлы, а desktop-клиент сам проверяет манифест и устанавливает обновление.

Типы обновлений:

| Тип | Payload | Когда использовать |
|---|---|---|
| `minor` | новый `app.asar` | Код приложения и assets внутри `app.asar` |
| `major` | NSIS `.exe` | Electron, native/unpacked files, `extraResources`, модели, DLL |

### Файловая структура

```
backend-api/updates/
  version.json                 # манифест, создаётся админкой или вручную
  chatter-update-<ts>.asar      # minor payload, имя генерирует админка
  chatter-update-<ts>.exe       # major payload, если exe загружен на сервер
```

Папка `updates/` раздаётся через `express.static` на `/updates/` и автоматически создаётся при старте.

### version.json

```json
{
  "version": "1.4.0",
  "type": "minor",
  "downloadUrl": "chatter-update-1780866466318.asar",
  "releaseNotes": "Что нового",
  "size": 49467302
}
```

- `version` — версия, с которой desktop сравнивает `app.getVersion()`. Обновление показывается только если manifest version новее текущей.
- `type` — `minor` или `major`.
- `downloadUrl` — имя файла внутри `/updates/` или полный прямой URL.
- `releaseNotes` — текст в модалке обновления.
- `size` — размер payload в байтах, используется для отображения.

Для `major` внешний URL должен быть прямой ссылкой на `.exe`. Публичная страница облака не подходит: клиент скачает HTML вместо инсталлера. Если URL не заканчивается на `.exe`, desktop сохранит файл как `.tmp` и откажется устанавливать major.

### Админка обновлений

HTML-страница с формой для публикации обновлений.

- `GET /admin/updates` — HTML-страница (login → dashboard)
- `GET /admin/updates/status` — текущий манифест + список файлов (admin JWT)
- `POST /admin/updates/upload` — загрузка файла + генерация `version.json` (multipart/form-data, admin JWT)
- `DELETE /admin/updates/file/:name` — удаление файла (admin JWT)

Форма позволяет загрузить файл (`.asar`, `.exe`, `.zip`), указать версию, тип, release notes, либо указать внешний URL вместо файла.

Upload реализован через `busboy`: файл пишется потоково в `updates/`, после завершения записи создаётся `version.json`.

Админ-доступ:
- пользователь логинится логином/паролем desktop/API-аккаунта через `/api/v1/auth/login`;
- доступ разрешён, если `is_admin = 1` у самого desktop/API user или у привязанного Telegram user (`linked_tg_id`);
- `version.json` не показывается в списке файлов для удаления, его содержимое отображается наверху как `Current`.

### Публикация minor

1. В `desktop-app/package.json` поднять `version`.
2. Собрать desktop: `npm run build:win`.
3. Достать `resources/app.asar` из release zip/unpacked-сборки.
4. Открыть `/admin/updates`, выбрать `type: minor`, загрузить `app.asar`.
5. Админка сохранит файл как `chatter-update-<timestamp>.asar` и обновит `version.json`.

### Публикация major

1. В `desktop-app/package.json` поднять `version`.
2. Собрать desktop: `npm run build:win`.
3. В `/admin/updates` выбрать `type: major`.
4. Загрузить NSIS `.exe` или указать прямой `.exe` URL.
