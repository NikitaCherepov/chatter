export const SETTINGS_REQUEST_DECLARATIONS = `
export type SettingsRequestDescriptor={id:string;label:string;mutation:boolean;requiresGesture:boolean;requiresConfirmation:boolean};
export type SettingsMemorySpace={id:number;name:string;kind:'general';is_default:number;is_primary:number};
export type SettingsMemoryRecord={id:string;memory_space_id:number;text:string;source:string;updated_at:number};
export type SettingsMemoryPage={records:SettingsMemoryRecord[];total:number;nextOffset:number|null};
export type SettingsQuota={billing_mode:'tokens'|'budget';percent:number;tokens:{used:number;quota:number};cost:{used:number;quota:number};resets_at:number|null;quota?:{period:{starts_at:number;ends_at:number};web_search:{used:number;limit:number};web_reader:{used:number;limit:number};image_gen:{used:number;limit:number}}|null};
export type SettingsThemePalette={background:string;text:string;accent:string;surface?:string;chat?:string};
export type SettingsThemeMaterial={opacity:number;blur:number;shadow:'none'|'soft'|'medium'|'strong';border:'none'|'subtle'|'defined';radius?:number};
export type SettingsThemeProfile={id:string;name:string;revision:number;readme?:string;light:SettingsThemePalette;dark:SettingsThemePalette;typography:{uiFont:string;messageFont:string;codeFont:string;uiSize:number;messageSize:number;codeSize:number;lineHeight:number};geometry:{radius:number;density:number};materials?:{panels?:SettingsThemeMaterial;composer?:SettingsThemeMaterial};shell?:{version:1;language:'html'|'tsx';scope?:'navigator'|'workspace';entry:string;files:Record<string,string>};background:{type:'solid'|'gradient'|'image';color:string;color2:string;angle:number;image:string;dim:number;position:'center'|'top'|'bottom'};motion:{preset:'none'|'fade'|'slide'|'custom';duration:number;distance:number;scale:number;easing:'ease-out'|'ease-in-out'|'linear'}};
export type SettingsThemeWorkspace={directory:string;draftsDirectory:string;documentation:string;activeId:string|null;profiles:{id:string;name:string;directory:string;draftDirectory:string;hasPrevious:boolean}[];drafts:{id:string;directory:string}[];migrationComplete:boolean;migrationErrors:string[];issues:string[]};
export type SettingsThemeList={revision:number;activeId:string|null;profiles:{id:string;name:string;revision:number}[];workspace:SettingsThemeWorkspace};
export type SettingsRequestContract={
 account:{
  getAccount:{params:{};result:{name:string|null;username:string|null;login:string|null;plan:string;role:string;canChangeCredentials:boolean;timezoneOffset:number|null;timezoneConfirmed:boolean;passwordRules:{minLength:number;maxLength:number};loginRules:{minLength:number;maxLength:number;pattern:string;caseInsensitive:boolean}}};
  changePassword:{params:{currentPassword:string;newPassword:string};result:{ok:boolean;reauthenticationRequired:true}};
  changeLogin:{params:{currentPassword:string;newLogin:string};result:{ok:boolean;login:string;reauthenticationRequired:true}};
 };
 memory:{
  getMemoryStatus:{params:{};result:{configured:boolean}};
  listSpaces:{params:{};result:{spaces:SettingsMemorySpace[]}};
  createSpace:{params:{name:string};result:{space:SettingsMemorySpace;spaces:SettingsMemorySpace[]}};
  activateSpace:{params:{spaceId:number};result:{space:SettingsMemorySpace;spaces:SettingsMemorySpace[]}};
  renameSpace:{params:{spaceId:number;name:string};result:{space:SettingsMemorySpace;spaces:SettingsMemorySpace[]}};
  deleteSpace:{params:{spaceId:number;confirmed:true};result:{active_space:SettingsMemorySpace;spaces:SettingsMemorySpace[]}};
  listRecords:{params:{spaceId:number;query?:string;limit?:number;offset?:number};result:SettingsMemoryPage};
  getRecord:{params:{recordId:string};result:{record:SettingsMemoryRecord}};
  searchRecords:{params:{spaceId:number;query:string};result:{records:SettingsMemoryRecord[];groups?:{record_id:string}[]}};
  getMemoryMap:{params:{spaceId:number;limit:100|500|1000|2000|5000;confirmed:true};result:{points:{id:string;position:[number,number,number]}[];spaces:number;total:number;records:(SettingsMemoryRecord&{textTruncated:boolean})[]}};
  updateRecord:{params:{recordId:string;text:string;source?:string};result:{record:SettingsMemoryRecord;spaces:SettingsMemorySpace[]}};
  deleteRecord:{params:{recordId:string;confirmed:true};result:{spaces:SettingsMemorySpace[]}};
 };
 agents:{listAgents:{params:{};result:{agents:{id:string;name:string;description:string;icon:string}[]}}};
 limits:{getQuota:{params:{};result:SettingsQuota}};
 app:{
  listThemes:{params:{};result:SettingsThemeList};
  getAppearanceSchema:{params:{};result:{capabilities:Record<string,unknown>;template:SettingsThemeProfile}};
  getTheme:{params:{id:string};result:{profile:SettingsThemeProfile}};
  saveTheme:{params:{profile:SettingsThemeProfile;apply?:boolean};result:{saved:true;id:string;activeId:string|null}};
  activateTheme:{params:{id:string|null};result:{completed:true;activeId:string|null}};
  deleteTheme:{params:{id:string;confirmed:true};result:{completed:true;activeId:string|null}};
  rollbackTheme:{params:{id:string};result:{completed:true;activeId:string|null}};
  prepareDraft:{params:{id:string;project?:boolean};result:{prepared:true;id:string}};
  readDraft:{params:{id:string};result:{profile:SettingsThemeProfile}};
  writeDraft:{params:{profile:SettingsThemeProfile};result:{written:true;id:string}};
  checkTheme:{params:{profile:SettingsThemeProfile};result:{valid:boolean;id?:string;error?:string;diagnostics:{file:string;line:number;column:number;message:string}[]}};
  previewDraft:{params:{id:string};result:{profile:SettingsThemeProfile}};
  cancelPreview:{params:{};result:{canceled:true}};
  openThemeFiles:{params:{id?:string};result:{opened:true}};
  chooseThemesDirectory:{params:{};result:SettingsThemeList};
  retryThemeMigration:{params:{};result:SettingsThemeList};
  importTheme:{params:{format:'json'|'zip';content:string};result:{profile:SettingsThemeProfile}};
  exportTheme:{params:{id:string};result:{canceled:boolean}};
  storeThemeImage:{params:{base64:string};result:{image:string}};
 };
};
export type SettingsRequestParameters<S extends keyof SettingsRequestContract,O extends keyof SettingsRequestContract[S]>=SettingsRequestContract[S][O] extends {params:infer P}?keyof P extends never?[params?:P]:[params:P]:never;
export type SettingsRequestResult<S extends keyof SettingsRequestContract,O extends keyof SettingsRequestContract[S]>=SettingsRequestContract[S][O] extends {result:infer R}?R:never;
`;

