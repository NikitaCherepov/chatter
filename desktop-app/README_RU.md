# chatter desktop-app

[English](README.md) | [Русский](README_RU.md)

Electron + React + Vite десктоп-клиент для Chatter.

## Быстрый старт

```bash
npm install
npm run dev
```

```bash
npm run build
```

## Подключение к серверу и Content Security Policy

Ключ доступа к серверу, JWT аккаунта и Content Security Policy (CSP) решают разные задачи:

- Ключ сервера подтверждает, что этот Desktop-клиент имеет право пользоваться конкретным self-hosted сервером Chatter.
- JWT авторизует пользователя после входа в аккаунт.
- CSP технически ограничивает ресурсы и сетевые адреса, доступные Electron renderer, если его содержимое будет скомпрометировано.

Pairing выполняется через Electron main process, а не через неограниченный запрос из renderer:

1. Renderer разбирает ссылку `chatter://` и передаёт адрес сервера и ключ через узкий preload API.
2. Main process принимает только HTTP(S)-адрес без встроенных логина/пароля, query-параметров и fragment.
3. Main process проверяет ключ через `/api/v1/server-access/validate` с таймаутом 15 секунд.
4. В `userData/trusted-server.json` сохраняется только канонический origin сервера. Ключ доступа в этот файл не записывается.
5. При смене доверенного origin окно один раз перезагружается. Новый главный документ получает CSP, разрешающую HTTP- и WebSocket-подключения только к этому origin.

После обновления уже сохранённое в renderer подключение один раз проверяется и автоматически переносится в новую схему. При удалении или смене сервера доверенный origin в main process очищается, после чего renderer перезагружается.

CSP packaged-сборки разрешает:

- встроенные скрипты и стили приложения;
- inline-стили, необходимые текущему React-интерфейсу, но не inline-скрипты и не `eval`;
- API, изображения, медиа и WebSocket выбранного сервера Chatter;
- фиксированные домены Google Fonts и карт Carto, ArcGIS и OpenStreetMap;
- локальные `data:`/`blob:` изображения, медиа, шрифты и workers там, где они нужны.

Запрещены iframe, плагины/objects, произвольный base URL, произвольные form targets, сторонние скрипты и произвольные сетевые origin. Источники Vite и localhost добавляются только в dev-режиме и не попадают в packaged-политику.

Связанные файлы:

- `src/main/main.ts` — нормализация URL, проверка ключа сервера, сохранение доверенного origin и формирование CSP-заголовка.
- `src/main/preload.ts` — узкий IPC-мост `authorizeServer` и `clearTrustedServer`.
- `src/renderer/lib/api.ts` — разбор pairing-ссылки и хранение подключения в renderer.
- `src/renderer/lib/auth.tsx` — автоматический перенос подключений, созданных до появления CSP.

Если позже в приложение добавляется встроенный браузер, он должен работать через отдельный `WebContentsView` и отдельную Electron session/partition. Нельзя открывать произвольные сайты внутри renderer Chatter или ослаблять ради них основную CSP.

## Голос, Whisper, Wake Word

Голосовой сценарий в desktop-приложении в основном живет в Electron main process и в renderer-странице `ChatPage`.

### Ручная расшифровка голоса

- Renderer записывает звук с микрофона через `MediaRecorder` и отправляет аудиобуфер в main process через IPC `transcribe-audio`.
- Main process сохраняет браузерный звук во временный `.webm`, конвертирует его в mono WAV 16 kHz через `fluent-ffmpeg`, а затем запускает локальный `whisper.exe`.
- Ресурсы Whisper ожидаются в `models/` в dev-режиме и в `resources/models/` в packaged-сборке:
  - `whisper.exe`
  - `ggml-small.bin`
  - нужные whisper/ggml DLL
- В разделе «Голос» можно выбрать `auto` (по умолчанию) или конкретный язык распознавания. Фиксированный язык не тратит время на автоопределение и рекомендуется для коротких фраз.
- `ffmpeg-static` должен быть распакован из `app.asar`; в `package.json` для этого используется `asarUnpack` на `node_modules/ffmpeg-static/**/*`.

### Wake word

Wake word обрабатывается без Python, через `onnxruntime-node` в Electron main process:

- ONNX runtime: `src/main/wakeword.ts`
- Renderer audio stream: `src/renderer/lib/wakeWordAudio.ts`
- ONNX resources: `wakeword/models/*.onnx`

Renderer держит поток микрофона через Web Audio API, ресемплит через `AudioContext({ sampleRate: 16000 })`, режет PCM на чанки по 1280 samples (80 ms) и отправляет их в main process через IPC `wakeword-audio-chunk`.

Main process повторяет openWakeWord pipeline:

1. `melspectrogram.onnx`
2. `embedding_model.onnx`
3. wake-word модели (`alexa`, `hey_jarvis`, `hey_mycroft`, `hey_rhasspy`, `timer`, `weather`)
4. `silero_vad.onnx` для VAD-фильтра

При срабатывании main process формирует payload:

```json
{"type":"wakeword","name":"...","score":0.9,"ts":1710000000}
```

И отправляет события:

- `wakeword:detected` в renderer
- `pixel-avatar:state` со `state: "listening"`

После этого renderer запускает `createSpeechRecorder()`, записывает фразу пользователя после wake word, отправляет ее в `transcribe-audio` и отправляет распознанный текст в чат.

### Особенности упаковки

`npm run build:win` должен включать:

- `models/` как `resources/models`
- `wakeword/` как `resources/wakeword`

`onnxruntime-node` должен быть распакован из `app.asar`; это настроено через `asarUnpack` в `package.json`.

Старые файлы Vosk не используются для wake word и явно исключены из packaged-сборки. Ключевые слова работают через ONNX-ресурсы из `wakeword/models/`.

## TTS (Text-to-Speech)

Озвучка сообщений бота — три модели, единый стейт, плавные переходы.

### Модели

| Модель | Движок | Голоса |
|---|---|---|
| **Piper** (по умолчанию) | Локальный `piper.exe` через IPC → WAV → Web Audio API | Автоматически читаются из `.onnx.json`; в стандартной сборке — Ruslan и Irina (ru), HFC Male и HFC Female (en-US) |
| **Встроенный (Chromium)** | `window.speechSynthesis` — системные голоса Windows | Все голоса ОС |
| **Cartesia (облачная)** | Backend-прокси → Cartesia.ai API → MP3 → Web Audio API | Голоса для поддерживаемых backend языков интерфейса, подгружаются с сервера |

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
- `SettingsModal.tsx` — вкладка «Голос»: язык распознавания, модель озвучки, голос, громкость, прослушивание

### Управление воспроизведением

- **Единый стейт** — `ttsSubscribe(fn)` → только одно сообщение играет одновременно
- **Generation ticket** — `ttsStop()` инвалидирует in-flight IPC-запросы, буфер отбрасывается
- **Настройки** — модель + голос + громкость (0–1) в `localStorage` (`chatter_tts_settings`)

### Ресурсы Piper

