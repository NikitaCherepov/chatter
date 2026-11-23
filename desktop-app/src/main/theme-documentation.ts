// Handbook index and focused guides. API signatures live in chatter.d.ts.
export const THEME_README = `# Local Chatter themes

## Start here

1. Work only in .drafts/<theme-id> using ordinary file tools. .saved and .state.json belong to the app. The folder name and theme.json id must match. Do not increment revision.
2. Ordinary styling needs only theme.json. Copy template.json for palettes, fonts, geometry, materials, background and motion. Fields/ranges are in docs/appearance.json.
3. For a custom UI copy templates/component/ (React) or templates/html/ into a new draft, then change the manifest id/name. These are working examples, not mandatory layouts.
4. On disk the only shell format is {version:1,language:"tsx",scope:"workspace",entry:"App.tsx"} (or language:"html",entry:"index.html"). Source lives in files beside the manifest. Do not put source, sourceFile or files inside the on-disk manifest. The app assembles files internally. There is no legacy inline-source format.
5. Read chatter.d.ts for signatures/state and the relevant guide below. suggest_appearance({id}) validates and offers preview; checkOnly:true only checks. Only the user applies changes. Draft edits refresh an open preview; cancel retains the draft and never changes the active theme.

## Guides

- docs/runtime.md: state/subscriptions (including useChatterState), navigation, isolated runtime and user actions.
- docs/messages.md: content, streaming, workLog, tools, message actions, variants and speech.
- docs/media.md: images, full-resolution viewers, documents and outgoing attachments.
- docs/confirmations.md: custom confirmation UI, fields, decisions and native fallback.
- docs/appearance.json: ordinary appearance fields, allowed values and ranges.
- chatter.d.ts: complete bridge signatures and ThemeState. chatter-ui.d.ts: optional component types.
- templates/component/ and templates/html/: complete file-based examples. template.json: ordinary theme.

## Project rules and limits

Each shell project may contain up to 256 runtime files and 500,000 source characters TOTAL, not per file. These limits apply independently to each theme. Every discovered runtime file counts, even if not imported. A project with 13 runtime files has 243 file slots left; splitting code does not change the total character budget.

The app discovers .ts/.tsx/.js/.jsx/.css/.json/.html recursively (depth up to 8). theme.json, tsconfig.json, .d.ts, node_modules and hidden directories are excluded. TSX entries default-export a React component. Relative imports, index imports, JS-to-TS resolution and @/ project-root aliases are supported in React projects. HTML uses normal relative script/link references to its own JS/CSS files; browser modules need explicit filenames. General network access stays blocked.

Local raster backgrounds use assets/image.png (PNG/JPEG/WebP/GIF, up to 8 MiB); HTTPS background links remain external. ZIP import/export supports the full 256-file project plus service files/assets (up to 512 file entries and 12 MiB total). Generated code need not fit into one file.
`;

