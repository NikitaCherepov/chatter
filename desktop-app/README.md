# chatter desktop-app

Electron + React + Vite десктоп-клиент для Chatter.

## Быстрый старт

```bash
npm install
npm run dev
```

```bash
npm run build
```

## Голос, Whisper, Wake Word

Голосовой сценарий в desktop-приложении в основном живет в Electron main process и в renderer-странице `ChatPage`.

### Ручная расшифровка голоса

- Renderer записывает звук с микрофона через `MediaRecorder` и отправляет аудиобуфер в main process через IPC `transcribe-audio`.
- Main process сохраняет браузерный звук во временный `.webm`, конвертирует его в mono WAV 16 kHz через `fluent-ffmpeg`, а затем запускает локальный `whisper.exe`.
- Ресурсы Whisper ожидаются в `models/` в dev-режиме и в `resources/models/` в packaged-сборке:
  - `whisper.exe`
  - `ggml-small.bin`
  - нужные whisper/ggml DLL
- `ffmpeg-static` должен быть распакован из `app.asar`; в `package.json` для этого используется `asarUnpack` на `node_modules/ffmpeg-static/**/*`.

### Wake word

Wake word обрабатывается отдельным Python-listener:

- Исходник: `wakeword/listener.py`
- Dev-запуск: `.venv-wakeword/Scripts/python.exe wakeword/listener.py`
- Packaged-запуск: `resources/.venv-wakeword/Scripts/python.exe resources/wakeword/listener.py`

В packaged-приложении намеренно используется встроенный `.venv-wakeword`, а не собранный через PyInstaller `wakeword-listener.exe`. PyInstaller проверялся, но frozen-exe падал при загрузке `onnxruntime_pybind11_state`; тот же listener, запущенный через Python из venv, работает стабильно и доходит до состояния `listening`.

Electron main запускает listener через IPC `wakeword:start`. Listener пишет JSON-строки в stdout:

```json
{"type":"wakeword","name":"...","score":0.9,"ts":1710000000}
```

Main process парсит эти строки и отправляет события:

- `wakeword:detected` в renderer
- `pixel-avatar:state` со `state: "listening"`

После этого renderer запускает `createSpeechRecorder()`, записывает фразу пользователя после wake word, отправляет ее в `transcribe-audio` и отправляет распознанный текст в чат.

### Особенности упаковки

`npm run build:win` должен включать:

- `models/` как `resources/models`
- `wakeword/` как `resources/wakeword`
- `.venv-wakeword/` как `resources/.venv-wakeword`

Не стоит полагаться на `dist/wakeword-listener.exe` для production wake word, пока проблема PyInstaller/onnxruntime не решена. Текущий `files` config явно исключает старые wakeword listener binaries из `dist`.

## TTS (Text-to-Speech)

Озвучка сообщений бота — три модели, единый стейт, плавные переходы.

### Модели

| Модель | Движок | Голоса |
|---|---|---|
| **Piper** (по умолчанию) | Локальный `piper.exe` через IPC → WAV → Web Audio API | `ruslan` (ru), расширяемо |
| **Встроенный (Chromium)** | `window.speechSynthesis` — системные голоса Windows | Все голоса ОС |
| **Cartesia (облачная)** | Backend-прокси → Cartesia.ai API → MP3 → Web Audio API | Голоса en/ru/de/fr, подгружаются с сервера |

### Архитектура

```
Renderer (tts.ts)          Main (main.ts)          FileSystem / Server
─────────────────          ──────────────          ────────────────────
ttsSpeak(msgId, text, audio)
  │
  ├─ Piper? ──► IPC tts:generate ──► spawn piper.exe ──► models/piper-voices/*/
  │              (text)              -m model.onnx -f out.wav
  │                                  ◄── WAV buffer ──── temp file
  │
  ├─ Cartesia? ► audio.url есть? ──► GET /api/v1/audio/xxx.mp3 ──► playBuffer()
  │              нет? ──► POST /api/v1/tts/generate ──► server → Cartesia API
  │                      ◄── { audio_url } ──► GET /api/v1/audio/xxx.mp3 ──► playBuffer()
  │                      (audio привязывается к сообщению, повторный play — без генерации)
  │
  ├─ Builtin? ► SpeechSynthesisUtterance (Chromium API, 0 IPC)
  │
  ▼
AudioManager (Web Audio API)
  Source ► GainNode (fade-in/out) ► Destination
```

### Ключевые файлы

- `lib/tts.ts` — единый TTS-сервис: модели, голоса, подписки на стейт, `generationTicket` для отмены
- `lib/audioManager.ts` — Web Audio API плеер: `playBuffer()` с fade-in 40ms / fade-out 15ms до конца буфера, `stopWithFade()` 150ms
- `ChatPage.tsx` — play/stop кнопка в metaRow каждого сообщения
- `SettingsModal.tsx` — вкладка "Голос": модель, голос, громкость, прослушивание

