/**
 * Cartesia.ai TTS proxy service.
 *
 * Proxies voice listing and audio generation to Cartesia API.
 * API key is stored server-side — clients never see it.
 */

import dotenv from 'dotenv';
dotenv.config();

const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY || '';
const CARTESIA_BASE_URL = 'https://api.cartesia.ai';
const CARTESIA_VERSION = '2026-03-01';
const DEFAULT_MODEL = process.env.CARTESIA_MODEL_ID || 'sonic-3.5';

if (!CARTESIA_API_KEY) {
  console.log('[tts-cartesia] CARTESIA_API_KEY not set — cloud TTS disabled');
}

export function isCartesiaConfigured(): boolean {
  return CARTESIA_API_KEY.length > 0;
}

// ── Voice listing ───────────────────────────────────────────────────────

export type CartesiaVoice = {
  id: string;
  name: string;
  description?: string;
  language?: string;
  gender?: string;
};

export async function fetchCartesiaVoices(language?: string): Promise<CartesiaVoice[]> {
  const allVoices: CartesiaVoice[] = [];
  let startingAfter: string | undefined;

  // Paginate through all voices
  do {
    const params = new URLSearchParams();
    params.set('limit', '100');
    if (language) params.set('language', language);
    if (startingAfter) params.set('starting_after', startingAfter);

    const url = `${CARTESIA_BASE_URL}/voices?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${CARTESIA_API_KEY}`,
        'Cartesia-Version': CARTESIA_VERSION,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Cartesia voices API error: ${res.status} ${body}`);
    }

    const data = await res.json() as {
      data: Array<{ id: string; name: string; description?: string; language?: string; gender?: string }>;
      has_more: boolean;
      next_page?: string;
    };

    for (const v of data.data) {
      allVoices.push({
        id: v.id,
        name: v.name,
        description: v.description,
        language: v.language,
        gender: v.gender,
      });
      startingAfter = v.id;
    }

    if (!data.has_more) break;
  } while (true);

  return allVoices;
}

// ── Audio generation ────────────────────────────────────────────────────

export type GenerateTtsResult = {
  audioBuffer: Buffer;
  contentType: string;
};

export async function generateTtsAudio(
  text: string,
  voiceId: string,
  language: string = 'ru',
): Promise<GenerateTtsResult> {
  const body = {
    model_id: DEFAULT_MODEL,
    transcript: text,
    voice: { mode: 'id', id: voiceId },
    output_format: { container: 'mp3', sample_rate: 44100 },
    language,
  };

  const res = await fetch(`${CARTESIA_BASE_URL}/tts/bytes`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CARTESIA_API_KEY}`,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Cartesia TTS API error: ${res.status} ${errBody}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    audioBuffer: Buffer.from(arrayBuffer),
    contentType: 'audio/mpeg',
  };
}