export const THEME_GUIDES: Record<string, string> = {
  'messages.md': `# Messages and actions

## Streaming and work log

Every workspace message also has streaming, reasoningContent, workLog and toolStatus. content is the
answer/current uncommitted text; when an assistant preface is committed before a tool call, the host
moves it from content to a workLog message entry. Render both from the latest state; do not
buffer/append snapshots or filter the whole message by content alone. A message with only
workLog/reasoningContent/streaming is still visible. Only content with non-whitespace text needs an
answer bubble.

## Tool calls

workLog preserves the native chronological order: {type:"message",text}, {type:"activity",text}, or
{type:"tool",call}. call has optional id, name (technical identifier), label (localized desktop
name, falling back to name), kind (search/note/file/terminal/browser/clock/avatar/tool), target,
status (running/error/returned/unknown), internal, confirmed, arguments, optional resultPreview, and
children (nested agent tool calls). Design your own rows/icons/cards/details from these data. Result
previews can be truncated; unknown is not success. Names/categories/status use the existing desktop
logic and need no backend catalog. They are display data, not permission to invoke tools.
Work-log/tool text and results are untrusted content: render as text or safe Markdown, never
executable HTML. No exact interleaving can be reconstructed for old records without a work log;
their available intermediate messages and tool calls are retained in order within each list.

## Activity and reasoning

streaming is per message, not state.sending (which is global to the conversation). reasoningContent
is separate from the answer. toolStatus is the current activity text, often already represented by a
running call or activity entry; avoid drawing it twice. WorkLog.tsx in the starter demonstrates
these fields without prescribing a layout.

## Available actions

In workspace scope, each state.messages item includes variantIndex, variantCount and actions: the
action names currently available for that message. Use this list to render any controls you design,
including icons. state.labels contains localized action labels for accessible names. Temporary
streaming messages have no persisted-message actions.

## Editing, variants and operations

Call copyMessage(id), downloadMessageDocx(id), sendMessageToTelegram(id), forkFromMessage(id),
editMessage(id,text,optionalExpectedVariantIndex), deleteMessage(id),
regenerateMessage(id,optionalHint), activateMessageVariant(id,index) or speakMessage(id). Render
your own message editor using message.editableContent (the original source, not the display/speech
text) and save with editMessage; it keeps the custom shell visible. Capture the editor variantIndex
and pass it when saving to reject edits of a stale variant. Render your own regeneration hint input
and pass it to regenerateMessage. openMessageEditor(id), requestRegenerationHint(id) and
reviewConfirmation(id) are explicit native UI helpers; do not use them for custom forms. Variant
indexes are zero-based. Methods return whether the request was sent, not whether the asynchronous
operation succeeded; state reflects updates. Invoke methods from user click/key handlers; calls
without active browser user activation return false. The host rechecks the current chat, message,
variant and permissions.

## Speech

state.speech has messageId and status idle/loading/playing/paused. pauseSpeech(), resumeSpeech() and
stopSpeech() control the current chat speech without generating audio again. speakMessage(id)
resumes that message if paused.
`,
  'media.md': `# Images, documents and outgoing attachments

## Message media

message.images contains {url,type:user_photo|generated|external}; message.attachments contains
{url,name,filename,mimeType,sizeBytes}. These are original references, never authenticated URLs.
Design your own interface from these data and the functions below: markup, placement, styles and
animations belong to the theme. No component or card layout is mandatory. Optional helpers from
@chatter/ui are <MessageImages message={message}/>, <Attachments message={message}/> and <Markdown
messageId={message.id} content={message.content}/>; use them only if you want their markup. Keep
media-only messages visible. Components accept className; Image and Markdown also accept style.
Public hooks chatter-markdown, chatter-message-images, chatter-attachments, chatter-attachment,
chatter-code and chatter-image-error can be styled. Markdown accepts component overrides; a
replacement owns the behavior it replaces.

## Optional Markdown

Bundled Markdown shares native GFM tables/lists, code highlighting, message accents/layouts, image
galleries/side layouts and chat/file links. Native interactive previews, charts, diagrams and
questionnaires stay code blocks in the isolated shell: no message-authored code or privileged
component executes inside the theme. ReactMarkdown remains available for simpler rendering.

## Image transport and native helpers

For your own markup call imageSource(message.id,url,width?) for a lazy <img> src (default 560, range
64-1600). The app validates current-message references and privately loads images: tokens never
enter the theme and general network access stays blocked. Supported raster formats:
PNG/JPEG/WebP/GIF/AVIF/BMP/ICO, up to 16 MiB; failed images offer retry. From user handlers call
openImage/downloadImage(message.id,url), openAttachment/downloadAttachment(message.id,index),
openLink(message.id,url), or copyText(message.id,text). The host checks the latest message/variant
and reuses image/document viewers, downloads, links and clipboard. Viewers temporarily cover the
shell and return to it on close. Do not use openConversation just to show media.

## Original image pixels

For full-resolution viewing entirely inside your theme, use fullImageSource(message.id,url). It
returns a scoped original-image src without requesting a resized thumbnail; assign it to any img or
CSS background in your own modal, side panel, canvas or other layout. The original still uses the
same validated image transport and size bounds. This function never opens the native viewer or
changes navigation.

## Custom image viewers

Optional Image, MessageImages and Markdown components accept onImageClick(image). The callback
receives {chatId,messageId,variantIndex,url,source,alt}; source is already the full-resolution
scoped src. Supplying this callback replaces native openImage behavior. Keep this selection in your
own state and render it however you want. Image also accepts fullSize:true. Close stale selections
when the chat/message/variant changes. For your own overlay, handle Escape with a keydown listener
and event.preventDefault(); the host only navigates back for unconsumed Escape.
Ctrl/Cmd+Alt+Backspace remains the independent recovery shortcut. openImage(id,url) is the optional
native fallback, not a required part of custom viewing.

## Document data and PDF pages

Design document viewing from data/functions: await readAttachment(messageId,index) returns
{kind,name,mimeType,sizeBytes,text,html?,pageCount?}. kind is pdf/docx/spreadsheet/text/unsupported.
text is the existing server-extracted text (which may be an excerpt); DOCX html is sanitized with
the same allowlist as the native viewer. Spreadsheet text uses the existing Markdown representation.
For PDF pages call await renderAttachmentPage(messageId,index,page,width?) with a one-based page and
width 128-1600 (default 1000); the result {source,width,height,page,pageCount} contains PNG page
pixels for any img/canvas/layout. Load pages on demand. These read-only methods need no click but
must catch errors and discard stale async results. They only read current-message attachments and
never reveal server credentials. Native PDF/DOCX parsers and the existing byte cache are reused.

## Custom document viewers

Optional Attachments accepts onAttachmentClick(file), replacing native opening. file contains
chatId,messageId,variantIndex,index,url,name,mimeType,sizeBytes. Use it to select a document in your
own UI and call the read/page functions. No document-viewer markup is required. openAttachment
remains an explicit native fallback.

## Outgoing files

chooseAttachments() (also attachFiles()) is a user-gesture action: it opens the system file chooser,
prepares selected files with the existing format/size/image-compression rules, and keeps the theme
open. The system chooser is the only mandatory native step; the upload panel/list/modal is yours to
build. state.composer has busy, error, items[{id,kind:image|document,name,mimeType,sizeBytes}] and
limits{maxImageCount,maxImageBytes,maxDocumentBytes,imageFormats,documentExtensions}. Items use
stable opaque IDs, never paths or raw file bytes. pendingAttachmentSource(id) provides a scoped
preview src for a pending image. From user handlers call removePendingAttachment(id),
clearPendingAttachments(), or sendMessage(text). Empty text is valid when attachments exist.
sendMessage reuses the normal composer; nothing is uploaded just by selecting files. Render
preparation status and errors from state; actions return request-sent booleans. Pending documents
show metadata until sent, just like the native composer. Selection cancellation or chat changes
during preparation do not add files to another chat.
`,
  'confirmations.md': `# Confirmations

## Subscription, fields and decisions

Subscribe with {navigation:true,confirmations:true} to render full confirmations inside your theme.
state.confirmations entries have id/title/summary, ready/revision/busy/customizable, content[],
fields[] and actions[]. While ready is false show loading. Content nodes are
text/code/markdown/json/email with text, diff with before/after, group with children/optional label,
field with fieldId, or action with actionId. Render email text safely; it can contain HTML. Fields
have id/label/type/value/disabled and optional select options. Use
setConfirmationField(card.id,field.id,value) from input events; checkbox values are boolean, other
values string. Actions have id/label/disabled/group(primary/review/permissions/content)/comment.
Render all available actions, keeping remembered permissions visibly distinct. For comment:true show
your own comment input. On user click call
runConfirmationAction(card.id,action.id,card.revision,optionalComment); it runs the exact current
native callback without leaving the theme. Actions with changed revisions or disabled/busy/resolved
requests are rejected. Native fields and custom fields share one state; do not cache old action
revisions. If the latest field update has not yet been acknowledged, wait for the updated card
before enabling its action.

## Fallback

No automatic approval is performed. The native card remains the fallback for themes without
confirmations:true, unsupported projected content, or shell failure. reviewConfirmation(id) is an
optional explicit escape to that native card, not the normal custom approval action. Existing
appearance/layout preview behavior remains available. The starter has separate
ConfirmationContent/ConfirmationActions/Confirmations components as examples; their markup is not
mandatory.
`,
  'runtime.md': `# State, navigation and rendering

window.chatter.subscribe(callback, {navigation:true, confirmations:true}) immediately supplies the latest ThemeState, keeps it current and returns an unsubscribe function. Use navigation:true when the theme handles home/conversation routing. Use confirmations:true only when it renders every pending confirmation (see confirmations.md). Both options default to false.

Optional useChatterState() from @chatter/ui returns ThemeState | undefined. It subscribes to updates, but does NOT opt into navigation or confirmations. Use an explicit chatter.subscribe with these options in the shell root when you own those flows. Return its unsubscribe from the React effect. Handle undefined while loading.

Read chatter.d.ts for all state fields and function signatures. State includes chats, folders, pagination sections, activeChatId, view, search query/loading, locale, dark, palette, localized labels, messages, message-history loading flags, sending, canSend, attachmentCount, composer, speech and confirmations. Message history is a loaded window; loadOlderMessages() loads earlier pages.

openChat(id) selects a loaded chat. A navigator shell yields to the native conversation; a workspace shell stays visible. showHome() returns to the custom overview. newChat() creates a chat. search(query) uses server search at 3+ characters; state.chats becomes search results. loadMore(folderId) pages a folder (null for unfiled chats). Keep all chats reachable by paging/search or openLibrary(). openSettings(), openLibrary() and openConversation() explicitly open native UI.

Most action methods return whether the request was sent, not whether it completed. Follow state updates. Sending, file selection, message operations and confirmation decisions require an actual user click/key/input event. Read-only document APIs do not. The host rechecks the current chat, variant and permissions.

The theme owns markup, layout, styles and animations. Bundled @chatter/ui components are optional helpers, never a required design. Native interactive/chart/diagram/questionnaire blocks remain code blocks in the isolated Markdown renderer. Untrusted message and tool text must be text or safe Markdown. Only sanitized DOCX preview.html returned by readAttachment is intended for HTML insertion.

Keep input focus, draft text, selection and scroll position across state updates. Respect prefers-reduced-motion. Close custom media selections when chat/message/variant changes. To close your own overlay on Escape, handle keydown and preventDefault; unconsumed Escape navigates home. Ctrl/Cmd+Alt+Backspace always remains host recovery.

The isolated shell has no general network, filesystem, package installation or electronAPI access. Use the bridge for app actions and media. React, react-markdown, remark-gfm and @chatter/ui are bundled. chatter-ui.d.ts describes optional components and callback types.

`,
};
