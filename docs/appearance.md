# Desktop appearances

## Local storage and migration

Desktop themes belong to the local app installation, independently of accounts and servers. The default directory is Electron userData/themes. Settings show the actual path and can copy the complete workspace to a different empty directory, or reopen an existing local workspace. The original directory is retained. The selected location is stored in theme-location.json as a single directory; .workspace.json identifies the local image origin, without user or server IDs. Older .scope.json markers remain readable for compatibility, without ownership checks.

On upgrade, old account/server directories (including custom locations in theme-locations.json) are copied into the common workspace. Imported IDs receive a deterministic suffix to preserve themes with identical IDs. Draft source files, assets and preceding saved versions are retained; invalid drafts remain available for repair. The most recently modified old selection is used when the common workspace is empty. Old directories are retained as backups. Reopening the common workspace does not repeat the import or reset local changes.

- .drafts/<id>/theme.json and source files are the editable workspace.
- .saved/<id>/<snapshot>/ contains immutable published versions. A completed snapshot is written and read back before .state.json is atomically replaced.
- .state.json stores selection, saved snapshot pointers, collection revisions and the migration marker. Only the app edits it.
- Current and preceding published versions are retained. Rollback publishes a new monotonic revision. If a current snapshot is damaged, the preceding valid snapshot is recovered; unreadable records and original files are preserved for inspection.
- .trash retains replaced/deleted draft directories. Canceling a preview retains its draft.
- THEMES.md, template.json and chatter.d.ts provide on-demand documentation and editor types.

On first load, the desktop reads /api/v1/user/appearance/legacy, which preserves raw appearance entries instead of filtering unknown older fields. Older servers fall back to /api/v1/user/appearance; a fresh login snapshot can seed migration if the server is unavailable. All valid profiles are materialized into local manifests/source files; active selection is preserved only for a previously empty workspace. Existing local profiles, selection and draft files are never overwritten by migration. .migration-backup.json retains the original collection, including any invalid entries, and migration errors are shown in settings. The database collection is not deleted. After successful migration, the desktop no longer reads or writes it for normal appearance operations. A pending migration can be retried in settings.

Ordinary appearances remain ordinary configuration. They need only theme.json with palettes, typography, geometry, materials, background and motion. No HTML is required. The existing CSS tokens, contrast correction, fonts, density, material and animation runtime apply these values as before. A null activeId selects the built-in appearance. Existing system/light/dark/scheduled palette selection is unchanged.

## Components and source files

Canonical contracts are shared/appearance.ts and shared/appearance-project.ts; run node scripts/sync-appearance.mjs and validate with --check. They are mirrored into the main process, renderer and legacy backend parser.

A component project's on-disk shell manifest is:

```json
{"version":1,"language":"tsx","scope":"workspace","entry":"App.tsx"}
```

The app discovers TSX, TS, JSX, JS, CSS and JSON files recursively, with up to 32 runtime files and 100,000 source characters. theme.json, tsconfig.json, declaration files, node_modules and hidden directories are excluded. Components support named/default exports, relative imports, extensionless and index imports, @/ aliases rooted at the project, JS-to-TS import resolution, shared CSS side-effect imports and JSON data. The entry default-exports a React component. Bundled external modules are react, react-markdown and remark-gfm. Package installation and direct OS access are not exposed inside the running shell.

chatter.d.ts gives editor types for window.chatter. The generated tsconfig.json includes the @/ alias. Create component project in settings writes a working App.tsx, separate chat list, conversation and composer components, a stylesheet and editor support files. The native editor can still edit individual files, while Open files goes straight to the draft directory in the file manager.

HTML and legacy single-source TSX retain exact source in a file. Their shell manifests use sourceFile (index.html or App.tsx) instead of entry. Existing full-profile JSON imports remain supported. Source is assembled into the existing in-memory AppearanceProfile contract only when needed by the UI or isolation runtime.

navigator scope opens selected chats in the native conversation. workspace scope keeps its own message renderer and composer. The live bridge supports chat/folder summaries, pagination, search, active messages, generation state and user-triggered actions. Read generated THEMES.md/chatter.d.ts for the complete API. Route-aware shells subscribe with {navigation:true}; older shells still reload their initial overview on return home.

## Editing, preview and application