Dev: `models/piper/piper.exe` + `models/piper-voices/<voice>/*.onnx`
Packaged: `resources/models/piper/` + `resources/models/piper-voices/`

Перед сборкой установите стандартные русскую и английскую модели:

```powershell
npm run voices:download
```

Piper-голоса определяются динамически по метаданным `.onnx.json`. В стандартную packaged-сборку входят Ruslan и Irina для русского языка, HFC Male и HFC Female для английского; устаревшие Denis и Dmitri исключены для уменьшения размера.

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
    │   ├── DocumentsTool  # Документы чата (attachments)
    │   ├── GalleryTool    # Галерея фото из чата
    │   ├── RadioGroup     # Переиспользуемый радио-селектор
    │   ├── SettingsModal  # Настройки (аккаунт, привязанные аккаунты, промпт, голос, лимиты, приложение, макросы, серверы, инструкции, умный дом)
    │   ├── MacroSettings  # Управление макросами (CRUD + AI explain/describe)
    │   ├── ServerSettings # Управление SSH-серверами DevOps (CRUD + политики + привязка инструкций)
    │   ├── RunbookSettings # Управление инструкциями DevOps (CRUD + AI extraction/review)
    │   ├── SmartHomeSettings # Управление умным домом (токен Яндекса, синхронизация устройств)
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

В выпадающем списке рядом с моделями, поддерживающими vision, отображается бейдж `[Vision]` (зелёным). Бейджи реализованы через generic-механику в `Select` — поле `badge?: { text, color?, icon? }` у `SelectOption`. Цвета ограничены: `success | error | info | warning`, каждый берётся из CSS-переменной (`--color-success` и т.д.). Если `icon` не передан — рисуется `[text]`.

Обе боковые панели работают одинаково: `motion.aside` с анимацией ширины, всегда в DOM. Сворачивание не сбрасывает внутреннее состояние.

## Привязанные аккаунты

В Settings modal есть отдельная вкладка **«Привязанные аккаунты»**. Сейчас UI поддерживает только Telegram.

Модель backend — один канонический аккаунт с несколькими способами входа:

```text
канонический аккаунт
├── password identity (логин Desktop)
└── Telegram identity (Telegram user ID)
```

Desktop-клиент не считает Telegram ID вторым владельцем данных. Чаты, картинки, промпты, настройки, лимиты, счётчики и memory принадлежат каноническому backend-аккаунту и общие для всех прикреплённых identities.

### Процесс привязки

1. Пользователь открывает Настройки → Привязанные аккаунты → Telegram.
2. Desktop запрашивает шестизначный одноразовый код. Код действует 10 минут.
3. Пользователь отправляет `/link` Telegram-боту и вводит код.
4. Backend объединяет существующие Desktop- и Telegram-аккаунты в один канонический аккаунт.
5. Desktop заново запрашивает `/api/v1/auth/me` и `/api/v1/link/status`, затем переподключает WebSocket под разрешённым account ID.

Перед показом кода модальное окно предупреждает о слиянии. Данные обеих сторон сохраняются; персональные настройки Desktop имеют приоритет там, где backend должен разрешить конфликт настроек.

### Процесс отвязки

Отвязка доступна только тогда, когда у аккаунта есть и Telegram identity, и password identity. В окне подтверждения пользователь выбирает, какая сторона сохраняет общие данные:

- **Данные остаются в Desktop:** password identity остаётся на текущем аккаунте с данными, Telegram переносится в новый пустой аккаунт.
- **Данные остаются в Telegram:** Telegram остаётся на текущем аккаунте с данными, password identity переносится в новый пустой Desktop-аккаунт.

Операция не удаляет и не разделяет отдельные чаты, картинки, промпты, настройки, файлы, счётчики или vector memory. Все существующие данные целиком остаются на выбранной стороне.

Backend отзывает JWT, выпущенные до разделения, и возвращает новые access/refresh tokens Desktop. Клиент сохраняет их, обновляет закешированного пользователя, перезагружает зависящее от аккаунта состояние и переподключает WebSocket. Если владельцем данных выбран Telegram, Desktop продолжает работу уже в созданном пустом Desktop-аккаунте.

Telegram-бот предоставляет то же разделение через `/unlink`: он спрашивает, какая сторона сохраняет данные, и вызывает backend с тем же значением `data_owner`.

Связанный клиентский код:

- `src/renderer/components/SettingsModal.tsx` — карточка привязки, выбор владельца, замена tokens/user и переподключение WebSocket.
- `src/renderer/components/LinkTelegramModal.tsx` — генерация кода, таймер, polling и предупреждение о слиянии.
- `src/renderer/lib/api.ts` — типы и вызовы `/api/v1/link/status`, `/generate` и `/unlink`.
- `src/renderer/assets/integrations/telegram.webp` — Telegram-иконка, попадающая в сборку.

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

Read-only просмотр задач с фильтрами по статусу (pending/done/all). Каждая карточка показывает статус, тип (`message`, `smart_home`, `ai_instruction`), дату, payload preview, recurrence badge. Кнопка удаления (появляется при наведении).

API: `GET /api/v1/tasks?status=&limit=`, `DELETE /api/v1/tasks/:id`.

Бот может открывать задачи через `desktop_action` с `action: open_widget, target: tasks`.

### Scheduler task_result (push от сервера)

Когда scheduler выполняет задачу, результат пушится в десктоп через WS `{ type: 'task_result', chat_id, text, is_new_chat }`. Обработка в `ChatPage.tsx`:

- Если чат открыт — сообщения перезагружаются из БД
- Если другой чат — инкрементируется бейдж непрочитанных через `useUnreadChats` hook
- При `is_new_chat: true` — обновляется список чатов в сайдбаре

### useUnreadChats hook

`lib/useUnreadChats.ts` — переиспользуемый hook для отслеживания непрочитанных сообщений по чатам:
- `incrementUnread(chatId)` — добавить непрочитанное
- `markAsRead(chatId)` — очистить при открытии чата
- `getUnread(chatId)` — получить счётчик
- `totalUnread` — всего непрочитанных

Бейдж (`.unreadBadge`) рендерится в сайдбаре рядом с названием чата.

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

## Браузер (BrowserTool)

В ToolsPanel встроена настоящая Chromium-страница, которую Electron отображает через `WebContentsView`. Поддерживаются режимы sidebar, floating, fullscreen и отдельное окно; между ними перемещается одно и то же представление браузера с общей сессией, а не создаётся новая вкладка.

**Возможности для пользователя:**
- Адресная/поисковая строка, переход назад и вперёд, перезагрузка.
- Постоянная сессия входа в локальном разделе `persist:chatter-browser`.
- Пользователь может сам открыть страницу и попросить ассистента прочитать её или выполнить действие.
- В Settings отдельно настраиваются подтверждения открытия URL, нажатий и заполнения полей. Нажатия или ввод можно разрешить для текущего origin до закрытия Chatter.
- Любая загрузка файла перехватывается и ждёт карточку подтверждения. Неподтверждённые временные загрузки отменяются через пять минут.

