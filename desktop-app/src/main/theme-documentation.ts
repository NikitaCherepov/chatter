import { APPEARANCE_LABEL_KEYS } from './appearance-shell-types';

// Handbook index and focused guides. API signatures live in chatter.d.ts.
import { SETTINGS_OPERATIONS_GUIDE } from './theme-settings-request-documentation';
import { THEME_SETTINGS_RESOURCE_EXAMPLES } from './theme-settings-resource-examples';

export const THEME_README = `# Local Chatter themes

## Start here

1. Work only in .drafts/<theme-id> using ordinary file tools. .saved and .state.json belong to the app. The folder name and theme.json id must match. Do not increment revision.
2. Ordinary styling needs only theme.json. Copy template.json for palettes, fonts, geometry, materials, background and motion. Fields/ranges are in docs/appearance.json.
3. For a custom UI copy templates/component/ (React) or templates/html/ into a new draft, then change the manifest id/name. These are working examples, not mandatory layouts.
4. On disk the only shell format is {version:1,language:"tsx",scope:"workspace",entry:"App.tsx"} (or language:"html",entry:"index.html"). Source lives in files beside the manifest. Do not put source, sourceFile or files inside the on-disk manifest. The app assembles files internally. There is no legacy inline-source format.
5. Read chatter.d.ts for signatures/state and the relevant guide below. suggest_appearance({id}) validates and offers preview; checkOnly:true only checks. Only the user applies changes. Draft edits refresh an open preview; cancel retains the draft and never changes the active theme.
6. Add/update README.md beside theme.json to explain this theme's idea, files, controls and limitations. It is saved/exported with the theme but is not runtime code. See docs/theme-files.md.

Available API features are not a mandatory UI checklist: choose what suits this theme. See docs/runtime.md, "Choosing features".

## Build with reuse

Keep generation and maintenance small by reusing code as you write it:

- Use the existing SDK for supported behavior before writing loading, draft, save or error-handling logic yourself. For React settings start with docs/settings-sdk.md.
- When the same structure serves the same purpose in two places, extract one theme-owned component and import it. Repeated fields, cards, dialogs and groups such as a form hint with Save/Discard buttons should share their markup; pass differences as props or children. Visual similarity alone does not require an abstraction.
- Share repeated CSS through a base class, modifiers and variables instead of copying rules for each screen. A repeated group can start as a local component or shared class; a separate file for every small element is unnecessary.
- Split larger themes by responsibility: keep the entry focused on composition and import panels, editors and shared components from separate files. Small themes may stay small. No fixed folder structure is required.
- Reuse preserves the theme's own markup, style and animations. Do not simplify its design or replace cards with tables just to reduce code size. Bundled UI components remain optional.

## Guides

- docs/theme-files.md: per-theme README.md, persistence and portable theme files.
- docs/library.md: chat/folder menus, available operations and custom forms.
- docs/runtime.md: state/subscriptions (including useChatterState), navigation, isolated runtime and user actions.
- docs/messages.md: content, streaming, workLog, tools, message actions, variants and speech.
- docs/session.md: model selection, context/token indicators and voice recording/transcription.
- docs/settings-sdk.md: start here for settings; headless editors, shared drafts, typed operations and queries.
- docs/settings.md: catalog/search, field descriptors and the lower-level bridge.
- docs/settings-operations.md: account security forms, memory spaces/records/map, quotas, agents and theme management.
- docs/settings-intuition.md: intuition preferences, editable questions and generated suggestions.
- docs/settings-profiles.md: prompt libraries, generation, personas and their avatars.
- docs/settings-instructions.md: persona instructions and the complete questionnaire workflow.
- docs/settings-profile-images.md: custom avatar pickers, previews and cropping without native modals.
- docs/media.md: images, full-resolution viewers, documents and outgoing attachments.
- docs/confirmations.md: custom confirmation UI, fields, decisions and native fallback.
- docs/appearance.json: ordinary appearance fields, allowed values and ranges.
- chatter.d.ts: bridge signatures and ThemeState. chatter-ui.d.ts: headless SDK and optional components.
- templates/component/ and templates/html/: complete file-based examples. template.json: ordinary theme.

## Project rules and limits

Each shell project may contain up to 256 runtime files and 500,000 source characters TOTAL, not per file. These limits apply independently to each theme. Every discovered runtime file counts, even if not imported. A project with 13 runtime files has 243 file slots left; splitting code does not change the total character budget.

The app discovers .ts/.tsx/.js/.jsx/.css/.json/.html recursively (depth up to 8). theme.json, tsconfig.json, .d.ts, node_modules and hidden directories are excluded. TSX entries default-export a React component. Relative imports, index imports, JS-to-TS resolution and @/ project-root aliases are supported in React projects. HTML uses normal relative script/link references to its own JS/CSS files; browser modules need explicit filenames. General network access stays blocked.

Local raster backgrounds use assets/image.png (PNG/JPEG/WebP/GIF, up to 8 MiB); HTTPS background links remain external. ZIP import/export supports the full 256-file project plus service files/assets (up to 512 file entries and 12 MiB total). Generated code need not fit into one file.
`;

