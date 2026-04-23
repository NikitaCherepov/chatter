// ─────────────────────────────────────────────────────────────────────────────
// Minimal GIF89a parser — extracts total animation duration by reading the
// Graphic Control Extension blocks (delay per frame) and counting frames.
//
// GIF spec: https://www.w3.org/Graphics/GIF/spec-gif89a.txt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a GIF and return its total animation duration in milliseconds.
 * For a static image (single frame) returns 0.
 *
 * @param url — URL to the GIF (works with Vite-resolved paths, blobs, etc.)
 */
export async function getGifDurationMs(url: string): Promise<number> {
  const response = await fetch(url);
  if (!response.ok) return 0;

  const buffer = await response.arrayBuffer();
  const data = new Uint8Array(buffer);
  const len = data.length;

  // Must start with "GIF89a" or "GIF87a"
  if (len < 13) return 0;
  const sig = String.fromCharCode(...data.slice(0, 6));
  if (sig !== 'GIF89a' && sig !== 'GIF87a') return 0;

  // Skip Logical Screen Descriptor (7 bytes after signature)
  let offset = 13;

  // Global Color Table
  const gctFlag = (data[10] & 0x80) >> 7;
  const gctSize = gctFlag ? 3 * (1 << ((data[10] & 0x07) + 1)) : 0;
  offset += gctSize;

  let totalDelay = 0;
  let frameCount = 0;

  while (offset < len) {
    const block = data[offset];

    // 0x3B — Trailer (end of GIF)
    if (block === 0x3B) break;

    // 0x21 — Extension
    if (block === 0x21) {
      const label = data[offset + 1];

      // 0xF9 — Graphic Control Extension (contains delay)
      if (label === 0xF9 && offset + 8 < len) {
        const packed = data[offset + 3];
        const delayCs = data[offset + 4] | (data[offset + 5] << 8); // centiseconds
        // Per spec: 0 means "use 100ms" for most decoders
        const delayMs = (delayCs === 0 ? 10 : delayCs) * 10;
        totalDelay += delayMs;
        frameCount++;
      }

      // Skip sub-blocks
      offset += 2; // skip introducer + label
      offset = skipSubBlocks(data, offset);
      continue;
    }

    // 0x2C — Image Descriptor
// 0x2C — Image Descriptor
    if (block === 0x2C) {
      offset += 10; // Image Descriptor is always 10 bytes
      
      // Local Color Table
      const packedField = data[offset - 1]; // ИСПРАВЛЕНО: было offset - 3
      const lctFlag = (packedField & 0x80) >> 7;
      
      if (lctFlag) {
        const lctSize = 3 * (1 << ((packedField & 0x07) + 1));
        offset += lctSize;
      }
      // LZW minimum code size
      offset++;
      // Image data sub-blocks
      offset = skipSubBlocks(data, offset);
      continue;
    }

    // Unknown block — skip
    offset++;
  }

  // Single frame → not animated
  if (frameCount <= 1) return 0;

  return totalDelay;
}

/** Skip a sequence of sub-blocks (each starts with size byte, 0 = terminator) */
function skipSubBlocks(data: Uint8Array, offset: number): number {
  while (offset < data.length) {
    const size = data[offset];
    offset++;
    if (size === 0) break;
    offset += size;
  }
  return offset;
}
