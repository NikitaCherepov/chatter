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

## Guides

- docs/theme-files.md: per-theme README.md, persistence and portable theme files.
- docs/library.md: chat/folder menus, available operations and custom forms.
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

Optional useChatterState(options?) from @chatter/ui returns ThemeState | undefined. In the shell root use useChatterState({navigation:true, confirmations:true}) when you render custom navigation and all confirmations. Other components can call useChatterState() with no options. Defaults are false. Active hook consumers share one state subscription; their options are combined, so an ordinary consumer never disables another consumer's capabilities. Unmounting or changing options releases only that consumer's request. Direct chatter.subscribe subscriptions are counted too. No additional explicit subscription is needed when using the hook. Handle undefined while loading. Keep a navigation owner mounted across home/conversation routes; keep confirmations:true mounted only while your theme renders all pending cards.

Read chatter.d.ts for all state fields and function signatures. State includes chats, folders, library operation status, pagination sections, activeChatId, view, search query/loading, locale, dark, palette, localized labels, messages, message-history loading flags, sending, canSend, attachmentCount, composer, speech and confirmations. Message history is a loaded window; loadOlderMessages() loads earlier pages.

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
