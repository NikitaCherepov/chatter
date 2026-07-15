import { sendMessageThroughAi } from './ai.js';

type VoiceTurnOptions = {
  userTelegramChatId?: number | null;
  userTelegramMessageId?: number | null;
  assistantTelegramChatId?: number | null;
};

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const getMaxAudioBytes = () => parsePositiveInteger(process.env.VOICE_MAX_AUDIO_MB, 10) * 1024 * 1024;

const resolveDefaultVoiceEndpoint = (transcribeUrl: string, targetPath: '/api/tts' | '/api/silero') => {
  try {
    const parsed = new URL(transcribeUrl);
    if (parsed.pathname.endsWith('/api/voice')) {
      parsed.pathname = parsed.pathname.replace(/\/api\/voice$/, targetPath);
    } else {
      parsed.pathname = targetPath;
    }
    return parsed.toString();
  } catch {
    return transcribeUrl;
  }
};

const normalizeTtsEngine = (value: string | undefined) => {
  const lowered = `${value || ''}`.trim().toLowerCase();
  if (lowered === 'silero') return 'silero';
  return 'tts';
};

const getVoiceConfig = () => {
  const transcribeUrl = `${process.env.VOICE_TRANSCRIBE_URL || ''}`.trim();
  const token = `${process.env.VOICE_TRANSCRIBE_TOKEN || ''}`.trim();

  if (!transcribeUrl) throw new Error('VOICE_TRANSCRIBE_URL_REQUIRED');
  if (!token) throw new Error('VOICE_TRANSCRIBE_TOKEN_REQUIRED');

  const ttsEngine = normalizeTtsEngine(process.env.VOICE_TTS_ENGINE);
  const ttsUrl = `${process.env.VOICE_TTS_URL || resolveDefaultVoiceEndpoint(transcribeUrl, '/api/tts')}`.trim();
  const sileroUrl = `${process.env.VOICE_SILERO_URL || resolveDefaultVoiceEndpoint(transcribeUrl, '/api/silero')}`.trim();

  return {
    transcribeUrl,
    token,
    synthesisUrl: ttsEngine === 'silero' ? sileroUrl : ttsUrl
  };
};

const transcribeAudio = async (audioBuffer: Buffer, mimeType: string) => {
  const config = getVoiceConfig();
  const formData = new FormData();
  formData.append('audio', new Blob([new Uint8Array(audioBuffer)], { type: mimeType || 'audio/ogg' }), 'voice.ogg');

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`
  };

  const response = await fetch(config.transcribeUrl, {
    method: 'POST',
    headers,
    body: formData
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    const extra = details ? ` | ${details.slice(0, 300)}` : '';
    throw new Error(`VOICE_TRANSCRIBE ${response.status} ${response.statusText}${extra}`);
  }

  const payload = await response.json() as { text?: string };
  return `${payload?.text || ''}`.trim();
};

const synthesizeVoice = async (text: string) => {
  const safeText = `${text || ''}`.trim();
  if (!safeText) return null;
  const config = getVoiceConfig();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.token}`
  };

  const response = await fetch(config.synthesisUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: safeText })
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    const extra = details ? ` | ${details.slice(0, 300)}` : '';
    throw new Error(`VOICE_SYNTH ${response.status} ${response.statusText}${extra}`);
  }

  const audioArrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(audioArrayBuffer);
  if (!buffer.length) {
    throw new Error('VOICE_SYNTH_EMPTY_AUDIO');
  }
  const contentType = `${response.headers.get('content-type') || 'audio/mpeg'}`.trim();
  return { buffer, contentType };
};

export const runVoiceTurn = async (
  userId: number,
  audioBase64: string,
  mimeType: string,
  chatId?: number,
  options?: VoiceTurnOptions
) => {
  const normalizedBase64 = `${audioBase64 || ''}`.trim();
  if (!normalizedBase64) throw new Error('empty_audio');

  const audioBuffer = Buffer.from(normalizedBase64, 'base64');
  if (!audioBuffer.length) throw new Error('empty_audio');
  if (audioBuffer.length > getMaxAudioBytes()) throw new Error('audio_too_large');

  const transcribedText = await transcribeAudio(audioBuffer, mimeType || 'audio/ogg');
  if (!transcribedText) {
    return {
      recognized_text: '',
      reply_text: '',
      voice_audio_base64: null,
      voice_mime_type: null,
      model_fallback_notice: null,
      tool_user_messages: [],
      message_id: null
    };
  }

  const aiResult = await sendMessageThroughAi(userId, transcribedText, chatId, {
    persistUserText: transcribedText,
    userTelegramChatId: Number.isFinite(Number(options?.userTelegramChatId)) ? Math.floor(Number(options?.userTelegramChatId)) : null,
    userTelegramMessageId: Number.isFinite(Number(options?.userTelegramMessageId)) ? Math.floor(Number(options?.userTelegramMessageId)) : null,
    assistantTelegramChatId: Number.isFinite(Number(options?.assistantTelegramChatId)) ? Math.floor(Number(options?.assistantTelegramChatId)) : null
  });

  let voiceAudioBase64: string | null = null;
  let voiceMimeType: string | null = null;
  let voiceError: string | null = null;

  try {
    const voice = await synthesizeVoice(aiResult.reply_text || '');
    if (voice?.buffer?.length) {
      voiceAudioBase64 = voice.buffer.toString('base64');
      voiceMimeType = voice.contentType || null;
    }
  } catch (err: any) {
    voiceError = `${err?.message || String(err)}`;
  }

  return {
    recognized_text: transcribedText,
    reply_text: aiResult.reply_text,
    voice_audio_base64: voiceAudioBase64,
    voice_mime_type: voiceMimeType,
    voice_error: voiceError,
    model_fallback_notice: aiResult.model_fallback_notice || null,
    tool_user_messages: Array.isArray(aiResult.tool_user_messages) ? aiResult.tool_user_messages : [],
    message_id: Number.isFinite(Number(aiResult.message_id)) ? Math.floor(Number(aiResult.message_id)) : null
  };
};
