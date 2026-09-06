import { useEffect, useRef, useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { getBaseFace, getReaction, type BaseMood, type ReactionKey } from './faces';
import { getGifDurationMs } from './gifDuration';
import type { SetDisplayStatePayload } from './schema';
import { resolveImageUrl } from '../../lib/api';
import { openToolInLastLayout } from '../../lib/tools';
import s from './PixelAvatar.module.scss';

// ── Blink config ────────────────────────────────────────────────────────────

const BLINK_INTERVAL_MIN_MS = 3000;
const BLINK_INTERVAL_MAX_MS = 6000;
const FALLBACK_BLINK_MS = 400; // used if GIF duration can't be determined

function randomBlinkDelay(): number {
  return BLINK_INTERVAL_MIN_MS + Math.random() * (BLINK_INTERVAL_MAX_MS - BLINK_INTERVAL_MIN_MS);
}

// ── Persistence ────────────────────────────────────────────────────────────

const CACHE_KEY = 'pixel_avatar_mood';

function loadCachedMood(): BaseMood {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) return raw;
  } catch {}
  return 'idle';
}

function cacheMood(mood: BaseMood) {
  try {
    localStorage.setItem(CACHE_KEY, mood);
  } catch {}
}

// ── Component ───────────────────────────────────────────────────────────────

type BrowserSessionView = {
  id: string;
  chatId: number | null;
  source: 'browser' | 'google_ai' | 'web_search';
  status: 'working' | 'idle' | 'challenge';
  openTarget: { type: 'browser_session' } | { type: 'app_tool'; toolId: string; title?: string };
  image?: string;
  title?: string;
  updatedAt: number;
};

type PixelAvatarProps = {
  chatId?: number | null;
};

const sessionSourceLabel = (source: BrowserSessionView['source']) => (
  source === 'browser' ? 'Browser' : source === 'google_ai' ? 'Google AI' : 'Web search'
);

const sessionStatusLabel = (status: BrowserSessionView['status']) => {
  if (status === 'working') return 'Выполняется';
  if (status === 'challenge') return 'Нужна проверка';
  return 'Ожидает';
};

