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

Озвучка сообщений бота — две модели, единый стейт, плавные переходы.

### Модели

| Модель | Движок | Голоса |
|---|---|---|
| **Piper** (по умолчанию) | Локальный `piper.exe` через IPC → WAV → Web Audio API | `ruslan` (ru), расширяемо |
| **Встроенный (Chromium)** | `window.speechSynthesis` — системные голосы Windows | Все голоса ОС |

### Архитектура

```
Renderer (tts.ts)          Main (main.ts)          FileSystem
─────────────────          ──────────────          ──────────
ttsSpeak(msgId, text)
  │
  ├─ Piper? ──► IPC tts:generate ──► spawn piper.exe ──► models/piper-voices/*/
  │              (text)              -m model.onnx -f out.wav
  │                                  ◄── WAV buffer ──── temp file
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
    │   ├── SettingsModal  # Настройки (аккаунт, промпт, голос, приложение)
    │   ├── Select         # Универсальный select-компонент
    │   ├── PromptSelector # Выбор промпта
    │   ├── MarkdownRenderer
    │   ├── AttachModal
    │   └── LinkTelegramModal
    └── lib/
        ├── api.ts         # API + SSE streaming
        ├── auth.tsx       # Auth context
        ├── tts.ts         # TTS-сервис (Piper + Chromium SpeechSynthesis)
        ├── audioManager.ts # Web Audio API плеер с fade-in/out
        └── tools.ts       # Tools panel state + desktop_action роутер
```

## Layout

```
┌─────────────────────────────────────────────────┐
│  Sidebar (260px)  │  Main chat  │  ToolsPanel   │
│  чаты/бургер      │  messages   │  инструменты  │
│  collapsed: 65px  │             │  collapsed:65 │
│                   │             │  default: 65  │
└─────────────────────────────────────────────────┘
```

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
2. AI вызывает tool → бэкенд отправляет SSE `event: desktop_action`
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

**Widget data dispatch:** `dispatchWidgetData()` ставит команду в очередь если виджет ещё не смонтирован (pending commands). При подписке — очередь дренируется.

## SSE Streaming

Desktop-клиент использует **SSE (Server-Sent Events)** для стриминга ответов AI в реальном времени. Реализация в `lib/api.ts`, функция `streamChatMessage()`.

SSE — однонаправленный стрим от сервера к клиенту (в отличие от WebSocket, который двунаправленный). Клиент отправляет обычный POST-запрос на `/api/v1/chat/send` с `is_desktop: true`, сервер отвечает `Content-Type: text/event-stream` и стримит события.

**Формат событий:**

| Event | Описание |
|---|---|
| `intermediate` | Промежуточный текст AI (сгенерирован одновременно с tool call) |
| `tool_status` | Статус выполнения инструмента ("Ищу информацию...") |
| `display_state` | Изменение состояния пиксельного аватара |
| `desktop_action` | Команда управления интерфейсом (открыть виджет, создать черновик) |
| `map_update` | Данные карты (место/маршрут) — открывает MapTool, обновляет состояние |
| `done` | Финальный ответ с `reply_text`, `message_id`, `chat_id` |
| `error` | Ошибка |

Клиент парсит поток вручную через `ReadableStream` + `TextDecoder`, без `EventSource` (т.к. нужен POST с body).

Telegram-бот ходит через обычный JSON-эндпоинт `/internal/ai/send` — SSE только для десктопа.

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
