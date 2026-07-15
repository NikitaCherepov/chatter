import type { NextRequest } from 'next/server';

export type LimitedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: string };

export const readLimitedJson = async (
  request: NextRequest,
  maxBytes: number
): Promise<LimitedJsonResult> => {
  const contentLengthRaw = request.headers.get('content-length');
  if (contentLengthRaw) {
    const contentLength = Number(contentLengthRaw);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false, status: 413, error: 'Request body is too large' };
    }
  }

  if (!request.body) {
    return { ok: false, status: 400, error: 'Invalid JSON' };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: 'Request body is too large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: 'Invalid request body' };
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: 'Invalid JSON' };
  }
};
