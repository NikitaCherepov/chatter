import React, { useEffect, useRef, useState } from 'react';
import hark from 'hark';

/** Wake word / phrase that triggers voice command mode */
export const WAKE_WORD = 'компьютер';

interface PassiveListenerProps {
  onCommand: (text: string) => void;
}

export const PassiveListener: React.FC<PassiveListenerProps> = ({ onCommand }) => {
  const [status, setStatus] = useState<'idle' | 'listening' | 'processing'>('idle');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const harkRef = useRef<ReturnType<typeof hark> | null>(null);
  const onCommandRef = useRef(onCommand);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  onCommandRef.current = onCommand;

  useEffect(() => {
    let stream: MediaStream;
    let cancelled = false;

    const init = async () => {
      try {
        // Skip if not in Electron
        if (!window.electronAPI?.transcribeAudio) return;

        stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        // 1. Set up recorder
        mediaRecorderRef.current = new MediaRecorder(stream);
        mediaRecorderRef.current.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };

        mediaRecorderRef.current.onstop = async () => {
          if (cancelled) return;
          setStatus('processing');

          const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
          chunksRef.current = [];
          const arrayBuffer = await blob.arrayBuffer();

          try {
            // Send audio to local Whisper via IPC
            const text = await window.electronAPI.transcribeAudio(arrayBuffer);
            console.log('[PassiveListener] Heard:', text);

            const lowerText = text.toLowerCase();

            // Look for wake word (fuzzy: each word of WAKE_WORD must appear in text)
            const wakeWords = WAKE_WORD.toLowerCase().split(/\s+/);
            const wakeMatch = wakeWords.every(w => lowerText.includes(w));

            if (wakeMatch) {
              // Take everything AFTER the LAST occurrence of the full wake phrase
              // For single-word wake words, split on that word
              const lastWakeWord = wakeWords[wakeWords.length - 1];
              const parts = lowerText.split(new RegExp(lastWakeWord, 'i'));
              let command = parts[parts.length - 1].trim();

              // Strip leading/trailing punctuation (whisper often adds ... , . etc.)
              command = command.replace(/^[^а-яёa-z\d]+/, '').replace(/[^а-яёa-z\d]+$/, '').trim();

              console.log('[PassiveListener] Wake word detected! Command:', command);

              // Guard against empty triggers
              if (command.length > 2) {
                onCommandRef.current(command);
              } else {
                console.log('[PassiveListener] Trigger word found but no command after it');
              }
            }
          } catch (err) {
            console.error('[PassiveListener] Whisper error:', err);
          } finally {
            if (!cancelled) setStatus('idle');
          }
        };

        // 2. Set up Hark (silence / speech detection)
        harkRef.current = hark(stream, {
          interval: 100,
          threshold: -50,
          play: false,
        });

        harkRef.current.on('speaking', () => {
          if (cancelled) return;
          // Cancel pending stop — person resumed speaking
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
          if (mediaRecorderRef.current?.state === 'inactive') {
            setStatus('listening');
            chunksRef.current = [];
            mediaRecorderRef.current.start();
          }
        });

        harkRef.current.on('stopped_speaking', () => {
          if (cancelled) return;
          // Don't stop immediately — wait 800ms in case person continues
          // (e.g. pause between wake word and command)
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = setTimeout(() => {
            silenceTimerRef.current = null;
            if (mediaRecorderRef.current?.state === 'recording') {
              mediaRecorderRef.current.stop();
            }
          }, 800);
        });
      } catch (err) {
        console.error('[PassiveListener] Mic access failed:', err);
      }
    };

    init();

    // Cleanup on unmount
    return () => {
      cancelled = true;
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      if (harkRef.current) harkRef.current.stop();
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '16px',
        right: '16px',
        padding: '8px 12px',
        backgroundColor: 'var(--bg-secondary, #1e1e2e)',
        color: 'var(--text-primary, #cdd6f4)',
        borderRadius: '8px',
        fontSize: '12px',
        opacity: status === 'idle' ? 0.4 : 0.8,
        transition: 'opacity 0.2s',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor:
            status === 'listening'
              ? '#4caf50'
              : status === 'processing'
                ? '#ff9800'
                : '#666',
          animation:
            status === 'listening'
              ? 'pulse 1.5s ease-in-out infinite'
              : status === 'processing'
                ? 'spin 1s linear infinite'
                : 'none',
        }}
      />
      {status === 'listening'
        ? 'Слушаю...'
        : status === 'processing'
          ? 'Распознаю...'
          : `Жду "${WAKE_WORD}"`}
    </div>
  );
};