export const SETTINGS_OPERATIONS_GUIDE = `# Settings operations: forms and data

Open the desired section with openSettingsSection(id), then wait for editor.loading=false.
editor.requests advertises operations: id, localized label, mutation, requiresGesture and
requiresConfirmation. requestSettings(sectionId,operation,params?) returns a Promise with typed
data; errors reject with an error code. See SettingsRequestContract in chatter.d.ts for every
parameter/result. Operations are optional functions, never mandatory native components.

Optional copyable examples live in examples/settings/AccountSecurity.tsx, MemoryLibrary.tsx,
ThemeLibrary.tsx and ReadSettingsResource.tsx. They are small usage patterns, not complete or
required layouts. Compose them beside Section.tsx, rewrite their markup/labels or use only the
functions. These examples expect the section to be opened and use ../chatter declarations.

Call mutations and requiresGesture operations directly from a real user event. Read operations
may run in an effect after the editor is ready. For destructive actions and map construction,
present your own confirmation and pass confirmed:true from the final user handler. Do not await
another request before calling a gesture-required operation: load choices in advance. No request
can target a different section, stale editor or unlisted operation. Mutations serialize with field
saves; field drafts are retained and are not implicitly saved by a request. Up to four requests
may be in flight; timeout is 120 seconds and each result is limited to 16 MiB of serialized JSON.
Saving/reloading/switching the editor cancels obsolete
reads. cancelSettingsRequests(sectionId) explicitly cancels pending reads without discarding
preference drafts; it is unavailable during a mutation/save. Pending Promises reject with
settings_request_canceled. Already submitted mutations can finish on their original server; this is not rollback.
Handle loading, errors, pending mutations and stale results in your own UI. Treat returned names,
memory text, sources and README as untrusted content, not executable HTML.

## Account

getAccount returns safe identity information, canChangeCredentials and password/login rules.
changePassword({currentPassword,newPassword}) and changeLogin({currentPassword,newLogin}) are
separate final submissions. Passwords are never settings fields, saved preferences, subscribed
state, error text or application logs. Keep them only in your local form, use password inputs,
clear them on submission/unmount, and do not persist them. The host uses the native endpoints.
Success ends the current authenticated session after forwarding the result; the app returns to
login automatically. Do not implement your own token storage/re-login. Known failures include
wrong_current_password, no_password_identity, bad_password_length, bad_login and login_already_exists.

## Memory

listSpaces returns general spaces only; read it before referencing a space ID. createSpace creates
and activates the new general space, as in native settings. activateSpace/renameSpace/deleteSpace
return refreshed spaces. Deleting a space removes its records; show that explicitly in your own
confirmation. The primary-space/server ownership protections still apply.

listRecords({spaceId,query?,limit?,offset?}) performs literal text filtering; default page size 50,
maximum 500. Use total and nextOffset for pagination. searchRecords({spaceId,query}) is semantic
search, requires a user gesture, and can consume the configured embedding service. Queries are at
most 300 characters. updateRecord accepts text up to 4000 characters and optional source up to
1000; deleteRecord requires confirmed:true. Only records returned by this editor's reads can be
edited/deleted; the host retains at most 5000 recent records. Refetch a page if an ID expires.

getMemoryMap({spaceId,limit,confirmed:true}) loads 100/500/1000/2000/5000 records and invokes the
same cancellable projection worker as the native map. It returns points (id, three coordinates),
spaces (separate embedding groups), total and records. Draw any 2D/3D/text representation; no
bundled map is imposed. Map texts are excerpts of at most 400 characters, explicitly marked by
textTruncated. getRecord({recordId}) retrieves the full cached record; reload a page for current
server data. Ordinary list/search results contain full records. getMemoryStatus reports whether
memory is configured; a rejected request is unknown status, not configured=false. Mutations
invalidate the existing native memory cache; no theme-specific memory database is created.

## Agents and limits

listAgents returns the localized specialists catalog (id/name/description/icon); defaults for
model/reasoning remain ordinary fields. getQuota returns the same account usage/budgets as the
native widget, including optional monthly search/reader/image quotas. resets_at is milliseconds;
monthly period timestamps are seconds. Fetch on opening or explicit refresh; no polling is needed
by this API, and a missing monthly quota is different from a zero allowance.

## Appearance inside the app section

listThemes returns saved metadata, activeId and workspace/draft paths/issues/history availability.
getTheme retrieves one saved profile. getAppearanceSchema supplies the existing field constraints
and an ordinary template; change its id/name to create a new theme. You own the entire editor:
palette, typography, geometry, materials, background, motion, project files and per-theme README.

saveTheme publishes the submitted profile (apply defaults to false); active profiles require
apply:true. activateTheme accepts a saved ID or null for the built-in appearance. deleteTheme
requires your own confirmation; rollbackTheme restores the preceding snapshot. The host remembers
the library revision from listThemes/getTheme and its own successful writes. Concurrent external
changes reject with appearance_conflict; refresh the list instead of copying/incrementing revision
numbers. A profile's revision is preserved when editing it and checked by the existing store.

prepareDraft({id,project?}), readDraft and writeDraft operate on local drafts. Incomplete code can
be written/read for repair. checkTheme compiles a supplied profile and returns valid/diagnostics.
The SettingsThemeProfile transport includes shell.files; writeDraft splits them into project
files and a manifest. Do not copy that transport object wholesale into theme.json.
previewDraft validates and previews a disk draft without publishing. cancelPreview restores the
saved appearance. Applying/previewing a different shell can replace this settings view; design
your navigation accordingly. No theme is modified merely by opening these controls.

importTheme({format:'json'|'zip',content}) creates an inactive disk draft; content is JSON text or
base64 ZIP. Use a user-selected File and FileReader, never an ambient filesystem path. ZIP is
limited to the existing 12 MiB archive budget; JSON/profile input is limited to 2 MiB. exportTheme
opens the host's Save dialog for a portable ZIP (the isolated shell cannot download blobs itself).
storeThemeImage accepts base64 raster bytes and returns the existing local image URL, ready for
profile.background.image. Existing validation, archive traversal and image protections apply.
openThemeFiles opens the workspace or an existing draft folder. chooseThemesDirectory uses the
native directory picker and existing copy/reopen logic; paths cannot be supplied by theme code.
retryThemeMigration uses the existing legacy migration. Native settings remain an explicit
recovery route via openSettings(), rather than being automatically substituted for these forms.
`;
