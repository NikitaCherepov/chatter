# Chatter Bot (`index.ts`)

[English](README.md) | [Русский](README_RU.md)

Telegram bot for the `chatter` project.

`index.ts` handles the Telegram UX (commands, menus, text/voice/photo processing) and communicates with `backend-api` via an internal API for AI and user management.

## Key Things to Know

- The bot and API run as two separate processes.
- For user lifecycle management, the bot uses the backend (`/internal/users/*`), so the backend must be running.
- The main project database: `chatter.db`.
- The bot resolves each incoming `ctx.from.id` through the Telegram identity endpoint once. All backend operations then use the canonical `account_id`; the Telegram ID is retained only for Telegram API delivery, command scope, linking, and unlinking.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Configure `.env` (see minimum below).
3. Start the backend API:

```bash
npm run dev:api
```

4. In another terminal, start the bot:

```bash
npm run dev
```

## PM2 Startup

```bash
npm run start:api
npm run start
```

```bash
npm run logs:api
npm run logs
```

## Minimum ENV Variables for the Bot

- `TELEGRAM_TOKEN` — Telegram bot token.
- `BACKEND_INTERNAL_TOKEN` — must match the backend.
- `BACKEND_API_BASE_URL` — defaults to `http://127.0.0.1:3050`.

## Recommended ENV Variables

- Administrators are assigned in the database (`role=admin`, `status=approved`); `ADMIN_ID(S)` are no longer used.
- `ENCRYPTION_KEY` — encryption key for mail data.
- `NOTES_WEBAPP_URL` — link to the Notes WebApp in the menu.
- `AUTO_SYNC_PLAN_LIMITS_ON_BOOT=1` — auto-sync plan limits on startup.
- `BACKEND_TIMEOUT_AI_MS` — timeout for AI requests (ms), default `120000` (2 min).
- `BACKEND_TIMEOUT_MEDIA_MS` — timeout for voice/photo (ms), default `180000` (3 min).
- `BACKEND_TIMEOUT_DEFAULT_MS` — timeout for other backend requests (ms), default `15000` (15 sec).
- `TG_USE_RICH_STREAMING=1` — enables rich streaming in Telegram via `sendRichMessageDraft` / `sendRichMessage` (Bot API 10.1+).
- `TG_STREAM_DEBUG=1` — verbose rich-stream flush/finalize/backoff logs.

## AI Tools

The bot receives the list of tools from the backend and passes them to the AI. Available tools:

- **search_web** — web search (Tavily).
- **read_webpage** — fetch and clean webpage text.
- **get_smart_devices** / **control_smart_home** — smart home control (Yandex). Two tools: the first returns a list of devices from the DB, the second controls them by device_id. Token and devices are configured via UI (Settings → Smart Home).
- **schedule_task** / **get_my_tasks** / **delete_my_task** — schedule tasks and reminders.
- **set_user_timezone** — set user timezone.
- **check_emails** / **read_email_content** / **send_email** — email operations.
- **save_note** / **list_my_notes** / **read_note** / **delete_note** — notes.
- **update_core_memory** — static user profile.
- **search_cold_memory** / **save_to_cold_memory** / **delete_from_cold_memory** — vector memory archive.
- **random_roll** — coin/dice roll.
- **generate_image** — generate images from a text description. Triggered by explicit intent ("draw", "generate an image"). The prompt is automatically translated to English. The image is sent to Telegram as a photo.
- **execute_pc_command** — execute a command on the user's PC. Requires confirmation via inline buttons (if desktop is connected). Optional `background: true` is used for opening GUI applications (VS Code, Notepad, browser) when stdout/stderr is not needed and there's no need to wait for the window to close.
- **execute_ssh_command** — execute an SSH command on a server. Requires confirmation via inline buttons.
- **list_devops_servers** / **list_devops_runbooks** / **read_devops_runbook** / **suggest_devops_runbook** — DevOps tools.
- **install_ssh_public_key** / **create_server_user** / **change_server_user_password** / **suggest_server_creds_update** — SSH access management.
- **map_control** / **get_map_pins** / **find_transit_route** / **search_nearby** — maps, routes, place search.
- **list_my_macros** / **execute_macro** — user-defined console command macros.
- **explore_fs** — read a directory on the PC (requires connected desktop).
- **suggest_macro** — suggest saving a new macro.
- **capture_screen** — take a screenshot of the PC screen. The backend takes a screenshot via the desktop, sends it to a vision model for analysis (finding elements, describing the UI). The screenshot is saved and shown in the chat. Coordinates are returned in normalized form (0.0–1.0) for use in execute_visual_click. Requires a connected desktop.
- **execute_visual_click** — click the mouse at specified coordinates on the PC screen. Before clicking, takes a fresh screenshot, draws a red crosshair (circle + crosshair) and sends it to Telegram as a photo with inline buttons "Click" / "Reject". After confirmation, nut.js moves the real cursor and clicks. Coordinates are normalized (0.0–1.0), multi-monitor is supported. Requires user confirmation and a connected desktop.