### Управление воспроизведением

- **Единый стейт** — `ttsSubscribe(fn)` → только одно сообщение играет одновременно
- **Generation ticket** — `ttsStop()` инвалидирует in-flight IPC-запросы, буфер отбрасывается
- **Настройки** — модель + голос + громкость (0–1) в `localStorage` (`chatter_tts_settings`)

### Ресурсы Piper

Dev: `models/piper/piper.exe` + `models/piper-voices/<voice>/*.onnx`
Packaged: `resources/models/piper/` + `resources/models/piper-voices/`

## Архитектура

```
src/
├── main/              # Electron main process
├── preload/           # Preload scripts
└── renderer/          # React app (Vite)
    ├── main.tsx       # Entry point
    ├── App.tsx        # Auth guard
    ├── global.scss    # CSS variables
    ├── pages/
    │   ├── AuthPage   # Login/register
    │   └── ChatPage   # Основной экран
    ├── components/
    │   ├── PixelAvatar/   # Пиксельный аватар (canvas)
    │   ├── ToolsPanel     # Правая панель инструментов
    │   ├── FloatingWidget # Обёртка для floating/fullscreen режимов
    │   ├── NotebookTool   # Виджет блокнота
    │   ├── TasksTool      # Просмотр задач
    │   ├── MapTool        # Карта (Leaflet + react-leaflet)
    │   ├── RadioGroup     # Переиспользуемый радио-селектор
    │   ├── SettingsModal  # Настройки (аккаунт, промпт, голос, приложение, макросы, серверы, инструкции)
    │   ├── MacroSettings  # Управление макросами (CRUD + AI explain/describe)
    │   ├── ServerSettings # Управление SSH-серверами DevOps (CRUD + политики + привязка инструкций)
    │   ├── RunbookSettings # Управление инструкциями DevOps (CRUD + AI extraction/review)
    │   ├── Select         # Универсальный select-компонент
    │   ├── PromptSelector # Выбор промпта
    │   ├── MarkdownRenderer
    │   ├── AttachModal
    │   └── LinkTelegramModal
    └── lib/
        ├── api.ts         # API + WebSocket streaming (SSE fallback)
        ├── auth.tsx       # Auth context + WS lifecycle
        ├── tts.ts         # TTS-сервис (Piper + Chromium SpeechSynthesis + Cartesia)
        ├── audioManager.ts # Web Audio API плеер с fade-in/out
        └── tools.ts       # Tools panel state + desktop_action роутер
```

## Layout

```
┌─────────────────────────────────────────────────┐
│  Sidebar (260px)  │  Main chat  │  ToolsPanel   │
│  чаты/бургер      │  [top bar]  │  инструменты  │
│  collapsed: 65px  │  messages   │  collapsed:65 │
│                   │             │  default: 65  │
└─────────────────────────────────────────────────┘
```

Top bar — компактная полоска над `.messages` с селектором модели (появляется только если на сервере задан `MODELS_MANUAL`). Модель хранится на сервере (`preferred_model`), синхронизируется между desktop и Telegram.

Обе боковые панели работают одинаково: `motion.aside` с анимацией ширины, всегда в DOM. Сворачивание не сбрасывает внутреннее состояние.

## Панель инструментов (ToolsPanel)

Правая боковая панель. По умолчанию свёрнута (65px) — видна только иконка гаечного ключа.

### Layout Modes (режимы отображения)

Каждый инструмент может находиться в одном из трёх состояний (`LayoutMode`):

| Режим | Описание |
|---|---|
| `sidebar` | Рендерится в правой колонке (flex), сдвигает основной чат. По умолчанию. |
| `fullscreen` | Рендерится поверх всего интерфейса (`position: fixed, inset: 0, z-index: 100`). |
| `floating` | Свободно плавающее окно поверх чата (`position: fixed, z-index: 50`). Перетаскивается за шапку через `@dnd-kit/core` + `restrictToWindowEdges`. |

**Управление:**
- В sidebar-режиме рядом с заголовком инструмента появляются кнопки (floating / fullscreen)
- В floating/fullscreen режиме в шапке окна: кнопки "в сайдбар", "на весь экран"/"плавающее", "закрыть"
- Если инструмент в floating/fullscreen — он скрывается из списка инструментов в сайдбаре
- Клик на иконку гаечного ключа возвращает из floating/fullscreen в sidebar

**Архитектура:**
- Состояние layout хранится в `lib/tools.ts` — `getToolLayout()` / `setToolLayout()` / `subscribeToolLayout()`
- Компонент `FloatingWidget` — обёртка с `useDraggable` для floating режима
- `DndContext` + `restrictToWindowEdges` на уровне `ToolsPanel`
- Координаты floating-окна обновляются в `onDragEnd` через `delta.x/y`

**Хедер:** назад (fade) | заголовок (fade) | иконка инструментов (всегда видна)

**Внутри:** список инструментов → конкретный инструмент (AnimatePresence slide).