**Управление моделью:**
- `browser_control` поддерживает `open`, `read`, `back`, `forward`, `reload`, `scroll`, `click` и `fill` через IPC renderer → main process.
- Чтение возвращает структурированный видимый текст и интерактивные элементы с временными ref. Режимы `viewport`, `delta` и `full` позволяют не отправлять весь документ повторно.
- Основная страница и iframe парсятся в изолированных JavaScript worlds. Для cross-origin OOPIF используются отдельные CDP-сессии; изоляция гарантирует, что парсер не влияет на состояние страницы.
- Нажатия используют ref из последнего чтения и проверяют, что элемент и origin не изменились. Ввод выполняется через trusted input events.

**Безопасность и хранение:**
- Браузер использует `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true` и по умолчанию отклоняет запросы сайтов на разрешения.
- Cookies, localStorage, IndexedDB и браузерная сессия остаются в локальном профиле Electron. Шифрование browser cookies включено и в dev-, и в packaged-сборке. При чтении страницы на backend/модели отправляется извлечённый контент, а не cookie-хранилище или локальное хранилище сайта.
- Пароли и другие чувствительные поля исключаются из чтения и недоступны для заполнения моделью. Обычные текстовые поля модель видеть может.
- Разрешены только переходы по `http:` и `https:`. Запросы нового окна остаются внутри встроенного браузера.

**Ключевые файлы:**

| Файл | Роль |
|---|---|
| `src/main/browser.ts` | Жизненный цикл WebContentsView, навигация, DOM/iframe-парсинг, ввод, разрешения и загрузки |
| `src/main/cursor-input.ts` | Программный ввод мыши и прокрутки |
| `src/renderer/components/BrowserTool.tsx` | Панель навигации и viewport браузера внутри ToolsPanel |
| `src/renderer/components/BrowserSettings.tsx` | Настройки подтверждений аккаунта |
| `src/renderer/lib/api.ts` | WebSocket IPC-мост удалённых действий браузера |

## Документы (DocumentsTool)

Инструмент в правой панели для просмотра и управления прикреплёнными документами в чате. Зеркало «Галереи» для фотографий.

### Прикрепление файлов

- Кнопка-скрепка слева от поля ввода открывает единую модалку `AttachModal` для фото и документов.
- Drag-and-drop или выбор файлов через диалог.
- Фото: PNG, JPEG, WebP (до 20 МБ). Лимит количества зависит от плана.
- Документы: txt, md, json, csv, log, xml, yaml, ini, toml, код (py, js, ts, go, rs, java, c, cpp, cs, php, sh, sql, html, css и т.д.), **docx**, **pdf**, rtf (до 5 МБ).
- Превью фото и список документов отображаются над полем ввода.
- При отправке файлы передаются на сервер как base64, сервер парсит текст и сохраняет файл.

### DocumentsTool (ToolsPanel)

`DocumentsTool.tsx` — список всех документов в текущем чате:
- Загружается через `GET /api/v1/chats/:chatId/attachments`.
- Каждый элемент: иконка файла, имя, размер, дата.
- Кнопка скачивания (через `resolveImageUrl(item.url)` для auth-token).
- Кнопка удаления с подтверждением → `DELETE /api/v1/chats/:chatId/messages/:messageId/attachments/:filename`.

### Отображение в сообщениях

- В user-сообщениях с attachments показывается список файлов с иконкой, именем, размером и кнопкой скачивания.
- Скачивание использует `resolveImageUrl(att.url)` для подстановки JWT-токена.

### Настройки лимита токенов

Вкладка «Лимиты» в SettingsModal — слайдеры лимита контекста чата и документов:
- `0` = Авто (90% от `max_context_tokens`).
- Ручной ввод от 1000 до `max_context_tokens` токенов.
- Сохраняется через `PUT /api/v1/user/attachment-tokens-limit`.

### Ключевые файлы

| Файл | Роль |
|---|---|
| `components/DocumentsTool.tsx` | ToolsPanel-компонент: список документов, удаление, скачивание |
| `components/AttachModal.tsx` | Единая модалка прикрепления фото + документов: drag-drop, превью, валидация |
| `pages/ChatPage.tsx` | Кнопка-скрепка, превью, рендер attachments в сообщениях |
| `components/SettingsModal.tsx` | Слайдер лимита токенов на документы |
| `lib/api.ts` | Типы `MessageAttachment`, `ChatAttachmentItem`, `AttachmentTokenLimit` + API-функции |

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
| `file_action_confirmation` | Подтверждение `read_file` (когда `file_read_enabled=false`) или `write_file` (всегда). Карточка показывает путь, режим (overwrite/append), размер и превью контента. Кнопки «Записать»/«Прочитать» и «Отклонить». TG-бот рендерит через inline-кнопки `fileconfirm:allow`/`fileconfirm:reject`. |
| `edit_file_lines_confirmation` | Подтверждение `edit_file_lines` (всегда). Карточка показывает путь, диапазон строк и **diff-превью**: красный блок «Удаляется» (старые строки) + зелёный блок «Добавляется» (новые строки). TG-бот рендерит аналогичный diff через inline-кнопки `fileconfirm:allow`/`fileconfirm:reject`. |
| `email_confirmation` | Подтверждение `send_email` — карточка с From, To, Subject и превью Body (через MarkdownRenderer). Кнопки «Отправить» / «Отклонить». Дедупликация по `confirmation_id`. |
| `suggest_devops_runbook` | Предложение инструкции — карточка с кнопками «Сохранить»/«Проверить»/«Отклонить» |

UX отклонения: карточки подтверждения на десктопе используют общий компонент `RejectWithComment`; при нажатии кнопки отклонения открывается небольшое текстовое поле. Комментарий отправляется как `rejection_comment`, а backend возвращает его AI как `user_comment` в результате отклонённого вызова инструмента.

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
| `execute-commands` | Последовательно выполняет массив команд через `child_process.exec` (30с таймаут, 1MB буфер). Блокирует опасные команды (`rm -rf /`, `format`, `shutdown` и т.д.). Возвращает объединённый stdout/stderr. Логирует batch/cmd start/done/error для диагностики зависаний команд. На Windows команды оборачиваются в PowerShell с UTF-8 I/O для корректной кириллицы (см. ниже). |
| `read-directory` | Чтение содержимого директории (read-only). Возвращает `{ name, isDirectory, size, modifiedAt }[]`. |
| `read-file` | Нативное чтение файла через `fs.createReadStream` + `readline` (UTF-8, с пагинацией). Параметры: `{ file_path, start_line?, max_lines?, line_numbers? }`. Возвращает `{ content, start_line, read_lines, total_lines, encoding, line_numbers }`. При `line_numbers=true` каждая строка имеет префикс `     N\t` (формат `cat -n`). Не загружает весь файл в память — построчное чтение. **Для `.docx`** использует `mammoth.extractRawText()` — извлекает чистый текст, затем применяет ту же пагинацию. |
| `write-file` | Нативная запись файла через `fs.promises.writeFile`/`appendFile` (UTF-8). Параметры: `{ file_path, content, mode? }`. Создаёт родительские директории при отсутствии. Возвращает `{ ok, bytes_written, mode }`. **Для `.docx`** генерирует валидный Word-документ через `docx` пакет (каждая строка текста = абзац). Режим `append` для `.docx` запрещён — возвращается ошибка. |
| `edit-file-lines` | Точечная замена строк в файле через `Array.splice`. Параметры: `{ file_path, start_line, end_line, new_content }`. Читает файл → разбивает на строки → вырезает `start_line..end_line` → вставляет `new_content` → записывает обратно. Поддерживает вставку без удаления (`end_line = start_line - 1`) и удаление (`new_content = ""`). Возвращает `{ ok, lines_removed, lines_added, total_lines_before, total_lines_after }`. Не поддерживает `.docx`. |
| `capture-screen` | Захват скриншотов всех мониторов через `desktopCapturer.getSources()`. Возвращает `{ displays: [{ display_id, name, bounds, screenshot_base64 }] }`. Используется инструментом `capture_screen` для visual control. |
| `visual-click` | Клик мышкой по нормализованным координатам (0.0–1.0). Использует `@nut-tree-fork/nut-js` для перемещения курсора и клика. Переводит нормализованные координаты в глобальные через `display.bounds`. Поддерживает мульти-монитор (включая мониторы с отрицательными координатами). |