## Main Commands

User:

- `/start`, `/menu`
- `/clear`
- `/tz <UTC>`
- `/tasks`, `/task_delete <id>`
- `/note_add <text>`, `/notes`, `/note_find <text>`, `/note_delete <id>`
- `/mail_setup <prov> <mail> <app_pass>`, `/mail_use <yandex|google>`, `/mail_limit`, `/mail_forget`
- `/chats`, `/chat_new [name]`, `/chat_use <id>`
- `/rename`
- `/prompts`, `/prompt_use <id>`

## Document Attachments in Telegram

In addition to photos, the bot can accept text documents: txt, md, json, csv, log, xml, yaml, ini, toml, code (py, js, ts, go, rs, java, c, cpp, cs, php, sh, sql, html, css, etc.), **docx**, **pdf**, rtf. Limit is 5 MB per file (same as desktop). These files also immediately appear in the desktop's `DocumentsTool` — the backend is the same.

Works exactly like photos: file received → immediately sent to AI.

- **File + caption** — the caption becomes the request text, the file is attached to the same message.
- **File without caption** — sent with a neutral placeholder ("Analyze the attached documents.").
- **Multiple files as an album** (`media_group_id`) — collected via a short timer and sent as a single AI request; the caption is taken from the first message in the group.

Data flow: TG bot downloads the file → base64 → `POST /internal/ai/stream` with a `documents[]` field → the backend parses it (via `parseDocument`), saves the file, writes `attachments` JSON to `chat_messages`, and injects the extracted_text into the AI context. Same logic as in `/api/v1/chat/send` for desktop.

Desktop (additional):

- Full-text search across messages in the sidebar (FTS5, 300 ms debounce)
- `GET /api/v1/chats/search?q=keyword` — returns chats with snippets of found messages

Admin (additional):

- `/add`, `/remove`
- `/users`
- `/ban <id> [reason]`, `/unban <id>`
- `/prompt_add`, `/prompt_show`, `/prompt_set`, `/prompt_desc`, `/prompt_rename`, `/prompt_default`, `/prompt_delete`
- `/history_user <user_id> [limit]`
- `/history_delete <user_id> <message_id> [db|tg]`
- `/sync_plan_limits`

## Build

```bash
npm run build
```

Compiled output: `dist/index.js`.

## If the Bot Is Not Responding

1. Check that the backend is alive:

```bash
curl -s http://127.0.0.1:3050/health
```

2. Check logs:

```bash
npm run logs:api
npm run logs
```

3. Verify that `BACKEND_INTERNAL_TOKEN` is the same for both the bot and the backend.

## Related Documentation

- API backend: [backend-api/README.md](./backend-api/README.md)

## SSE/Rich Streaming and Command Confirmations in Telegram

The bot communicates with the backend via SSE streaming (`/internal/ai/stream`) — the user sees the AI working in real time: token-by-token text, reasoning, intermediate messages, tool statuses, and command confirmation cards.

### How It Works