**Реестр инструментов:** массив в `buildTools()` внутри ToolsPanel.tsx. Чтобы добавить новый — добавить entry в массив + компонент.

### Мульти-окно

Инструменты хранятся в массиве `openTools[]` (а не один `activeToolId`). Несколько инструментов могут быть открыты одновременно — каждый в своём floating/fullscreen окне. Sidebar отображает первый инструмент в режиме sidebar.

Управление: `openTool(id)` / `closeTool(id)` из `lib/tools.ts`.

## Блокнот (NotebookTool)

Два состояния:
- **Список** — все заметки + кнопка "Создать" + поиск
- **Редактор** — создание/редактирование одной заметки (title + textarea + save)

API: `GET/POST/DELETE /api/v1/notes`. Обновление = delete + create (нет PUT на бэкенде).

## Задачи (TasksTool)

Read-only просмотр задач с фильтрами по статусу (pending/done/all). Каждая карточка показывает статус, тип, дату, payload preview, recurrence badge. Кнопка удаления (появляется при наведении).

API: `GET /api/v1/tasks?status=&limit=`, `DELETE /api/v1/tasks/:id`.

Бот может открывать задачи через `desktop_action` с `action: open_widget, target: tasks`.

## Карта (MapTool)

Leaflet-карта с тремя слоями (светлая/спутник/стандартная), управляемая через кастомный `RadioGroup` компонент. Выбор слоя сохраняется в `localStorage`.

**Возможности:**
- Бот показывает места на карте (`map_control` → `show_place`) через Nominatim геокодирование
- Бот прокладывает маршруты (`draw_route`) через OSRM — синяя polyline
- Бот ищет маршруты общественного транспорта (`find_transit_route`) через Overpass API — зелёная polyline + оранжевые маркеры остановок
- Бот ищет заведения и объекты рядом (`search_nearby`) через Overpass API — фиолетовые маркеры POI (рестораны, аптеки, магазины и т.д.)
- SSE-событие `map_update` доставляет данные на клиент (четыре типа action: `show_place`, `draw_route`, `transit_route`, `poi_search`)
- Пользователь ставит свои метки (pin placement mode) — сохраняются на бэкенде (шифрованные координаты)
- Drag & drop для перемещения меток
- Бот может читать метки пользователя через `get_map_pins` tool
- `ResizeHandler` вызывает `invalidateSize()` при смене layout (sidebar ↔ floating)

**Типы `map_update` payload:**

| Action | Поля | Рендеринг |
|---|---|---|
| `show_place` | `lat, lng, label` | Один маркер + `flyTo` |
| `draw_route` | `from, to, route` | Два маркера + синяя Polyline + `fitBounds` |
| `transit_route` | `routeName, path, stops` | Зелёная Polyline (сегмент между pickup/dropoff) + оранжевые маркеры остановок + `fitBounds` |
| `poi_search` | `places[], query` | Фиолетовые маркеры POI (имя, адрес, часы) + `flyTo` к первому |

**API пинов:** `GET/POST/PUT/DELETE /api/v1/map-pins[/:id]`. Координаты шифруются на бэкенде через `MAP_PINS_ENCRYPTION_KEY`.

## RadioGroup

Переиспользуемый компонент (`components/RadioGroup.tsx`) — кнопка-триггер, при нажатии раскрывается список радио-кнопок. Оформление идентично другим контролам карты (`#e8f0fe` / `#1a73e8`, 30x30px, `border-radius: 8px`). Принимает `options`, `value`, `onChange`, опционально `icon`.

## Desktop Action (bot → UI)

Бот может управлять интерфейсом через tool `desktop_action`. Паттерн как у `set_display_state`:

1. Бэкенд получает `is_desktop: true` в body → добавляет `desktop_action` tool в AI
2. AI вызывает tool → бэкенд отправляет WS `desktop_action` (или SSE fallback)
3. Фронтенд ловит через `onDesktopAction` → `handleDesktopAction()` в `lib/tools.ts`

**Actions:**

| Action | Описание |
|---|---|
| `open_widget` | Открыть виджет (target: `notebook`, `tasks`) |
| `close_widget` | Закрыть виджет |
| `set_widget_data` | Передать данные в виджет (например текст черновика) |
| `open_note` | Открыть конкретную запись по ID (value: `{ note_id }`) |
| `read_widget_state` | Прочитать текущее состояние виджета |
| `toggle_panel` | Открыть/закрыть панель инструментов |
| `execute_macro` | Выполнить макрос — команды приходят в `value.commands` из SSE payload. Если `target === '__explore_fs__'` — чтение директории через `readDirectory` IPC |
| `suggest_macro` | Предложить макрос — рендерит карточку «Сохранить/Отклонить» в ChatPage |
| `devops_confirmation` | Подтверждение SSH-команды — карточка с кнопками «Разрешить»/«Разрешить всегда»/«? Проверить»/«Отклонить» |
| `pc_command_confirmation` | Подтверждение `execute_pc_command` — карточка команды на ПК. `ChatPage` обрабатывает её через общий `handleIncomingDesktopAction` во всех потоках `streamChatMessage`: обычная отправка, regenerate и regenerate-with-hint. |
| `suggest_devops_runbook` | Предложение инструкции — карточка с кнопками «Сохранить»/«Проверить»/«Отклонить» |