export const THEME_GUIDES: Record<string, string> = {
  'settings-sdk.md': `# Settings SDK: behavior without markup

Use the bundled @chatter/ui SDK for new React settings interfaces. The SDK has no modal, styles,
layout, routing or required controls. It exposes data, state and methods. Draw a page, cards,
floating panels or command UI. The lower-level window.chatter methods remain available for HTML
and custom workflows. The host's endpoints, gesture checks and conflict guards are unchanged.

## Smallest useful editor

const form = usePersonaEditor(personaId); // number for an existing persona, null for a new draft
return <form onSubmit={form.submit}>
  <textarea {...form.bind('coreMemory')}/>
  <button disabled={!form.canSave}>Save</button>
  <button type="button" onClick={form.discard}>Discard</button>
</form>;

Render form.loading, busy, error, errors and conflict where appropriate. bind supplies only input
value/checked/onChange/disabled/aria-invalid; it has no markup or style. Use draft and set instead
for custom controls or commands. View choices (selected tab, dialog visibility, filters, zoom)
remain your UI state. Do not recreate loading effects, draft baselines or stale-response guards.

## Sessions and ownership

Hooks open their section automatically with openSettingsSession. Host state.settings.editors has
one canonical session per opened section. Several sections can coexist. state.settings.editor
remains the legacy active-section pointer; SDK code should use hooks, not that pointer.
Ordinary scalar drafts live in the existing host controller. Structured drafts live once in the
SDK, keyed by session and entity; consumers of the same editor share them. They are not duplicate
server preferences and are not written to disk. Hiding/unmounting a form retains its draft within
the same session; returning to that entity restores it. Changing entity changes the draft key.
Account/server/role/theme change, runtime destruction or explicit section reload invalidates the
old session and its SDK stores. Chat navigation alone does not reset them. Discard explicitly
abandons a draft. Saving never happens on unmount, blur, tab switch or proposal generation.

## Forms and conflicts

Editors provide draft, saved, dirty, loading, busy, error, errors, conflict, canSave and
set(key,value), replace(value), bind(key), save(), submit(event), discard(), rebase(), clearError().
save/submit are direct user actions. Reloaded data updates a clean form. A dirty form keeps its
input; newer stored data is retained as incoming and conflicting saves are blocked. discard adopts
stored data. After deliberately reconciling edits, rebase accepts the new baseline while keeping
your edited draft; never call it automatically. Native CAS/preflight checks still run on saving.
An unchanged ordinary form does not write again. Applying a survey proposal and submitting even
empty optional answers are distinct explicit workflow actions and still reach the host.

Methods that call Promise operations return {ok:true,value} or {ok:false,error}; failures remain
in the controller and do not become unhandled rejections from JSX handlers. Mutations invoke the
bridge before their first await, preserving genuine user activation. Already submitted mutations
can finish on their original server after closing; a stale result never updates a new scope.

## Ready-made behavior, arbitrary UI

- useSettingsSection(id): ordinary fields/groups/actions/links, field(id), bind(id), set, save,
  discard, reload, run and submit. Uses the host's existing scalar draft, availability and validation.
  hasDraftChanges includes nested structured forms; canReload/reload protect them from an accidental
  whole-section reset. Refresh a resource with its own reload to preserve and reconcile its draft.
- usePersonas / usePrompts: shared library data and activate/select/remove(id,confirmed:true).
- usePersonaEditor(id|null) / usePromptEditor(id|null): editable profile forms. createdId identifies
  a successfully created entry. Prompt creation selects it; persona creation does not. Prompt
  generate returns a separate proposal; useProposal copies it into the local draft only. Its
  sections/sectionKeys/setSection support the native advanced editor format without extra requests.
- useIntuitionEditor: config/questions, addQuestion/updateQuestion/removeQuestion/useDefaults,
  suggest, proposal and useProposal. Stable question ids, defaults and save behavior are handled.
- usePersonaInstructions(id): saved instruction form, surveys, selected/select, answers form,
  proposal form, create, regenerate, followUp, apply and remove(surveyId,removeApplied,true).
  create accepts the same optional choices as createPersonaSurvey. answers.submit invokes the
  native answer validator/generator; apply is the final explicit instruction change. Failed AI
  stages reload stored survey state without discarding local text. Read settings-instructions.md
  for context sharing, quota, immutable answers and restoration semantics. No hidden consent.
- useProfileAvatar(section,id): source/pick(file)/crop(rect,outputSize?)/save/remove/discard.
  A picker and cropper can have any markup. Picking/cropping does not upload; save is explicit.

Examples/settings are copyable markup patterns using these controllers. They do not automatically
mount in your theme and are not a feature checklist. A persona profile editor excludes its separate
instruction text so saving a biography cannot overwrite an instruction editor's newer work.

## Generic building blocks

useSettingsApi(section) exposes typed methods: const api=useSettingsApi('memory'); api.listSpaces().
It returns ordinary rejecting Promises, for advanced composition. requestSettings remains intact.
useSettingsResource(section,readOperation,params?) supplies shared data/loading/busy/error/reload.
Only non-gesture reads auto-load. It deduplicates equivalent reads and schedules them within the
bridge's concurrency budget. Canceled reads may retry once when idle; failures never start a polling loop.
useSettingsAction(section,operation,key?) provides run(params), busy/error/data without effects or
parameter retention. Destructive calls still require your own confirmation and confirmed:true.
useSettingsTask(section,key) wraps a custom asynchronous user action with the same result/error
handling. useSettingsQuery(section,key,loader,enabled?) supports dependent read queries.
useSettingsForm(section,key,value,writer,validate?) provides shared draft behavior for other forms.
Keys must distinguish different entities/workflows; two consumers using one key share one form.
Do not put passwords/secrets in shared forms or resource keys. AccountSecurity.tsx keeps credentials
only in the submission handler, clears inputs immediately and uses useSettingsAction.

## Types and compatibility

chatter-ui.d.ts and settings-sdk.d.ts describe the SDK. They are generated from its implementation
by build:sdk; operation types come from the same contract as the handbook. Applications own saved
settings. The SDK introduces no theme-specific preference database or alternate API endpoints.
Existing raw bridge themes retain their old opening/dirty/save behavior. SDK sessions are additive;
adopting one for the currently open section reuses the same host editor and scalar draft.
`,
  'settings-instructions.md': `# Persona instructions and questionnaires

Open the personas section, load listPersonas, then call getPersonaInstructions({id}) for a known
persona. It returns saved text and up to 50 most recent surveys. A persona always has enabled:true
and mode:'both'; the both/persona/chat/off selector belongs to per-chat settings, not this editor.
No new instruction mode is invented here. Types are in chatter.d.ts. Optional starting points:
examples/settings/PersonaInstructions.tsx and SurveyQuestions.tsx. Compose or replace their markup.

## Saving text

Keep changes locally. savePersonaInstructions({id,text}) explicitly saves at most 12000 characters
and returns the refreshed instruction state/surveys. The host retains the text read from the server
for the existing atomic compare-and-save check. instructions_changed preserves the server's newer
text: retain your draft, reload, reconcile and submit again. Never retry automatically. You need
getPersonaInstructions again after that conflict. Persona biography/core memory are not changed.

## Creating a proposal

createPersonaSurvey({id,brief?,currentText?,questionCount?,includePrompt?,personalize?,modelId?})
creates and stores a questionnaire, returning {survey}. brief defaults to empty (max 2000), currentText
to the last loaded instructions (max 12000), questionCount to 10 (integer 1..100). The model may ask
fewer questions. includePrompt and personalize default to false: offer explicit user controls and
explain data use. includePrompt supplies the selected assistant prompt; personalize permits the
native preference agent to consult permitted memory. Persona surveys NEVER receive chat history.
The host ignores extra scope/target/history fields; the target is always the known persona id.

listGenerationModels returns allowed id/name pairs and the preferred selectedId. Load it before
passing an explicit modelId. Omit modelId to use the server preference; null explicitly chooses
automatic selection for surveys. Subsequent stages use the survey's saved model and evidence.
Generation operations require a direct user gesture, can consume quota and store surveys/answers;
they never replace active instructions. An already submitted request can finish after closing.

## Questions, answers and review

survey.questionnaire contains id/title/questions. Each question has a stable id, label, required,
type (single/multiple/text/textarea), optional options, allowOther and image metadata. Render any
interface; a questionnaire component is not required. Submit answerPersonaSurvey({id,surveyId,answers}).
Answer keys must match question ids. Text is a string; multiple is a string array of option values;
an allowed custom answer is {other:string,selected?:string[]} (selected applies to multiple only).
Required/options/lengths are checked by the shared native validator and the server. Text limits:
1000 characters, textarea 4000, other 1000; at most 32000 serialized answer-value characters total.

Answering stores answers, then generates survey.draft; instructions stay unchanged. If generation
fails after saving answers, reload getPersonaInstructions and offer regeneratePersonaSurvey with
the same id/surveyId. Saved answers are immutable; submitting different answers to an answered
survey is rejected. regeneratePersonaSurvey uses saved answers/evidence and replaces only its draft.
followUpPersonaSurvey({id,surveyId,brief?}) creates a NEW round from an answered survey, using all
earlier rounds and saved context; brief is optional, max 2000. Review the returned survey separately.

Show draft in an editable local field. applyPersonaSurvey({id,surveyId,text}) is the FINAL explicit
application, with the native conflict protection. It returns refreshed state. The applied text may
be edited (max 12000). Do not auto-apply a generated draft or silently overwrite a dirty local form.

deletePersonaSurvey({id,surveyId,removeApplied,confirmed:true}) requires a user confirmation.
removeApplied:false deletes the questionnaire only. true also restores the pre-survey instructions
when its applied text is still current; otherwise instructions_changed protects newer edits. Explain
this choice explicitly. Deletion/apply/save return refreshed state and update native persona consumers.
Survey IDs must come from reads/results for this same persona; a different persona/chat is rejected.

## Failure and recovery

Show loading/busy and retain local inputs on errors. Known errors include instructions_changed,
survey_busy, survey_already_answered, survey_not_answered, questionnaire_invalid, quota_exceeded,
model_not_available and survey_context_too_large. Reload stored state after a failed/timed-out AI
stage; it may already have saved answers or a survey. No polling, hidden application or second store
is introduced. Titles, questions, answers and proposals are untrusted text, never executable HTML.
`,
  'settings-profile-images.md': `# Profile image functions

Prompt/persona avatars share the same functions. Read listPrompts/listPersonas before addressing
an existing id. getPromptImageSource/getPersonaImageSource({id}) returns {source:dataURL|null}.
Use that source in any custom viewer/crop editor; raw image_url/imageUrl is metadata, not permission
for a sandbox network fetch. Failed reads reject instead of pretending the avatar is absent.

Build a file input or drag/drop picker in the theme. Read only user-selected PNG/JPEG/WebP/GIF,
up to 10 MiB decoded, as raw base64 (remove FileReader's data-URL prefix). cropProfileImage accepts
{base64,mimeType,crop:{x,y,size},outputSize?} in either the prompt or personas section. Coordinates
are pixels in the decoded image; the square must fit inside it. outputSize defaults to 512,
integer 1..2048. The existing server image budget of 60 million source pixels also applies.

Invoke cropProfileImage from the crop confirmation button. It returns PNG base64, mimeType,
previewUrl (a data URL), width and height. It never opens a native dialog, saves an avatar or
changes the active profile. Draw your own preview, zoom and pan. For a square viewport of side V,
source W/H, zoom Z>=1 and pan offsets dx/dy: scale=max(V/W,V/H)*Z; size=V/scale;
x=(W*scale-V)/2/scale-dx/scale; y=(H*scale-V)/2/scale-dy/scale. Clamp pan so the square stays inside.
The native editor and bridge share the same crop implementation. Cropping flattens animations.

Keep the result in local draft state. setPromptImage/setPersonaImage({id,base64,mimeType}) performs
the separate explicit save on an existing custom prompt/persona. Save a new profile first.
deletePromptImage/deletePersonaImage removes its image. Built-in prompts are not editable.
You may upload the original without cropping. Optional examples/settings/ProfileAvatar.tsx shows
a picker, source preview, crop controls and explicit upload, with fully replaceable markup.
`,
  'settings-profiles.md': `# Prompts and personas

Open openSettingsSection('prompt' or 'personas'), wait for editor.loading=false, then load the
library with listPrompts or listPersonas. These sections offer operations with empty fields arrays.
Build any form/list/layout; examples/settings/ProfileLibrary.tsx is an optional
starting point. Keep unsaved input in your own state and ask before discarding it on selection.
Signatures/results live in SettingsRequestContract in chatter.d.ts.

## Prompts

listPrompts returns built-in prompts (metadata only), custom_prompts (editable content), the
selected_prompt_id and max_custom_prompt_length when supplied by the server. IDs are opaque:
pass the returned id unchanged, including negative IDs. Built-ins are selectable, not editable.
Legacy id -1 selects the old single custom_prompt_content; create a library entry to edit a copy.

createPrompt({name,description?,content}) saves AND selects the new prompt, just like native
settings. Tell the user this before the final submission. updatePrompt({id,name,description?,content})
edits a custom entry; selectPrompt selects an existing entry. Results refresh the library; creation
also returns createdId. Use the returned plan-specific content limit and handle server errors.
deletePrompt({id,confirmed:true}) requires your own final user confirmation. Existing server
selection/fallback rules apply after deletion. These are account defaults, not per-chat overrides.

generatePrompt({instruction,currentContent?,detail?,modelId?}) returns generated_prompt ONLY. It uses the
configured AI and quota. Invoke directly from a user handler; show the proposal separately and
only copy it into the local editor on request. Generating never saves or selects a prompt.
listGenerationModels returns allowed models and selectedId; read it before passing an explicit
modelId. Omit modelId to use the server preference. detail is minimal/medium/detailed/none.

parsePromptSections({content}) and serializePromptSections({sections}) use the native advanced
editor format: description/personality/scenario/examples/other with explicit top-level headings.
Free-form text is retained in description. These local transformations never save/select a prompt;
let the user edit a whole text or separate fields, then submit updatePrompt/createPrompt normally.
For an existing custom entry with character_card metadata, startPromptChat({id}) starts its chat
through the existing endpoint and opens it after the result is delivered. It returns chatId and
messageId; the saved first message is included by the server. This does not import a Character Card.

## Personas

listPersonas returns safe profile data: id/name/description/coreMemory/userInstructions/imageUrl,
allowCoreMemoryUpdate/primary/active. IDs are unchanged; flags are booleans. createPersona and
updatePersona accept name, description, coreMemory, allowCoreMemoryUpdate and optional
userInstructions. Omitting userInstructions on update preserves it. For its dedicated instruction
editor and full questionnaire workflow use settings-instructions.md. Names are nonblank, at most 80
characters; descriptions at most 240; userInstructions at most 12000. Texts may otherwise be
empty. The shared bridge request limit is 2 MiB total. The server remains authoritative.

Creation returns createdId and leaves the active persona unchanged. activatePersona({id}) is
a separate user action. It changes the global default; explicit per-chat selections remain.
deletePersona({id,confirmed:true}) deletes the persona and resets chats referring to it to
automatic selection, as in native settings. The primary persona cannot be deleted. All writes
return the refreshed library and update the same native cache/events; there is no second store.

## Avatars, editing and recovery

Avatar source, picker, crop and upload functions are documented once in settings-profile-images.md.

Read a library before addressing existing IDs. Only entries returned by this settings session's
library reads are addressable. Before editing/deleting, the host rereads the target to detect outside changes;
settings_entity_changed means preserve the draft, explicitly reload and reconcile before retrying.
This preflight is not an atomic server revision lock. Loading/busy/errors and late results must
be handled by your form, just like other settings operations. Generation does not overwrite drafts.

Imports remain outside these operations. editor.links points to the native data/import section;
open it only at the user's request with openSettings(link.sectionId,link.target). Ordinary library,
instruction, survey and image operations stay in the theme; startPromptChat intentionally navigates
to the created chat. No other operation automatically opens or replaces the interface.
`,
  'settings-intuition.md': `# Intuition settings

This section exposes account-wide intuition preferences. Open openSettingsSection('intuition'),
wait for editor.loading=false, then requestSettings('intuition','getIntuitionConfig').
The section has operations and an empty fields array. Use your own reusable form components.
An optional editable example is examples/settings/IntuitionEditor.tsx.

getIntuitionConfig returns settings, available, defaults and effective values. available describes
whether the server's evaluation service is configured; preferences can still be edited while it
is unavailable. Global settings.mode is enabled or disabled. historyMessages:null uses the default
depth; integer values 0..50 choose an explicit depth. questions:null uses the default questions;
an empty array explicitly clears them. Effective values describe what the server will use.

Keep the edited settings in local form state. Each question has a unique stable id matching
^[a-z][a-z0-9_]{0,63}$, a nonblank name (up to 100 characters), a nonblank question (up to 1000)
and enabled:boolean. Up to 20 questions are allowed. Themes choose controls, order and layout.
Do not generate IDs again when merely editing or reordering an existing question.

saveIntuitionConfig({settings}) submits the whole form from a user handler and returns the saved
normalized config. It uses the same endpoint and cache as native settings, invalidating chat
overrides so inherited global values refresh. A read must precede the first save. The host keeps
the revision internally; do not add a revision parameter. intuition_settings_changed means another
editor changed the settings. Preserve your draft, explicitly reload and reconcile it before saving
again. Never retry a conflicting save automatically. Closing/switching an editor discards late
results; an already submitted save can still finish. Errors/loading/busy belong in your form.

suggestIntuitionQuestions({brief}) generates proposed questions using the existing configured
AI service. brief may be empty and is at most 2000 characters. Invoke from a user gesture;
generation may consume quota and may fail if the service is unavailable. The global editor sends
no chat history. Suggestions return as data and do not save any preferences. Show them separately,
let the user copy/apply them into the local form, and save only on the final explicit submission.
Account defaults and per-chat overrides continue to follow the existing inheritance rules.
`,
  'settings-operations.md': SETTINGS_OPERATIONS_GUIDE,
  'settings.md': `# Settings: data, actions and reusable theme components

## Choose your interface

Settings are optional API capabilities, not a mandatory modal or layout. Build a page, dialog,
drawer, command interface or only the controls your theme needs. getSettingsSections() and
state.settings.sections return the same localized catalog. state.settings.groups provides group
labels. Section IDs are stable; labels change with the app's language. Admin sections are omitted
for non-admin accounts. mode is native (native contents), fields (custom field API) or hybrid
(custom fields plus explicitly listed native editors). Currently app, account, limits, agents,
memory, voice, browser, intuition, prompt and personas provide custom fields or operations; other sections are native. Never infer
that a section is editable just because it is in the catalog.

## Search and opening

searchSettings(query) updates state.settings.query/results/hasMoreResults using the native
settings index of localized UI labels/help, not user values or secrets. Results have sectionId,
key, title, sectionTitle, fieldId (custom field when mapped), operationId (when mapped) and native. At most 50 results are
returned; refine a broad query if hasMoreResults is true. Built-in field labels are indexed;
dynamic memory records, specialists and saved themes use the operations in settings-operations.md.
Search matches inside the connected sections stay in their custom section, including
password/login and appearance results. operationId identifies a form/control, not permission to
automatically execute its operation; show the user's inputs/confirmation first.
For a custom section call openSettingsSection(id). For a native result/section explicitly call
openSettings(sectionId, optionalResultKey) from a user handler. The native modal opens that
section and can highlight its indexed field, while retaining the selected theme underneath.
openSettings() without arguments remains the ordinary native settings entry.

## Field-based forms

state.settings.editor is null before opening. Afterwards it has sectionId, loading, busy, dirty,
error, groups, links, actions, requests and fields. Each field has id, groupId, type, localized label/help, value
(draft), savedValue, dirty, validation error and visible; select fields add options, number
fields min/max/step, text fields maxLength. Select options can be disabled (unavailable); render
that flag, including when displaying an unchanged unavailable saved choice. Fields/links are authoritative: do not invent IDs or save unseen unsupported
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

editor.actions lists non-saving operations with id, label, disabled and active. Invoke only
listed enabled actions using runSettingsAction(sectionId,actionId) from a real user event.
They do not save the form. Editing/discarding/saving/reloading or opening a different section
cancels its current operation; unmount/account/server/theme changes also cancel it. Represent
active/disabled/error in your UI. Do not invent action IDs or invoke them from render/effects.

## Connected sections

- app: language, theme, lightFrom, darkFrom, zoom, renderPerf, showTokens, diceRoll.
- voice: recognitionSource (local/server), recognitionLanguage, modelId, voiceId, volume and
  sfxVolume (0..1), wakeEnabled, wakeSensitivity (0..100), and wake_<word-id> toggles for available
  activation names/phrases. The activation group must retain at least one phrase when enabled.
  Enabling on Save starts the same native listener; simply reading/editing fields never requests
  the microphone. Changing modelId updates voiceId and its options in the draft; submit the
  resulting state, do not retain your own old voice list. Unavailable saved choices remain
  visible but cannot be newly selected. Loading a section never changes the saved voice.
  A failed remote voice/transcription catalog leaves local controls available. previewVoice
  plays the draft engine/voice/volume without saving; stopPreview stops it. Supported preview
  engines are Piper, builtin and Cartesia. Unavailable/unsupported choices disable the action.
  Late generated audio after cancellation is ignored. No microphone is used for preview.
- account: name and timezone (UTC offsets in hours, including quarter hours). An unconfirmed
  timezone is the disabled saved value auto; choosing an explicit offset confirms it on Save.
  Password/login forms use separate requestSettings operations; credentials are never settings fields.
- limits: contextTokens (at least 1000; max comes from the server), attachmentTokens (0 means
  automatic; otherwise at most 90% of the draft context). Reducing context can reduce the
  effective existing attachment budget; the host rereads normalized values after saving.
  browserConcurrency (1..6), desktopSearch and desktopReader control the existing desktop web
  runtime. Quotas use the read-only getQuota operation.
- agents: model (empty string means automatic), reasoning (empty string means automatic).
  Options come from the available model catalog. Changing model resets an unsupported draft
  reasoning level to automatic. listAgents supplies the localized specialists catalog.
- memory: automaticMemory and resultLimit (automatic means the administrator's default;
  otherwise a string from 1 to 20). These are account defaults; per-chat overrides continue
  to take precedence. Spaces, records, search and map use separate operations.
- browser: autoOpen, autoClick, autoFill and humanTyping, all booleans. The auto* fields are
  positive permissions: true allows that browser action without confirmation. They invert
  the existing browser_confirm_* storage flags. humanTyping=true means character-by-character
  input, false means immediate insertion. The existing manual-only password protection remains.

These are the ordinary desktop preferences and existing account endpoints, not settings stored
inside the theme. Each section loads only when opened. editor.links lists the native portions;
invoke openSettings(link.sectionId,link.target) to open one. Choosing a native link keeps this
theme's draft; native changes to a dirty field cause a conflict on Save rather than silently
overwriting it. See settings-operations.md for typed Promise operations and account/appearance
forms. No arbitrary filesystem or provider-credential access is implied.

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

context.source is provider or local (fallback only when no provider measurement exists).
measurementStale means the last measured window predates a compaction or new input; do not
present that value as the exact size of the next request. Auxiliary models have separate windows.
context.summary is null or {kind:'summary',title,content,throughTimelineIndex,sourceMessageCount,
 tokenCount,contextLimit,modelName,providerName,updatedAt}. It is an explicitly labeled recap of
older dialogue, not a new assistant answer. Show it independently of showTokens, with your own
markup/styles, and never attach message actions to it. message.timelineIndex is the stable chat
order; message.archived marks fully summarized original rows (they remain readable in the chat).
Place the recap before the first loaded message whose timelineIndex exceeds throughTimelineIndex;
if that boundary is outside loaded history, show it once at the start of the loaded conversation.
An oversized response may be summarized partway through its tool trace; its remaining steps stay
verbatim internally. The app targets the freshest ~30% plus the recap, using complete exchanges
and provider checkpoints; the boundary is approximate, not an exact per-message token count.

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

export const THEME_SETTINGS_EXAMPLES=THEME_SETTINGS_RESOURCE_EXAMPLES;