1. User sends text to the bot
2. The bot opens an SSE connection to the backend (`POST /internal/ai/stream`)
3. The backend streams events: `reasoning_token`, `stream_token`, `intermediate`, `tool_status`, `desktop_action`, `done`, `error`
4. If `TG_USE_RICH_STREAMING=1` is enabled, the bot updates a single rich draft via `sendRichMessageDraft`; otherwise it continues the old mode of separate messages/final reply
5. Confirmation cards render inline keyboards
6. On `done`, the rich draft is finalized via `sendRichMessage` so the message persists in history

### Rich streaming (`TG_USE_RICH_STREAMING=1`)

The implementation lives in `index.ts` (`RichStreamSession`). A separate session with buffers is created for each AI request:

- `reasoningBuf` — model reasoning tokens (`reasoning_token`)
- `lastToolStatus` — the latest tool status (`tool_status`, e.g. "Executing command on PC…"); only one is stored — a new one replaces the old one
- `intermediateBuf` — intermediate model text between tool-call iterations (`intermediate`); not rendered in the draft (its content ends up in `textBuf` via the stream anyway), used only as a flush trigger and status reset
- `textBuf` — the model's final response (`stream_token`)

#### Ephemeral log (architectural decision)

All buffers **except `textBuf`** are ephemeral: they are shown in the draft during generation but **completely discarded in the final `sendRichMessage`**. After completion, only the clean model response remains in the chat. No `<blockquote expandable>💭 Reasoning…`, no "🔧 Executing command…" in history.

**Draft (during generation):**

1. `<tg-thinking>{reasoning_tail}</tg-thinking>` — "thinking…" animation; we show the **tail** of the reasoning (the latest thoughts are more important than the beginning "The user asks…")
2. `<i>🔧 {last_tool_status}</i>` — a single current tool status in italics; when the tool finishes (`onIntermediate`/`onToken`) — it is cleared so it doesn't linger
3. `{textBuf}` — the streaming final response

**Final (after `done`):**

- Only `{textBuf}`. Everything else vanishes.
- If `textBuf` is longer than `STREAM_FINAL_TEXT_LIMIT` (4000) — it is split into multiple persisted messages (`splitMarkdownForFinal` cuts by `\n\n`/`\n`, each is converted to Rich HTML separately).

#### Dynamic draft trimming

The total HTML draft length is limited by `STREAM_DRAFT_TEXT_LIMIT = 4000`. Priority — `textBuf` (always in full as much as fits), then `lastToolStatus`, then `reasoningBuf`. Reasoning is shown as a tail with `…` at the beginning. If it still doesn't fit — it is trimmed further.