## Макросы

Пользовательские наборы консольных команд, которые AI может запускать на десктопе. Хранятся на сервере (SQLite), не в localStorage.

### Компоненты

- **MacroSettings** (`components/MacroSettings.tsx`) — UI управления макросами во вкладке настроек «Макросы»
  - Список макросов с чекбоксами (enabled, pinned)
  - Кнопки: редактировать, выполнить, AI-объяснение, AI-описание, удалить
  - Форма создания/редактирования: название, описание, команды (динамический список), чекбоксы enabled/pinned
  - AI-помощники: explain (что делают команды) и describe (предложить название/описание) через `/api/v1/macro/explain` и `/api/v1/macro/describe`
- **ChatPage** — карточка `suggest_macro` (массив `pendingMacros`, может быть несколько одновременно)
  - Кнопка «Сохранить» → POST `/api/v1/macros`
  - Кнопка «Отклонить» → удаление из массива

### IPC-обработчики

| IPC | Описание |
|---|---|
| `execute-commands` | Последовательно выполняет массив команд через `child_process.exec` (30с таймаут, 1MB буфер). Блокирует опасные команды (`rm -rf /`, `format`, `shutdown` и т.д.). Возвращает объединённый stdout/stderr. Логирует batch/cmd start/done/error для диагностики зависаний команд. |
| `read-directory` | Чтение содержимого директории (read-only). Возвращает `{ name, isDirectory, size, modifiedAt }[]`. |

### Поток выполнения

**Обычный макрос (fire-and-forget):**
```
AI: execute_macro(macro_id)
  → Backend: находит макрос в БД, формирует WS/SSE payload
  → WS/SSE: desktop_action { action: 'execute_macro', value: { commands } }
  → api.ts onmessage: electronAPI.executeCommands(commands) + callback в React
  → main.ts: exec() для каждой команды
```

**Макрос из Telegram (TG→Desktop push):**
```
TG пользователь: "Запусти макрос X"
  → Backend /internal/ai/send → sendMessageThroughAi (с activeMacros)
  → AI: execute_macro → desktopActionSink.value = payload
  → result.desktop_action возвращается в server.ts
  → server.ts: isDesktopOnline(userId) → WS push { type: 'desktop_action', action: 'execute_macro', value: { commands } }
  → api.ts onmessage: electronAPI.executeCommands(commands)
  → main.ts: exec() для каждой команды
```
Условие: десктоп-клиент должен быть подключён через WS, а TG-аккаунт — привязан к аккаунту desktop. Если десктоп не подключён — макрос не выполнится (fire-and-forget без получателя).

**Макрос с return_output (через WS):**
```
AI: execute_macro(macro_id) — return_output: true
  → Backend: sendIpcToDesktop('execute_commands', { commands })
  → WS: execute_ipc { request_id, ipc_type: 'execute_commands', payload }
  → IPC executeCommands(commands) → stdout
  → WS: ipc_result { request_id, data: stdout }
  → Backend резолвит Promise → AI получает stdout как tool response
```

**Чтение директории (explore_fs, через WS):**
```
AI: explore_fs(target_path)
  → Backend: sendIpcToDesktop('read_directory', { target_path })
  → WS: execute_ipc { request_id, ipc_type: 'read_directory', payload }
  → IPC readDirectory(target_path) → entries[]
  → WS: ipc_result { request_id, data: entries }
  → Backend резолвит Promise → AI получает listing как tool response
```

### Предложение макроса

```
AI: suggest_macro(title, description, commands)
  → WS/SSE: desktop_action { action: 'suggest_macro', value: { title, description, commands } }
  → ChatPage: setPendingMacros(prev => [...prev, newMacro])
  → Рендер карточки с кнопками «Сохранить»/«Отклонить»
  → Сохранение: POST /api/v1/macros → БД
```

**Widget data dispatch:** `dispatchWidgetData()` ставит команду в очередь если виджет ещё не смонтирован (pending commands). При подписке — очередь дренируется.

## DevOps Agent Runtime

Система удалённого выполнения SSH-команд на серверах через AI с подтверждением пользователя (Human-in-the-Loop).

### Настройки серверов (SettingsModal → «Серверы»)

`ServerSettings.tsx` — управление SSH-серверами:
- Форма: название, хост, порт, пользователь, пароль, приватный ключ, пароль для sudo (опционально)
- Кнопка проверки подключения
- Список серверов с индикаторами (пароль, ключ, sudo)
- Политики auto-approve для каждого сервера (regex-паттерны)
- Кнопки «Привязать инструкцию» для каждого сервера

