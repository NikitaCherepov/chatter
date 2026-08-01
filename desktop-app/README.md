# chatter desktop-app

[English](README.md) | [Русский](README_RU.md)

Electron + React + Vite desktop client for Chatter.

## Quick Start

```bash
npm install
npm run dev
```

```bash
npm run build
```

## Server Connection and Content Security Policy

The Desktop server-access key, account JWT, and Content Security Policy (CSP) solve different problems:

- The server-access key proves that this Desktop installation may use a particular self-hosted Chatter server.
- The account JWT authenticates the user after login.
- CSP limits what the Electron renderer is technically allowed to load or contact if renderer content is compromised.

The pairing flow is owned by the Electron main process, not by an unrestricted renderer request:

1. The renderer parses the `chatter://` link and sends the server URL and access key through the narrow preload API.
2. The main process accepts only HTTP(S) URLs without embedded credentials, query strings, or fragments.
3. The main process validates the access key through `/api/v1/server-access/validate` with a 15-second timeout.
4. Only the canonical server origin is persisted in Electron's `userData/trusted-server.json`. The access key is not written to that file.
5. The window reloads once when the trusted origin changes. The next main document receives a CSP that allows HTTP and WebSocket traffic only to that origin.

On upgrade, an existing renderer-side connection is validated once and migrated automatically. Clearing or changing the server clears the trusted main-process origin and reloads the renderer.

The packaged CSP permits:

- bundled scripts and styles;
- inline styles required by the current React UI, but not inline scripts or `eval`;
- API, media, images, and WebSocket traffic from the selected Chatter server;
- the fixed Google Fonts hosts and the fixed Carto, ArcGIS, and OpenStreetMap tile hosts;
- local `data:`/`blob:` images, media, fonts, and workers where required.

Frames, plugins/objects, arbitrary base URLs, arbitrary form targets, third-party scripts, and arbitrary network origins are denied. Development-only Vite and localhost sources are added only when the application is not packaged.

Relevant files:

- `src/main/main.ts` — URL normalization, server-key validation, trusted-origin persistence, and CSP header generation.
- `src/main/preload.ts` — narrow `authorizeServer` and `clearTrustedServer` IPC bridge.
- `src/renderer/lib/api.ts` — pairing-link parsing and renderer connection persistence.
- `src/renderer/lib/auth.tsx` — automatic migration of connections created before the CSP implementation.

If an embedded browser is added later, it must use a separate `WebContentsView` and a separate Electron session/partition. Do not render arbitrary websites inside the Chatter renderer or relax the Chatter CSP for them.

## Voice, Whisper, Wake Word

The voice scenario in the desktop app mainly lives in the Electron main process and in the `ChatPage` renderer page.

### Manual Voice Transcription

- The renderer records audio from the microphone via `MediaRecorder` and sends the audio buffer to the main process via the `transcribe-audio` IPC.
- The main process saves the browser audio as a temporary `.webm`, converts it to mono WAV 16 kHz via `fluent-ffmpeg`, and then launches the local `whisper.exe`.
- Whisper resources are expected in `models/` in dev mode and in `resources/models/` in a packaged build:
  - `whisper.exe`
  - `ggml-small.bin`
  - required whisper/ggml DLLs
- The "Voice" settings page lets the user select `auto` (default) or a specific recognition language. A fixed language avoids auto-detection overhead and is recommended for short phrases.
- `ffmpeg-static` must be unpacked from `app.asar`; `package.json` uses `asarUnpack` for this on `node_modules/ffmpeg-static/**/*`.

### Wake Word

Wake word is processed without Python, via `onnxruntime-node` in the Electron main process:

- ONNX runtime: `src/main/wakeword.ts`
- Renderer audio stream: `src/renderer/lib/wakeWordAudio.ts`
- ONNX resources: `wakeword/models/*.onnx`

The renderer maintains a microphone stream via the Web Audio API, resamples via `AudioContext({ sampleRate: 16000 })`, slices PCM into chunks of 1280 samples (80 ms), and sends them to the main process via the `wakeword-audio-chunk` IPC.

The main process replicates the openWakeWord pipeline:

1. `melspectrogram.onnx`
2. `embedding_model.onnx`
3. wake-word models (`alexa`, `hey_jarvis`, `hey_mycroft`, `hey_rhasspy`, `timer`, `weather`)
4. `silero_vad.onnx` for the VAD filter

On detection, the main process builds a payload:

```json
{"type":"wakeword","name":"...","score":0.9,"ts":1710000000}
```

And sends events:

- `wakeword:detected` to the renderer
- `pixel-avatar:state` with `state: "listening"`

After that, the renderer starts `createSpeechRecorder()`, records the user's phrase after the wake word, sends it to `transcribe-audio`, and sends the recognized text to the chat.

### Packaging Notes

`npm run build:win` must include:

- `models/` as `resources/models`
- `wakeword/` as `resources/wakeword`

`onnxruntime-node` must be unpacked from `app.asar`; this is configured via `asarUnpack` in `package.json`.

Legacy Vosk files are not used by wake-word detection and are explicitly excluded from packaged builds. Wake words use the ONNX resources from `wakeword/models/`.

## TTS (Text-to-Speech)

Bot message voiceover — three models, unified state, smooth transitions.

### Models

| Model | Engine | Voices |
|---|---|---|
| **Piper** (default) | Local `piper.exe` via IPC → WAV → Web Audio API | Discovered from installed `.onnx.json` files; the default build uses Ruslan and Irina (ru), HFC Male and HFC Female (en-US) |
| **Built-in (Chromium)** | `window.speechSynthesis` — Windows system voices | All OS voices |
| **Cartesia (cloud)** | Backend proxy → Cartesia.ai API → MP3 → Web Audio API | Voices matching the backend's supported interface languages, loaded from the server |

### Architecture

```
Renderer (tts.ts)          Main (main.ts)          FileSystem / Server
─────────────────          ──────────────          ────────────────────
ttsSpeak(msgId, text, audio)
  │
  ├─ Piper? ──► IPC tts:generate ──► spawn piper.exe ──► models/piper-voices/*/
  │              (text)              -m model.onnx -f out.wav
  │                                  ◄── WAV buffer ──── temp file
  │
  ├─ Cartesia? ► audio.url exists? ──► GET /api/v1/audio/xxx.mp3 ──► playBuffer()
  │              no? ──► POST /api/v1/tts/generate ──► server → Cartesia API
  │                      ◄── { audio_url } ──► GET /api/v1/audio/xxx.mp3 ──► playBuffer()
  │                      (audio is bound to the message, replay — without generation)
  │
  ├─ Builtin? ► SpeechSynthesisUtterance (Chromium API, 0 IPC)
  │
  ▼
AudioManager (Web Audio API)
  Source ► GainNode (fade-in/out) ► Destination
```

### Key Files

- `lib/tts.ts` — unified TTS service: models, voices, state subscriptions, `generationTicket` for cancellation
- `lib/audioManager.ts` — Web Audio API player: `playBuffer()` with 40ms fade-in / 15ms fade-out before end of buffer, `stopWithFade()` 150ms
- `ChatPage.tsx` — play/stop button in each message's metaRow
- `SettingsModal.tsx` — "Voice" tab: recognition language, synthesis model, voice, volume, preview

### Playback Control

- **Unified state** — `ttsSubscribe(fn)` → only one message plays at a time
- **Generation ticket** — `ttsStop()` invalidates in-flight IPC requests, buffer is discarded
- **Settings** — model + voice + volume (0–1) in `localStorage` (`chatter_tts_settings`)

### Piper Resources

Dev: `models/piper/piper.exe` + `models/piper-voices/<voice>/*.onnx`
Packaged: `resources/models/piper/` + `resources/models/piper-voices/`

Install the default Russian and English voice models before building:

```powershell
npm run voices:download
```

Piper voices are discovered dynamically from their `.onnx.json` metadata. The default packaged build includes Ruslan and Irina for Russian plus HFC Male and HFC Female for English; the legacy Denis and Dmitri models are excluded to keep its size down.

