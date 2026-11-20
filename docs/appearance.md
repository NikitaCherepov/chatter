# Desktop appearances

Appearance changes use data profiles, not user CSS or JavaScript. Component placement is unchanged.

- Canonical schema: shared/appearance.ts. Run node scripts/sync-appearance.mjs; use --check in validation.
- Storage: users.ui_settings.appearance, with a version, collection revision, active ID and up to 32 profiles.
- Each profile includes light/dark palettes, interface/message/code fonts and sizes, radius/density, a chat background and message-arrival motion.
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