**Фоновый режим execute-commands:** `electronAPI.executeCommands(commands, { background: true })` используется инструментом `execute_pc_command` для GUI/open-команд, где не нужен stdout. В этом режиме main process запускает detached-процесс через `spawn(..., { shell: true, stdio: 'ignore', windowsHide: true })` и `child.unref()`, затем сразу возвращает `[background] launched: ...`. Обычные команды по-прежнему используют `exec()` и ждут stdout/stderr.

### Кодировка команд на Windows (fix кракозябр)

`execute-commands` на Windows оборачивает каждую команду в PowerShell-обёртку с UTF-8 I/O, чтобы кириллица в stdout не превращалась в мусор (`�ਢ��`).

**Проблема:** `child_process.exec` на Windows запускает `cmd.exe /d /s /c "..."`. Cmd получает аргументы в системной ANSI-кодировке (cp1251 в русской локали) **до** выполнения `chcp`, поэтому `chcp 65001 && echo Привет` не помогает — к моменту переключения кодовой страницы команда уже искажена.

**Решение — двойной Base64** (`src/main/main.ts`, хендлер `execute-commands`):

1. Исходная команда кодируется в Base64 (UTF-16LE для .NET): `Buffer.from(cmd, 'utf16le').toString('base64')`.
2. PowerShell-скрипт декодирует её через `[Text.Encoding]::Unicode.GetString(...)` и выполняет через `cmd.exe /c $decCmd` — это сохраняет cmd-семантику (`&&`, `|`, `>`, `echo`, `ver`, builtin-команды).
3. В PS форсируется UTF-8: `$OutputEncoding` и `[Console]::OutputEncoding`.
4. Весь PS-скрипт пакуется во второй Base64 (UTF-16LE) и передаётся через `powershell -NoProfile -EncodedCommand`.

На Linux/macOS обёртка не применяется — `execCmd = cmd` как есть.

### Visual Control (удалённое управление через скриншоты)

Позволяет AI управлять мышкой пользователя через Telegram. Два инструмента работают вместе:

**Pipeline:**
```
AI: capture_screen({ purpose: "Найди кнопку Сохранить" })
  → Backend: sendIpcToDesktop('capture_screen') → desktopCapturer
  → Backend: sharp (сжатие до 1280px, JPEG) → сохранение в чат
  → Backend: runCompletion('vision-pro') со скриншотом + purpose
  → Vision-модель возвращает координаты (0.0–1.0)
  → AI получает текстовый ответ (без картинки в контексте)

AI: execute_visual_click({ display_id, x: 0.63, y: 0.42 })
  → Backend: свежий скриншот → sharp рисует красный прицел (SVG composite)
  → SSE → TG: фото с прицелом + кнопки «Кликнуть» / «Отклонить»
  → Юзер подтверждает → sendIpcToDesktop('visual_click')
  → Desktop: nut.js mouse.setPosition() + leftClick/rightClick
```

**Безопасность:**
- Каждый клик требует подтверждения (HitL) — TTL 60 секунд
- Один клик за одно подтверждение (никаких серий)
- Скриншот с прицелом отправляется в Telegram — юзер видит точку клика
- Инструменты отключаются через feature flags `disable_pc_commands` и `disable_pc_control_full`

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
Условие: у канонического аккаунта должны быть Telegram и password identities, а его Desktop-клиент должен быть подключён через WebSocket. Если Desktop не подключён — макрос не выполнится (fire-and-forget без получателя).

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

**Метаданные файла (get_file_info, через WS):**

```text
AI: get_file_info(file_path, include_line_count?)
    Backend: sendIpcToDesktop('get_file_info', { file_path, include_line_count })
    → Desktop: get-file-info IPC → fs.statSync()
    → AI получает exists/type/size_bytes/timestamps/name/extension.
      Если include_line_count=true и это файл, desktop дополнительно считает line_count потоковым чтением.
```

**Поиск по файлу (search_file_keywords, через WS):**

```text
AI: search_file_keywords(file_path, query, max_matches?)
    Backend: sendIpcToDesktop('search_file_keywords', { file_path, query, max_matches })
    → Desktop: search-file-keywords IPC → readline/mammoth
    → AI получает только строки с совпадениями и номерами строк.
```

**Чтение файла (read_file, через WS):**
```
AI: read_file(file_path, start_line?, max_lines?)
  → Если file_read_enabled=true:
    Backend: sendIpcToDesktop('read_file', { file_path, start_line, max_lines })
    → WS: execute_ipc → IPC readFile() → { content, start_line, read_lines, total_lines }
    → AI получает контент как tool response
  → Если file_read_enabled=false:
    HitL-карточка file_action_confirmation → пользователь подтверждает →
    затем тот же IPC-поток через /api/v1/pc-commands/approve
```

