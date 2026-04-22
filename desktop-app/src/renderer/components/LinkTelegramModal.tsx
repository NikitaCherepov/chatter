import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as api from '../lib/api';

type Props = {
  onClose: () => void;
  onLinked: () => void;
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

  // Generate code on mount
  useEffect(() => {
    generate();
  }, [generate]);

  // Countdown + poll for link status
  useEffect(() => {
    if (!code) return;

    pollRef.current = setInterval(async () => {
      setExpiresIn((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          setCode(null);
          return 0;
        }
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

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [code, onLinked]);

  const formatCountdown = (s: number) => {
    const min = Math.floor(s / 60);
    const sec = s % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.title}>Привязать Telegram</h2>

        {linked && (
          <div style={styles.success}>
            <div style={styles.successIcon}>&#10003;</div>
            <p>Аккаунт привязан!</p>
          </div>
        )}

        {!linked && loading && <p style={styles.hint}>Генерация кода...</p>}

        {!linked && !loading && error && (
          <div style={styles.errorBlock}>
            <p>{error}</p>
            <button style={styles.retryBtn} onClick={generate}>Попробовать снова</button>
          </div>
        )}

        {!linked && !loading && !error && code && (
          <>
            <p style={styles.hint}>
              Отправь команду <code style={styles.code}>/link</code> в Telegram-боте
              и введи этот код:
            </p>
            <div style={styles.codeBlock}>{code}</div>
            <p style={styles.timer}>Код действителен: {formatCountdown(expiresIn)}</p>
            {expiresIn <= 0 && (
              <button style={styles.retryBtn} onClick={generate}>
                Получить новый код
              </button>
            )}
          </>
        )}

        {!linked && !loading && !error && !code && (
          <div style={styles.errorBlock}>
            <p>Код истёк</p>
            <button style={styles.retryBtn} onClick={generate}>
              Получить новый код
            </button>
          </div>
        )}

        <button style={styles.closeBtn} onClick={onClose}>Закрыть</button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: '32px',
    width: 380,
    textAlign: 'center',
    boxShadow: '0 12px 48px rgba(0,0,0,0.4)',
  },
  title: {
    margin: '0 0 20px',
    fontSize: 20,
    fontWeight: 700,
    color: '#eee',
  },
  hint: {
    color: '#8899aa',
    fontSize: 14,
    lineHeight: 1.5,
    marginBottom: 16,
  },
  code: {
    backgroundColor: '#0f3460',
    padding: '2px 6px',
    borderRadius: 4,
    color: '#e94560',
  },
  codeBlock: {
    fontSize: 36,
    fontWeight: 700,
    letterSpacing: 8,
    color: '#e94560',
    backgroundColor: '#0f3460',
    borderRadius: 12,
    padding: '16px',
    margin: '16px 0',
  },
  timer: {
    color: '#667',
    fontSize: 13,
    marginBottom: 16,
  },
  success: {
    color: '#4caf50',
    fontSize: 16,
    marginBottom: 16,
  },
  successIcon: {
    fontSize: 48,
    marginBottom: 8,
  },
  errorBlock: {
    color: '#ff6b6b',
    fontSize: 14,
    marginBottom: 16,
  },
  retryBtn: {
    padding: '8px 20px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: '#e94560',
    color: '#fff',
    fontSize: 14,
    cursor: 'pointer',
    marginTop: 8,
  },
  closeBtn: {
    marginTop: 12,
    padding: '8px 24px',
    borderRadius: 8,
    border: '1px solid #2a3a5e',
    backgroundColor: 'transparent',
    color: '#8899aa',
    fontSize: 14,
    cursor: 'pointer',
  },
};