### Инструкции (SettingsModal → «Инструкции»)

`RunbookSettings.tsx` — управление runbooks:
- Форма: название, markdown-контент, массив shell-команд
- Кнопка «Извлечь команды из текста» — AI (LITE) автоматически находит shell-команды в тексте
- Кнопка «?» — AI проверяет безопасность каждой команды (модальное окно с MarkdownRenderer)
- Список инструкций с кнопками редактировать/проверить/удалить

### Карточки в чате (ChatPage)

**Подтверждение команды (`devops_confirmation`):**
Появляется когда AI хочет выполнить SSH-команду, не попадающую под auto-approve политику.
- Показывает: название сервера, хост, команда
- Кнопки: «Разрешить», «Разрешить всегда» (создаёт политику точного совпадения), «? Проверить» (LITE AI анализирует безопасность), «Отклонить»
- Вердикт AI рендерится через MarkdownRenderer прямо на карточке

**Предложение инструкции (`suggest_devops_runbook`):**
Появляется когда AI предлагает сохранить инструкцию.
- Показывает: название, список команд
- Кнопки: «Сохранить» (POST runbook), «Проверить» (LITE AI проверяет безопасность), «Отклонить»
- Вердикт рендерится через MarkdownRenderer

### Поток данных

```
AI: execute_ssh_command(server_id, command)
  → Backend: auto-approve? → Да: выполнить сразу
  → Нет: WS push { action: 'devops_confirmation', ... }
    → ChatPage: карточка подтверждения
    → Пользователь: Разрешить / Отклонить
    → Backend: POST /api/v1/devops/approve
    → SSH executor: выполнить команду → stdout/stderr/exitCode → AI
```

### DevOps: актуальные карточки и пароли

Desktop получает DevOps-действия через WS `desktop_action` и рендерит их в `ChatPage.tsx`.

**`devops_confirmation`**
- Используется для SSH-команд, `create_server_user` и `change_server_user_password`.
- Карточка показывает сервер, host и безопасное preview команды.
- Если backend передал `needs_sudo_password=true`, появляется поле `Sudo password` и чекбокс сохранения в `sudo_password` сервера.
- Если backend передал `needs_new_password=true`, появляется поле `New password`. Это пароль Linux-пользователя для `change_server_user_password`; бот его не видит, в preview остаётся `password=***`.
- Кнопки: allow, allow always, review, reject. `allow always` создаёт auto-approve policy для точного preview команды и затем подтверждает текущую операцию.
- Подтверждение отправляется в `POST /api/v1/devops/approve` с `{ confirmation_id, approved, sudo_password?, save_sudo_password?, new_password? }`.

**`suggest_server_creds_update`**
- Используется, когда бот предлагает переключить credentials сервера после создания пользователя или установки SSH-ключа.
- Поддерживает `new_username`, `use_ssh_key_for_login` / `use_ssh_key`, `remove_password`.
- Если есть `confirmation_id`, карточка подтверждает изменение через `/api/v1/devops/approve`, чтобы backend tool call дождался решения пользователя и продолжил тот же AI-поток.
- Если `use_ssh_key_for_login=true`, backend будет логиниться по дефолтному SSH-ключу сервера. Если ключ не подходит, password fallback не выполняется.

**Настройки сервера**
- `password` — обычный SSH password.
- `sudo_password` — пароль для sudo и пароль, который используется `create_server_user`, если он сохранён.
- `default_ssh_key_id` — ключ, который можно ставить на сервер и использовать для входа.
- `use_ssh_key_for_login` — отдельная галочка способа входа: password login или key login.

### DevOps: current cards and passwords

Desktop receives DevOps actions through WS `desktop_action` and renders them in `ChatPage.tsx`.

**`devops_confirmation`**
- Used for SSH commands, `create_server_user`, and `change_server_user_password`.
- Shows server name, host, and a safe command preview.
- If backend sends `needs_sudo_password=true`, the card shows a `Sudo password` input and a checkbox to save it into server `sudo_password`.
- If backend sends `needs_new_password=true`, the card shows a `New password` input. This is the Linux user's new password for `change_server_user_password`; the bot does not see it, and the preview stays `password=***`.
- Confirmation is sent to `POST /api/v1/devops/approve` with `{ confirmation_id, approved, sudo_password?, save_sudo_password?, new_password? }`.

**`suggest_server_creds_update`**
- Used when the bot proposes changing server credentials after creating a user or installing an SSH key.
- Supports `new_username`, `use_ssh_key_for_login` / `use_ssh_key`, and `remove_password`.
- If `confirmation_id` is present, the card confirms through `/api/v1/devops/approve`, so the backend tool call waits for the user and continues the same AI flow.
- If `use_ssh_key_for_login=true`, backend logs in with the server default SSH key. If the key does not work, password fallback is not attempted.

