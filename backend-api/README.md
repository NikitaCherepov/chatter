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
- `BROWSERLESS_TOKEN` (+ `BROWSERLESS_BASE_URL` опционально) - для `/internal/tools/read_url`.
- `PROXYAPI_KEY` - ключ ProxyAPI для генерации изображений.
- `PROXYAPI_BASE_URL` - базовый URL ProxyAPI (по умолчанию `https://api.proxyapi.ru/openai/v1`).
- `IMAGE_GEN_MODEL` - модель генерации (по умолчанию `gpt-image-1`).
- `IMAGE_GEN_QUALITY` - качество: `low`/`medium`/`high` (по умолчанию `low`).
- `IMAGE_GEN_SIZE` - размер: `1024x1024` (по умолчанию `1024x1024`).

### AI-провайдеры (основные)

- `TIMEWEB_BASE_URL` + `TIMEWEB_API_KEY` - PRO-провайдер (по умолчанию).
- `TIMEWEB_MODEL` - цепочка моделей PRO (через запятую, fallback).
- `TIMEWEB_LITE_BASE_URL` + `TIMEWEB_LITE_API_KEY` - LITE-провайдер.
- `TIMEWEB_LITE_MODEL` - цепочка моделей LITE.
- `TIMEWEB_LITE_ROUTER_ENABLED` - `0`, чтобы не вызывать LITE-router и сразу отправлять все текстовые запросы в PRO (по умолчанию включен).
- `TIMEWEB_PRO_ENDPOINTS` - дополнительные PRO-эндпоинты (формат: `base_url|api_key|models;...`).
- `TIMEWEB_LITE_ENDPOINTS` - дополнительные LITE-эндпоинты (аналогично).

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
  - `POST /internal/ai/send` -> `{ user_id, text, chat_id?, options? }` -> `{ reply_text, chat_id, message_id, model_fallback_notice?, tool_user_messages?, generated_images?, usage }`
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

## AI-инструменты

Инструменты доступны AI через tool calling. Определены в `services/ai.ts` в `toolDefinitions`.

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

### Клиентские инструменты (desktop-only)

Доступны только если в запросе передан `is_desktop: true`. Не показываются в Telegram.

| Инструмент | Описание |
|---|---|
| `set_display_state` | Управление пиксельным аватаром. Enum-значения (moods/reactions) берутся из `display_manifest` — массива, который клиент передаёт в body. Если манифеста нет (Telegram) — tool не добавляется. |
| `desktop_action` | Единый роутер управления интерфейсом десктопного приложения. Действия: `open_widget`, `close_widget`, `set_widget_data`, `open_note`, `read_widget_state`, `toggle_panel`. Цели: `notebook`, `tasks`. Позволяет боту открывать/закрывать виджеты, создавать черновики заметок, открывать конкретные записи по ID, читать состояние. |
| `map_control` | Управление картой в десктопе. Действия: `show_place` (геокодирование через Nominatim), `draw_route` (маршрут через OSRM). Результат отправляется как SSE `event: map_update`. |
| `get_map_pins` | Получить список сохранённых меток пользователя на карте. Возвращает расшифрованные координаты + названия. |
| `find_transit_route` | Поиск маршрутов общественного транспорта (автобус, маршрутка, троллейбус, трамвай) через Overpass API. Принимает координаты точки А и Б, опционально `radius_meters` (по умолчанию 500). Auto-retry с расширением радиуса если ничего не найдено. Возвращает текстовое описание маршрутов (доступно всем клиентам) + отправляет визуал на карту через SSE (desktop-only). |
| `search_nearby` | Поиск заведений и объектов (POI) рядом с точкой по названию через Overpass API. Принимает координаты, текст запроса (`query`) и `radius_meters` (по умолчанию 3000). Ищет по `name` (regex, case-insensitive) среди nodes и ways. Возвращает список мест с адресом/часами (доступно всем клиентам) + отправляет маркеры на карту через SSE (desktop-only). Auto-retry с расширением радиуса. |
| `list_my_macros` | Показывает список включённых макросов пользователя (id, title, description, commands). Lazy loading — AI вызывает инструмент, когда упоминается закреплённый макрос или пользователь просит выполнить макрос. |
| `execute_macro` | Запускает макрос по `macro_id` (number) или `macro_name` (string). Бэкенд находит макрос в `activeMacros` (загружаются из БД через `getEnabledMacros`), включает команды в SSE payload `desktop_action` с `action: execute_macro`. Десктоп-клиент выполняет команды через IPC `execute-commands`. |
| `explore_fs` | Запрос на чтение директории на ПК пользователя. Отправляет SSE `desktop_action` с `action: execute_macro, target: '__explore_fs__'`. Десктоп-клиент выполняет `readDirectory` IPC. **Ограничение:** SSE однонаправленный — результат чтения не возвращается AI (требуется WebSocket для полного функционала). |
| `suggest_macro` | Предлагает пользователю сохранить новый макрос. AI формирует `title, description, commands` → SSE `desktop_action` с `action: suggest_macro` → десктоп-клиент рендерит карточку «Сохранить/Отклонить». Может вызываться несколько раз за один ответ (множественные карточки). |

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
| `return_output` | boolean | (Зарезервировано) Вернуть вывод команд AI. Пока не реализовано — требует WebSocket для обратного канала |

