# Desktop appearances

Appearance profiles include palettes, materials, typography and optional independently coded shells. A shell can supply a chat navigator or a complete custom workspace using the existing desktop isolation runtime.

- Canonical schema: shared/appearance.ts. Run node scripts/sync-appearance.mjs; use --check in validation.
- Storage: users.ui_settings.appearance, with a version, collection revision, active ID and up to 32 profiles.
- Each profile includes light/dark palettes, interface/message/code fonts and sizes, radius/density, a chat background and message-arrival motion. Optional shell source is stored in the same profile and follows the same preview/save/apply lifecycle.
- A null activeId selects the built-in appearance; it is always available and cannot be deleted.
- The existing system/light/dark/scheduled theme preference chooses the palette. Its behavior is preserved.
- Font names refer to fonts installed on the current PC. A fallback is used when unavailable; no font installation is performed.
- Solid chat backgrounds follow the selected palette. Gradient colors and uploaded/HTTPS images are explicit profile settings.
- Shell and chat colors are derived separately. Text, metadata, links, tool surfaces and code colors adapt to the actual chat backdrop, including when a dark gradient is used in light mode. Low-contrast palettes are corrected locally without rewriting the saved colors. Images receive a contrast scrim; mixed gradients receive one only when needed. Miniature previews use the same rendering rules.
- Fonts, sizes, density and corners use the existing appearance tokens across settings, tools, dialogs, work logs and navigation. Circular controls, avatars and document artwork retain their shapes.
- Image uploads use existing media storage. Draft uploads expire unless saved; owned assets become persistent through profile references.
- Arrival motion supports fade, translation and scale with bounded duration and easing. It respects reduced motion, does not animate loaded history, and does not replay when virtual rows remount.

## API and tools

GET /api/v1/user/appearance reads the collection.

POST /api/v1/user/appearance accepts save, activate or delete. Saving includes the complete profile and an explicit apply flag; a stale profile revision returns HTTP 409. Activate/delete require the collection revision. Updates preserve unrelated user settings. The ordinary UI settings endpoint preserves appearance data but does not replace it.

POST /api/v1/user/appearance/image accepts an image as base64, up to 8 MiB before encoding.

get_appearance defaults to saved variant summaries and the active profile. The capabilities view returns supported fields, limits and a complete template; profile reads a variant by ID.

suggest_appearance validates a complete profile and emits the existing desktop action/confirmation flow. It never saves or applies a theme. Saving and applying require explicit user action in the editor or confirmation/preview UI.

Preview state is local and temporary. The independent recovery bar and Escape restore the saved appearance. Ctrl/Command + Alt + Backspace restores the default locally immediately and saves the choice to the server; a failed save retains readable local recovery controls. Changing accounts clears previews and account-scoped query data is kept separate.

## Custom shells

Optional profile.shell contains version 1, language html or tsx, source (nonempty, up to 100,000 characters) and optional scope navigator or workspace. Navigator is the default. Both support arbitrary markup, styles and animations. Workspace also receives the active conversation and can supply its own message renderer and composer.

Source runs in the existing isolated WebContentsView, with a separate process/session, offline CSP, no application preload, and a dedicated narrow window.chatter bridge. Bundled TSX supports react, react-markdown and remark-gfm. The bridge publishes chat summaries, folders, existing section pagination, server search, active-chat messages, generation state, locale, palette and translated labels. No app credentials or direct OS access are passed to source.

window.chatter.subscribe(callback) returns unsubscribe and immediately supplies the latest state when available. State.messages is the loaded history, with id, role, content (final-answer body), and createdAt. messagesLoading, hasOlderMessages, olderMessagesLoading, sending, canSend and attachmentCount describe the native conversation. Existing bot confirmation cards temporarily reveal the native interface.

Actions are openChat(id), showHome(), newChat(), loadMore(folderId), search(query), sendMessage(text), stopGeneration(), loadOlderMessages(), openConversation(), attachFiles(), openLibrary(), and openSettings(). Folder ID null means unfiled. Main validates actions against the owning view, published chat IDs and section pagination. Sending uses the existing composer/streaming flow, requires real user activation, and captures the active chat ID to reject stale requests.

Native controls outside generated code open settings/library and close the shell. Route-aware source subscribes with window.chatter.subscribe(callback, {navigation:true}) to retain its running UI on back navigation. Previously imported source without this option reloads its own initial overview when the host returns home.

The shell reads state.view (home/conversation) and can call showHome() to return to its own overview. The host All chats button also selects home, including after using native conversation actions. Escape from a conversation returns home and keeps the appearance preview. Escape from home leaves a temporary preview. Standard interface is a separate explicitly labeled action. Ctrl/Command + Alt + Backspace still restores the default from a focused isolated surface. Render failures and the existing hang watchdog release the custom view and leave the native app available.

Import appearance opens a new draft with a new ID and revision 0. Export includes all source. The editor exposes source format, scope and code. Neither importing nor editing applies a profile automatically. Existing profiles without shell are unchanged.

The bot uses the same get_appearance capabilities and suggest_appearance tools. Capabilities include the source contract, bridge API and minimal working HTML. A supplied profile revision must equal the current saved revision; the server increments it on save.

examples/appearances/journal.json is a typographic paper journal with a full-page reading view and Markdown. examples/appearances/worktable.json is a note-card board whose conversations open in a modal card. Both are independent TSX implementations with their exact source beside the JSON.

examples/appearances/holographic.json is an importable full appearance. examples/appearances/holographic.html is its exact shell source, ready to give to a bot as a starting point. The sample opens with an orbital chat map and provides its own conversation, live text updates, composer, stop action, native attachments and conversation actions. It maintains keyed message elements, skips empty answer bubbles, supports reduced motion and pauses decorative animation while hidden.

## Checks

- node scripts/sync-appearance.mjs --check
- tsx backend-api/tests/appearance.test.mts
- tsx desktop-app/tests/appearance-colors.test.mts
- tsx desktop-app/tests/appearance-ui.test.mts
- Existing message/sidebar virtualization tests verify the unchanged default layout.

## Color regions

Each light/dark palette has background (application shell), text and accent. Optional surface controls the sidebar, header, composer, tools panel, title bar and settings window, with its own derived text and control colors. Optional chat sets the solid conversation color. The existing profile.background gradient/image is conversation-only and takes precedence over chat. Omitted surface/chat retain previous behavior exactly; Auto removes the corresponding override. No database migration or theme preference change is needed. The shared schema, capabilities and editor use the same names; legacy profiles still validate without adding fields.

## Surface materials

Optional profile.materials.panels and profile.materials.composer each contain opacity (0.55–1), blur (0–32px), shadow (none/soft/medium/strong), border (none/subtle/defined), and optional radius (0–24px, otherwise the global radius). Omission means exact legacy styling; Auto removes that region. These additive fields use the existing API, tools, saved variants and confirmation flow.

Only the background fill is translucent. Text/control colors are derived against worst-case black/white backdrops; fill opacity is applied exactly as requested. A low-contrast material produces an editor hint instead of a hidden opacity increase. Backdrop blur is static, bounded, and scoped to chrome/composer surfaces; it never filters the conversation or runs in scroll handlers. Panels above flat content may show no visible blur. Reduced transparency and browsers without backdrop-filter get opaque paint. Shadow and border use finite presets, not arbitrary CSS. Materials do not change measured row heights.