- The first `stream_token` transitions the phase to `answering`; reasoning is no longer updated in the draft (but stays in the buffer until the final step where it's discarded).
- `tool_status` and `intermediate` can arrive before/after reasoning — they are independent of the phase.
- If `textBuf` is empty after `done` (the model gave no response) — `finalize()` returns false → fallback to `safeReply`.
- If the rich draft fails for a reason other than 429, the session sets `draftFailed` and the `onToolStatus`/`onIntermediate` callbacks fall back to the old mode (`ctx.reply` with separate messages).
- On a successful rich final, `backend.tool_user_messages` **are not sent** as separate messages — they were already visible in the ephemeral draft. They are only sent in fallback mode.
- Command confirmation cards (`desktop_action`) **do not go through the rich pipeline** — they are always separate messages with inline buttons, so confirmations (`execute_pc_command`, `execute_ssh_command`, file operations, etc.) are independent of rich streaming and don't break.

### Rich response formatting

The main model response text arrives as Markdown and is converted to Telegram Rich HTML via `marked` with a custom renderer. Raw HTML from the model response is not executed, but escaped.

Supported elements:

- paragraphs and line breaks (`<p>`, `<br>`)
- headings (`<h1>`-`<h6>`)
- bold/italic/strikethrough/inline-code (`<b>`, `<i>`, `<s>`, `<code>`)
- code fences (`<pre><code class="language-...">`)
- lists (`<ul>`, `<ol>`, `<li>`) with inline formatting inside items
- blockquotes (`<blockquote>`)
- tables (`<table>`, `<tr>`, `<th>`, `<td>`)
- safe links (`http`, `https`, `mailto`, `tel`, `tg://`)

Important: `marked` is only needed by the Telegram bot. Desktop renders markdown in React via `MarkdownRenderer` (`ReactMarkdown + remark-gfm + rehype-highlight`), while Telegram receives a ready-made `rich_message.html` string.

### Throttle and 429 backoff

The rich draft cannot be updated on every token without limits: Telegram quickly returns `429 Too Many Requests`.

- Base flush interval: `STREAM_FLUSH_BASE_INTERVAL_MS = 500` (~2 updates/sec).
- Maximum adaptive throttle: `STREAM_FLUSH_MAX_INTERVAL_MS = 5000`.
- If `STREAM_MIN_DELTA_CHARS = 30` have accumulated, a flush can fire before the interval, except during the cooldown period after a 429.
- On 429, the bot reads `retry_after`, sets `nextAllowedFlushAt` to the future and does not send a new draft until the cooldown ends, even if a large `textDelta` has accumulated.
- AIMD logic: on 429 the interval increases, after a series of successful flushes it gradually returns to the base 500 ms.

### Inline Confirmation Buttons

When the AI executes a PC command (`execute_pc_command`) or an SSH command (`execute_ssh_command`), the bot sends a card with buttons:

| Button | Action |
|---|---|
| ✅ Allow | Execute the command |
| 🔓 Always allow | Confirmation → create an auto-approve policy + execute |
| ❓ Check | LITE AI analyzes the command safety |
| ❌ Reject | Reject execution |
| 💬 Reject with comment | The bot asks for a comment in the next message and passes it to the backend as `rejection_comment` |

Cards are sent simultaneously to Telegram (inline buttons) and desktop (WS). Whoever responds first — that one executes, the second channel is ignored.
If the user rejects with a comment, the backend returns this text to the model in the rejected tool result as `user_comment`, so the AI can adjust the next step.

### Background PC Commands

`execute_pc_command` supports a `background` flag. The AI should set `background: true` only for GUI/open scenarios where console output is not needed: open VS Code, Notepad, a browser, a file, or a folder. On desktop this is launched via detached `spawn(..., { shell: true, stdio: 'ignore', windowsHide: true })` + `unref()`, so Telegram/AI gets a quick result and doesn't wait for the window to close.

Regular diagnostic commands (`where`, `dir`, `ipconfig`, `tasklist`, scripts with stdout) should run with `background: false` or without the parameter.

### Telegraf Architecture (fire-and-forget)

`processUserTextThroughAi` is started **without `await`** — this is critical. If AI processing blocked the event loop, callback_query from inline buttons would not be processed, and Telegram would return "query is too old" after ~15 seconds.

Button processing order:
1. `answerCbQuery()` — immediately upon receiving the callback
2. Axios request to the backend — in a background IIFE
3. Result — as a separate message in the chat

### Storing Commands for Review/Always

Telegram **strips Markdown** from message text (backticks disappear), so the command cannot be extracted from `callbackQuery.message.text`. The bot stores full commands in memory (`pendingPcCommandTexts` Map) when sending the card and retrieves them by `confirmationId` when "Always allow" or "Check" is pressed.

## Desktop-only Tools (via backend API)

The following AI tools are only available when a desktop is connected (`isDesktop=true`) and are not displayed in Telegram:

- **`desktop_action`** — desktop UI control (opening widgets, macros, suggestions).
- **`invoke_subagent`** — invoke a specialized subagent registered in the static registry.
- **`spawn_subagent`** — create ad-hoc subagents on the fly: the model defines a task, system prompt, toolset, and iteration limit. Multiple calls within the same iteration run in parallel (up to 3 concurrently). The full trace is saved in a separate `subagents_json` field for display in the desktop UI.

Subagent architecture details: [backend-api/README.md → Subagent System](./backend-api/README.md#subagent-system-desktop-only-isdesktop).

## Soft Abort (stopping generation)

When generation is stopped (`/abort_message`, `chat_stop`), the bot **does not delete** the accumulated content. Everything the AI managed to produce (intermediate text, tool calls, reasoning, subagent traces) is saved to the DB as a regular assistant message marked with `_⏹ Generation stopped by user_`. This works both in Telegram and on desktop.
