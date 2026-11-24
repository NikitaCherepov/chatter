import { APPEARANCE_LABEL_KEYS } from './appearance-shell-types';

// Handbook index and focused guides. API signatures live in chatter.d.ts.
export const THEME_README = `# Local Chatter themes

## Start here

1. Work only in .drafts/<theme-id> using ordinary file tools. .saved and .state.json belong to the app. The folder name and theme.json id must match. Do not increment revision.
2. Ordinary styling needs only theme.json. Copy template.json for palettes, fonts, geometry, materials, background and motion. Fields/ranges are in docs/appearance.json.
3. For a custom UI copy templates/component/ (React) or templates/html/ into a new draft, then change the manifest id/name. These are working examples, not mandatory layouts.
4. On disk the only shell format is {version:1,language:"tsx",scope:"workspace",entry:"App.tsx"} (or language:"html",entry:"index.html"). Source lives in files beside the manifest. Do not put source, sourceFile or files inside the on-disk manifest. The app assembles files internally. There is no legacy inline-source format.
5. Read chatter.d.ts for signatures/state and the relevant guide below. suggest_appearance({id}) validates and offers preview; checkOnly:true only checks. Only the user applies changes. Draft edits refresh an open preview; cancel retains the draft and never changes the active theme.
6. Add/update README.md beside theme.json to explain this theme's idea, files, controls and limitations. It is saved/exported with the theme but is not runtime code. See docs/theme-files.md.

Available API features are not a mandatory UI checklist: choose what suits this theme. See docs/runtime.md, "Choosing features".

## Guides

- docs/theme-files.md: per-theme README.md, persistence and portable theme files.
- docs/library.md: chat/folder menus, available operations and custom forms.
- docs/runtime.md: state/subscriptions (including useChatterState), navigation, isolated runtime and user actions.
- docs/messages.md: content, streaming, workLog, tools, message actions, variants and speech.
- docs/session.md: model selection, context/token indicators and voice recording/transcription.
- docs/settings.md: settings catalog/search, reusable field descriptors, drafts/save/discard and native sections.
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
  'settings.md': `# Settings: data, actions and reusable theme components

## Choose your interface

Settings are optional API capabilities, not a mandatory modal or layout. Build a page, dialog,
drawer, command interface or only the controls your theme needs. getSettingsSections() and
state.settings.sections return the same localized catalog. state.settings.groups provides group
labels. Section IDs are stable; labels change with the app's language. Admin sections are omitted
for non-admin accounts. mode is native (native contents), fields (custom field API) or hybrid
(custom fields plus explicitly listed native editors). Currently app is hybrid; other sections
are native. Never infer that a section is editable just because it is in the catalog.

## Search and opening

searchSettings(query) updates state.settings.query/results/hasMoreResults using the native
settings index of localized UI labels/help, not user values or secrets. Results have sectionId,
key, title, sectionTitle, fieldId (custom field when mapped) and native. At most 50 results are
returned; refine a broad query if hasMoreResults is true. Built-in field labels are indexed;
dynamic records inside native editors remain native for now.
For a custom section call openSettingsSection(id). For a native result/section explicitly call
openSettings(sectionId, optionalResultKey) from a user handler. The native modal opens that
section and can highlight its indexed field, while retaining the selected theme underneath.
openSettings() without arguments remains the ordinary native settings entry.

## Field-based forms

state.settings.editor is null before opening. Afterwards it has sectionId, loading, busy, dirty,
error, groups, links and fields. Each field has id, groupId, type, localized label/help, value
(draft), savedValue, dirty, validation error and visible; select fields add options, number
fields min/max/step. Fields/links are authoritative: do not invent IDs or save unseen unsupported
settings. visible controls presentation (for example, schedule times); validation applies to all
draft fields. Scalar values are string/number/boolean. Numeric/time drafts may temporarily be
invalid while typing; their errors prevent saving. The opaque editor id is handled by the bridge;
authors do not read or increment revisions.

