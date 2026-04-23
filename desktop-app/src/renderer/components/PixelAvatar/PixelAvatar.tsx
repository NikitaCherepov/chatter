import { useEffect, useRef, useState, useCallback } from 'react';
import { getBaseFace, getReaction, type BaseMood, type ReactionKey } from './faces';
import { getGifDurationMs } from './gifDuration';
import type { SetDisplayStatePayload } from './schema';
import s from './PixelAvatar.module.scss';

// ── Blink config ────────────────────────────────────────────────────────────

const BLINK_INTERVAL_MIN_MS = 3000;
const BLINK_INTERVAL_MAX_MS = 6000;
const FALLBACK_BLINK_MS = 400; // used if GIF duration can't be determined

function randomBlinkDelay(): number {
  return BLINK_INTERVAL_MIN_MS + Math.random() * (BLINK_INTERVAL_MAX_MS - BLINK_INTERVAL_MIN_MS);
}

// ── Component ───────────────────────────────────────────────────────────────

export function PixelAvatar() {
  // -- State: Media layer (highest priority) --
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);

  // -- State: Reaction queue --
  const [reactionQueue, setReactionQueue] = useState<ReactionKey[]>([]);
  const [activeReaction, setActiveReaction] = useState<{ src: string; duration: number } | null>(null);

  // -- State: Base mood (lowest priority) --
  const [baseMood, setBaseMood] = useState<BaseMood>('idle');
  const [blinking, setBlinking] = useState(false);
  const [blinkKey, setBlinkKey] = useState(0);

  // -- Refs for timers & blink duration --
  const reactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blinkCounterRef = useRef(0);
  const blinkDurationMs = useRef(FALLBACK_BLINK_MS);
  const queueRef = useRef<ReactionKey[]>(reactionQueue);
  queueRef.current = reactionQueue;

  // ── Measure blink GIF duration once on mount ──────────────────────────────

  useEffect(() => {
    const blinkSrc = getBaseFace('idle', true);
    if (blinkSrc) {
      getGifDurationMs(blinkSrc).then((ms) => {
        // >0 means animated GIF; use measured duration, otherwise keep fallback
        if (ms > 0) blinkDurationMs.current = ms;
      });
    }
  }, []);

  // ── Process reaction queue ──────────────────────────────────────────────

  const processNextReaction = useCallback(() => {
    setReactionQueue((prev) => prev.slice(1));
    setActiveReaction(null);
  }, []);

  // When queue changes, pop the first item and start playback
  useEffect(() => {
    if (reactionQueue.length === 0) {
      setActiveReaction(null);
      return;
    }
    const key = reactionQueue[0];
    const reaction = getReaction(key);
    setActiveReaction(reaction);

    if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);

    reactionTimerRef.current = setTimeout(() => {
      processNextReaction();
    }, reaction.duration);

    return () => {
      if (reactionTimerRef.current) clearTimeout(reactionTimerRef.current);
    };
  }, [reactionQueue, processNextReaction]);

  // ── Blink logic (only in base mood layer) ───────────────────────────────

  useEffect(() => {
    // Blink only when: no media, no active reaction
    const inBaseLayer = !mediaUrl && !activeReaction;
    if (!inBaseLayer) {
      setBlinking(false);
      if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
      return;
    }

    const scheduleNext = () => {
      if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
      blinkTimerRef.current = setTimeout(() => {
        blinkCounterRef.current += 1;
        setBlinkKey(blinkCounterRef.current);
        setBlinking(true);
        // End blink after the GIF finishes playing
        blinkTimerRef.current = setTimeout(() => {
          setBlinking(false);
          scheduleNext();
        }, blinkDurationMs.current);
      }, randomBlinkDelay());
    };

    scheduleNext();

    return () => {
      if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
    };
  }, [mediaUrl, activeReaction]);

  // ── External control: apply a SetDisplayState payload ────────────────────

  const applyState = useCallback((payload: SetDisplayStatePayload) => {
    if (payload.mode === 'media' && payload.media_url) {
      setMediaUrl(payload.media_url);
      setReactionQueue([]);
      setActiveReaction(null);
      return;
    }
    if (payload.mode === 'face') {
      setMediaUrl(null);
    }

    if (payload.base_mood) {
      setBaseMood(payload.base_mood);
    }

    if (payload.reactions && payload.reactions.length > 0) {
      setReactionQueue((prev) => [...prev, ...payload.reactions!]);
    }
  }, []);

  // ── Listen for custom events (IPC bridge / app code) ────────────────────

  useEffect(() => {
    const handler = (e: Event) => {
      const payload = (e as CustomEvent<SetDisplayStatePayload>).detail;
      if (payload) applyState(payload);
    };
    window.addEventListener('pixel-avatar:state', handler);
    return () => window.removeEventListener('pixel-avatar:state', handler);
  }, [applyState]);

  // ── Determine what to render (priority: media > reaction > base + blink) ─

  const renderSrc = mediaUrl
    ?? activeReaction?.src
    ?? getBaseFace(baseMood, blinking);

  return (
    <div className={s.container}>
      <img
        key={blinking ? `blink-${blinkKey}` : 'base'}
        className={s.face}
        src={renderSrc}
        alt=""
        draggable={false}
      />
    </div>
  );
}

// ── Convenience: dispatch helpers ───────────────────────────────────────────

export function dispatchAvatarState(payload: SetDisplayStatePayload) {
  window.dispatchEvent(new CustomEvent('pixel-avatar:state', { detail: payload }));
}

export function pushAvatarReaction(key: ReactionKey) {
  window.dispatchEvent(
    new CustomEvent<SetDisplayStatePayload>('pixel-avatar:state', {
      detail: { reactions: [key] },
    }),
  );
}
