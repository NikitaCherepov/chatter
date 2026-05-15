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
    │   ├── NotebookTool   # Виджет блокнота
    │   ├── SettingsModal  # Настройки
    │   ├── PromptSelector # Выбор промпта
    │   ├── MarkdownRenderer
    │   ├── AttachModal
    │   └── LinkTelegramModal
    └── lib/
        ├── api.ts     # API + SSE streaming
        ├── auth.tsx   # Auth context
        └── tools.ts   # Tools panel state + desktop_action роутер
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

**Хедер:** назад (fade) | заголовок (fade) | иконка инструментов (всегда видна)

**Внутри:** список инструментов → конкретный инструмент (AnimatePresence slide). Сейчас один инструмент — Блокнот.

**Реестр инструментов:** массив в `buildTools()` внутри ToolsPanel.tsx. Чтобы добавить новый — добавить entry в массив + компонент.

## Блокнот (NotebookTool)

Два состояния:
- **Список** — все заметки + кнопка "Создать" + поиск
- **Редактор** — создание/редактирование одной заметки (title + textarea + save)

API: `GET/POST/DELETE /api/v1/notes`. Обновление = delete + create (нет PUT на бэкенде).

## Desktop Action (bot → UI)

Бот может управлять интерфейсом через tool `desktop_action`. Паттерн как у `set_display_state`:

1. Бэкенд получает `is_desktop: true` в body → добавляет `desktop_action` tool в AI
2. AI вызывает tool → бэкенд отправляет SSE `event: desktop_action`
3. Фронтенд ловит через `onDesktopAction` → `handleDesktopAction()` в `lib/tools.ts`

**Actions:**

| Action | Описание |
|---|---|
| `open_widget` | Открыть виджет (target: `notebook`) |
| `close_widget` | Закрыть виджет |
| `set_widget_data` | Передать данные в виджет (например текст черновика) |
| `open_note` | Открыть конкретную запись по ID (value: `{ note_id }`) |
| `read_widget_state` | Прочитать текущее состояние виджета |
| `toggle_panel` | Открыть/закрыть панель инструментов |

**Widget data dispatch:** `dispatchWidgetData()` ставит команду в очередь если виджет ещё не смонтирован (pending commands). При подписке — очередь дренируется.

## CSS Variables

Все цвета/отступы через CSS-переменные в `global.scss`. Ключевые:
- `--bg-primary/secondary`, `--border-light/medium`, `--text-primary/body/muted/hint`
- `--accent`, `--accent-icon`, `--bg-input`, `--bg-bubble`, `--bg-modal-hover`