setSettingValue(sectionId,fieldId,value) changes only the draft. saveSettingsSection(sectionId)
requires a real user event and applies only changed valid fields through the same writers as the
native settings. discardSettingsSection(id) restores the saved draft baseline without writes.
reloadSettingsSection(id) reads current settings when the draft is clean. Opening the same section
again keeps its draft. A different custom section cannot replace a dirty draft: save/discard it
first. Hiding your own settings dialog does not save or discard it. Render loading/busy/errors and
disable edits during save. Methods return request-sent booleans; state determines completion.

Before saving the host checks whether changed settings diverged from the baseline. A conflict
preserves the draft: the user may discard and then reload. Successful fields update savedValue;
if a later field fails, earlier successful writes remain applied and only the remaining draft is
dirty. This is not one transaction across local preferences and server settings. Account/server
changes, switching to another theme or unmounting discard obsolete drafts/results; chat navigation
and editing the same theme's source alone retain them.
Section app currently exposes language, theme, lightFrom, darkFrom, zoom, renderPerf, showTokens,
diceRoll. Language/theme/zoom use existing desktop preferences and account UI flags use the existing
UI-settings endpoint. editor.links explicitly lists the native theme editor (no raw theme-file
editor API is implied). Invoke openSettings(link.sectionId,link.target) to open it.

## Reuse your components

Build a single SettingsField renderer by type, wrap it in your SettingsRow/SettingsGroup, and
reuse one SettingsSection component for future field-based sections. This avoids copying forms
per tab. Metadata describes behavior, not appearance: you own typography, controls, icons, grid,
animations and interaction style. No bundled SettingsModal/Select is required. Optional source
examples are in examples/settings/Field.tsx and Section.tsx; copy them together into your draft's
components/ directory and style/replace them. They use the generated ../chatter types. The
starter does not insert a settings UI automatically. For a modal, handle focus and Escape as
described in media.md; an HTML dialog opened with showModal() owns Escape before shell navigation.
`,
  'library.md': `# Chat and folder menus

Menus are data and functions, not a predefined component. This API covers the chat/folder library;
it does not expose the tools panel or the individual tools. It works in navigator and workspace
shells without switching to native UI. Use useChatterState() or subscribe for live data.

## Available actions and state

state.chats adds isOwner (boolean or null when metadata is unknown), botHidden and actions.
Chat actions are rename, downloadDocx, move, setBotHidden, and delete for owned chats OR leave for
joined rooms. state.folders adds actions (rename/delete). Render only the listed operations.
getChatMenu(chatId) and getFolderMenu(folderId) return optional descriptors:
{id,label,disabled,dangerous,requiresConfirmation}. These read-only helpers require no gesture.
Labels are localized from state.labels; bot visibility uses hideFromBot/showInBot as appropriate.
Choose your own icons, menus, inline controls, command palette or terminal commands.

state.library has busy, operation (such as chat:42:rename or folder:create), error,
canCreateFolder and limits{chatTitle:120,folderName:80}. These name limits match server truncation.
busy also covers initial list refresh and in-flight section pagination. Disable commands while
busy. Commands return request-sent booleans, not completion results; observe state changes/error.
Only one library mutation runs at a time, shared with the native sidebar. Errors remain until the
next command; the theme decides where/how to show or dismiss them visually. A newly created
folder appears with its server ID in state.folders; names need not be unique.

Search summaries can lack ownership metadata and expose an empty actions list. Do not infer
ownership or available mutations from the title. Opening that chat refreshes its metadata.
Only currently exposed, loaded entities and destination folders may be targeted. Close stale
menus when their entity disappears. Server access checks still apply. Existing pagination,
folder counts, optimistic updates and error rollback are reused. The client ignores late UI
updates after an account/server/filter scope change.

## Chat operations

- renameChat(id,title): submit your own input. Blank titles are rejected; at most 120 characters.
- downloadChatDocx(id): uses the existing DOCX exporter and system save dialog. Empty chats report
  an error. The current exporter reads up to 10,000 messages; this API does not change that limit.