export function PixelAvatar({ chatId = null }: PixelAvatarProps) {
  const [browserPreview, setBrowserPreview] = useState<{ active: boolean; source?: BrowserSessionView['source']; image?: string }>({ active: false });
  const [browserSessions, setBrowserSessions] = useState<BrowserSessionView[]>([]);
  const [sessionDockOpen, setSessionDockOpen] = useState(false);
  const [sessionDockExpanded, setSessionDockExpanded] = useState(false);
  // -- State: Media layer (highest priority) --
  const [mediaUrl, setMediaUrl] = useState<string | null>(null);

  // -- State: Loop reaction (plays infinitely until explicitly stopped) --
  const [loopReaction, setLoopReaction] = useState<string | null>(null);

  // -- State: Reaction queue --
  const [reactionQueue, setReactionQueue] = useState<ReactionKey[]>([]);
  const [activeReaction, setActiveReaction] = useState<{ src: string; duration: number } | null>(null);

  // -- State: Base mood (lowest priority) --
  const [baseMood, setBaseMood] = useState<BaseMood>(loadCachedMood);
  const [blinking, setBlinking] = useState(false);
  const [blinkKey, setBlinkKey] = useState(0);

  // -- Refs for timers & blink duration --
  const reactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blinkCounterRef = useRef(0);
  const blinkDurationMs = useRef(FALLBACK_BLINK_MS);
  const queueRef = useRef<ReactionKey[]>(reactionQueue);
  const dockCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    // Blink only when: no media, no loop reaction, no active reaction
    const inBaseLayer = !mediaUrl && !loopReaction && !activeReaction;
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
  }, [mediaUrl, loopReaction, activeReaction]);

  // ── External control: apply a SetDisplayState payload ────────────────────

  const applyState = useCallback((payload: SetDisplayStatePayload) => {
    // Stop loop if requested
    if (payload.clear_loop) {
      setLoopReaction(null);
    }

    if (payload.mode === 'media' && payload.media_url) {
      setMediaUrl(resolveImageUrl(payload.media_url));
      setReactionQueue([]);
      setActiveReaction(null);
      setLoopReaction(null);
      return;
    }
    if (payload.mode === 'face') {
      setMediaUrl(null);
    }

    if (payload.base_mood) {
      setBaseMood(payload.base_mood);
      cacheMood(payload.base_mood);
    }

    // Start a looping reaction (replaces any current loop)
    if (payload.loop_reaction) {
      const reaction = getReaction(payload.loop_reaction);
      setLoopReaction(reaction.src);
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

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onBrowserActivityPreview?.((payload) => {
      setBrowserPreview((current) => {
        return {
          active: payload.active,
          source: payload.active ? payload.source : undefined,
          image: payload.image ?? (payload.active && current.source === payload.source ? current.image : undefined),
        };
      });
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    setBrowserSessions([]);
    setSessionDockOpen(false);
    setSessionDockExpanded(false);

    const applySnapshot = (snapshot: { activeChatId: number | null; sessions: BrowserSessionView[] }) => {
      if (snapshot.activeChatId === chatId) setBrowserSessions(snapshot.sessions);
    };
    const unsubscribe = window.electronAPI?.onBrowserSessionsChanged?.(applySnapshot);
    void window.electronAPI?.setActiveBrowserChat?.(chatId).then(applySnapshot).catch(() => {});
    return () => unsubscribe?.();
  }, [chatId]);

  const showSessionDock = useCallback(() => {
    if (dockCloseTimerRef.current) clearTimeout(dockCloseTimerRef.current);
    dockCloseTimerRef.current = null;
    setSessionDockOpen(true);
  }, []);

  const scheduleSessionDockClose = useCallback(() => {
    if (dockCloseTimerRef.current) clearTimeout(dockCloseTimerRef.current);
    dockCloseTimerRef.current = setTimeout(() => {
      setSessionDockExpanded(false);
      setSessionDockOpen(false);
    }, 140);
  }, []);

  useEffect(() => () => {
    if (dockCloseTimerRef.current) clearTimeout(dockCloseTimerRef.current);
  }, []);

  const openSession = useCallback((session: BrowserSessionView) => {
    if (session.openTarget.type === 'app_tool') {
      openToolInLastLayout(session.openTarget.toolId, {
        title: session.openTarget.title || session.title || session.openTarget.toolId,
        activeChatId: chatId,
      });
      return;
    }
    void window.electronAPI.openBrowserSession(session.id);
  }, [chatId]);

  // ── Determine what to render (priority: media > loop > reaction queue > base + blink) ─

  const renderSrc = mediaUrl
    ?? loopReaction
    ?? activeReaction?.src
    ?? getBaseFace(baseMood, blinking);

  return (
    <div
      className={s.container}
      onMouseEnter={showSessionDock}
      onMouseLeave={scheduleSessionDockClose}
    >
      <div className={`${s.avatarFrame} ${browserPreview.active ? s.browserPreviewActive : ''}`}>
        {browserPreview.active ? (
          <>
            {browserPreview.image
              ? <img className={s.browserPreview} src={browserPreview.image} alt="" draggable={false} />
              : <div className={s.browserPreviewLoading} />}
            <span className={s.browserPreviewIndicator} />
          </>
        ) : (
          <img
            key={blinking ? `blink-${blinkKey}` : 'base'}
            className={s.face}
            src={renderSrc}
            alt=""
            draggable={false}
          />
        )}
      </div>
      <AnimatePresence>
      {sessionDockOpen && browserSessions.length > 0 && (
        <motion.div
          className={s.sessionDock}
          initial={{ width: 64, opacity: 0, y: 16, scale: 0.96 }}
          animate={{
            width: sessionDockExpanded ? 280 : 64,
            opacity: 1,
            y: 0,
            scale: 1,
          }}
          exit={{ width: 64, opacity: 0, y: 12, scale: 0.96 }}
          transition={{
            width: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
            opacity: { duration: 0.14 },
            y: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
            scale: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
          }}
          onMouseEnter={() => setSessionDockExpanded(true)}
          onMouseLeave={() => setSessionDockExpanded(false)}
        >
          <div className={s.sessionDockList}>
            {browserSessions.map((session, index) => (
              <motion.button
                key={session.id}
                type="button"
                className={s.sessionRow}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.16, delay: index * 0.045, ease: 'easeOut' }}
                onClick={() => openSession(session)}
              >
                <motion.span
                  className={s.sessionInfoCard}
                  animate={{ opacity: sessionDockExpanded ? 1 : 0, x: sessionDockExpanded ? 0 : 8 }}
                  transition={{ duration: 0.14, ease: 'easeOut' }}
                >
                  <span className={s.sessionMeta}>
                    <span className={s.sessionTitle}>
                      {session.openTarget.type === 'app_tool'
                        ? session.openTarget.title || session.openTarget.toolId
                        : sessionSourceLabel(session.source)}
                    </span>
                    <span className={`${s.sessionStatus} ${s[`sessionStatus_${session.status}`]}`}>
                      <span className={s.sessionStatusDot} />
                      {sessionStatusLabel(session.status)}
                    </span>
                  </span>
                  <span className={s.sessionOpen}>↗</span>
                </motion.span>
                <span className={s.sessionThumbnail}>
                  {session.image
                    ? <img src={session.image} alt="" draggable={false} />
                    : <span>{session.openTarget.type === 'app_tool'
                      ? session.openTarget.toolId.slice(0, 1).toUpperCase()
                      : session.source === 'google_ai' ? 'G' : '⌕'}</span>}
                </span>
              </motion.button>
            ))}
          </div>
        </motion.div>
      )}
      </AnimatePresence>
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

/** Start a looping reaction that plays until explicitly stopped. */
export function startAvatarLoop(key: ReactionKey) {
  window.dispatchEvent(
    new CustomEvent<SetDisplayStatePayload>('pixel-avatar:state', {
      detail: { loop_reaction: key },
    }),
  );
}

/** Stop the currently playing loop reaction. */
export function stopAvatarLoop() {
  window.dispatchEvent(
    new CustomEvent<SetDisplayStatePayload>('pixel-avatar:state', {
      detail: { clear_loop: true },
    }),
  );
}
