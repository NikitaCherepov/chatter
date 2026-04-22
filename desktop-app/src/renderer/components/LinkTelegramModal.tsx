import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import * as api from '../lib/api';
import s from './LinkTelegramModal.module.scss';

type Props = {
  onClose: () => void;
  onLinked: () => void;
};

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { opacity: 0, y: 16, transition: { duration: 0.15 } },
};

export function LinkTelegramModal({ onClose, onLinked }: Props) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresIn, setExpiresIn] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [linked, setLinked] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>();

  const generate = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.generateLinkCodeApi();
      setCode(res.code);
      setExpiresIn(res.expires_in);
    } catch (err: any) {
      setError(err?.message || 'Failed to generate code');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { generate(); }, [generate]);

  useEffect(() => {
    if (!code) return;

    pollRef.current = setInterval(async () => {
      setExpiresIn((prev) => {
        const next = prev - 1;
        if (next <= 0) { setCode(null); return 0; }
        return next;
      });

      try {
        const status = await api.getLinkStatus();
        if (status.linked) {
          setLinked(true);
          if (pollRef.current) clearInterval(pollRef.current);
          setTimeout(() => onLinked(), 1500);
        }
      } catch {}
    }, 3000);

    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [code, onLinked]);

  const formatCountdown = (sec: number) => {
    const min = Math.floor(sec / 60);
    const r = sec % 60;
    return `${min}:${r.toString().padStart(2, '0')}`;
  };

  return (
    <motion.div
      className={s.overlay}
      onClick={onClose}
      variants={overlayVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
        <motion.div
          className={s.modal}
          onClick={(e) => e.stopPropagation()}
          variants={modalVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
        <button className={s.closeBtn} onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className={s.iconWrap}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-primary)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </div>

        <h2 className={s.title}>Link Telegram</h2>

        {linked && (
          <div className={s.success}>
            <div className={s.successCheck}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <p className={s.successText}>Account linked successfully!</p>
          </div>
        )}

        {!linked && loading && (
          <div className={s.loadingState}>
            <div className={s.spinner} />
            <p className={s.loadingText}>Generating code...</p>
          </div>
        )}

        {!linked && !loading && error && (
          <div className={s.errorBlock}>
            <p className={s.errorText}>{error}</p>
            <button className={s.actionBtn} onClick={generate}>Try again</button>
          </div>
        )}

        {!linked && !loading && !error && code && (
          <>
            <p className={s.hint}>
              Send <span className={s.codeTag}>/link</span> in the Telegram bot
              and enter this code:
            </p>
            <div className={s.codeBlock}>
              {code.split('').map((ch, i) => (
                <span key={i} className={s.codeDigit}>{ch}</span>
              ))}
            </div>
            <p className={s.timer}>
              Valid for <span className={s.timerBold}>{formatCountdown(expiresIn)}</span>
            </p>
            {expiresIn <= 0 && (
              <button className={s.actionBtn} onClick={generate}>Get new code</button>
            )}
          </>
        )}

        {!linked && !loading && !error && !code && (
          <div className={s.errorBlock}>
            <p className={s.errorText}>Code expired</p>
            <button className={s.actionBtn} onClick={generate}>Get new code</button>
          </div>
        )}
      </motion.div>
      </motion.div>
  );
}