- moveChat(id,folderId): choose from state.folders; null moves to the unfiled list.
- setChatBotHidden(id,hidden): explicit boolean, not a toggle; the list reflects the resulting state.
- deleteChat(id,true): final deletion of an owned chat, after your own explicit confirmation.
- leaveChat(id,true): final exit from a joined room, after your own explicit confirmation; it is
  not deletion of that room for its owner. delete is unavailable for such rooms.

## Folder operations

- createFolder(name): create a folder, when canCreateFolder and not busy.
- renameFolder(id,name): submit your own input. Nonempty names, at most 80 characters.
- deleteFolder(id,true): after your own confirmation, remove ONLY the folder. Its chats remain
  and return to the unfiled list. It never recursively deletes conversations.

All mutation/export functions require a genuine user click/key event. The final true argument
for delete/leave explicitly acknowledges the theme's own confirmation step; false/missing is
rejected. That flag is not a substitute for a clear confirmation UI. There is no forced menu,
modal markup or automatic confirmation. Do not call these actions from a render/effect. Use a
form submit or command handler so user activation is present. The host revalidates entity,
available action, destination and busy state; vanished/stale requests are rejected. Opening,
editing or submitting these custom menus does not call openConversation/openLibrary.

For example, getChatMenu(id) can populate any UI. A rename form submits renameChat(id,title), a
move chooser submits moveChat(id,selectedFolderId), and your delete confirmation calls
deleteChat(id,true) only from its final confirmation button. Use state.library.error for failures
and keep the user's form text until success. Full signatures and menu types are in chatter.d.ts.
`,
  'theme-files.md': `# Theme files and README

A theme can have a root README.md next to theme.json, with or without a custom shell.
Recommend writing one when creating or substantially changing a theme: explain its idea,
file/component structure, controls, supported features and known limitations. Keep it about this
theme; the app API reference belongs to the workspace docs, not a copied manual in each README.

README.md is optional UTF-8 text, up to 256 KiB (bytes). It is not runtime code, is never executed,
does not count toward the 256 source files or 500,000 source characters, and is not automatically
injected into the model prompt. Authors can read/edit it with ordinary file tools when relevant.
Keep personal chat data, secrets and generated user-specific content out of portable theme docs.

Saving captures the README with that exact theme version. It survives app restart, draft rewriting,
workspace copying, ZIP import/export and rollback. Preview remains reversible; editing a README in
the draft never edits the published version. A proposal retains its captured README, even if the
draft is edited while awaiting a decision. Empty README files and an absent README are distinct;
delete the draft file and publish that draft to remove it from a saved version.