Draft file changes are observed with filesystem events and debouncing, without polling. Before a preview or proposal, the desktop checks syntax and imports without executing model code. An already open draft preview refreshes when valid files change. Invalid edits keep the preceding preview visible, show file/line diagnostics, and disable application until repaired. After cancellation, filesystem edits cannot reopen the preview. Active appearance snapshots never follow draft changes automatically.

Only explicit user application saves/selects a new published snapshot. Native controls provide a Back to custom interface button in the native conversation and the chat library drawer. Settings opened from a shell return to that shell when closed. Escape and the independent recovery bar restore the saved appearance; Ctrl/Command + Alt + Backspace selects the built-in appearance locally. Changing accounts, servers or signing out retains the same local library and selection; local appearance loading and recovery are available without signing in.

## Images and portability

Uploaded raster backgrounds are stored locally, with an 8 MiB limit and PNG/JPEG/WebP/GIF signature validation. On disk, a theme refers to assets/<image>. In memory, the app uses a content-addressed chatter-theme URL; the protocol serves only validated image hashes in an initialized theme workspace. Paths, symlinks and arbitrary files are rejected. The isolated code surface does not receive a filesystem bridge.

Migration tries to copy owned /api/v1/images backgrounds to the PC. If a resource cannot be downloaded, the original server reference remains and settings report it. External HTTPS image links retain their original behavior. The database backup remains unchanged.

Export creates a ZIP containing theme.json, source and local assets. ZIP import creates a new inactive draft with a new ID. Old complete JSON exports still import. Archive paths and expanded size are bounded; traversal and symlinks are rejected. Copying a theme directory or importing its package preserves local raster resources across PCs/accounts.

## Bot integration

No theme instructions or state are injected into the system prompt, and theme metadata is not synchronized to the backend automatically. get_theme_docs() requests two blocks from the connected desktop: readme (the current THEMES.md guide for creating and editing themes) and state (directory/documentation paths, active theme ID, saved theme IDs/names and draft IDs). desktopVersion identifies the app supplying the guide. Source files are read on demand through the existing desktop file tools. The backend only forwards this request over appearance_workspace IPC; guide content can change with desktop releases without backend changes. The request has no file path argument, returns no theme source, and cannot propose or apply a theme.

The two exposed appearance tools are get_theme_docs() and suggest_appearance({id, checkOnly?}). The latter requires the draft folder ID, reads and validates that draft locally, then emits the existing confirmation card. checkOnly:true returns diagnostics without a proposal. Raw profiles and source maps are not tool arguments, and bot proposals do not save or apply files. Refresh documentation and state by calling get_theme_docs() again.

The old HTTP appearance endpoints remain for migration and older clients. The updated desktop does not use POST /api/v1/user/appearance or the server image-upload endpoint for its local themes. Chat layout remains a separate existing feature.

## Checks

- node scripts/sync-appearance.mjs --check
- tsx backend-api/tests/appearance.test.mts
- tsx desktop-app/tests/local-appearance.test.mts
- tsx desktop-app/tests/appearance-colors.test.mts
- tsx desktop-app/tests/appearance-ui.test.mts
- Existing message/sidebar virtualization tests verify the unchanged default layout.

## Color regions

Each light/dark palette has background (application shell), text and accent. Optional surface controls the sidebar, header, composer, tools panel, title bar and settings window, with its own derived text and control colors. Optional chat sets the solid conversation color. The existing profile.background gradient/image is conversation-only and takes precedence over chat. Omitted surface/chat retain previous behavior exactly; Auto removes the corresponding override. The optional color fields require no additional migration or palette-preference change. The shared schema, capabilities and editor use the same names; legacy profiles still validate without adding fields.

## Surface materials

Optional profile.materials.panels and profile.materials.composer each contain opacity (0.55–1), blur (0–32px), shadow (none/soft/medium/strong), border (none/subtle/defined), and optional radius (0–24px, otherwise the global radius). Omission means exact legacy styling; Auto removes that region. These additive fields use the existing API, tools, saved variants and confirmation flow.

Only the background fill is translucent. Text/control colors are derived against worst-case black/white backdrops; fill opacity is applied exactly as requested. A low-contrast material produces an editor hint instead of a hidden opacity increase. Backdrop blur is static, bounded, and scoped to chrome/composer surfaces; it never filters the conversation or runs in scroll handlers. Panels above flat content may show no visible blur. Reduced transparency and browsers without backdrop-filter get opaque paint. Shadow and border use finite presets, not arbitrary CSS. Materials do not change measured row heights.
