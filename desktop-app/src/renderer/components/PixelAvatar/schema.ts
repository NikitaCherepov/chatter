// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema for the set_display_state tool — consumed by the LLM to control
// the pixel avatar.  This schema can be sent verbatim as a function/tool
// definition to any OpenAI-compatible chat completions endpoint.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Set the display state of the pixel avatar.
 *
 * Modes:
 *   "face"  — normal face mode (base mood + reaction queue + blink logic).
 *   "media" — override mode; a static image or GIF URL is shown instead of
 *             the face.  All face logic is suspended until mode is set back
 *             to "face".
 */
export const SET_DISPLAY_STATE_SCHEMA = {
  name: 'set_display_state',
  description:
    'Control the pixel-avatar display. Switch between face and media mode, ' +
    'change the base mood, or push temporary emotion reactions.',
  parameters: {
    type: 'object' as const,
    properties: {
      mode: {
        type: 'string' as const,
        enum: ['face', 'media'],
        description:
          '"face" = normal avatar with mood & reactions. ' +
          '"media" = show an arbitrary image/GIF from media_url instead.',
      },
      base_mood: {
        type: 'string' as const,
        description:
          'Set the base mood face (e.g. "idle", "happy", "sad", "angry", ' +
          '"surprised", "neutral"). Only meaningful when mode="face".',
      },
      reactions: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description:
          'Queue temporary reaction animations (e.g. ["shock","laugh"]). ' +
          'They play in order, each for its configured duration, then the ' +
          'avatar falls back to base_mood. Only meaningful when mode="face".',
      },
      media_url: {
        type: 'string' as const,
        description:
          'Direct URL to an image or GIF to display when mode="media". ' +
          'Ignored when mode="face".',
      },
    },
    // At least one field must be provided
    required: [] as string[],
  },
} as const;

// ── TypeScript type derived from schema ─────────────────────────────────────

export type SetDisplayStatePayload = {
  mode?: 'face' | 'media';
  base_mood?: string;
  reactions?: string[];
  media_url?: string;
  /** Start a looping reaction that plays until explicitly stopped */
  loop_reaction?: string;
  /** Stop the currently playing loop reaction */
  clear_loop?: boolean;
};