**Server settings**
- `password` is the normal SSH login password.
- `sudo_password` is used for `sudo -S` and as the password source for `create_server_user` when saved.
- `default_ssh_key_id` is the key used for installation and optional key login.
- `use_ssh_key_for_login` is the explicit login-mode checkbox: password login or key login.

## Feature Flags (ограничения инструментов)

Вкладка "Ограничения" в SettingsModal позволяет пользователю выборочно отключать AI-инструменты. Флаги хранятся на сервере (`users.feature_flags`, JSON), синхронизируются между desktop и Telegram.

### UI

`SettingsModal.tsx` → вкладка `restrictions` → 6 чекбоксов. Каждый чекбокс — instant save через `api.setFeatureFlags()` с optimistic update и rollback при ошибке.

### Ключевые файлы

| Файл | Роль |
|---|---|
| `lib/api.ts` | Тип `FeatureFlags` + `getFeatureFlags()` / `setFeatureFlags()` |
| `components/SettingsModal.tsx` | Вкладка `restrictions`: state, загрузка, 6 чекбоксов с описаниями |

### Флаги

| Ключ | Название | Отключает |
|---|---|---|
| `disable_memory_write` | Запрет записи данных | `save_to_cold_memory`, `delete_from_cold_memory`, `save_note`, `delete_note`. Hot memory (`update_core_memory`) остаётся доступной |
| `disable_pc_control_lite` | Ограниченный режим | SSH, макросы, отправка писем, задачи, серверы, runbooks. Умный дом, карты, чтение почты, виджеты, файловая система остаются |
| `disable_pc_commands` | Без команд на ПК | Только `execute_pc_command`. SSH, макросы, файловая система остаются |
| `disable_pc_control_full` | Полная блокировка | Всё из lite + команды на ПК + умный дом, почта, карты, виджеты, файловая система |
| `disable_internet` | Без интернета и генерации | `search_web`, `read_webpage`, `generate_image` |
| `disable_personal` | Гостевой режим | Промпт, hot/cold memory, заметки, задачи. AI общается с чистого листа |
| `disable_subagents` | Без субагентов | `invoke_subagent` |

### Как добавить новый флаг

1. Добавить ключ в `VALID_FLAG_KEYS` в `backend-api/src/server.ts`
2. Добавить поле в тип `FeatureFlags` в `desktop-app/src/renderer/lib/api.ts`
3. Добавить инструменты в `disabledToolSet` в `backend-api/src/services/ai.ts`
4. Добавить чекбокс в `SettingsModal.tsx` (state default + render)

### Как добавить новый инструмент под существующие флаги

Добавить `disabledToolSet.add('tool_name')` в соответствующий блок флага в `ai.ts` (секция `Feature flags → disabled tools`). Фильтрация сработает автоматически.

## ChatPage Messages

Основная лента чата живет в `pages/ChatPage.tsx`.

### Оптимизация ленты

- Сообщения рендерятся через memoized `MessageItem` (`React.memo`), чтобы изменение input, TTS, popover-состояний или WS-событий не перерисовывало всю историю.
- Активные состояния передаются в `MessageItem` как booleans (`isTtsPlaying`, `isReasoningOpen`, `isToolCallsOpen`, `isRegenHintOpen`), а не как глобальные id. Так при переключении TTS/reasoning/tool calls изменяются только затронутые сообщения.
- Начальная загрузка истории берет последние `MESSAGE_PAGE_SIZE = 50` сообщений.
- Старые сообщения подгружаются кнопкой "Загрузить старые сообщения" через `GET /api/v1/chats/:id/messages?limit=&offset=`.
- При prepend старых сообщений ChatPage сохраняет `scrollHeight`/`scrollTop` и восстанавливает позицию через `useLayoutEffect`, чтобы экран не прыгал вниз.
- Автоскролл вниз пропускается, если идет prepend старых сообщений.
- Архивные сообщения (`msg.archived === true`) отображаются с пониженной прозрачностью (opacity 0.55) и меткой «архив» в metaRow. Архивные сообщения не отправляются в AI-контекст, но остаются в БД и доступны для просмотра и поиска.

### Reasoning и tool calls

Assistant-сообщения могут иметь дополнительные поля:

- `reasoning_content?: string | null`
- `tool_calls?: Array<{ id?: string; name: string; arguments: unknown; result_preview?: string }>`
- `result_preview` содержит до 500 символов ответа инструмента и показывается только во всплывашке инструментов.

UI:

- Кнопка `Рассуждение` появляется только если `reasoning_content` непустой.
- Кнопка инструментов появляется только если `tool_calls.length > 0`.
- Оба блока открываются как absolute popover поверх ширины сообщения (`reasoningPanel`) и не раздвигают ленту.
- Анимация popover сделана через `AnimatePresence` + `motion.div`, направление раскрытия — сверху вниз (`y: -16 -> 0`).

### Regeneration

