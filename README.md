# Chatter Bot (`index.ts`)

Telegram-бот проекта `chatter`.

`index.ts` отвечает за Telegram UX (команды, меню, обработку текста/голоса/фото) и ходит в `backend-api` через internal API для AI и управления пользователями.

## Что важно понимать

- Бот и API запускаются как два отдельных процесса.
- Для user lifecycle бот использует backend (`/internal/users/*`), поэтому backend должен быть запущен.
- Основная БД проекта: `chatter.db`.

## Быстрый старт

1. Установить зависимости:

```bash
npm install
```

2. Настроить `.env` (минимум см. ниже).
3. Запустить backend API:

```bash
npm run dev:api
```

4. В другом терминале запустить бота:

```bash
npm run dev
```

## PM2 запуск

```bash
npm run start:api
npm run start
```

```bash
npm run logs:api
npm run logs
```

## Минимальные ENV для бота

- `TELEGRAM_TOKEN` - токен Telegram-бота.
- `BACKEND_INTERNAL_TOKEN` - должен совпадать с backend.
- `BACKEND_API_BASE_URL` - по умолчанию `http://127.0.0.1:3050`.

## Рекомендуемые ENV

- `ADMIN_IDS` или `ADMIN_ID` - чтобы назначить админов.
- `ENCRYPTION_KEY` - ключ шифрования для mail-данных.
- `NOTES_WEBAPP_URL` - ссылка на WebApp заметок в меню.
- `AUTO_SYNC_PLAN_LIMITS_ON_BOOT=1` - авто-синхронизация лимитов при старте.
- `BACKEND_TIMEOUT_AI_MS` - таймаут AI-запросов (ms), по умолчанию `120000` (2 мин).
- `BACKEND_TIMEOUT_MEDIA_MS` - таймаут голоса/фото (ms), по умолчанию `180000` (3 мин).
- `BACKEND_TIMEOUT_DEFAULT_MS` - таймаут прочих запросов к backend (ms), по умолчанию `15000` (15 сек).

## AI-инструменты

Бот получает список инструментов из backend и передаёт их AI. Доступные:

- **search_web** - поиск в интернете (Tavily).
- **read_webpage** - чтение и очистка текста веб-страницы.
- **get_smart_devices** / **control_smart_home** - управление умным домом (Яндекс). Два инструмента: первый возвращает список устройств из БД, второй управляет по device_id. Токен и устройства настраиваются через UI (Настройки → Умный дом).
- **schedule_task** / **get_my_tasks** / **delete_my_task** - планирование задач и напоминаний.
- **set_user_timezone** - установка часового пояса.
- **check_emails** / **read_email_content** / **send_email** - работа с почтой.
- **save_note** / **list_my_notes** / **read_note** / **delete_note** - заметки.
- **update_core_memory** - статический профиль пользователя.
- **search_cold_memory** / **save_to_cold_memory** / **delete_from_cold_memory** - векторный архив памяти.
- **random_roll** - бросок монетки/кубиков.
- **generate_image** - генерация изображений по текстовому описанию. Вызывается при явном намерении ("нарисуй", "сгенерируй картинку"). Промпт автоматически переводится на английский. Изображение отправляется в Telegram как фото.
- **execute_pc_command** - выполнение команды на ПК пользователя. Требует подтверждения через inline-кнопки (если десктоп подключён). Опциональный `background: true` используется для открытия GUI-приложений (VS Code, Notepad, браузер), когда не нужен stdout/stderr и не надо ждать закрытия окна.
- **execute_ssh_command** - выполнение SSH-команды на сервере. Требует подтверждения через inline-кнопки.
- **list_devops_servers** / **list_devops_runbooks** / **read_devops_runbook** / **suggest_devops_runbook** - DevOps инструменты.
- **install_ssh_public_key** / **create_server_user** / **change_server_user_password** / **suggest_server_creds_update** - управление SSH-доступом.
- **map_control** / **get_map_pins** / **find_transit_route** / **search_nearby** - карта, маршруты, поиск мест.
- **list_my_macros** / **execute_macro** - пользовательские макросы консольных команд.
- **explore_fs** - чтение директории на ПК (требует подключённого десктопа).
- **suggest_macro** - предложение сохранить новый макрос.
- **capture_screen** - скриншот экрана ПК. Бэкенд делает скриншот через десктоп, отправляет в vision-модель для анализа (поиск элементов, описание интерфейса). Скриншот сохраняется и показывается в чате. Координаты возвращаются в нормализованном виде (0.0–1.0) для использования в execute_visual_click. Требует подключённого десктопа.
- **execute_visual_click** - клик мышкой по указанным координатам на экране ПК. Перед кликом делает свежий скриншот, рисует красный прицел (круг + перекрестье) и отправляет в Telegram как фото с inline-кнопками «Кликнуть» / «Отклонить». После подтверждения nut.js двигает реальный курсор и кликает. Координаты — нормализованные (0.0–1.0), поддерживается мульти-монитор. Требует подтверждения пользователя и подключённого десктопа.

