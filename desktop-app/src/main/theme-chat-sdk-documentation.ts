export const CHAT_SDK_GUIDE = `# Chat SDK: behavior without markup

Import hooks from @chatter/ui. They reuse the native state, API, permissions and workflows;
you own the markup, layout, styles and animations. No component, modal or feature is mandatory.
Optional examples/chat/*.tsx show composition. Reuse theme-owned components for repeated markup.
Plain HTML and advanced React themes can still use the lower-level window.chatter API.

## Shared data, drafts and results

Hooks share the existing subscription; do not fetch/poll or mirror the message list yourself.
Drafts are shared per entity, retained on unmount and separate per chat. Account/server/theme
runtime changes invalidate old stores and callbacks. No second preferences database is introduced.
Hooks never save/send on mount, unmount, navigation or transcription. UI-only state, such as
which dialog is open, belongs to your components.

Keep a navigation owner mounted across home/conversation routes: useConversation({navigation:true}),
useChatLibrary({navigation:true}) or useChatterState({navigation:true}). Capabilities are combined;
plain readers never disable another owner. useConfirmations claims custom confirmation ownership:
render ALL pending cards while it is mounted. useConfirmation(id) alone does not claim ownership.

Most actions return a synchronous boolean: true means ACCEPTED BY THE BRIDGE, not server success.
Text-editor save/submit wraps this acceptance in {ok:true,value}/{ok:false,error}; it is not a server
acknowledgement. Host errors and native confirmation requirements remain authoritative. Preview
reads return actual asynchronous results. Do not show "saved/copied/uploaded" from a queued command.
Call mutations directly in a user event, before awaiting anything, to retain genuine activation.

## Composer, voice and speech

const composer=useComposer(); return <form onSubmit={composer.submit}><textarea {...composer.bind()}/>
  <button disabled={!composer.canSend}>Send</button></form>;

useComposer returns text/setText/clear, canSend/sending/busy/error, limits, items, send(text?), submit,
chooseAttachments, clearAttachments and stop. Each item includes a safe preview source and remove().
bind supplies input/textarea props only. It handles Enter/Shift+Enter, IME composition and file paste;
custom controls can call onPaste/onKeyDown. submitOnEnter:false lets you define another shortcut.
onPaste must execute synchronously in a real paste event; text insertion is prevented only when
the host accepts its files. chooseAttachments opens the system picker; file inputs are blocked.
Native preparation, limits and uploads are reused. Rejected sends keep the draft; accepted sends
clear matching text. Duplicate sends of the same snapshot are blocked. A later server error does
not retroactively change the acceptance boolean; the host still serializes actual sends.

useVoice exposes status/canStart/error/transcript and start/stop/cancel using the native microphone
lifecycle. useComposer inserts completed transcripts once per shared draft, including across
multiple consumers/remounts, without sending. voiceTranscript:false enables manual handling.
useSpeech exposes messageId/status and pause/resume/stop; it reuses the existing audio engine.

## Models, reasoning and context

useModels returns items/options/selectedId/selected, loading/busy/error, automaticSupportsVision,
contextLimit, select(id|null) and bind() for a select. reasoning exposes label/value/options,
available, select(level|null) and bind(). Levels and localized labels come from the SAME native
model catalog/selector, including automatic-model capabilities; never hard-code supported values.
null means automatic; 'none' explicitly disables reasoning when offered. For select options use
value={option.value??''}; bind maps '' back to null. Unsupported levels are rejected. Both selectors
reuse preferences, serialized writes, scope checks and error recovery. See examples/chat/Models.tsx.
useConversation().context includes provider/local source, stale measurement flags and token data;
preserve these semantics rather than inventing estimates. A recap is independent of token visibility.

## Conversation and messages

useConversation returns messages/timeline, loading/sending, hasOlder/loadingOlder/loadOlder,
context/summary. timeline interleaves {kind:'message',key,message} and {kind:'summary',key,summary}
at the host timelineIndex boundary. Original archived messages remain visible. Recaps are not
assistant messages. Do not replace streamed snapshots with final-text-only local buffers.

useMessage(id) returns message/info, hasBody/hasActivity/streaming, actions, can(action),
run(action,{text?,hint?,index?}), variants.previous/next/select and copy/edit/regenerate/speak,
openLink/copyText. hasBody covers nonempty text/images/documents; draw a bubble only when true.
Reasoning, workLog and toolStatus can stream before a final body; their structure is in messages.md.
activity.steps/status suppresses a duplicate current-status row; example WorkLog.tsx renders nested calls.
Action descriptors have id/label/requiresInput/run. Speech labels and speechStatus reflect playback.
edit, regenerateHint and activateVariant need
your input UI; they do not switch to a native editor automatically. speak toggles pause/resume.
Callbacks target their original chat/variant; old ones cannot modify a replacement variant.

useMessageEditor(id) provides text/setText/bind, dirty/canSave/busy/error/errors/conflict,
save/submit/discard/rebase. It preserves hidden drafts and blocks conflicts after incoming changes.
Reconcile before explicitly calling rebase. It submits only on your command (see acceptance above).
For regeneration call useMessage(id).regenerate(optionalHint); the hint UI itself is theme-owned.

## Images and documents

useImage(messageId,url,{fullSize?,width?}) returns source/key/failed/onError/onLoad/retry and
fullSource/openNative/download. useImageViewer adds open(messageId,url,alt?), visible/close and
full-resolution state for any custom pane/dialog. Wire source/key and error/load callbacks yourself.
useDocument(messageId,index,{enabled?}) returns file/data/loading/busy/error/read/reload and
openNative/download. enabled defaults true; null ids/index disable loading. Equivalent reads share
a request/cache. Media/settings reads share one bounded queue instead of flooding the bridge.
useDocumentPage(messageId,index,page,{width?,enabled?}) renders a PDF page.
useDocumentViewer combines selection, document loading, page/setPage/renderedPage and close.
Chat/variant changes invalidate targets; old reads do not replace a new selection. Inactive preview
cache entries are bounded. Retry explicitly, not in an effect loop. Only DOCX data.html from the
host is sanitized HTML; render other text as text and PDF pages as images. Format details: media.md.
Bundled Markdown/Image/Attachments are optional helpers, not required design components.

## Confirmations and chat/folder library

useConfirmations returns the entire queue. useConfirmation(id) returns card/content, fields with
set(value), actions with run(comment?), bind(fieldId), run/set and review(). Draw content/diffs and
all relevant options before asking for a decision. Required comments and revisions are enforced;
nothing is approved automatically. Pending field changes are shared: bind shows the pending value,
busy/waiting disables decisions until the host echoes it. An old callback cannot approve in that gap.
review is an explicit optional native fallback.

useChatLibrary returns chats/folders/groups, activeChatId/query/loading/busy/error/limits,
bindSearch/search, open/newChat/home/loadMore(folderId), openNative/openNativeConversation.
Search and pagination reuse native filtering/cursors; do not filter only the loaded prefix.
groups contains the host totals/loading flags and loaded chats. useChatMenu(id)/useFolderMenu(id)
provide localized available items and scoped operations: chat rename/download/move/setBotHidden/
remove/leave; folder rename/remove. remove/leave require explicit confirmed:true after a real user
confirmation. useChatEditor(id)/useFolderEditor(id|null) provide the same text-form controller as
message editing; null creates a folder. Host permissions, optimistic updates and rollback are reused.
API requests are functions requiring inputs, not automatic fallback buttons for a section.
`;
