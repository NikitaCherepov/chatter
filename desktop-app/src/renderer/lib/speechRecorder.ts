import hark from 'hark';

type SpeechRecorderOptions = {
  silenceDelayMs?: number;
  harkThreshold?: number;
  harkInterval?: number;
  maxRecordingMs?: number;
  mimeType?: string;
  onSpeechStart?: () => void;
  onSpeechEnd?: (audioBlob: Blob) => void | Promise<void>;
  /** Called when recording stopped without detecting any speech (timeout) */
  onNoSpeech?: () => void;
  onVolumeChange?: (volume: number, threshold: number) => void;
  onError?: (error: unknown) => void;
};

type SpeechRecorderController = {
  start: () => Promise<void>;
  stop: () => void;
  isActive: () => boolean;
};

export function createSpeechRecorder(
  options: SpeechRecorderOptions = {},
): SpeechRecorderController {
  const {
    silenceDelayMs = 900,
    harkThreshold = -55,
    harkInterval = 100,
    maxRecordingMs = 8000,
    mimeType = 'audio/webm',
    onSpeechStart,
    onSpeechEnd,
    onNoSpeech,
    onVolumeChange,
    onError,
  } = options;

  let stream: MediaStream | null = null;
  let mediaRecorder: MediaRecorder | null = null;
  let speechEvents: ReturnType<typeof hark> | null = null;

  let chunks: BlobPart[] = [];
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxRecordingTimer: ReturnType<typeof setTimeout> | null = null;
  let active = false;
  let hadSpeech = false;

  const clearSilenceTimer = () => {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  };

  const clearMaxRecordingTimer = () => {
    if (maxRecordingTimer) {
      clearTimeout(maxRecordingTimer);
      maxRecordingTimer = null;
    }
  };

  const stopCurrentRecording = async () => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      return;
    }

    // Cancel max recording timer — recording is stopping for another reason
    clearMaxRecordingTimer();

    mediaRecorder.stop();
  };

  const startCurrentRecording = () => {
    if (!stream) return;

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      return;
    }

    chunks = [];

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported(mimeType)
        ? mimeType
        : undefined,
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      // No speech detected — skip transcription, notify caller
      if (!hadSpeech) {
        chunks = [];
        onNoSpeech?.();
        return;
      }

      const audioBlob = new Blob(chunks, {
        type: mimeType,
      });

      chunks = [];

      if (audioBlob.size > 0) {
        await onSpeechEnd?.(audioBlob);
      }
    };

    mediaRecorder.start();

    onSpeechStart?.();
  };

  const start = async () => {
    if (active) return;

    active = true;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Start MediaRecorder IMMEDIATELY — no waiting for hark.
      // Wake word already confirmed the user is speaking.
      startCurrentRecording();

      // Hard limit: force stop if recording runs too long
      // (e.g. user said wake word but stayed silent)
      maxRecordingTimer = setTimeout(() => {
        console.log('[speechRecorder] max recording time reached, stopping');
        stopCurrentRecording();
      }, maxRecordingMs);

      // hark runs in parallel, only used for silence detection (auto-stop)
      speechEvents = hark(stream, {
        threshold: harkThreshold,
        interval: harkInterval,
      });

      // Grace period: ignore silence for the first 1.5s so we don't
      // cut off immediately if there's a brief pause before speech begins
      let gracePeriod = true;
      setTimeout(() => { gracePeriod = false; }, 1500);

      speechEvents.on('speaking', () => {
        hadSpeech = true;
        clearSilenceTimer();
        clearMaxRecordingTimer();
      });

      speechEvents.on('stopped_speaking', () => {
        if (gracePeriod) return;

        clearSilenceTimer();

        silenceTimer = setTimeout(() => {
          stopCurrentRecording();
        }, silenceDelayMs);
      });

      speechEvents.on('volume_change', (volume: number, threshold: number) => {
        onVolumeChange?.(volume, threshold);
      });
    } catch (error) {
      active = false;
      onError?.(error);
    }
  };

  const stop = () => {
    active = false;

    clearSilenceTimer();
    clearMaxRecordingTimer();

    if (speechEvents) {
      speechEvents.stop();
      speechEvents = null;
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      stream = null;
    }

    mediaRecorder = null;
    hadSpeech = false;
    chunks = [];
  };

  return {
    start,
    stop,
    isActive: () => active,
  };
}