## Architecture

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
    │   └── ChatPage   # Main screen
    ├── components/
    │   ├── PixelAvatar/   # Pixel avatar (canvas)
    │   ├── ToolsPanel     # Right tools panel
    │   ├── FloatingWidget # Wrapper for floating/fullscreen modes
    │   ├── NotebookTool   # Notebook widget
    │   ├── TasksTool      # Tasks viewer
    │   ├── MapTool        # Map (Leaflet + react-leaflet)
    │   ├── DocumentsTool  # Chat documents (attachments)
    │   ├── GalleryTool    # Photo gallery from chat
    │   ├── RadioGroup     # Reusable radio selector
    │   ├── SettingsModal  # Settings (account, linked accounts, prompt, voice, limits, app, macros, servers, runbooks, smart home)
    │   ├── MacroSettings  # Macro management (CRUD + AI explain/describe)
    │   ├── ServerSettings # DevOps SSH server management (CRUD + policies + runbook attachment)
    │   ├── RunbookSettings # DevOps runbook management (CRUD + AI extraction/review)
    │   ├── SmartHomeSettings # Smart home management (Yandex token, device sync)
    │   ├── Select         # Universal select component
    │   ├── PromptSelector # Prompt selector
    │   ├── MarkdownRenderer
    │   ├── AttachModal
    │   └── LinkTelegramModal
    └── lib/
        ├── api.ts         # API + WebSocket streaming (SSE fallback)
        ├── auth.tsx       # Auth context + WS lifecycle
        ├── tts.ts         # TTS service (Piper + Chromium SpeechSynthesis + Cartesia)
        ├── audioManager.ts # Web Audio API player with fade-in/out
        └── tools.ts       # Tools panel state + desktop_action router
```

## Layout

```
┌─────────────────────────────────────────────────┐
│  Sidebar (260px)  │  Main chat  │  ToolsPanel   │
│  chats/burger     │  [top bar]  │  tools        │
│  collapsed: 65px  │  messages   │  collapsed:65 │
│                   │             │  default: 65  │
└─────────────────────────────────────────────────┘
```

Top bar — a compact strip above `.messages` with a model selector (only appears if the server has `MODELS_MANUAL` set). The model is stored on the server (`preferred_model`), synced between desktop and Telegram.

In the dropdown next to models that support vision, a `[Vision]` badge is displayed (in green). Badges are implemented through a generic mechanism in `Select` — the `badge?: { text, color?, icon? }` field on `SelectOption`. Colors are limited: `success | error | info | warning`, each taken from a CSS variable (`--color-success`, etc.). If `icon` is not provided — `[text]` is rendered.

Both sidebars work identically: `motion.aside` with width animation, always in the DOM. Collapsing does not reset internal state.

## Linked Accounts

The Settings modal has a dedicated **Linked accounts** tab. Telegram is currently the only external identity exposed by the UI.

The backend model is one canonical account with multiple login identities:

```text
canonical account
├── password identity (Desktop login)
└── Telegram identity (Telegram user ID)
```

The Desktop client never treats the Telegram ID as a second data owner. Chats, images, prompts, settings, limits, counters, and memory belong to the canonical backend account and are shared by every attached identity.

### Linking flow

1. The user opens Settings → Linked accounts → Telegram.
2. Desktop requests a six-digit one-time code. The code is valid for 10 minutes.
3. The user sends `/link` to the Telegram bot and enters the code.
4. The backend merges the existing Desktop and Telegram accounts into one canonical account.
5. Desktop refreshes `/api/v1/auth/me` and `/api/v1/link/status`, then reconnects WebSocket under the resolved account.

The modal warns about the merge before showing the code. Existing data from both sides is preserved; Desktop personal settings take priority where the backend has to resolve a settings conflict.

### Unlinking flow

Unlinking is available only when the account has both Telegram and password login identities. The confirmation modal asks which side keeps the shared data:

- **Desktop keeps data:** the password identity remains on the current data account; Telegram is moved to a new empty account.
- **Telegram keeps data:** Telegram remains on the current data account; the password identity is moved to a new empty Desktop account.

The operation does not delete or split individual chats, images, prompts, settings, files, counters, or vector memory. All existing data stays together on the selected side.

The backend revokes pre-split JWTs and returns fresh Desktop access/refresh tokens. Desktop stores them, updates the cached user, reloads account-dependent state, and reconnects WebSocket. If Telegram was selected as data owner, the Desktop client therefore continues in the newly created empty Desktop account.

The Telegram bot exposes the same split through `/unlink`: it asks which side keeps the data and calls the backend with the same `data_owner` value.

Relevant client code:

- `src/renderer/components/SettingsModal.tsx` — linked-account card, owner selection, token/user replacement, WebSocket reconnect.
- `src/renderer/components/LinkTelegramModal.tsx` — code generation, countdown, polling, and merge warning.
- `src/renderer/lib/api.ts` — `/api/v1/link/status`, `/generate`, and `/unlink` API types and calls.
- `src/renderer/assets/integrations/telegram.webp` — bundled Telegram integration icon.

## Tools Panel (ToolsPanel)

Right sidebar. Collapsed by default (65px) — only a wrench icon is visible.

### Layout Modes

Each tool can be in one of three states (`LayoutMode`):

| Mode | Description |
|---|---|
| `sidebar` | Rendered in the right column (flex), shifts the main chat. Default. |
| `fullscreen` | Rendered over the entire interface (`position: fixed, inset: 0, z-index: 100`). |
| `floating` | Free-floating window over the chat (`position: fixed, z-index: 50`). Draggable by the header via `@dnd-kit/core` + `restrictToWindowEdges`. |

**Controls:**
- In sidebar mode, buttons appear next to the tool title (floating / fullscreen)
- In floating/fullscreen mode, the window header has buttons: "to sidebar", "fullscreen"/"floating", "close"
- If a tool is in floating/fullscreen — it is hidden from the sidebar tools list
- Clicking the wrench icon returns from floating/fullscreen to sidebar

**Architecture:**
- Layout state is stored in `lib/tools.ts` — `getToolLayout()` / `setToolLayout()` / `subscribeToolLayout()`
- `FloatingWidget` component — wrapper with `useDraggable` for floating mode
- `DndContext` + `restrictToWindowEdges` at the `ToolsPanel` level
- Floating window coordinates are updated in `onDragEnd` via `delta.x/y`

**Header:** back (fade) | title (fade) | tools icon (always visible)

**Inside:** tools list → specific tool (AnimatePresence slide).

**Tool registry:** array in `buildTools()` inside ToolsPanel.tsx. To add a new one — add an entry to the array + a component.

### Multi-Window

Tools are stored in an `openTools[]` array (not a single `activeToolId`). Multiple tools can be open simultaneously — each in its own floating/fullscreen window. The sidebar displays the first tool in sidebar mode.

Management: `openTool(id)` / `closeTool(id)` from `lib/tools.ts`.

## Notebook (NotebookTool)

Two states:
- **List** — all notes + "Create" button + search
- **Editor** — create/edit a single note (title + textarea + save)

API: `GET/POST/DELETE /api/v1/notes`. Update = delete + create (no PUT on the backend).

## Tasks (TasksTool)

Read-only task viewer with status filters (pending/done/all). Each card shows status, type (`message`, `smart_home`, `ai_instruction`), date, payload preview, recurrence badge. Delete button (appears on hover).

API: `GET /api/v1/tasks?status=&limit=`, `DELETE /api/v1/tasks/:id`.

The bot can open tasks via `desktop_action` with `action: open_widget, target: tasks`.

### Scheduler task_result (server push)

When the scheduler executes a task, the result is pushed to the desktop via WS `{ type: 'task_result', chat_id, text, is_new_chat }`. Handled in `ChatPage.tsx`:

- If the chat is open — messages are reloaded from the DB
- If a different chat — the unread badge is incremented via the `useUnreadChats` hook
- On `is_new_chat: true` — the chat list in the sidebar is refreshed

### useUnreadChats hook

`lib/useUnreadChats.ts` — reusable hook for tracking unread messages per chat:
- `incrementUnread(chatId)` — add an unread
- `markAsRead(chatId)` — clear on chat open
- `getUnread(chatId)` — get the counter
- `totalUnread` — total unread

The badge (`.unreadBadge`) is rendered in the sidebar next to the chat name.

## Map (MapTool)

Leaflet map with three layers (light/satellite/standard), controlled via a custom `RadioGroup` component. Layer selection is saved in `localStorage`.

**Features:**
- Bot shows places on the map (`map_control` → `show_place`) via Nominatim geocoding
- Bot draws routes (`draw_route`) via OSRM — blue polyline
- Bot searches public transit routes (`find_transit_route`) via Overpass API — green polyline + orange stop markers
- Bot searches nearby establishments and objects (`search_nearby`) via Overpass API — purple POI markers (restaurants, pharmacies, shops, etc.)
- SSE event `map_update` delivers data to the client (four action types: `show_place`, `draw_route`, `transit_route`, `poi_search`)
- User places custom pins (pin placement mode) — saved on the backend (encrypted coordinates)
- Drag & drop to move pins
- Bot can read user pins via the `get_map_pins` tool
- `ResizeHandler` calls `invalidateSize()` on layout change (sidebar ↔ floating)

**`map_update` payload types:**

| Action | Fields | Rendering |
|---|---|---|
| `show_place` | `lat, lng, label` | Single marker + `flyTo` |
| `draw_route` | `from, to, route` | Two markers + blue Polyline + `fitBounds` |
| `transit_route` | `routeName, path, stops` | Green Polyline (segment between pickup/dropoff) + orange stop markers + `fitBounds` |
| `poi_search` | `places[], query` | Purple POI markers (name, address, hours) + `flyTo` the first |

**Pins API:** `GET/POST/PUT/DELETE /api/v1/map-pins[/:id]`. Coordinates are encrypted on the backend via `MAP_PINS_ENCRYPTION_KEY`.

## Documents (DocumentsTool)

A right-panel tool for viewing and managing attached documents in a chat. A mirror of the photo "Gallery".

### Attaching Files

- The paperclip button to the left of the input field opens a unified `AttachModal` for photos and documents.
- Drag-and-drop or file selection via dialog.
- Photos: PNG, JPEG, WebP (up to 20 MB). Quantity limit depends on the plan.
- Documents: txt, md, json, csv, log, xml, yaml, ini, toml, code (py, js, ts, go, rs, java, c, cpp, cs, php, sh, sql, html, css, etc.), **docx**, **pdf**, rtf (up to 5 MB).
- Photo previews and document list are displayed above the input field.
- On send, files are transmitted to the server as base64; the server parses the text and saves the file.

### DocumentsTool (ToolsPanel)

`DocumentsTool.tsx` — list of all documents in the current chat:
- Loaded via `GET /api/v1/chats/:chatId/attachments`.
- Each item: file icon, name, size, date.
- Download button (via `resolveImageUrl(item.url)` for auth-token).
- Delete button with confirmation → `DELETE /api/v1/chats/:chatId/messages/:messageId/attachments/:filename`.

### Display in Messages

- User messages with attachments show a file list with icon, name, size, and download button.
- Download uses `resolveImageUrl(att.url)` to inject the JWT token.

### Token Limit Settings

"Limits" tab in SettingsModal — chat context and document token limit sliders:
- `0` = Auto (90% of `max_context_tokens`).
- Manual input from 1000 to `max_context_tokens` tokens.
- Saved via `PUT /api/v1/user/attachment-tokens-limit`.

### Key Files

| File | Role |
|---|---|
| `components/DocumentsTool.tsx` | ToolsPanel component: document list, delete, download |
| `components/AttachModal.tsx` | Unified photo + document attachment modal: drag-drop, preview, validation |
| `pages/ChatPage.tsx` | Paperclip button, previews, attachment rendering in messages |
| `components/SettingsModal.tsx` | Document token limit slider |
| `lib/api.ts` | Types `MessageAttachment`, `ChatAttachmentItem`, `AttachmentTokenLimit` + API functions |

## RadioGroup

Reusable component (`components/RadioGroup.tsx`) — a trigger button that expands a list of radio buttons on click. Styling is identical to other map controls (`#e8f0fe` / `#1a73e8`, 30x30px, `border-radius: 8px`). Accepts `options`, `value`, `onChange`, optionally `icon`.