В ChatPage есть обычная перегенерация последнего assistant-сообщения и перегенерация с hint.

Поток:

1. Клиент находит последнее user-сообщение перед assistant-сообщением.
2. Старое assistant-сообщение оптимистично удаляется из UI и удаляется на backend через `DELETE /api/v1/chats/:id/messages/:messageId`.
3. `streamChatMessage()` отправляет тот же user text, `skip_user_history: true` и `regenerate_from_history: true`.
4. Для hint дополнительно отправляется `regenerate_hint`.
5. Backend не сохраняет новый user message и не дублирует user text в AI-history; он использует последнее user-сообщение из истории как текущий запрос один раз.

WS это не ломает: `streamChatMessage()` по-прежнему получает `intermediate`, `tool_status`, `display_state`, `desktop_action`, `map_update`, `done`, `error`; memoized rendering влияет только на React-перерисовки.

## WebSocket Transport

Desktop-клиент использует **WebSocket** для двунаправленного обмена с сервером. Реализация в `lib/api.ts`.

**Подключение:**
- `initWebSocket()` — вызывается в `auth.tsx` после успешного логина/регистрации
- WS подключается к `ws://host:3050/ws?token=jwt`, JWT валидируется сервером
- Auto-reconnect с exponential backoff (1s → 2s → 4s → ... → 30s)
- При refresh токена (401 в apiFetch) → `reconnectWebSocket()` с новым токеном
- При logout → `closeWebSocket()` (code 1000, без реконнекта)

**Отправка сообщений:**
- `streamChatMessage()` при подключённом WS отправляет `{ type: 'chat_send', text, ... }`
- Если WS не подключён — fallback на SSE (POST + ReadableStream)

**Входящие сообщения (WS → клиент):**

| type | Описание |
|---|---|
| `intermediate` | Промежуточный текст AI |
| `tool_status` | Статус выполнения инструмента ("Ищу информацию...") |
| `display_state` | Изменение состояния аватара |
| `desktop_action` | Команда управления UI / макрос |
| `map_update` | Данные карты |
| `done` | Финальный ответ: `reply_text`, ids, `reasoning_content?`, `tool_calls?`, `generated_images?`, `display_state?` |
| `error` | Ошибка |
| `execute_ipc` | Запрос сервера выполнить IPC и вернуть результат |
| `pong` | Ответ на ping |

**Обратный канал (execute_ipc):**
Сервер может запросить десктоп выполнить IPC-команду и вернуть результат. Используется для `return_output` макросов, `explore_fs` и подтверждённых `execute_pc_command`. `lib/api.ts` логирует получение `execute_ipc` и отправку `ipc_result`; связка с backend-логами делается по `request_id`.
1. Сервер шлёт `{ type: 'execute_ipc', request_id, ipc_type, payload }`
2. Десктоп выполняет IPC (`executeCommands` / `readDirectory`)
3. Десктоп отвечает `{ type: 'ipc_result', request_id, data }` или `{ error }`
4. Сервер резолвит pending Promise → AI получает результат как tool response

**SSE fallback** — если WS не подключён, `streamChatMessage` использует обычный POST + SSE. SSE — однонаправленный, обратный канал (`execute_ipc`) недоступен.

### Stop generation

- `stopChatStream()` sends `{ type: 'chat_stop' }` over WS when connected and also calls `POST /api/v1/chat/stop` as a fallback/backup.
- In `ChatPage`, `sending` means "there is an active chat request" and keeps the stop button visible until `done`, `error`, or aborted `done`.
- `showTyping` is separate from `sending`: it only controls the temporary typing bubble. The first `tool_status` or `intermediate` event hides typing and appends content to the same temporary assistant message.

## Tool Navigation

Кнопка "назад" в хедере ToolsPanel — единая для всех инструментов. Инструменты регистрируют свой `onBack` коллбэк через `registerToolNav(toolId, callback)` из `lib/tools.ts`.

| Контекст | Поведение кнопки назад |
|---|---|
| Инструмент с внутренним стеком (notebook editor) | Вызывает `tool.onBack()` → возврат к списку заметок |
| Инструмент без стека (notebook list) | Возврат к списку инструментов |
| Нет активного инструмента | Кнопка скрыта |

Новый инструмент просто вызывает `registerToolNav('myTool', onBack)` в useEffect. Если callback не зарегистрирован — назад возвращает к списку инструментов.

## CSS Variables

Все цвета/отступы через CSS-переменные в `global.scss`. Ключевые:
- `--bg-primary/secondary`, `--border-light/medium`, `--text-primary/body/muted/hint`
- `--accent`, `--accent-icon`, `--bg-input`, `--bg-bubble`, `--bg-modal-hover`

## Система обновлений

Кастомный механизм обновлений без `electron-updater`. Работает только в packaged-сборке (`app.isPackaged`).