On disk use README.md only, not a readme field in theme.json or shell.files. The internal full-profile
transport uses optional readme text so existing editor/save/proposal paths can preserve it. ZIP
exports carry it as a file. Both templates/component/ and templates/html/ contain a README stub.
`,
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
running call or activity entry; avoid drawing it twice. templates/component/components/WorkLog.tsx demonstrates
these fields without prescribing a layout.

## Available actions

In workspace scope, each state.messages item includes variantIndex, variantCount and actions: the
action names currently available for that message. This is an allowlist, not a requirement to show
every action. Use it to render whichever controls you design,
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

## Optional message information

message.info supplies modelName, providerName, tokenCount, tokenCountSource, usage and performance.
It is display data, not a required footer: omit it, put it in a popover or design any other view.
tokenCount follows the native renderer: assistant provider completion tokens when positive,
otherwise the local message token estimate. tokenCountSource is provider/estimate/null; do not
present estimates as exact billing. usage contains aggregate provider prompt/completion/total,
cache-hit/cache-miss and reasoning tokens across the response's calls, not just the final text.
performance has firstTokenLatencyMs, generationMs, totalMs and tokensPerSecond. Durations are ms;
generation excludes tool pauses, total includes them. Unknown values/blocks are null, not zero.
Respect context.showTokens when deciding whether to display numeric statistics. Record metadata
may be absent until the response is persisted. See chatter.d.ts for exact field names.
`,
  'session.md': `# Models, context and voice input

These are optional capabilities. Choose the controls/indicators your design needs; see
runtime.md (Choosing features). No model picker, token badge, microphone or statistics footer
component is mandatory. All data/functions below work without opening the native conversation.

## Model selection

state.models contains items, selectedId, automaticLabel, automaticSupportsVision, loading, busy,
error and contextLimit. Catalog items expose id/name/description, supportsVision, isFree,
contextLength, averageTokensPerSecond, intelligenceTier and priceTier; unavailable stats are null.
Only the models actually available to this account are listed. selectedId:null means automatic.
Call selectModel(id) or selectModel(null) directly from a user click/change handler. It uses the
same account-level preferred-model setting as the native selector, not a per-chat override.
Changes affect future generation; they do not replace an already running response. Follow busy,
error and selectedId for completion; a true return means request sent. The host validates IDs,
serializes changes and retains the previous selection on failure. Account/server changes discard
late UI updates. Build your own select, command menu, cards or other selection UI.

## Context and tokens

state.context contains showTokens (the user's numeric-statistics preference), limit (effective
selected model/user context cap when known), tokens (current context estimate), cachePercent,
messagesTokens, reasoningTokens, systemPromptTokens, activeMessages, archivedMessages and latest.
latest contains modelName and provider prompt/completion/total/cache-hit/cache-miss/reasoning
tokens for the latest response. models.contextLimit is the user's configured cap before applying
a selected model's smaller cap. Automatic routing may leave the effective limit unknown.
Unknown/unloaded values are null; zero is a real count. Counts use the existing context service,
not a sum of all displayed message rows. Chat changes clear the previous chat's counts. Cache
percent uses latest cache-hit / latest prompt tokens; it is not the fraction of context occupied.
Per-message statistics are in message.info (messages.md).

## Recording and transcription

state.voice has status idle/requesting/recording/transcribing, canStart, error and transcript.
startVoiceRecording() requests the microphone and records through the trusted host; the isolated
theme itself has no microphone permission. stopVoiceRecording() finishes manual recording and
starts the app's configured local/server recognition. cancelVoiceRecording() discards recording
or pending recognition; delayed permission/transcription results are ignored. Call these from
user click/key handlers and respect canStart/status. Recordings are scoped to the current chat,
account and server; switching/unmounting stops capture and discards late results. No raw audio or
device access is given to the theme. The microphone stream is released when stopped/cancelled.
The native wake-word flow remains separate; voice status also reflects its recording/recognition.
Stopping that automatically managed flow cancels it using its existing stop behavior.

Manual theme dictation returns transcript:{id,text}, or null before a result. Append each new id
once to your draft (or show it for review). Keep the consumed id in the persistent composer/root
so remounting a dialog does not insert it twice. Example inside that persistent React component:
const lastTranscript = React.useRef<number | null>(null);
React.useEffect(() => {
  const result = state?.voice.transcript;
  if (!result || result.id === lastTranscript.current) return;
  lastTranscript.current = result.id;
  setText(previous => previous ? previous + ' ' + result.text : result.text);
}, [state?.voice.transcript]);

The transcript stays available until the next manual recording or chat/account change; repeated
state updates are not new results. Recognition never sends a manual theme message automatically:
the user reviews it and your send control calls sendMessage(text). Playback/paused/loading of
spoken replies uses state.speech and the separate speak/pause/resume/stop methods (messages.md).
Recording, recognition and reply playback are distinct states; do not combine them into one flag.
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

Code blocks: components.code owns the entire .chatter-code block, including its header, copy
button and body. components.pre wraps that output and defaults to a transparent fragment;
replacing only pre does not remove the built-in code header. For a complete custom block use
components={{pre:({children})=><>{children}</>,code:CustomCode}}.
CustomCode must handle inline code too: node.properties['data-code-block'] === 'yes' identifies a
block; node.properties['data-code-source'] contains its original text, and className carries the
language. Copy that source via chatter.copyText(messageId,source), not navigator.clipboard.

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

## Image failures and retry

The optional Image helper (also used by Markdown/MessageImages) replaces a failed img with a
button.chatter-image-error. Its label is state.labels.imageLoadFailed (localized); clicking clears
the failure and mounts the image again. It is an interactive retry button, not an error banner.
Changing the source resets its failure state automatically. Style it as a button, preserving its
keyboard/focus behavior. If you replace image markup, you own this behavior: track onError per
source, show an accessible retry control, and clear the error to mount the img again. imageSource
and fullImageSource return src strings; they do not create an error UI. There is no retryImage API,
and opening the native conversation is not required.

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

The bridge currently has no reliable original extraction character count or explicit truncation
flag. text.length is the number of available string code units, not a guaranteed full-document
length; server char_count also describes the stored extraction. Do not infer completeness from
file byte size, pageCount, or the absence of a truncation marker. Show the available text count
without an invented total; offer downloadAttachment for the original. DOCX html and PDF page
pixels come from the original attachment and are separate from this text extraction limitation.

## Custom document viewers

Optional Attachments accepts onAttachmentClick(file), replacing native opening. file contains
chatId,messageId,variantIndex,index,url,name,mimeType,sizeBytes. Use it to select a document in your
own UI and call the read/page functions. No document-viewer markup is required. openAttachment
remains an explicit native fallback.

## Outgoing files

chooseAttachments() (also attachFiles()) is a user-gesture action: it opens the system file chooser,
prepares selected files with the existing format/size/image-compression rules, and keeps the theme
open. Picking files from disk uses the system chooser; the upload panel/list/modal is yours to
build inside the theme. state.composer has busy, error, items[{id,kind:image|document,name,mimeType,sizeBytes}] and
limits{maxImageCount,maxImageBytes,maxDocumentBytes,imageFormats,documentExtensions}. Items use
stable opaque IDs, never paths or raw file bytes. pendingAttachmentSource(id) provides a scoped
preview src for a pending image. From user handlers call removePendingAttachment(id),
clearPendingAttachments(), or sendMessage(text). Empty text is valid when attachments exist.
sendMessage reuses the normal composer; nothing is uploaded just by selecting files. Render
preparation status and errors from state; actions return request-sent booleans. Pending documents
show metadata until sent, just like the native composer. Selection cancellation or chat changes
during preparation do not add files to another chat.

For Ctrl+V (or the system Paste command), call attachPastedFiles() synchronously from your message
input's paste handler. It returns true when it claims image/document files from that actual user
paste; then preventDefault(). Text-only paste returns false: allow the browser to insert it.
React: onPaste={event=>{if(window.chatter.attachPastedFiles())event.preventDefault();}}.
HTML: input.addEventListener('paste',event=>{if(chatter.attachPastedFiles())event.preventDefault();}).
No event/File argument is needed; the isolated preload captures the original trusted event.
Calls outside dispatch, synthetic events, repeated claims or a busy composer return false. This
does not read the clipboard in the background. Accepts screenshots and files exposed by the OS
as clipboard files (not a copied file-path string). Uses the same preparation, preview, removal
and sending flow as chooseAttachments. Transfer ceiling: 256 files / 50 MiB total per paste;
unreadable/oversized files show preparation errors. No upload occurs until sendMessage.

## Custom attachment dialogs

A theme can create its own dialog, drawer, terminal prompt or inline attachment view using the
same functions and state. No upload-modal component is required. Opening/closing this view is
local theme state; chooseAttachments() only selects files and updates state.composer. Render
pendingAttachmentSource(id) for image previews and metadata for documents. Offer remove/clear
using the existing methods, and show busy/error when offering attachment handling. Closing the
view does not discard pending files; call clearPendingAttachments() explicitly to discard them.
Files are sent only by sendMessage(text), including attachment-only messages with empty text.

Use a dialog/overlay inside the isolated theme DOM; no additional native window is needed. For
a modal, label it, move focus inside, keep Tab within it and restore focus on close. A native
HTML dialog with showModal() supplies focus containment and a top layer inside the theme;
Escape is reserved for that modal instead of shell navigation. Handle close/cancel events to
synchronize local state. For your own div/aside overlay, consume the Escape keydown with
preventDefault() before closing it; otherwise Escape may navigate the whole shell home. Invoke chooseAttachments
directly in a user handler, not after a timeout/effect. Put attachPastedFiles() on the message
input or an editable paste target in your dialog. A plain text file-path string is not a file.
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

## Choosing features

The API describes available data and functions, not a checklist of controls to put in every
theme. Choose which capabilities serve the intended design. Message metadata/statistics,
individual message actions, model/context indicators, attachments and voice controls need not
all be visible. A theme may omit a feature, show it on demand, or present it in its own way;
do not fill the interface with controls merely because a field/method exists. This does not
make new APIs available: consult chatter.d.ts for what this desktop version actually exposes.
The starter is an example, not a completeness requirement. Describe intentional omissions in
the theme README when helpful. For a feature you do offer, respect its permissions, availability,
busy/error states and user gestures. Capability ownership is separate: navigation:true requires
working navigation; confirmations:true requires rendering every pending confirmation. Leave
those flags false when relying on native handling. See the corresponding guides.

## Subscriptions and state

window.chatter.subscribe(callback, {navigation:true, confirmations:true}) immediately supplies the latest ThemeState, keeps it current and returns an unsubscribe function. Use navigation:true when the theme handles home/conversation routing. Use confirmations:true only when it renders every pending confirmation (see confirmations.md). Both options default to false.

Optional useChatterState(options?) from @chatter/ui returns ThemeState | undefined. In the shell root use useChatterState({navigation:true, confirmations:true}) when you render custom navigation and all confirmations. Other components can call useChatterState() with no options. Defaults are false. Active hook consumers share one state subscription; their options are combined, so an ordinary consumer never disables another consumer's capabilities. Unmounting or changing options releases only that consumer's request. Direct chatter.subscribe subscriptions are counted too. No additional explicit subscription is needed when using the hook. Handle undefined while loading. Keep a navigation owner mounted across home/conversation routes; keep confirmations:true mounted only while your theme renders all pending cards.

Read chatter.d.ts for all state fields and function signatures. State includes chats, folders, library operation status, pagination sections, activeChatId, view, search query/loading, locale, dark, palette, localized labels, messages, message-history loading flags, sending, canSend, attachmentCount, composer, models, context, voice, speech, settings and confirmations. Message history is a loaded window; loadOlderMessages() loads earlier pages.

## Localized labels

state.labels uses the app's current locale (state.locale), including Russian translations when
Russian is selected. Known keys, also enumerated as LabelKey in chatter.d.ts:
${APPEARANCE_LABEL_KEYS.join(', ')}.

These are human-readable labels, not stable command identifiers. Action names such as copy or
regenerate stay technical IDs. A theme can display its own terminal tokens like [copy] and use
labels.copy as an accessible aria-label, or display the localized value directly. Most action IDs
match label keys; activateVariant uses previousVariant/nextVariant for directional controls.
confirmations:true cards carry their own title/field/action labels. Unknown future label keys may
be absent; use a theme-authored fallback. The hook does not translate custom text automatically.

## Navigation

openChat(id) selects a loaded chat. A navigator shell yields to the native conversation; a workspace shell stays visible. showHome() returns to the custom overview. newChat() creates a chat. search(query) uses server search at 3+ characters; state.chats becomes search results. loadMore(folderId) pages a folder (null for unfiled chats). Keep all chats reachable by paging/search or openLibrary(). openSettings(), openLibrary() and openConversation() explicitly open native UI.

Most action methods return whether the request was sent, not whether it completed. Follow state updates. Sending, file selection, message operations and confirmation decisions require an actual user click/key/input event. Read-only document APIs do not. The host rechecks the current chat, variant and permissions.

The theme owns markup, layout, styles and animations. Bundled @chatter/ui components are optional helpers, never a required design. Native interactive/chart/diagram/questionnaire blocks remain code blocks in the isolated Markdown renderer. Untrusted message and tool text must be text or safe Markdown. Only sanitized DOCX preview.html returned by readAttachment is intended for HTML insertion.

Keep input focus, draft text, selection and scroll position across state updates. Respect prefers-reduced-motion. Close custom media selections when chat/message/variant changes. To close your own overlay on Escape, handle keydown and preventDefault; unconsumed Escape navigates home. Ctrl/Cmd+Alt+Backspace always remains host recovery.

The isolated shell has no general network, filesystem, package installation or electronAPI access. Use the bridge for app actions and media. React, react-markdown, remark-gfm and @chatter/ui are bundled. chatter-ui.d.ts describes optional components and callback types.

`,
};