## Desktop Action (bot → UI)

The bot can control the interface via the `desktop_action` tool. Same pattern as `set_display_state`:

1. Backend receives `is_desktop: true` in the body → adds the `desktop_action` tool to the AI
2. AI calls the tool → backend sends a WS `desktop_action` (or SSE fallback)
3. Frontend catches it via `onDesktopAction` → `handleDesktopAction()` in `lib/tools.ts`

**Actions:**

| Action | Description |
|---|---|
| `open_widget` | Open a widget (target: `notebook`, `tasks`) |
| `close_widget` | Close a widget |
| `set_widget_data` | Pass data to a widget (e.g. draft text) |
| `open_note` | Open a specific note by ID (value: `{ note_id }`) |
| `read_widget_state` | Read the current widget state |
| `toggle_panel` | Open/close the tools panel |
| `execute_macro` | Execute a macro — commands arrive in `value.commands` from the SSE payload. If `target === '__explore_fs__'` — directory read via `readDirectory` IPC |
| `suggest_macro` | Suggest a macro — renders a "Save/Reject" card in ChatPage |
| `devops_confirmation` | SSH command confirmation — card with "Allow"/"Always allow"/"? Check"/"Reject" buttons |
| `pc_command_confirmation` | `execute_pc_command` confirmation — PC command card. `ChatPage` handles it through the shared `handleIncomingDesktopAction` in all `streamChatMessage` flows: normal send, regenerate, and regenerate-with-hint. |
| `file_action_confirmation` | `read_file` (when `file_read_enabled=false`) or `write_file` (always) confirmation. Card shows path, mode (overwrite/append), size, and content preview. "Write"/"Read" and "Reject" buttons. TG bot renders via inline buttons `fileconfirm:allow`/`fileconfirm:reject`. |
| `edit_file_lines_confirmation` | `edit_file_lines` (always) confirmation. Card shows path, line range, and a **diff preview**: red "Removed" block (old lines) + green "Added" block (new lines). TG bot renders a similar diff via inline buttons `fileconfirm:allow`/`fileconfirm:reject`. |
| `email_confirmation` | `send_email` confirmation — card with From, To, Subject, and Body preview (via MarkdownRenderer). "Send" / "Reject" buttons. Deduplication by `confirmation_id`. |
| `suggest_devops_runbook` | Runbook suggestion — card with "Save"/"Check"/"Reject" buttons |
| `suggest_chat_link` | Inline card suggesting to open a found chat (value: `{ chat_id, title }`). Rendered like `suggest_macro` — stays until user clicks "Open chat" or "Reject". Used by AI after `search_chat_history` to let the user jump to a found conversation. |

Reject UX: desktop confirmation cards use a shared `RejectWithComment`; clicking reject opens a short textarea. The comment is sent as `rejection_comment`, and the backend returns it to the AI as `user_comment` in the rejected tool result.

## Macros

User-defined sets of console commands that the AI can run on the desktop. Stored on the server (SQLite), not in localStorage.

### Components

- **MacroSettings** (`components/MacroSettings.tsx`) — macro management UI in the "Macros" settings tab
  - Macro list with checkboxes (enabled, pinned)
  - Buttons: edit, execute, AI-explain, AI-describe, delete
  - Create/edit form: title, description, commands (dynamic list), enabled/pinned checkboxes
  - AI assistants: explain (what the commands do) and describe (suggest title/description) via `/api/v1/macro/explain` and `/api/v1/macro/describe`
- **ChatPage** — `suggest_macro` card (`pendingMacros` array, multiple can be present simultaneously)
  - "Save" button → POST `/api/v1/macros`
  - "Reject" button → removes from array

### IPC Handlers