**Запись файла (write_file, через WS, всегда HitL):**
```
AI: write_file(file_path, content, mode?)
  → Backend: регистрирует pending в pc-command-confirmations (kind: 'file_action')
  → Desktop action: file_action_confirmation { confirmation_id, action_type: 'write', file_path, mode, size_bytes, content_preview }
  → Карточка в ChatPage / inline-кнопки в TG
  → Пользователь подтверждает → POST /api/v1/pc-commands/approve
  → Backend: sendIpcToDesktop('write_file', { file_path, content, mode })
  → IPC writeFile() → { ok, bytes_written, mode }
  → AI получает результат как tool response
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

## Умный дом (Smart Home)

Вкладка "Умный дом" в SettingsModal — управление устройствами умного дома через Яндекс.Умный дом.

`SmartHomeSettings.tsx` — UI управления:
- Поле ввода OAuth-токена Яндекса (шифруется на сервере через `ENCRYPTION_KEY`)
- Кнопка синхронизации — загружает актуальный список устройств и групп из Яндекса
- Список устройств: имя, комната, бейдж "группа", capabilities, тип

**Настройка:**
1. Получить отладочный OAuth-токен на `oauth.yandex.ru` (права: «API Умного дома Яндекса»)
2. Вставить токен во вкладке "Умный дом" → "Сохранить"
3. Нажать "Синхронизировать" — устройства появятся в списке
4. После этого AI может управлять устройствами: `get_smart_devices()` → `control_smart_home({ device_id, action })`

**Файлы:**

| Файл | Назначение |
|---|---|
| `components/SmartHomeSettings.tsx` | Вкладка настроек: токен, синхронизация, список устройств |
| `lib/api.ts` | Типы `SmartDeviceDto`, `SmartHomeSettingsDto` + API-функции |

Подробности архитектуры бэкенда: [backend-api/README_RU.md → Smart Home](../backend-api/README_RU.md#smart-home-умный-дом).

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
| `disable_specialized_subagents` | Без специализированных субагентов | `invoke_subagent` |
| `disable_adhoc_subagents` | Без создания субагентов | `spawn_subagent` |

### Как добавить новый флаг

1. Добавить ключ в `VALID_FLAG_KEYS` в `backend-api/src/server.ts`
2. Добавить поле в тип `FeatureFlags` в `desktop-app/src/renderer/lib/api.ts`
3. Добавить инструменты в `disabledToolSet` в `backend-api/src/services/ai.ts`
4. Добавить чекбокс в `SettingsModal.tsx` (state default + render)

### Как добавить новый инструмент под существующие флаги

Добавить `disabledToolSet.add('tool_name')` в соответствующий блок флага в `ai.ts` (секция `Feature flags → disabled tools`). Фильтрация сработает автоматически.

## Dice Roll Mode (d20 Roleplay)

Режим «кубика» для roleplay-фана. Включается чекбоксом «Режим кубика (d20)» во вкладке настроек «Приложение». Сохраняется в `users.ui_settings.dice_roll_enabled` (boolean, default `false`), синхронизируется между desktop и Telegram.

### Логика работы

1. При отправке сообщения (или regenerate) десктоп **сразу** запускает анимацию кружка-кубика.
2. Бэкенд бросает d20 (`1..20`) до запроса к LLM и мгновенно пушит результат отдельным событием `dice_roll` (WS: `{ type: 'dice_roll', roll }`, SSE: `event: dice_roll`).
3. Десктоп ловит `onDiceRoll` → **тут же** останавливает анимацию на значении и красит кружок в цвет результата.
4. Сам ответ AI приходит позже в `done` — кубик к этому моменту уже давно остановился. В `done` поле `dice_roll` дублируется как fallback.
5. Результат сохраняется в `sessionStorage` (`chatter_dice_roll`) и не исчезает до следующего броска. Восстанавливается при перезагрузке страницы.

### Цвета результата

| Roll | Цвет | Значение |
|---|---|---|
| 1 | красный (`#e53935`) + glow | Критический провал |
| 2–10 | оранжевый (`#ff9800`) | Неудача |
| 11–19 | зелёный (`#4caf50`) | Успех |
| 20 | жёлтый (`#ffc107`) + glow | Критический успех |

### UI

Кружок 30x30px (`border-radius: 50%`) слева от иконки вложений (вне блока `inputArea`, рендерится только если `diceRollEnabled`). Состояния:
- `idle` — эмодзи
- `rolling` — анимация `diceSpin` (быстрые случайные числа 1..20, постепенно замедляется, ~1.2с общая длительность)
- `success` / `crit` / `fail` / `crit_fail` — зафиксированное число с цветом

### Анимация броска

Реализована через `setTimeout`-chain в `startDiceRollAnimation()`. Интервал тика растёт от 50мс до 220мс к концу (`50 + progress² · 170`), на каждом тике показывается `Math.floor(Math.random() * 20) + 1`. Общая длительность ~1.2с, но **анимация может быть остановлена раньше**, если `dice_roll` событие пришло быстрее (что и происходит — сервер шлёт результат мгновенно).

### Форсированные режимы (dice mode)

Клик по кружку-кубику переключает режим броска (цикл `normal → always_one → always_twenty → normal`). Режим хранится **локально** в `localStorage` (`chatter_dice_mode`), не синхронизируется с сервером.

| Режим | Что делает | Визуально (до броска) |
|---|---|---|
| `normal` | Обычный случайный бросок d20 | 🎲 эмодзи, серый border |
| `always_one` | Сервер всегда возвращает 1 (крит. провал) | «1», красный пунктирный border |
| `always_twenty` | Сервер всегда возвращает 20 (крит. успех) | «20», жёлтый пунктирный border |

В форсированных режимах кружок показывает «1» или «20» пунктирным border-ом (чтобы отличать от реального броска). При отправке сообщения режим прокидывается в body как `dice_mode`, сервер через `resolveDiceForceValue()` возвращает `diceRollForceValue: 1 | 20` в `sendMessageThroughAi`, и бросок форсируется вместо случайного.

### Промпт бота

Бэкенд инджектит в начало `proSystemPrompt` хинт с результатом броска. Кубик влияет **только** на нарративный тон ответа (насмешка при 1, триумф при 20 и т.д.), но **не** блокирует tool calls — даже при roll=1, если требуется `execute_ssh_command`, бот его выполнит.

### Ключевые файлы

| Файл | Роль |
|---|---|
| `pages/ChatPage.tsx` | State кубика (`diceRolling`, `diceValue`, `diceStatus`), `startDiceRollAnimation`, `finishDiceRoll`, рендер кружка |
| `pages/ChatPage.module.scss` | `.diceRoll` + состояния (`.diceRolling`, `.diceRollCrit`, `.diceRollSuccess`, `.diceRollFail`, `.diceRollCritFail`) + `@keyframes diceSpin` |
| `lib/api.ts` | `onDiceRoll` в `StreamCallbacks`, обработка WS `type: 'dice_roll'` и SSE `event: dice_roll` |
| `components/SettingsModal.tsx` | Чекбокс во вкладке `app`, `handleToggleDiceRoll` |
| `backend-api/src/services/ai.ts` | `buildDiceRollPrompt()`, бросок в `sendMessageThroughAi`, `onDiceRoll` callback |
| `backend-api/src/server.ts` | Проброс `diceRollMode` в 3 точках (SSE/WS/TG), отправка `dice_roll` события |

## Настройки моделей (Model Settings)

Вкладка "Модели" в SettingsModal позволяет настраивать параметры генерации (temperature, penalties, top_p, top_k, max_tokens) для каждой кастомной модели из `MODELS_MANUAL`. Настройки хранятся на сервере (`users.model_settings`, JSON-мапа по `model_id`), применяются только для ручных моделей (не для auto-роутинга PRO/LITE).

### UI

`SettingsModal.tsx` → вкладка `models`:
- Загружает каталог моделей (`GET /api/v1/models`) + сохранённые настройки (`GET /api/v1/user/model-settings`) при открытии вкладки
- Для каждой модели — раскрывающийся блок с слайдерами параметров
- Список параметров фильтруется по `supported_params` модели (зависит от провайдера)
- Каждый параметр имеет чекбокс «авто» — если включён, параметр не отправляется (используется серверный дефолт)
- Save оптимистичный — при отпускании слайдера отправляется `PUT /api/v1/user/model-settings`

