// ─────────────────────────────────────────────────────────────────────────────
// FACES — dictionary of pixel-art assets keyed by string identifiers.
// Add new faces / reactions by simply extending the matching section.
//
// IMPORTANT: Use `new URL('./path', import.meta.url).href` for Vite to detect
// and bundle the asset.  Files that don't exist yet will produce a build-time
// warning but won't break anything — they'll be resolved at runtime.
// ─────────────────────────────────────────────────────────────────────────────

// ── Base moods (static PNGs / GIFs, blink variants go side-by-side) ────────

const BASE_FACES: Record<string, string> = {
  idle:          new URL('../../assets/faces/idle.png',      import.meta.url).href,
  idle_blink:    new URL('../../assets/faces/idle_blink.gif', import.meta.url).href,
  sad:        new URL('../../assets/faces/sad.png',        import.meta.url).href,
  sad_blink:        new URL('../../assets/faces/sad_blink.gif',        import.meta.url).href,
  angry:      new URL('../../assets/faces/angry.png',      import.meta.url).href,
  angry_blink:      new URL('../../assets/faces/angry_blink.gif',      import.meta.url).href,
  happy:      new URL('../../assets/faces/happy.png',      import.meta.url).href,
  happy_blink:      new URL('../../assets/faces/happy_blink.gif',      import.meta.url).href,
  // ── Add more below as you create them ──
  // happy:      new URL('../../assets/faces/happy.png',      import.meta.url).href,
  // happy_blink: new URL('../../assets/faces/happy_blink.gif', import.meta.url).href,
  // surprised:  new URL('../../assets/faces/surprised.png',  import.meta.url).href,
  // neutral:    new URL('../../assets/faces/neutral.png',    import.meta.url).href,
  // neutral_blink: new URL('../../assets/faces/neutral_blink.gif', import.meta.url).href,
};

// ── Reactions (GIFs or static — always time-boxed) ──────────────────────────

const REACTIONS: Record<string, string> = {
  // ── Uncomment as you add files ──
  // shock:    new URL('../../assets/reactions/shock.gif',    import.meta.url).href,
  // squint:   new URL('../../assets/reactions/squint.gif',   import.meta.url).href,
  // laugh:    new URL('../../assets/reactions/laugh.gif',    import.meta.url).href,
  // think:    new URL('../../assets/reactions/think.gif',    import.meta.url).href,
  // search:   new URL('../../assets/reactions/search.gif',   import.meta.url).href,
  // wave:     new URL('../../assets/reactions/wave.gif',     import.meta.url).href,
  // confused: new URL('../../assets/reactions/confused.gif', import.meta.url).href,
};

// ── Default reaction durations (ms) — override per-reaction if needed ───────

const REACTION_DURATIONS: Record<string, number> = {
  shock:    1200,
  squint:   1000,
  laugh:    1500,
  think:    2000,
  search:   2500,
  wave:     1000,
  confused: 1200,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

export type BaseMood = string;
export type ReactionKey = string;

/** Returns mood keys (excluding *_blink variants) that have assets */
export function getAvailableMoods(): string[] {
  return Object.keys(BASE_FACES).filter(k => !k.endsWith('_blink'));
}

/** Returns reaction keys that have assets */
export function getAvailableReactions(): string[] {
  return Object.keys(REACTIONS);
}

/** Manifest for sending to backend so AI knows what's available */
export function getAvatarManifest(): { moods: string[]; reactions: string[] } {
  return { moods: getAvailableMoods(), reactions: getAvailableReactions() };
}

export function getBaseFace(mood: BaseMood, blinking = false): string {
  if (blinking) {
    const blinkKey = `${mood}_blink`;
    if (BASE_FACES[blinkKey]) return BASE_FACES[blinkKey];
  }
  return BASE_FACES[mood] ?? BASE_FACES['idle'] ?? '';
}

export function getReaction(key: ReactionKey): { src: string; duration: number } {
  const duration = REACTION_DURATIONS[key] ?? 1500;

  // Known reaction → use registered path
  if (REACTIONS[key]) return { src: REACTIONS[key], duration };

  // Unknown reaction → try to resolve from reactions folder
  try {
    return { src: new URL(`../../assets/reactions/${key}.gif`, import.meta.url).href, duration };
  } catch {
    // Fallback: show idle face
    return { src: BASE_FACES['idle'] ?? '', duration };
  }
}

export { BASE_FACES, REACTIONS, REACTION_DURATIONS };
