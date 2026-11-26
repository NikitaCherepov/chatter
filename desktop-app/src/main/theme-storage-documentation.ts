export const THEME_STORAGE_GUIDE = `# Persistent theme state

Use useThemeStorage from @chatter/ui for theme-owned UI preferences: window positions,
collapsed panels, selected tabs, a command history or optional display controls. It supplies
behavior only; all markup, layout and styling remain yours. This is optional, not a UI checklist.

## React

const [collapsed, setCollapsed, storage] = useThemeStorage('sidebar.collapsed', false);
const [windows, setWindows] = useThemeStorage('desktop.windows', []);
// setCollapsed(value => !value); functional updaters must be pure, as with React state.
// storage.ready / saving / dirty / error
// storage.reset();                remove this key and use its initial value
// await storage.flush();         true if pending changes were persisted; false on error
// await storage.reload();        reread disk, retaining pending local edits

The initial value is a fallback, not an automatic write. Wait for ready when the saved value
affects an expensive mount or animation. An edit made before hydration is reapplied to saved
data rather than replacing it with the fallback. Components using the same key share state
and should provide the same initial value; the first default for a key wins within a renderer.
Treat returned objects immutably. Use stable keys, not a new key on each frame/message.

Writes coalesce over 100 ms and are serialized. Functional updates rebase after a conflict;
errors remain visible in storage.error and pending edits stay in memory for flush/reload.
For a critical Save button await flush() and check the boolean result. Normal UI changes save
automatically; a forced process kill before a pending write reaches the host can lose that edit.
There is one queue for all consumers, not one disk writer per component. A replacement renderer
can read state while staging, but only the displayed theme can write; pending writes retry when
it becomes visible. Other live renderers for the same theme receive committed updates.

## Scope and location

The host binds storage to the theme's id; theme code cannot supply a different theme id or path.
State lives on this PC under the app userData/theme-state/<theme-id>.json directory, outside the
selected themes workspace. It survives restarts, renderer recovery, theme updates, theme changes
and workspace directory changes. Reusing the same theme id reuses state; a copied theme with a
new id starts empty. Preview and applied versions of one id share state. Canceling preview does
not roll back UI preferences. This is device-local, not per account or per chat unless your keys
include a chat id. It does not modify theme.json, README, .drafts, .saved or exports. Deleting a
theme does not silently erase its saved UI preferences.

Store JSON data only: strings, finite numbers, booleans, null, arrays and plain objects. Functions,
Date, class instances, undefined and cycles are rejected. This is UI storage, not a credential
vault or storage for files/media/chat transcripts. Errors do not silently overwrite unreadable
files. Limits per theme: 1024 keys, 200 characters per key, 1 MiB per value, 4 MiB total JSON.
Keys cannot contain control characters or be __proto__, prototype or constructor.

## HTML and lower-level API

const snapshot = await chatter.requestThemeStorage({operation:'read'});
await chatter.requestThemeStorage({operation:'set',key:'sidebar.collapsed',value:true});
await chatter.requestThemeStorage({operation:'remove',key:'sidebar.collapsed'});
const unsubscribe = chatter.subscribeThemeStorage(snapshot => { /* redraw your own UI */ });

Writes optionally accept revision: snapshot.revision for compare-and-swap. A stale revision
rejects with theme_storage_conflict; read and recompute before retrying a functional update.
These methods are scoped by the host exactly like the React hook. Standard snippet previews
without a theme identity have no persistent storage. See theme-storage-sdk.d.ts for hook types.
`;