### Компоненты

| Компонент | Роль |
|---|---|
| `components/Slider.tsx` | Переиспользуемый слайдер. Два режима: `numeric` (temperature и т.д.) и `discrete` (reasoning level в топбаре). |
| `components/Checkbox.tsx` | Переиспользуемый чекбокс. Стили 1-в-1 как `macroCheckbox` из SettingsModal. |

### Ключевые файлы

| Файл | Роль |
|---|---|
| `lib/api.ts` | Типы `ModelSettings`, `ModelSettingsMap` + `getModelSettings()` / `setModelSettings()` / `deleteModelSettings()` |
| `components/Slider.tsx` | Переиспользуемый слайдер (numeric + discrete режимы) |
| `components/Checkbox.tsx` | Переиспользуемый чекбокс (auto toggle) |
| `components/SettingsModal.tsx` | Вкладка `models`: grid из чекбокс + слайдер для каждого параметра |

### Параметры

| Параметр | Диапазон | Назначение |
|---|---|---|
| `temperature` | 0.0–2.0 | Креативность/детерминированность |
| `top_p` | 0.0–1.0 | Nucleus sampling |
| `top_k` | 1–100 | Ограничение выборки K токенами (OpenRouter only) |
| `frequency_penalty` | -2.0–2.0 | Штраф за частоту токенов |
| `presence_penalty` | -2.0–2.0 | Штраф за присутствие токенов |
| `repetition_penalty` | 1.0–2.0 | Жёсткий штраф за повторения (OpenRouter only) |
| `max_tokens` | 1–65536 | Лимит длины ответа |

## Subagent Settings (модель и reasoning субагентов)

Во вкладке "Модели" в SettingsModal, отдельно от основной модели, настраиваются параметры для AI-субагентов:

- **Модель субагента** — селектор (аналогичный основному): `auto` (наследует модель основного агента) или конкретная модель из каталога. Сохраняется через `PUT /api/v1/user/subagent-model`.
- **Reasoning level** — появляется только если выбрана конкретная модель и она поддерживает reasoning levels. Сохраняется через `PUT /api/v1/user/subagent-reasoning-level`.

Оба значения прокидываются через `SubagentContext` в `runner.ts` и применяются в `runCompletion()` при каждом AI-вызове внутри субагента.

### Ключевые файлы

| Файл | Роль |
|---|---|
| `lib/api.ts` | `getSubagentModel()` / `setSubagentModel()` / `getSubagentReasoningLevel()` / `setSubagentReasoningLevel()` |
| `components/SettingsModal.tsx` | Селектор модели субагента + reasoning level slider |

## ChatPage Messages

Основная лента чата живет в `pages/ChatPage.tsx`.

### Оптимизация ленты

- Сообщения рендерятся через memoized `MessageItem` (`React.memo`), чтобы изменение input, TTS, popover-состояний или WS-событий не перерисовывало всю историю.
- Активные состояния передаются в `MessageItem` как booleans (`isTtsPlaying`, `isReasoningOpen`, `isToolCallsOpen`, `isRegenHintOpen`), а не как глобальные id. Так при переключении TTS/reasoning/tool calls изменяются только затронутые сообщения.
- Начальная загрузка истории берет последние `MESSAGE_PAGE_SIZE = 50` сообщений.
- Старые сообщения подгружаются кнопкой "Загрузить старые сообщения" через `GET /api/v1/chats/:id/messages?limit=&offset=`.
- Левое меню чатов грузит список порциями по `CHAT_PAGE_SIZE = 50` через `GET /api/v1/chats?limit=&offset=`; поиск чатов остается отдельным `/api/v1/chats/search` без этой пагинации.
- При prepend старых сообщений ChatPage сохраняет `scrollHeight`/`scrollTop` и восстанавливает позицию через `useLayoutEffect`, чтобы экран не прыгал вниз.
- Автоскролл вниз пропускается, если идет prepend старых сообщений.
- Архивные сообщения (`msg.archived === true`) отображаются с пониженной прозрачностью (opacity 0.55) и меткой «архив» в metaRow. Архивные сообщения не отправляются в AI-контекст, но остаются в БД и доступны для просмотра и поиска.

### Reasoning, tool calls и subagents

Assistant-сообщения могут иметь дополнительные поля:

- `reasoning_content?: string | null`
- `tool_calls?: Array<{ id?: string; name: string; arguments: unknown; result_preview?: string }>`
- `result_preview` — обрезанный результат инструмента (до 250 символов) для отображения в popover. При streaming приходит из `toolCallsHistory` (обрезка через `formatToolResultPreview`), при перезагрузке чата — реконструируется из trace-формата `tool_calls_json` (обрезка через `slice(0, 250)`).
- `subagents?: SubagentTrace[] | null` — полные trace ad-hoc субагентов (созданных через `spawn_subagent`). Каждый элемент содержит: `task`, `system_prompt`, `tools`, `tools_used`, `answer`, `summary`, `aborted?`, `trace` (пошаговые tool calls).

UI:

- Кнопка `Рассуждение` появляется только если `reasoning_content` непустой.
- Во время token streaming кнопка `Рассуждение` превращается в тот же toggle-контрол с текстом `Рассуждает...`: chevron и раскрытие popover работают сразу, не дожидаясь `done`.
- Если первым приходит `reasoning_token`, `ChatPage` сразу создаёт временное assistant-сообщение с `reasoning_content`, чтобы reasoning можно было открыть во время генерации. Пока обычный `content` ещё пустой, bubble показывает те же typing dots, но с более активной streaming-анимацией.
- После первого `stream_token` состояние переходит в `content`: typing dots заменяются Markdown-текстом, а `streamAppenderRef` продолжает rAF-батчить текст и reasoning в одно обновление на кадр.
- Кнопка инструментов появляется только если `tool_calls.length > 0`.
- Кнопка `N сабагент(ов)` появляется только если `subagents.length > 0`. Открывает панель с детальным trace каждого субагента: задача, промпт (обрезанный до 500 символов), список переданных инструментов, список выполненных инструментов, ответ.
- Прерванные субагенты помечаются `⏹ прерван`.
- Все три блока открываются как absolute popover поверх ширины сообщения (`reasoningPanel`) и не раздвигают ленту.
- Анимация popover сделана через `AnimatePresence` + `motion.div`, направление раскрытия — сверху вниз (`y: -16 -> 0`).
- Toggles управляются через `openSubagentsId` state (по аналогии с `openReasoningId` / `openToolCallsId`).

### Regeneration

В ChatPage есть обычная перегенерация последнего assistant-сообщения и перегенерация с hint.

Поток:

1. Клиент находит последнее user-сообщение перед assistant-сообщением.
2. Старое assistant-сообщение оптимистично удаляется из UI и удаляется на backend через `DELETE /api/v1/chats/:id/messages/:messageId`.
3. `streamChatMessage()` отправляет тот же user text, `skip_user_history: true` и `regenerate_from_history: true`.
4. Для hint дополнительно отправляется `regenerate_hint`.
5. Backend не сохраняет новый user message и не дублирует user text в AI-history; он использует последнее user-сообщение из истории как текущий запрос один раз.