| IPC | Description |
|---|---|
| `execute-commands` | Sequentially executes an array of commands via `child_process.exec` (30s timeout, 1MB buffer). Blocks dangerous commands (`rm -rf /`, `format`, `shutdown`, etc.). Returns combined stdout/stderr. Logs batch/cmd start/done/error for diagnosing hung commands. On Windows, commands are wrapped in PowerShell with UTF-8 I/O for correct Cyrillic (see below). |
| `read-directory` | Read directory contents (read-only). Returns `{ name, isDirectory, size, modifiedAt }[]`. |
| `read-file` | Native file reading via `fs.createReadStream` + `readline` (UTF-8, with pagination). Parameters: `{ file_path, start_line?, max_lines?, line_numbers? }`. Returns `{ content, start_line, read_lines, total_lines, encoding, line_numbers }`. With `line_numbers=true`, each line has a `     N\t` prefix (`cat -n` format). Does not load the entire file into memory — line-by-line reading. **For `.docx`** uses `mammoth.extractRawText()` — extracts plain text, then applies the same pagination. |
| `write-file` | Native file writing via `fs.promises.writeFile`/`appendFile` (UTF-8). Parameters: `{ file_path, content, mode? }`. Creates parent directories if missing. Returns `{ ok, bytes_written, mode }`. **For `.docx`** generates a valid Word document via the `docx` package (each text line = paragraph). `append` mode for `.docx` is forbidden — returns an error. |
| `edit-file-lines` | Surgical line replacement via `Array.splice`. Parameters: `{ file_path, start_line, end_line, new_content }`. Reads file → splits into lines → cuts `start_line..end_line` → inserts `new_content` → writes back. Supports insert without removal (`end_line = start_line - 1`) and deletion (`new_content = ""`). Returns `{ ok, lines_removed, lines_added, total_lines_before, total_lines_after }`. Does not support `.docx`. |
| `capture-screen` | Capture screenshots of all monitors via `desktopCapturer.getSources()`. Returns `{ displays: [{ display_id, name, bounds, screenshot_base64 }] }`. Used by the `capture_screen` tool for visual control. |
| `visual-click` | Mouse click at normalized coordinates (0.0–1.0). Uses `@nut-tree-fork/nut-js` to move the cursor and click. Converts normalized coordinates to global via `display.bounds`. Supports multi-monitor (including monitors with negative coordinates). |

**Background mode for execute-commands:** `electronAPI.executeCommands(commands, { background: true })` is used by the `execute_pc_command` tool for GUI/open commands where stdout is not needed. In this mode, the main process launches a detached process via `spawn(..., { shell: true, stdio: 'ignore', windowsHide: true })` and `child.unref()`, then immediately returns `[background] launched: ...`. Regular commands still use `exec()` and wait for stdout/stderr.

### Windows Command Encoding (fix for garbled output)

`execute-commands` on Windows wraps each command in a PowerShell wrapper with UTF-8 I/O so Cyrillic in stdout doesn't turn into garbage (`�ਢ��`).

**Problem:** `child_process.exec` on Windows runs `cmd.exe /d /s /c "..."`. Cmd receives arguments in the system ANSI code page (cp1251 in the Russian locale) **before** executing `chcp`, so `chcp 65001 && echo Привет` doesn't help — by the time the code page switches, the command is already corrupted.

**Solution — double Base64** (`src/main/main.ts`, `execute-commands` handler):

1. The original command is encoded to Base64 (UTF-16LE for .NET): `Buffer.from(cmd, 'utf16le').toString('base64')`.
2. A PowerShell script decodes it via `[Text.Encoding]::Unicode.GetString(...)` and executes it through `cmd.exe /c $decCmd` — this preserves cmd semantics (`&&`, `|`, `>`, `echo`, `ver`, builtin commands).
3. UTF-8 is forced in PS: `$OutputEncoding` and `[Console]::OutputEncoding`.
4. The entire PS script is packed into a second Base64 (UTF-16LE) and passed via `powershell -NoProfile -EncodedCommand`.

On Linux/macOS the wrapper is not applied — `execCmd = cmd` as-is.

### Visual Control (remote control via screenshots)

Allows the AI to control the user's mouse via Telegram. Two tools work together:

**Pipeline:**
```
AI: capture_screen({ purpose: "Find the Save button" })
  → Backend: sendIpcToDesktop('capture_screen') → desktopCapturer
  → Backend: sharp (compress to 1280px, JPEG) → save to chat
  → Backend: runCompletion('vision-pro') with screenshot + purpose
  → Vision model returns coordinates (0.0–1.0)
  → AI gets a text response (no image in context)

AI: execute_visual_click({ display_id, x: 0.63, y: 0.42 })
  → Backend: fresh screenshot → sharp draws a red crosshair (SVG composite)
  → SSE → TG: photo with crosshair + "Click" / "Reject" buttons
  → User confirms → sendIpcToDesktop('visual_click')
  → Desktop: nut.js mouse.setPosition() + leftClick/rightClick
```

**Security:**
- Every click requires confirmation (HitL) — 60 second TTL
- One click per confirmation (no series)
- Screenshot with crosshair is sent to Telegram — the user sees the click point
- Tools are disabled via feature flags `disable_pc_commands` and `disable_pc_control_full`

### Execution Flows

**Regular macro (fire-and-forget):**
```
AI: execute_macro(macro_id)
  → Backend: finds macro in DB, builds WS/SSE payload
  → WS/SSE: desktop_action { action: 'execute_macro', value: { commands } }
  → api.ts onmessage: electronAPI.executeCommands(commands) + callback to React
  → main.ts: exec() for each command
```

**Macro from Telegram (TG→Desktop push):**
```
TG user: "Run macro X"
  → Backend /internal/ai/send → sendMessageThroughAi (with activeMacros)
  → AI: execute_macro → desktopActionSink.value = payload
  → result.desktop_action returned to server.ts
  → server.ts: isDesktopOnline(userId) → WS push { type: 'desktop_action', action: 'execute_macro', value: { commands } }
  → api.ts onmessage: electronAPI.executeCommands(commands)
  → main.ts: exec() for each command
```
Requirement: the canonical account must have both Telegram and password identities, and its Desktop client must be connected through WebSocket. If Desktop is not connected, the macro will not execute (fire-and-forget without a recipient).

**Macro with return_output (via WS):**
```
AI: execute_macro(macro_id) — return_output: true
  → Backend: sendIpcToDesktop('execute_commands', { commands })
  → WS: execute_ipc { request_id, ipc_type: 'execute_commands', payload }
  → IPC executeCommands(commands) → stdout
  → WS: ipc_result { request_id, data: stdout }
  → Backend resolves Promise → AI gets stdout as tool response
```

**Directory listing (explore_fs, via WS):**
```
AI: explore_fs(target_path)
  → Backend: sendIpcToDesktop('read_directory', { target_path })
  → WS: execute_ipc { request_id, ipc_type: 'read_directory', payload }
  → IPC readDirectory(target_path) → entries[]
  → WS: ipc_result { request_id, data: entries }
  → Backend resolves Promise → AI gets listing as tool response
```

**File metadata (get_file_info, via WS):**

```text
AI: get_file_info(file_path, include_line_count?)
    Backend: sendIpcToDesktop('get_file_info', { file_path, include_line_count })
    → Desktop: get-file-info IPC → fs.statSync()
    → AI gets exists/type/size_bytes/timestamps/name/extension.
      If include_line_count=true and it's a file, desktop additionally counts line_count via streaming.
```

**File keyword search (search_file_keywords, via WS):**

```text
AI: search_file_keywords(file_path, query, max_matches?)
    Backend: sendIpcToDesktop('search_file_keywords', { file_path, query, max_matches })
    → Desktop: search-file-keywords IPC → readline/mammoth
    → AI gets only matching lines with line numbers.
```

**File reading (read_file, via WS):**
```
AI: read_file(file_path, start_line?, max_lines?)
  → If file_read_enabled=true:
    Backend: sendIpcToDesktop('read_file', { file_path, start_line, max_lines })
    → WS: execute_ipc → IPC readFile() → { content, start_line, read_lines, total_lines }
    → AI gets content as tool response
  → If file_read_enabled=false:
    HitL card file_action_confirmation → user confirms →
    then the same IPC flow via /api/v1/pc-commands/approve
```