export const THEME_SETTINGS_EXAMPLES: Record<string, string> = {
  'Field.tsx': `import React from 'react';
import type { SettingsField } from '../chatter';
export default function Field({ sectionId, field, disabled }: { sectionId: string; field: SettingsField; disabled: boolean }) {
  const inputId = React.useId();
  if (!field.visible) return null;
  const update = (value: string | number | boolean) => window.chatter.setSettingValue(sectionId, field.id, value);
  const describedBy = field.help || field.error ? inputId + '-help' : undefined;
  const props = { id: inputId, disabled, 'aria-describedby': describedBy, 'aria-invalid': Boolean(field.error) };
  return <div className="settings-row" data-setting={field.id}>
    <label htmlFor={inputId}>{field.label}</label>
    {field.type === 'select' ? <select {...props} value={String(field.value)} onChange={event => update(event.target.value)}>{field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
      : field.type === 'toggle' ? <input {...props} type="checkbox" checked={field.value === true} onChange={event => update(event.target.checked)}/>
      : <input {...props} type={field.type} min={field.min} max={field.max} step={field.step} value={String(field.value)} onChange={event => update(event.target.value)}/>}
    <div id={inputId + '-help'}>{field.help && <p>{field.help}</p>}{field.error && <p role="alert">{field.error}</p>}</div>
  </div>;
}
`,
  'Section.tsx': `import React from 'react';
import { useChatterState } from '@chatter/ui';
import Field from './Field';
export default function Section({ sectionId }: { sectionId: string }) {
  const state = useChatterState();
  React.useEffect(() => { window.chatter.openSettingsSection(sectionId); }, [sectionId]);
  const editor = state?.settings.editor;
  if (!state || !editor || editor.sectionId !== sectionId) return null;
  return <section className="settings-section" aria-busy={editor.loading || editor.busy}>
    <h2>{state.settings.sections.find(section => section.id === sectionId)?.label}</h2>
    {(editor.loading || editor.busy) && <p role="status">{state.labels.loading}</p>}
    {editor.error && <p role="alert">{editor.error}</p>}
    {editor.groups.map(group => <fieldset key={group.id} disabled={editor.busy || editor.loading}><legend>{group.label}</legend>{editor.fields.filter(field => field.groupId === group.id).map(field => <Field key={field.id} sectionId={sectionId} field={field} disabled={editor.busy || editor.loading}/>)}</fieldset>)}
    {editor.links.map(link => <button type="button" key={link.id} disabled={editor.loading || editor.busy} onClick={() => window.chatter.openSettings(link.sectionId, link.target)}>{link.label}</button>)}
    <button type="button" disabled={!editor.dirty || editor.busy || editor.loading || editor.fields.some(field => field.error)} onClick={() => window.chatter.saveSettingsSection(sectionId)}>{state.labels.save}</button>
    <button type="button" disabled={!editor.dirty || editor.busy || editor.loading} onClick={() => window.chatter.discardSettingsSection(sectionId)}>{state.labels.cancel}</button>
    <button type="button" disabled={editor.dirty || editor.busy || editor.loading} onClick={() => window.chatter.reloadSettingsSection(sectionId)}>Reload</button>
  </section>;
}
`,
};