WS это не ломает: `streamChatMessage()` по-прежнему получает `intermediate`, `tool_status`, `display_state`, `desktop_action`, `map_update`, `done`, `error`; memoized rendering влияет только на React-перерисовки.

### Редактирование сообщений

В бургер-меню сообщения (где копировать/скачать) есть кнопка «Редактировать». Работает для сообщений любого роли — и user, и assistant.

1. Клик по «Редактировать» → контент сообщения заменяется на `<textarea>`.
2. Высота textarea автоматически подстраивается под исходную высоту сообщения (auto-size через `scrollHeight`).
3. **Ctrl+Enter** — сохранить, **Escape** — отмена. Кнопки «Сохранить» / «Отмена» под полем.
4. Optimistic update: UI обновляется мгновенно, при ошибке сети — откат к старому тексту.
5. API: `PUT /api/v1/chats/:chatId/messages/:messageId` ← `{ content }` → `{ ok, token_count }`.
6. После сохранения `token_count` обновляется из ответа сервера.

### Создание ветки диалога (fork)

В кебаб-меню сообщения (рядом с «Редактировать» / «Удалить») есть кнопка **«Создать ветку»**. Создаёт новый чат как копию текущего от начала до этого сообщения включительно.

**Поток:**

1. Клик по «Создать ветку» → `POST /api/v1/chats/:currentChatId/fork` ← `{ from_message_id }`.
2. Бэкенд копирует все сообщения от начала до `from_message_id` в новый чат (см. [backend README → Форк чата](../backend-api/README_RU.md#форк-чата-dialog-branch)).
3. Новый чат становится активным, сайдбар обновляется (`loadChats`), `selectChat(res.chat_id)` переключает на ветку.
4. Кнопка блокируется на время запроса (`forking` state).

**Title по умолчанию:** числовой префикс `[N]` — `"Отчёт"` → `"[2] Отчёт"`, `"[2] Отчёт"` → `"[3] Отчёт"`. Можно передать кастомный `title` в body.

**Что копируется:** сообщения (включая `token_count`, `reasoning_tokens`, `archived`), attachments (**физически копируются файлы** — удаление в ветке не ломает оригинал), images/audio (общие ссылки — удалений пока нет). FTS обновляется автоматически.

## Подсчёт токенов (token accounting)

Отображение количества токенов в сообщениях и общий контекст чата. Считается на сервере (gpt-tokenizer, o200k_base), десктоп только отображает.

### Где отображается

| Место | Что показывает |
|---|---|
| metaRow каждого сообщения | `Ntk` — количество токенов в сообщении (считается от развёрнутого trace: контент + tool_calls + tool_results) |
| Кнопка «Рассуждение» | `Рассуждение · Ntk` — токены reasoning_content (отдельно от основного token_count) |
| Top bar (справа) | `12 345tk · 1 876pk` — суммарные токены всех активных сообщений (`tk`) + размер системного промпта (`pk`) |

### Когда обновляется

- При загрузке чата (`getChatMessages`) — токены приходят в DTO каждого сообщения + отдельный запрос `getChatContextTokens(chatId)` для top bar.
- После ответа AI (`done` событие) — assistant-сообщение получает `token_count` и `reasoning_tokens` из ответа, top bar обновляется.
- User-сообщение получает `token_count` сразу в `done` (поле `user_token_count` ответа) — не требует перезагрузки чата.

### API

- `GET /api/v1/chats/:id/context-tokens` — возвращает `messages_tokens`, `reasoning_tokens`, `archived_tokens`, `active_messages`, `archived_messages`, `system_prompt_tokens`.
- `ChatContextTokens` тип и `getChatContextTokens()` — в `lib/api.ts`.

### Что НЕ считается

- `reasoning_content` не входит в `token_count` сообщения — он отдельно в `reasoning_tokens`.
- Архивированные сообщения не входят в `messages_tokens` (только в `archived_tokens`).
- Аддоны промпта (voice, avatar, image) не входят в `system_prompt_tokens` — считается только base prompt (prompt content + core memory + pinned macros).

## WebSocket Transport

Desktop-клиент использует **WebSocket** для двунаправленного обмена с сервером. Реализация в `lib/api.ts`.

**Подключение:**
- `initWebSocket()` — вызывается в `auth.tsx` после успешного логина/регистрации
- WS подключается к `ws://host:3050/ws?token=jwt`, JWT валидируется сервером
- Auto-reconnect с exponential backoff (1s → 2s → 4s → ... → 30s)
- При refresh токена (401 в apiFetch) → `reconnectWebSocket()` с новым токеном
- При logout → `closeWebSocket()` (code 1000, без реконнекта)
- Heartbeat: backend каждые 25s отправляет `{ type: 'ping' }`, desktop отвечает `{ type: 'pong' }`. Backend считает desktop online только если `lastPongAt` свежий (grace window 75s); stale-соединение не получает `execute_ipc`.

**Отправка сообщений:**
- `streamChatMessage()` при подключённом WS отправляет `{ type: 'chat_send', text, ... }`
- Если WS не подключён — fallback на SSE (POST + ReadableStream)

**Входящие сообщения (WS → клиент):**

| type | Описание |
|---|---|
| `intermediate` | Промежуточный текст AI |
| `stream_token` | Чанк обычного текста ответа. На стороне `ChatPage` попадает в `onStreamToken` → `streamAppenderRef.appendText()` и переводит UI в состояние `content`. |
| `reasoning_token` | Чанк reasoning/thinking. На стороне `ChatPage` попадает в `onReasoningStream` → `streamAppenderRef.appendReasoning()` и переводит UI в состояние `reasoning`. |
| `tool_status` | Статус выполнения инструмента ("Ищу информацию...") |
| `display_state` | Изменение состояния аватара |
| `desktop_action` | Команда управления UI / макрос |
| `map_update` | Данные карты |
| `dice_roll` | Результат броска d20 (Dice Roll Mode). Приходит сразу после броска, десктоп останавливает анимацию и фиксирует значение. См. [Dice Roll Mode](#dice-roll-mode-d20-roleplay) |
| `task_result` | Результат выполнения scheduler-задачи: `{ chat_id, text, is_new_chat }`. Если открыт тот же чат — перезагрузка сообщений; если другой — бейдж непрочитанных. См. [Задачи](#задачи-taskstool) |
| `done` | Финальный ответ: `reply_text`, ids, `reasoning_content?`, `tool_calls?`, `generated_images?`, `display_state?`, `dice_roll?` (fallback если realtime-событие потерялось) |
| `error` | Ошибка |
| `execute_ipc` | Запрос сервера выполнить IPC и вернуть результат |
| `ping` | Серверный heartbeat; клиент должен ответить `pong` |
| `pong` | Ответ на ping |

**Callbacks текущего стрима:** `lib/api.ts` разделяет постоянные WS handlers (`wsCallbacks`: connect/disconnect/task_result и fallback handlers) и callbacks активной генерации (`activeStreamCallbacks`). `streamChatMessage()` кладёт callbacks текущего запроса в `activeStreamCallbacks`, входящие `stream_token` / `reasoning_token` / `done` / `error` сначала доставляются туда, а на `done` или `error` active callbacks очищаются. Это защищает токен-стрим от случайной перерегистрации `initWebSocket()`.

**Скорость токенов:** фактический throttle задаётся на backend в `backend-api/src/services/ai.ts`: `STREAM_FLUSH_INTERVAL_MS = 50` (~20 WS/SSE chunks/sec). Desktop не задаёт отдельный millisecond-rate, а батчит входящие чанки через `requestAnimationFrame`, чтобы делать не больше одного `setState` на кадр.

**Обратный канал (execute_ipc):**
Сервер может запросить десктоп выполнить IPC-команду и вернуть результат. Используется для `return_output` макросов, `explore_fs`, `read_file`, `write_file` и подтверждённых `execute_pc_command`. `lib/api.ts` логирует получение `execute_ipc` и отправку `ipc_result`; связка с backend-логами делается по `request_id`.
1. Сервер шлёт `{ type: 'execute_ipc', request_id, ipc_type, payload }`
2. Десктоп выполняет IPC (`executeCommands` / `readDirectory` / `readFile` / `writeFile`)
3. Десктоп отвечает `{ type: 'ipc_result', request_id, data }` или `{ error }`
4. Сервер резолвит pending Promise → AI получает результат как tool response

**SSE fallback** — если WS не подключён, `streamChatMessage` использует обычный POST + SSE. SSE — однонаправленный, обратный канал (`execute_ipc`) недоступен.

### Stop generation

- `stopChatStream()` отправляет `{ type: 'chat_stop' }` через WS при активном подключении и дополнительно вызывает `POST /api/v1/chat/stop` как резервный вариант.
- В `ChatPage` состояние `sending` означает, что выполняется активный запрос чата, и сохраняет кнопку остановки видимой до получения `done`, `error` или прерванного `done`.
- `showTyping` не зависит от `sending`: оно управляет индикатором набора до появления сообщения ассистента. Первое событие `reasoning_token`, `stream_token`, `tool_status` или `intermediate` скрывает `showTyping` и переключает интерфейс на временное сообщение ассистента, которым управляет `streamAppenderRef`.

**Soft abort:** при остановке генерации бот не удаляет накопленный контент. Вместо этого:
- Если `res.aborted === true` и есть `res.message_id` — временное сообщение финализируется с реальным ID, всем накопленным контентом (`reasoning_content`, `tool_calls`, `subagents`) и текстом `_⏹ Генерация остановлена пользователем_`.
- Если `message_id === 0` — временное сообщение удаляется (ничего не успело сгенерироваться).
- Затронуто 4 потока: обычная отправка, regenerate, regenerate-with-hint, voice.

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

## Обновления Desktop

Установленные сборки используют `electron-updater` и публичные GitHub Releases репозитория `NikitaCherepov/chatter`.

- Версия Desktop берётся из `desktop-app/package.json`.
- Проверка запускается автоматически после старта приложения.
- Загрузку обновления подтверждает пользователь в существующей модалке.
- Прогресс загрузки приходит от `electron-updater`, установка выполняется через `quitAndInstall()`.
- NSIS-файл `.blockmap` позволяет скачивать только изменившиеся части сборки, когда это возможно.
- Обновления Desktop не связаны с Docker-обновлениями сервера.

Опубликованный релиз должен содержать NSIS-установщик, его `.blockmap` и `latest.yml`. Черновики GitHub Releases установленные клиенты не видят.

## Анонсы и приветственная модалка (Onboarding)

Многослайдовые анонсы для пользователей, которые их ещё не видели. Первый анонс (`welcome_v1`) — это приветственный онбординг после регистрации. Анонсы новых фич добавляются так же — одной записью в реестр.

### Как работает

1. Десктоп хранит все анонсы в [src/renderer/lib/announcements.ts](src/renderer/lib/announcements.ts) — массив `DESKTOP_ANNOUNCEMENTS`.
2. Сервер хранит `seen_announcements: string[]` в `users.ui_settings` (JSON). Сохраняется через `PUT /api/v1/user/ui-settings`.
3. При старте `AnnouncementOverlay` в App.tsx сравнивает `seen_announcements` с локальным реестром. Непросмотренные анонсы показываются один за другим.
4. После нажатия «Понятно» на последнем слайде ID сохраняются на сервер, модалка закрывается.
5. При входе другого пользователя `visible` сбрасывается — он видит свои непросмотренные анонсы.

### Добавление нового анонса

1. **Добавить запись** в `DESKTOP_ANNOUNCEMENTS` в [src/renderer/lib/announcements.ts](src/renderer/lib/announcements.ts):

```ts
{
  id: 'new_feature_v1',          // уникальный ID, сохраняется в seen_announcements
  slides: [
    {
      id: 'intro',               // уникальный в пределах анонса
      titleKey: 'onboarding.newFeature.intro.title',   // ключ i18n, Markdown
      bodyKey: 'onboarding.newFeature.intro.body',     // ключ i18n, Markdown
      image: someImportedImage,  // опционально, import img from '...'
    },
    // ещё слайды...
  ],
},
```

2. **Добавить ключи i18n** в `desktop-app/src/renderer/i18n/locales/{en,ru,...}/translation.json` в секции `onboarding.newFeature.*`. И title, и body поддерживают Markdown, рендерится через `MarkdownRenderer`.

3. Готово. Модалка автоматически покажет новый анонс пользователям, которые его ещё не видели. Сервер менять не нужно.

### Ключевые файлы

| Файл | Роль |
|---|---|
| `src/renderer/lib/announcements.ts` | Типы (`Announcement`, `AnnouncementSlide`), массив-реестр, хелпер `getUnseenAnnouncements()` |
| `src/renderer/components/OnboardingModal.tsx` | Переиспользуемая модалка: навигация по слайдам, `AnimatePresence` переходы, `MarkdownRenderer`, индикатор шагов |
| `src/renderer/App.tsx` → `AnnouncementOverlay` | Проверяет непросмотренные анонсы после auth, показывает модалку, сохраняет seen IDs на сервер |
| `backend-api/src/server.ts` → `VALID_UI_KEYS` | `seen_announcements` — валидируемое поле `string[]` в `users.ui_settings` |

### API компонента

```tsx
<OnboardingModal
  announcements={unseen}       // Announcement[]
  onDone={(seenIds) => {}}     // вызывается по «Понятно» / закрытию, передаёт ID для сохранения
/>
```

- Пропсы: `announcements: Announcement[]`, `onDone: (ids: string[]) => void`
- Анимация: framer-motion `AnimatePresence`, горизонтальный переход слайдов
- Размер: как SettingsModal (70vw × 75vh), все стили из переменных `global.scss`
- Футер: индикатор шагов по центру (absolute), кнопки Назад/Далее по краям (space-between)