**File writing (write_file, via WS, always HitL):**
```
AI: write_file(file_path, content, mode?)
  → Backend: registers pending in pc-command-confirmations (kind: 'file_action')
  → Desktop action: file_action_confirmation { confirmation_id, action_type: 'write', file_path, mode, size_bytes, content_preview }
  → Card in ChatPage / inline buttons in TG
  → User confirms → POST /api/v1/pc-commands/approve
  → Backend: sendIpcToDesktop('write_file', { file_path, content, mode })
  → IPC writeFile() → { ok, bytes_written, mode }
  → AI gets result as tool response
```

### Macro Suggestion

```
AI: suggest_macro(title, description, commands)
  → WS/SSE: desktop_action { action: 'suggest_macro', value: { title, description, commands } }
  → ChatPage: setPendingMacros(prev => [...prev, newMacro])
  → Renders card with "Save"/"Reject" buttons
  → Save: POST /api/v1/macros → DB
```

**Widget data dispatch:** `dispatchWidgetData()` queues a command if the widget is not yet mounted (pending commands). On subscription — the queue is drained.

## DevOps Agent Runtime

A system for remote SSH command execution on servers via AI with user confirmation (Human-in-the-Loop).

### Server Settings (SettingsModal → "Servers")

`ServerSettings.tsx` — SSH server management:
- Form: name, host, port, username, password, private key, sudo password (optional)
- Connection test button
- Server list with indicators (password, key, sudo)
- Auto-approve policies for each server (regex patterns)
- "Attach runbook" buttons for each server

### Runbooks (SettingsModal → "Runbooks")

`RunbookSettings.tsx` — runbook management:
- Form: name, markdown content, array of shell commands
- "Extract commands from text" button — AI (LITE) automatically finds shell commands in text
- "?" button — AI reviews each command's safety (modal with MarkdownRenderer)
- Runbook list with edit/review/delete buttons

### Chat Cards (ChatPage)

**Command confirmation (`devops_confirmation`):**
Appears when the AI wants to execute an SSH command that doesn't match an auto-approve policy.
- Shows: server name, host, command
- Buttons: "Allow", "Always allow" (creates an exact-match policy), "? Check" (LITE AI analyzes safety), "Reject"
- AI verdict is rendered via MarkdownRenderer right on the card

**Runbook suggestion (`suggest_devops_runbook`):**
Appears when the AI suggests saving a runbook.
- Shows: name, command list
- Buttons: "Save" (POST runbook), "Check" (LITE AI safety review), "Reject"
- Verdict rendered via MarkdownRenderer

### Data Flow

```
AI: execute_ssh_command(server_id, command)
  → Backend: auto-approve? → Yes: execute immediately
  → No: WS push { action: 'devops_confirmation', ... }
    → ChatPage: confirmation card
    → User: Allow / Reject
    → Backend: POST /api/v1/devops/approve
    → SSH executor: execute command → stdout/stderr/exitCode → AI
```

### DevOps: current cards and passwords

Desktop receives DevOps actions through WS `desktop_action` and renders them in `ChatPage.tsx`.

**`devops_confirmation`**
- Used for SSH commands, `create_server_user`, and `change_server_user_password`.
- Shows server name, host, and a safe command preview.
- If backend sends `needs_sudo_password=true`, the card shows a `Sudo password` input and a checkbox to save it into server `sudo_password`.
- If backend sends `needs_new_password=true`, the card shows a `New password` input. This is the Linux user's new password for `change_server_user_password`; the bot does not see it, and the preview stays `password=***`.
- Buttons: allow, allow always, review, reject. `allow always` creates an auto-approve policy for the exact command preview and then confirms the current operation.
- Confirmation is sent to `POST /api/v1/devops/approve` with `{ confirmation_id, approved, sudo_password?, save_sudo_password?, new_password? }`.

**`suggest_server_creds_update`**
- Used when the bot proposes changing server credentials after creating a user or installing an SSH key.
- Supports `new_username`, `use_ssh_key_for_login` / `use_ssh_key`, `remove_password`.
- If `confirmation_id` is present, the card confirms through `/api/v1/devops/approve`, so the backend tool call waits for the user and continues the same AI flow.
- If `use_ssh_key_for_login=true`, backend logs in with the server default SSH key. If the key does not work, password fallback is not attempted.

**Server settings**
- `password` — the normal SSH login password.
- `sudo_password` — used for `sudo -S` and as the password source for `create_server_user` when saved.
- `default_ssh_key_id` — the key used for installation and optional key login.
- `use_ssh_key_for_login` — the explicit login-mode checkbox: password login or key login.

## Smart Home

"Smart Home" tab in SettingsModal — manage smart home devices via Yandex Smart Home.

`SmartHomeSettings.tsx` — management UI:
- Yandex OAuth token input field (encrypted on the server via `ENCRYPTION_KEY`)
- Sync button — loads the current list of devices and groups from Yandex
- Device list: name, room, "group" badge, capabilities, type

**Setup:**
1. Get a debug OAuth token at `oauth.yandex.ru` (scope: "Yandex Smart Home API")
2. Paste the token in the "Smart Home" tab → "Save"
3. Click "Sync" — devices will appear in the list
4. After that, the AI can control devices: `get_smart_devices()` → `control_smart_home({ device_id, action })`

**Files:**

| File | Purpose |
|---|---|
| `components/SmartHomeSettings.tsx` | Settings tab: token, sync, device list |
| `lib/api.ts` | Types `SmartDeviceDto`, `SmartHomeSettingsDto` + API functions |