| Тип | Что скачивается | Размер | Когда использовать |
|---|---|---|---|
| **Minor** | новый `app.asar` | ~15-50 МБ | Код, renderer assets внутри `app.asar`, стили, main/preload |
| **Major** | полный NSIS-инсталлер `.exe` | зависит от сборки | Electron, `extraResources`, модели, DLL, wakeword/env/runtime-ресурсы |

### Архитектура

```
backend-api/updates/
  version.json                 # manifest: version/type/downloadUrl/releaseNotes/size
  chatter-update-<ts>.asar      # minor payload, имя генерирует админка
  chatter-update-<ts>.exe       # major payload, если exe загружен на сервер

desktop-app
  main.ts: setupCustomUpdater()
    3 сек после старта
    GET /updates/version.json
    показываем UpdateModal только если manifest.version > app.getVersion()
    update:download -> net.fetch + update:progress -> temp file
    update:install-minor -> backup app.asar -> hidden helper -> copy -> restart
    update:install-major -> run downloaded .exe /S -> quit
```

Minor-обновление скачивается во временный файл с расширением `.tmp`, даже если payload на сервере называется `.asar`. Это важно: Electron патчит `fs` для `.asar`-путей, поэтому недокачанный временный файл нельзя хранить как `*.asar`.

Для операций с установленным `resources/app.asar` используется `original-fs`, иначе Electron воспринимает путь как виртуальный ASAR-пакет.

Hot-swap helper:
- создаётся `.ps1` с логикой ожидания текущего PID, копирования и рестарта;
- создаётся `.vbs` launcher, который скрыто запускает PowerShell;
- логи пишет в `app.getPath('userData')/updater-hotswap.log`;
- основной лог апдейтера: `app.getPath('userData')/updater.log`.

### Ключевые файлы

- `src/main/main.ts` — `setupCustomUpdater()`: проверка, скачивание, установка (4 IPC-хендлера)
- `src/main/preload.ts` — `updateCheck`, `updateDownload`, `updateInstallMinor/Major`, `onUpdateAvailable`, `onUpdateProgress`
- `src/renderer/components/UpdateModal.tsx` — модалка с прогресс-баром, бейджами minor/major, release notes
- `src/renderer/App.tsx` — `UpdateListener`: подписка на `update:available` при старте
- `backend-api/src/server.ts` — `/admin/updates*`, upload через `busboy`, генерация `version.json`

### Версия приложения

- `package.json` → `version` → `app.getVersion()`
- Manifest считается обновлением только если `version` строго новее текущей версии.
- Если на сервере лежит та же или более старая версия, модалка не показывается.

### Публикация обновления

**Minor:**
1. `package.json` → `"version": "1.4.0"`
2. `npm run build:win`
3. Из `release/*.zip` достать `resources/app.asar`
4. Через админку `http://server:3050/admin/updates` загрузить этот `app.asar`, выбрать `type: minor`, указать версию и release notes.

Админка сохранит файл как `chatter-update-<timestamp>.asar` и создаст `version.json`:

```json
{
  "version": "1.4.0",
  "type": "minor",
  "downloadUrl": "chatter-update-1780866466318.asar",
  "releaseNotes": "...",
  "size": 49467302
}
```

Вручную можно сделать то же самое: положить `.asar` в `backend-api/updates/` и прописать его имя в `downloadUrl`.

**Major:**
1. `package.json` → `"version": "2.0.0"`
2. `npm run build:win`
3. Через админку загрузить NSIS `.exe` + `type: major`, либо указать внешний URL.

Для major нужна прямая ссылка на `.exe`. Публичная страница облака/Яндекс.Диска не подходит: клиент скачает HTML-страницу вместо инсталлера. URL должен заканчиваться на `.exe`, иначе клиент сохранит файл как `.tmp` и `update:install-major` вернёт `installer_must_be_exe`.

### Админка обновлений (backend-api)

- `GET /admin/updates` — HTML-страница с формой (логин/пароль desktop/API-аккаунта)
- `GET /admin/updates/status` — текущий манифест + список файлов (admin JWT)
- `POST /admin/updates/upload` — загрузка файла + генерация `version.json` (multipart/form-data)
- `DELETE /admin/updates/file/:name` — удаление файла

Админ-доступ проходит, если `is_admin = 1` у самого desktop/API user или у привязанного Telegram user (`linked_tg_id`).

`version.json` не показывается в списке удаляемых файлов: его содержимое отображается наверху как `Current`.

### Что можно обновлять minor-ом

Minor подходит для всего, что живёт внутри `app.asar`:
- React/renderer code;
- main/preload code;
- CSS/SCSS;
- assets, импортируемые Vite, например `src/renderer/assets/faces`.

Major нужен для всего, что лежит вне `app.asar`:
- `extraResources` (`models`, `wakeword`, `.venv-wakeword`, `sounds`);
- новые exe/dll/native runtime-файлы;
- изменения installer/electron-builder config;
- обновление Electron или зависимостей, требующих новой unpacked/native структуры.
