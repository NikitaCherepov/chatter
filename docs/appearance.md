# Desktop appearances

Appearance changes use data profiles, not user CSS or JavaScript. Component placement is unchanged.

- Canonical schema: shared/appearance.ts. Run node scripts/sync-appearance.mjs; use --check in validation.
- Storage: users.ui_settings.appearance, with a version, collection revision, active ID and up to 32 profiles.
- Each profile includes light/dark palettes, interface/message/code fonts and sizes, radius/density, a chat background and message-arrival motion.
- A null activeId selects the built-in appearance; it is always available and cannot be deleted.
- The existing system/light/dark/scheduled theme preference chooses the palette. Its behavior is preserved.
- Font names refer to fonts installed on the current PC. A fallback is used when unavailable; no font installation is performed.
- Solid chat backgrounds follow the selected palette. Gradient colors and uploaded/HTTPS images are explicit profile settings.
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
- tsx desktop-app/tests/appearance-ui.test.mts
- Existing message/sidebar virtualization tests verify the unchanged default layout.