**Архитектура видимости макросов для AI:**
1. **Pinned-подсказка** — если у макроса `pinned: true`, его название добавляется в системный промпт: `[ЗАКРЕПЛЁННЫЕ МАКРОСЫ] У пользователя есть ... "Макрос 1", "Макрос 2". Если запрос совпадает — вызови list_my_macros.`
2. **Lazy loading** — AI вызывает `list_my_macros` чтобы увидеть полный список с командами, затем `execute_macro` для запуска конкретного макроса
3. Макросы загружаются из БД (`getEnabledMacros(userId)`) при каждом запросе, не передаются клиентом

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
- SSE однонаправленный — `explore_fs` не может вернуть результат чтения директории AI
- `return_output` не реализован — для возврата stdout команд AI требуется WebSocket
- Опасные команды блокируются на уровне IPC (`rm -rf /`, `format`, `shutdown` и т.д.)
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

## Changelog

### 2025-05-03: Image Storage & Persistence

**Проблема:** Пользовательские и сгенерированные изображения не сохранялись на сервере. После отправки картинки в AI vision или генерации через `generate_image` — base64 просто терялся. В истории чата (desktop/TG) картинки не отображались.

**Решение — хранение изображений на сервере:**
- Новый сервис `services/image-storage.ts` (зависимость `sharp`):
  - `saveUserImageThumbnail()` — ресайзит до 512px, конвертирует в webp, сохраняет в `uploads/`.
  - `saveGeneratedImage()` — сохраняет PNG без сжатия.
- Статический сервер `/uploads/` с кешированием 30 дней.
- API скачивания `GET /api/v1/images/:filename` — только для владельца (JWT + проверка `images` в `chat_messages`).

**БД:**
- Колонка `images TEXT` в `chat_messages` — JSON-массив `[{ "url": "/uploads/abc.webp", "type": "user_photo" | "generated" }]`.
- `appendChatMessage` принимает параметр `images[]`.
- `getChatMessages` парсит и возвращает `images` в ответе.

**Токены AI:**
- `getHistoryForAi()` **не тронут** — AI видит только текст `[Фото]caption`, картинки не отправляются повторно в контексте.
- Разделение: "история для AI" = только текст, "история для отображения" = текст + images[].

**Потоки данных:**
- **Desktop отправляет фото:** base64 → сервер ресайзит + сохраняет thumbnail → оригинал в AI vision → в БД: `images: [{ url, type: "user_photo" }]`.
- **Генерация изображения:** AI вызывает `generate_image` → b64 сохраняется на диск → возвращается `image_url` → в БД assistant-сообщения: `images: [{ url, type: "generated" }]`.
- **Telegram фото:** бот скачивает фото → `/internal/photo/analyze` → thumbnail сохраняется → в БД user-сообщения.

**Типы:**
- `MessageImage` — `{ url: string; type: 'user_photo' | 'generated' }`.
- `GeneratedImage` — добавлено поле `image_url`.
- `ChatSendResponse` — добавлено поле `generated_images`.

### 2025-05-03: Agent Loop Fix + SSE Streaming

**Баг агентского цикла:**
Когда AI-модель генерировала текст и одновременно вызывала tool call (например `set_display_state`), текст терялся. На следующем проходе модель возвращала `content: null` с `finish_reason: "stop"`, и код подхватывал JSON-ответ инструмента как финальный ответ юзеру.

**Фикс в `services/ai.ts`:**
- Добавлены переменные `fullDbHistory` (буфер всего текста для БД) и `finalAnswer` (последний текст для отправки).
- `appendChatMessage` теперь получает `fullDbHistory || answer` — полная история сохраняется даже если текст ушёл через коллбэк.
- Добавлены коллбэки в `sendMessageThroughAi`:
  - `onIntermediateMessage` — текст, сгенерированный на промежуточных шагах (текст + tool call одновременно).
  - `onStateChange` — мгновенная передача изменений аватара при вызове `set_display_state`.
  - `onToolStatus` — статусы типа "Ищу информацию..." в реалтайме.

**SSE Streaming для Desktop-клиента:**
- Эндпоинт `POST /api/v1/chat/send` переведён с обычного JSON-ответа на SSE (Server-Sent Events).
- Формат событий: `intermediate`, `tool_status`, `display_state`, `done`, `error`.
- Валидация изображений остаётся обычной HTTP-ошибкой (до переключения на SSE).
- Telegram-бот не затронут — он ходит через `/internal/ai/send`, который остался JSON.
