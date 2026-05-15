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