Backend architecture details: [backend-api/README.md → Smart Home](../backend-api/README.md#smart-home).

## Feature Flags (tool restrictions)

"Restrictions" tab in SettingsModal allows the user to selectively disable AI tools. Flags are stored on the server (`users.feature_flags`, JSON), synced between desktop and Telegram.

### UI

`SettingsModal.tsx` → `restrictions` tab → 6 checkboxes. Each checkbox is an instant save via `api.setFeatureFlags()` with optimistic update and rollback on error.

### Key Files

| File | Role |
|---|---|
| `lib/api.ts` | Type `FeatureFlags` + `getFeatureFlags()` / `setFeatureFlags()` |
| `components/SettingsModal.tsx` | `restrictions` tab: state, loading, 6 checkboxes with descriptions |

### Flags

| Key | Name | Disables |
|---|---|---|
| `disable_memory_write` | Disable data writing | `save_to_cold_memory`, `delete_from_cold_memory`, `save_note`, `delete_note`. Hot memory (`update_core_memory`) remains available |
| `disable_pc_control_lite` | Limited mode | SSH, macros, email sending, tasks, servers, runbooks. Smart home, maps, email reading, widgets, file system remain |
| `disable_pc_commands` | No PC commands | Only `execute_pc_command`. SSH, macros, file system remain |
| `disable_pc_control_full` | Full lockdown | Everything from lite + PC commands + smart home, email, maps, widgets, file system |
| `disable_internet` | No internet & generation | `search_web`, `read_webpage`, `generate_image` |
| `disable_personal` | Guest mode | Prompt, hot/cold memory, notes, tasks. AI communicates from a clean slate |
| `disable_specialized_subagents` | No specialized subagents | `invoke_subagent` |
| `disable_adhoc_subagents` | No subagent creation | `spawn_subagent` |

### How to add a new flag

1. Add the key to `VALID_FLAG_KEYS` in `backend-api/src/server.ts`
2. Add the field to the `FeatureFlags` type in `desktop-app/src/renderer/lib/api.ts`
3. Add tools to `disabledToolSet` in `backend-api/src/services/ai.ts`
4. Add a checkbox in `SettingsModal.tsx` (state default + render)

### How to add a new tool under existing flags

Add `disabledToolSet.add('tool_name')` to the corresponding flag block in `ai.ts` (section `Feature flags → disabled tools`). Filtering will apply automatically.

## Dice Roll Mode (d20 Roleplay)

A "dice" mode for roleplay fun. Enabled via the "Dice Roll Mode (d20)" checkbox in the "Application" settings tab. Stored in `users.ui_settings.dice_roll_enabled` (boolean, default `false`), synced between desktop and Telegram.

### How It Works

1. On message send (or regenerate), the desktop **immediately** starts a dice-circle animation.
2. The backend rolls a d20 (`1..20`) before the LLM request and instantly pushes the result as a separate `dice_roll` event (WS: `{ type: 'dice_roll', roll }`, SSE: `event: dice_roll`).
3. Desktop catches `onDiceRoll` → **immediately** stops the animation on the value and colors the circle based on the result.
4. The AI response itself arrives later in `done` — by then the dice has long stopped. In `done`, the `dice_roll` field is duplicated as a fallback.
5. The result is saved in `sessionStorage` (`chatter_dice_roll`) and persists until the next roll. Restored on page reload.

### Result Colors

| Roll | Color | Meaning |
|---|---|---|
| 1 | red (`#e53935`) + glow | Critical failure |
| 2–10 | orange (`#ff9800`) | Failure |
| 11–19 | green (`#4caf50`) | Success |
| 20 | yellow (`#ffc107`) + glow | Critical success |

### UI

A 30x30px circle (`border-radius: 50%`) to the left of the attachments icon (outside the `inputArea` block, rendered only if `diceRollEnabled`). States:
- `idle` — emoji
- `rolling` — `diceSpin` animation (fast random numbers 1..20, gradually slowing down, ~1.2s total duration)
- `success` / `crit` / `fail` / `crit_fail` — fixed number with color

### Roll Animation

Implemented via a `setTimeout`-chain in `startDiceRollAnimation()`. The tick interval grows from 50ms to 220ms toward the end (`50 + progress² · 170`), each tick shows `Math.floor(Math.random() * 20) + 1`. Total duration ~1.2s, but the **animation can be stopped early** if the `dice_roll` event arrives faster (which is what happens — the server sends the result instantly).

### Forced Modes (dice mode)

Clicking the dice circle toggles the roll mode (cycle: `normal → always_one → always_twenty → normal`). The mode is stored **locally** in `localStorage` (`chatter_dice_mode`), not synced with the server.

| Mode | What it does | Visual (before roll) |
|---|---|---|
| `normal` | Normal random d20 roll | 🎲 emoji, gray border |
| `always_one` | Server always returns 1 (critical fail) | "1", red dashed border |
| `always_twenty` | Server always returns 20 (critical success) | "20", yellow dashed border |

In forced modes, the circle shows "1" or "20" with a dashed border (to distinguish from a real roll). On message send, the mode is passed in the body as `dice_mode`; the server via `resolveDiceForceValue()` returns `diceRollForceValue: 1 | 20` in `sendMessageThroughAi`, and the roll is forced instead of random.

### Bot Prompt

The backend appends a hint with the roll result to the final user message so the stable system prompt remains cacheable. The roll noticeably affects the narrative outcome, consequences, and tone, but **does not** alter real tool results or block tool calls — even on roll=1, if `execute_ssh_command` is needed, the bot will execute it normally.

### Key Files

| File | Role |
|---|---|
| `pages/ChatPage.tsx` | Dice state (`diceRolling`, `diceValue`, `diceStatus`), `startDiceRollAnimation`, `finishDiceRoll`, circle rendering |
| `pages/ChatPage.module.scss` | `.diceRoll` + states (`.diceRolling`, `.diceRollCrit`, `.diceRollSuccess`, `.diceRollFail`, `.diceRollCritFail`) + `@keyframes diceSpin` |
| `lib/api.ts` | `onDiceRoll` in `StreamCallbacks`, handling WS `type: 'dice_roll'` and SSE `event: dice_roll` |
| `components/SettingsModal.tsx` | Checkbox in `app` tab, `handleToggleDiceRoll` |
| `backend-api/src/services/ai.ts` | `buildDiceRollPrompt()`, roll in `sendMessageThroughAi`, `onDiceRoll` callback |
| `backend-api/src/server.ts` | `diceRollMode` propagation in 3 points (SSE/WS/TG), sending `dice_roll` event |

## Model Settings

"Models" tab in SettingsModal allows configuring generation parameters (temperature, penalties, top_p, top_k, max_tokens) for each custom model from `MODELS_MANUAL`. Settings are stored on the server (`users.model_settings`, JSON map by `model_id`), applied only for manual models (not for PRO/LITE auto-routing).

### UI

`SettingsModal.tsx` → `models` tab:
- Loads the model catalog (`GET /api/v1/models`) + saved settings (`GET /api/v1/user/model-settings`) when opening the tab
- For each model — an expandable block with parameter sliders
- The parameter list is filtered by the model's `supported_params` (depends on the provider)
- Each parameter has an "auto" checkbox — if enabled, the parameter is not sent (server default is used)
- Save is optimistic — on slider release, `PUT /api/v1/user/model-settings` is sent

### Components

| Component | Role |
|---|---|
| `components/Slider.tsx` | Reusable slider. Two modes: `numeric` (temperature, etc.) and `discrete` (reasoning level in the top bar). |
| `components/Checkbox.tsx` | Reusable checkbox. Styling identical to `macroCheckbox` from SettingsModal. |

### Key Files

| File | Role |
|---|---|
| `lib/api.ts` | Types `ModelSettings`, `ModelSettingsMap` + `getModelSettings()` / `setModelSettings()` / `deleteModelSettings()` |
| `components/Slider.tsx` | Reusable slider (numeric + discrete modes) |
| `components/Checkbox.tsx` | Reusable checkbox (auto toggle) |
| `components/SettingsModal.tsx` | `models` tab: grid of checkbox + slider for each parameter |

### Parameters

| Parameter | Range | Purpose |
|---|---|---|
| `temperature` | 0.0–2.0 | Creativity/determinism |
| `top_p` | 0.0–1.0 | Nucleus sampling |
| `top_k` | 1–100 | K-token sampling limit (OpenRouter only) |
| `frequency_penalty` | -2.0–2.0 | Token frequency penalty |
| `presence_penalty` | -2.0–2.0 | Token presence penalty |
| `repetition_penalty` | 1.0–2.0 | Hard repetition penalty (OpenRouter only) |
| `max_tokens` | 1–65536 | Response length limit |

## Subagent Settings (subagent model and reasoning)

In the "Models" tab in SettingsModal, separately from the main model, parameters for AI subagents are configured:

- **Subagent model** — a selector (similar to the main one): `auto` (inherits the main agent's model) or a specific model from the catalog. Saved via `PUT /api/v1/user/subagent-model`.
- **Reasoning level** — appears only if a specific model is selected and it supports reasoning levels. Saved via `PUT /api/v1/user/subagent-reasoning-level`.

Both values are propagated through `SubagentContext` in `runner.ts` and applied in `runCompletion()` on every AI call within the subagent.

### Key Files

| File | Role |
|---|---|
| `lib/api.ts` | `getSubagentModel()` / `setSubagentModel()` / `getSubagentReasoningLevel()` / `setSubagentReasoningLevel()` |
| `components/SettingsModal.tsx` | Subagent model selector + reasoning level slider |

## ChatPage Messages

The main chat feed lives in `pages/ChatPage.tsx`.

### Feed Optimization

- Messages are rendered via memoized `MessageItem` (`React.memo`), so changes to input, TTS, popover states, or WS events don't re-render the entire history.
- Active states are passed to `MessageItem` as booleans (`isTtsPlaying`, `isReasoningOpen`, `isToolCallsOpen`, `isRegenHintOpen`), not as global ids. This way, toggling TTS/reasoning/tool calls only affects the involved messages.
- Initial history load takes the last `MESSAGE_PAGE_SIZE = 50` messages.
- Older messages are loaded via the "Load older messages" button through `GET /api/v1/chats/:id/messages?limit=&offset=`.
- The chat sidebar loads the list in batches of `CHAT_PAGE_SIZE = 50` via `GET /api/v1/chats?limit=&offset=`; chat search remains a separate `/api/v1/chats/search` without this pagination.
- When prepending older messages, ChatPage preserves `scrollHeight`/`scrollTop` and restores the position via `useLayoutEffect`, so the screen doesn't jump down.
- Auto-scroll down is skipped when prepending older messages.
- Archived messages (`msg.archived === true`) are displayed with reduced opacity (0.55) and an "archived" label in metaRow. Archived messages are not sent to the AI context, but remain in the DB and are available for viewing and searching.

### Reasoning, tool calls, and subagents

Assistant messages can have additional fields:

- `reasoning_content?: string | null`
- `tool_calls?: Array<{ id?: string; name: string; arguments: unknown; result_preview?: string }>`
- `result_preview` — truncated tool result (up to 250 characters) for popover display. During streaming, comes from `toolCallsHistory` (truncation via `formatToolResultPreview`); on chat reload — reconstructed from the trace format `tool_calls_json` (truncation via `slice(0, 250)`).
- `subagents?: SubagentTrace[] | null` — full traces of ad-hoc subagents (created via `spawn_subagent`). Each element contains: `task`, `system_prompt`, `tools`, `tools_used`, `answer`, `summary`, `aborted?`, `trace` (step-by-step tool calls).

UI:

- The `Reasoning` button appears only if `reasoning_content` is non-empty.
- During token streaming, the `Reasoning` button turns into the same toggle control with text `Reasoning...`: chevron and popover expansion work immediately, without waiting for `done`.
- If `reasoning_token` arrives first, `ChatPage` immediately creates a temporary assistant message with `reasoning_content`, so reasoning can be opened during generation. While regular `content` is still empty, the bubble shows the same typing dots but with a more active streaming animation.
- After the first `stream_token`, the state transitions to `content`: typing dots are replaced by Markdown text, and `streamAppenderRef` continues to rAF-batch text and reasoning into a single update per frame.
- The tools button appears only if `tool_calls.length > 0`.
- The `N subagent(s)` button appears only if `subagents.length > 0`. Opens a panel with a detailed trace of each subagent: task, prompt (truncated to 500 characters), list of provided tools, list of executed tools, answer.
- Aborted subagents are marked with `⏹ aborted`.
- All three blocks open as absolute popovers over the message width (`reasoningPanel`) and don't expand the feed.
- Popover animation is done via `AnimatePresence` + `motion.div`, expansion direction — top to bottom (`y: -16 -> 0`).
- Toggles are managed via `openSubagentsId` state (similar to `openReasoningId` / `openToolCallsId`).

### Regeneration

ChatPage has a regular regeneration of the last assistant message and a regeneration with a hint.

Flow:

1. The client finds the last user message before the assistant message.
2. The old assistant message is optimistically deleted from the UI and on the backend via `DELETE /api/v1/chats/:id/messages/:messageId`.
3. `streamChatMessage()` sends the same user text, `skip_user_history: true`, and `regenerate_from_history: true`.
4. For a hint, `regenerate_hint` is additionally sent.
5. The backend doesn't save a new user message and doesn't duplicate the user text in AI history; it uses the last user message from history as the current request once.

WS doesn't break this: `streamChatMessage()` still receives `intermediate`, `tool_status`, `display_state`, `desktop_action`, `map_update`, `done`, `error`; memoized rendering only affects React re-renders.

### Message Editing

In the message burger menu (where copy/download is), there is an "Edit" button. Works for messages of any role — both user and assistant.

1. Click "Edit" → the message content is replaced by a `<textarea>`.
2. The textarea height automatically adjusts to the original message height (auto-size via `scrollHeight`).
3. **Ctrl+Enter** — save, **Escape** — cancel. "Save" / "Cancel" buttons under the field.
4. Optimistic update: UI updates instantly; on network error — rollback to old text.
5. API: `PUT /api/v1/chats/:chatId/messages/:messageId` ← `{ content }` → `{ ok, token_count }`.
6. After saving, `token_count` is updated from the server response.

### Chat Fork (dialog branch)

In the message kebab menu (next to "Edit" / "Delete"), there is a **"Create branch"** button. Creates a new chat as a copy of the current one from the beginning through this message inclusive.

**Flow:**

1. Click "Create branch" → `POST /api/v1/chats/:currentChatId/fork` ← `{ from_message_id }`.
2. The backend copies all messages from the beginning to `from_message_id` into a new chat (see [backend README → Chat Fork](../backend-api/README.md#chat-fork-dialog-branch)).
3. The new chat becomes active, the sidebar refreshes (`loadChats`), `selectChat(res.chat_id)` switches to the branch.
4. The button is disabled during the request (`forking` state).

**Default title:** numeric prefix `[N]` — `"Report"` → `"[2] Report"`, `"[2] Report"` → `"[3] Report"`. A custom `title` can be passed in the body.

**What is copied:** messages (including `token_count`, `reasoning_tokens`, `archived`), attachments (**files are physically copied** — deletion in the branch doesn't break the original), images/audio (shared references — no deletions yet). FTS is updated automatically.

## Token Accounting

Display of token counts in messages and the overall chat context. Calculated on the server (gpt-tokenizer, o200k_base), the desktop only displays.

### Where It's Displayed

| Location | What it shows |
|---|---|
| Each message's metaRow | `Ntk` — token count for the message (counted from the expanded trace: content + tool_calls + tool_results) |
| "Reasoning" button | `Reasoning · Ntk` — reasoning_content tokens (separate from the main token_count) |
| Top bar (right) | `12 345tk · 1 876pk` — total tokens of all active messages (`tk`) + system prompt size (`pk`) |

### When It Updates

- On chat load (`getChatMessages`) — tokens come in each message's DTO + a separate `getChatContextTokens(chatId)` request for the top bar.
- After AI response (`done` event) — the assistant message gets `token_count` and `reasoning_tokens` from the response, top bar updates.
- The user message gets `token_count` right in `done` (field `user_token_count` of the response) — doesn't require a chat reload.

### API

- `GET /api/v1/chats/:id/context-tokens` — returns `messages_tokens`, `reasoning_tokens`, `archived_tokens`, `active_messages`, `archived_messages`, `system_prompt_tokens`.
- `ChatContextTokens` type and `getChatContextTokens()` — in `lib/api.ts`.

### What Is NOT Counted

- `reasoning_content` is not included in the message's `token_count` — it's separately in `reasoning_tokens`.
- Archived messages are not included in `messages_tokens` (only in `archived_tokens`).
- Prompt add-ons (voice, avatar, image) are not included in `system_prompt_tokens` — only the base prompt is counted (prompt content + core memory + pinned macros).

## WebSocket Transport

The desktop client uses **WebSocket** for bidirectional communication with the server. Implementation in `lib/api.ts`.

**Connection:**
- `initWebSocket()` — called in `auth.tsx` after successful login/registration
- WS connects to `ws://host:3050/ws?token=jwt`, JWT is validated by the server
- Auto-reconnect with exponential backoff (1s → 2s → 4s → ... → 30s)
- On token refresh (401 in apiFetch) → `reconnectWebSocket()` with the new token
- On logout → `closeWebSocket()` (code 1000, no reconnect)
- Heartbeat: backend sends `{ type: 'ping' }` every 25s, desktop responds `{ type: 'pong' }`. Backend considers desktop online only if `lastPongAt` is fresh (grace window 75s); stale connections don't receive `execute_ipc`.

**Sending messages:**
- `streamChatMessage()` when WS is connected sends `{ type: 'chat_send', text, ... }`
- If WS is not connected — SSE fallback (POST + ReadableStream)

**Incoming messages (WS → client):**

| type | Description |
|---|---|
| `intermediate` | Intermediate AI text |
| `stream_token` | Chunk of regular response text. On the `ChatPage` side, goes to `onStreamToken` → `streamAppenderRef.appendText()` and transitions the UI to the `content` state. |
| `reasoning_token` | Chunk of reasoning/thinking. On the `ChatPage` side, goes to `onReasoningStream` → `streamAppenderRef.appendReasoning()` and transitions the UI to the `reasoning` state. |
| `tool_status` | Tool execution status ("Searching for information...") |
| `display_state` | Avatar state change |
| `desktop_action` | UI control command / macro |
| `map_update` | Map data |
| `dice_roll` | d20 roll result (Dice Roll Mode). Arrives immediately after the roll; desktop stops the animation and fixes the value. See [Dice Roll Mode](#dice-roll-mode-d20-roleplay) |
| `task_result` | Scheduler task execution result: `{ chat_id, text, is_new_chat }`. If the same chat is open — reload messages; if different — unread badge. See [Tasks](#tasks-taskstool) |
| `done` | Final response: `reply_text`, ids, `reasoning_content?`, `tool_calls?`, `generated_images?`, `display_state?`, `dice_roll?` (fallback if the realtime event is lost) |
| `error` | Error |
| `execute_ipc` | Server request to execute IPC and return result |
| `ping` | Server heartbeat; client must respond `pong` |
| `pong` | Response to ping |

**Current stream callbacks:** `lib/api.ts` separates permanent WS handlers (`wsCallbacks`: connect/disconnect/task_result and fallback handlers) from active generation callbacks (`activeStreamCallbacks`). `streamChatMessage()` puts the current request's callbacks into `activeStreamCallbacks`; incoming `stream_token` / `reasoning_token` / `done` / `error` are delivered there first, and on `done` or `error` the active callbacks are cleared. This protects the token stream from accidental `initWebSocket()` re-registration.

**Token speed:** the actual throttle is set on the backend in `backend-api/src/services/ai.ts`: `STREAM_FLUSH_INTERVAL_MS = 50` (~20 WS/SSE chunks/sec). The desktop doesn't set a separate millisecond rate; it batches incoming chunks via `requestAnimationFrame` to do no more than one `setState` per frame.

**Reverse channel (execute_ipc):**
The server can request the desktop to execute an IPC command and return the result. Used for `return_output` macros, `explore_fs`, `read_file`, `write_file`, and confirmed `execute_pc_command`. `lib/api.ts` logs receiving `execute_ipc` and sending `ipc_result`; correlation with backend logs is done by `request_id`.
1. Server sends `{ type: 'execute_ipc', request_id, ipc_type, payload }`
2. Desktop executes IPC (`executeCommands` / `readDirectory` / `readFile` / `writeFile`)
3. Desktop responds `{ type: 'ipc_result', request_id, data }` or `{ error }`
4. Server resolves the pending Promise → AI gets the result as a tool response

**SSE fallback** — if WS is not connected, `streamChatMessage` uses a regular POST + SSE. SSE is unidirectional; the reverse channel (`execute_ipc`) is unavailable.

### Stop generation

- `stopChatStream()` sends `{ type: 'chat_stop' }` over WS when connected and also calls `POST /api/v1/chat/stop` as a fallback/backup.
- In `ChatPage`, `sending` means "There is an active chat request" and keeps the stop button visible until `done`, `error`, or aborted `done`.
- `showTyping` is separate from `sending`: it controls the pre-message typing bubble before an assistant message exists. The first `reasoning_token`, `stream_token`, `tool_status`, or `intermediate` hides `showTyping` and switches to the temporary assistant message managed by `streamAppenderRef`.

**Soft abort:** on generation stop, the bot doesn't delete the accumulated content. Instead:
- If `res.aborted === true` and there is a `res.message_id` — the temporary message is finalized with the real ID, all accumulated content (`reasoning_content`, `tool_calls`, `subagents`), and the text `_⏹ Generation stopped by user_`.
- If `message_id === 0` — the temporary message is deleted (nothing had time to generate).
- Affected flows: normal send, regenerate, regenerate-with-hint, voice.

## Tool Navigation

The "back" button in the ToolsPanel header is unified for all tools. Tools register their `onBack` callback via `registerToolNav(toolId, callback)` from `lib/tools.ts`.

| Context | Back button behavior |
|---|---|
| Tool with internal stack (notebook editor) | Calls `tool.onBack()` → return to note list |
| Tool without stack (notebook list) | Return to tools list |
| No active tool | Button hidden |

A new tool simply calls `registerToolNav('myTool', onBack)` in useEffect. If no callback is registered — back returns to the tools list.

## CSS Variables

All colors/spacing via CSS variables in `global.scss`. Key ones:
- `--bg-primary/secondary`, `--border-light/medium`, `--text-primary/body/muted/hint`
- `--accent`, `--accent-icon`, `--bg-input`, `--bg-bubble`, `--bg-modal-hover`

## Desktop Updates

Packaged builds use `electron-updater` with public GitHub Releases from `NikitaCherepov/chatter`.

- The Desktop version is read from `desktop-app/package.json`.
- Update checks run automatically after startup.
- Downloads are started by the user from the existing update modal.
- `electron-updater` reports download progress and installs the update through `quitAndInstall()`.
- NSIS `.blockmap` metadata enables differential downloads when possible.
- Desktop updates are independent from Chatter server Docker updates.

A published release must contain the NSIS installer, its `.blockmap`, and `latest.yml`. Draft releases are ignored by installed clients.

## Announcements & Onboarding (welcome modal)

Multi-slide announcements shown to users who haven't seen them yet. The first announcement (`welcome_v1`) serves as the onboarding flow after registration. New feature announcements work the same way — just add an entry to the registry.

### How it works

1. Desktop stores all announcements in [src/renderer/lib/announcements.ts](src/renderer/lib/announcements.ts) — the `DESKTOP_ANNOUNCEMENTS` array.
2. Server stores `seen_announcements: string[]` in `users.ui_settings` (JSON). Merged via `PUT /api/v1/user/ui-settings`.
3. On startup, `AnnouncementOverlay` in App.tsx compares `seen_announcements` from the server with the local registry. Unseen announcements are shown one by one.
4. After clicking "Done" on the last slide, the IDs are saved to the server and the modal closes.
5. When a different user logs in, `visible` resets so they see their own unseen announcements.

### Adding a new announcement

1. **Add an entry** to `DESKTOP_ANNOUNCEMENTS` in [src/renderer/lib/announcements.ts](src/renderer/lib/announcements.ts):

```ts
{
  id: 'new_feature_v1',          // unique ID, stored in seen_announcements
  slides: [
    {
      id: 'intro',               // unique within this announcement
      titleKey: 'onboarding.newFeature.intro.title',   // i18n key, Markdown
      bodyKey: 'onboarding.newFeature.intro.body',     // i18n key, Markdown
      image: someImportedImage,  // optional, e.g. import img from '...'
    },
    // more slides...
  ],
},
```

2. **Add i18n keys** in `desktop-app/src/renderer/i18n/locales/{en,ru,...}/translation.json` under `onboarding.newFeature.*`. Both `title` and `body` support Markdown rendered by `MarkdownRenderer`.

3. That's it. The modal automatically uses the new entry for users who haven't seen it. No server changes needed.

### Key files

| File | Role |
|---|---|
| `src/renderer/lib/announcements.ts` | Types (`Announcement`, `AnnouncementSlide`), registry array, `getUnseenAnnouncements()` helper |
| `src/renderer/components/OnboardingModal.tsx` | Reusable modal: slide navigation, `AnimatePresence` transitions, `MarkdownRenderer` for content, step indicator |
| `src/renderer/App.tsx` → `AnnouncementOverlay` | Checks unseen announcements after auth, shows modal, saves seen IDs to server on close |
| `backend-api/src/server.ts` → `VALID_UI_KEYS` | `seen_announcements` is a validated `string[]` field in `users.ui_settings` |

### Modal component API

```tsx
<OnboardingModal
  announcements={unseen}       // Announcement[]
  onDone={(seenIds) => {}}     // called on "Done" / close, passes IDs to save
/>
```

- Props: `announcements: Announcement[]`, `onDone: (ids: string[]) => void`
- Slide transitions: framer-motion `AnimatePresence` with horizontal slide
- Style: same size as SettingsModal (70vw × 75vh), all styles from `global.scss` variables
- Footer: absolute step indicator centered, nav buttons space-between (Back left, Next/Done right)