## Основные команды

Пользователь:

- `/start`, `/menu`
- `/clear`
- `/tz <UTC>`
- `/tasks`, `/task_delete <id>`
- `/note_add <текст>`, `/notes`, `/note_find <текст>`, `/note_delete <id>`
- `/mail_setup <prov> <mail> <app_pass>`, `/mail_use <yandex|google>`, `/mail_limit`, `/mail_forget`
- `/chats`, `/chat_new [название]`, `/chat_use <id>`
- `/rename`
- `/prompts`, `/prompt_use <id>`

## Документы (attachments) в Telegram

Помимо фото, бот умеет принимать текстовые документы: txt, md, json, csv, log, xml, yaml, ini, toml, код (py, js, ts, go, rs, java, c, cpp, cs, php, sh, sql, html, css и т.д.), **docx**, **pdf**, rtf. Лимит — 5 МБ на файл (идентично desktop). Эти же файлы сразу появляются в `DocumentsTool` десктопа — бэкенд тот же.

Работает ровно как фото: пришёл файл → сразу уходит в AI.

- **Файл + подпись (caption)** — подпись становится текстом запроса, файл прикрепляется к этому же сообщению.
- **Файл без подписи** — уходит с нейтральным плейсхолдером («Проанализируй прикреплённые документы.»).
- **Несколько файлов как альбом** (`media_group_id`) — собираются через короткий таймер и уходят одним AI-запросом; caption берётся с первого сообщения группы.

Поток данных: TG-бот скачивает файл → base64 → `POST /internal/ai/stream` с полем `documents[]` → бэкенд парсит (через `parseDocument`), сохраняет файл, пишет `attachments` JSON в `chat_messages` и инджектит extracted_text в AI-контекст. Та же логика, что в `/api/v1/chat/send` для desktop.

Desktop (дополнительно):

- Полнотекстовый поиск по сообщениям в сайдбаре (FTS5, debounce 300 мс)
- `GET /api/v1/chats/search?q=keyword` — возвращает чаты со сниппетами найденных сообщений

Админ (дополнительно):

- `/add`, `/remove`
- `/users`
- `/ban <id> [причина]`, `/unban <id>`
- `/prompt_add`, `/prompt_show`, `/prompt_set`, `/prompt_desc`, `/prompt_rename`, `/prompt_default`, `/prompt_delete`
- `/history_user <user_id> [limit]`
- `/history_delete <user_id> <message_id> [db|tg]`
- `/sync_plan_limits`

## Сборка

```bash
npm run build
```

Скомпилированный файл: `dist/index.js`.

## Если бот не отвечает

1. Проверить, что backend жив:

```bash
curl -s http://127.0.0.1:3050/health
```

2. Проверить логи:

```bash
npm run logs:api
npm run logs
```

3. Проверить, что `BACKEND_INTERNAL_TOKEN` одинаковый у бота и backend.

## Смежная документация

- API backend: [backend-api/README.md](./backend-api/README.md)

## SSE-стриминг и подтверждения команд в Telegram

Бот работает с backend через SSE-стриминг (`/internal/ai/stream`) — пользователь видит процесс работы AI в реальном времени: промежуточные сообщения, статусы инструментов, карточки подтверждения команд.

### Как это работает

1. Пользователь отправляет текст боту
2. Бот открывает SSE-соединение с backend (`POST /internal/ai/stream`)
3. Backend стримит события: `intermediate` (промежуточный текст), `tool_status` (статус), `desktop_action` (карточка подтверждения)
4. Бот отправляет каждое промежуточное сообщение отдельным сообщением в чат
5. На карточки подтверждения рендерит inline-клавиатуры
6. По `done` — отправляет финальный ответ

### Inline-кнопки подтверждения

Когда AI выполняет команду на ПК (`execute_pc_command`) или SSH-команду (`execute_ssh_command`), бот присылает карточку с 4 кнопками:

| Кнопка | Действие |
|---|---|
| ✅ Разрешить | Выполнить команду |
| 🔓 Разрешить всегда | Подтверждение → создать политику auto-approve + выполнить |
| ❓ Проверить | LITE AI анализирует безопасность команды |
| ❌ Отклонить | Отклонить выполнение |
| 💬 Отклонить с комментарием | Бот попросит следующим сообщением написать комментарий и передаст его в backend как `rejection_comment` |

Карточки отправляются одновременно в Telegram (inline-кнопки) и на десктоп (WS). Кто первый ответил — выполняется, второй канал игнорируется.
Если пользователь отклоняет с комментарием, backend возвращает этот текст модели в rejected tool result как `user_comment`, чтобы AI мог скорректировать следующий шаг.

### PC-команды в фоне

`execute_pc_command` поддерживает флаг `background`. AI должен ставить `background: true` только для GUI/open-сценариев, где не нужен консольный вывод: открыть VS Code, Notepad, браузер, файл или папку. На desktop это запускается через detached `spawn(..., { shell: true, stdio: 'ignore', windowsHide: true })` + `unref()`, поэтому Telegram/AI получает быстрый результат и не ждёт закрытия окна.

Обычные диагностические команды (`where`, `dir`, `ipconfig`, `tasklist`, скрипты с stdout) должны идти с `background: false` или без параметра.

### Архитектура Telegraf (fire-and-forget)

`processUserTextThroughAi` запускается **без `await`** — это критично. Если бы AI-обработка блокировала event loop, callback_query от inline-кнопок не обрабатывались бы, и Telegram возвращал бы "query is too old" через ~15 секунд.

Порядок обработки кнопки:
1. `answerCbQuery()` — немедленно при получении callback
2. Axios-запрос к backend — в фоновой IIFE
3. Результат — отдельным сообщением в чат

### Хранение команд для Review/Always

Telegram **удаляет Markdown** из текста сообщения (backticks исчезают), поэтому команда не может быть извлечена из `callbackQuery.message.text`. Бот хранит полные команды в памяти (`pendingPcCommandTexts` Map) при отправке карточки и достаёт по `confirmationId` при нажатии «Разрешить всегда» или «Проверить».

## Desktop-only инструменты (через backend API)

Следующие AI-инструменты доступны только при подключённом десктопе (`isDesktop=true`) и не отображаются в Telegram:

- **`desktop_action`** — управление UI десктопа (открытие виджетов, макросы, предложения).
- **`invoke_subagent`** — вызов специализированного субагента, зарегистрированного в статическом реестре.
- **`spawn_subagent`** — создание ad-hoc субагентов «на лету»: модель задаёт задачу, системный промпт, набор инструментов и лимит итераций. Несколько вызовов в одной итерации выполняются параллельно (до 3 одновременно). Полный trace сохраняется в отдельном поле `subagents_json` для отображения в UI десктопа.

Подробности архитектуры субагентов: [backend-api/README.md → Subagent System](./backend-api/README.md#subagent-system-desktop-only-isdesktop).

## Soft Abort (остановка генерации)

При остановке генерации (`/abort_message`, `chat_stop`) бот **не удаляет** накопленный контент. Всё, что AI успел сделать (промежуточный текст, tool calls, reasoning, trace субагентов), сохраняется в БД как обычное assistant-сообщение с пометкой `_⏹ Генерация остановлена пользователем_`. Это работает как в Telegram, так и в desktop.

