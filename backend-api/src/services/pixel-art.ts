/**
 * Pixel Art encode/decode service.
 * Converts between ASCII representation ({ palette, pixels }) and PNG buffers.
 * Designed for small pixel art (1×1 to 64×64).
 */

import { PNG } from 'pngjs';

export interface PixelArtArgs {
  width: number;
  height: number;
  /** Key = single char (e.g. "B"), value = HEX color ("#FF0000") or "transparent" */
  palette: Record<string, string>;
  /** Array of strings, each string = one row of characters */
  pixels: string[];
}

export interface DecodedPixelArt {
  width: number;
  height: number;
  palette: Record<string, string>;
  pixels: string[];
}

const MAX_DIMENSION = 64;
const PALETTE_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Parse a hex color string ("#FF5733" or "FF5733") into RGB tuple */
function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) || 0;
  const g = parseInt(clean.substring(2, 4), 16) || 0;
  const b = parseInt(clean.substring(4, 6), 16) || 0;
  return [r, g, b];
}

/** Convert RGB to uppercase hex string "#RRGGBB" */
function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

/** Euclidean distance in RGB space */
function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Encode an ASCII pixel art representation into a PNG buffer.
 * Validates dimensions, pads/truncates pixel rows as needed.
 */
export function encodePixelArt(args: PixelArtArgs): Buffer {
  let { width, height, palette, pixels } = args;

  // Clamp dimensions
  width = Math.max(1, Math.min(Math.floor(width), MAX_DIMENSION));
  height = Math.max(1, Math.min(Math.floor(height), MAX_DIMENSION));

  // Normalize palette keys to single chars
  const normalizedPalette: Record<string, [number, number, number, number]> = {};
  for (const [key, colorStr] of Object.entries(palette)) {
    const k = key.charAt(0);
    const c = (typeof colorStr === 'string' ? colorStr : '').trim();
    if (!c || c === 'transparent' || c === 'none') {
      normalizedPalette[k] = [0, 0, 0, 0]; // transparent
    } else {
      const [r, g, b] = parseHex(c);
      normalizedPalette[k] = [r, g, b, 255];
    }
  }
  // Ensure "." is always transparent
  normalizedPalette['.'] = [0, 0, 0, 0];

  // Create PNG
  const png = new PNG({ width, height, filterType: -1 });

  // Fill pixel data
  for (let y = 0; y < height; y++) {
    const row = typeof pixels[y] === 'string' ? pixels[y] : '';
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const char = row[x] || '.';
      const color = normalizedPalette[char] || normalizedPalette['.'] || [0, 0, 0, 0];
      png.data[idx] = color[0];
      png.data[idx + 1] = color[1];
      png.data[idx + 2] = color[2];
      png.data[idx + 3] = color[3];
    }
  }

  return PNG.sync.write(png);
}

/**
 * Decode a PNG buffer into ASCII pixel art representation.
 * Assigns palette keys dynamically based on unique colors found.
 * If there are more unique colors than available keys (62),
 * quantizes by nearest-neighbor merging.
 */
export function decodePixelArtFromBuffer(buffer: Buffer): DecodedPixelArt {
  const png = PNG.sync.read(buffer);
  const { width, height } = png;

  // Collect unique colors (excluding transparent)
  const colorMap = new Map<string, [number, number, number]>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const a = png.data[idx + 3];

      if (a < 128) continue; // transparent — skip, will use "."

      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const hex = rgbToHex(r, g, b);

      if (!colorMap.has(hex)) {
        colorMap.set(hex, [r, g, b]);
      }
    }
  }

  // Sort colors by frequency (most used first) for better key assignment
  const colorCounts = new Map<string, number>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const a = png.data[idx + 3];
      if (a < 128) continue;
      const hex = rgbToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2]);
      colorCounts.set(hex, (colorCounts.get(hex) || 0) + 1);
    }
  }

  let uniqueColors = [...colorMap.entries()].sort((a, b) =>
    (colorCounts.get(b[0]) || 0) - (colorCounts.get(a[0]) || 0)
  );

  // If too many colors — quantize by merging nearest neighbors
  while (uniqueColors.length > PALETTE_KEYS.length) {
    let minDist = Infinity;
    let mergeI = -1;
    let mergeJ = -1;
    for (let i = 0; i < uniqueColors.length; i++) {
      for (let j = i + 1; j < uniqueColors.length; j++) {
        const d = colorDistance(uniqueColors[i][1], uniqueColors[j][1]);
        if (d < minDist) {
          minDist = d;
          mergeI = i;
          mergeJ = j;
        }
      }
    }
    if (mergeI < 0) break;
    // Merge j into i (keep the more frequent one)
    uniqueColors.splice(mergeJ, 1);
  }

  // Build palette: assign keys
  const hexToKey = new Map<string, string>();
  const palette: Record<string, string> = { '.': 'transparent' };

  uniqueColors.forEach(([hex], i) => {
    const key = PALETTE_KEYS[i] || '?';
    hexToKey.set(hex, key);
    palette[key] = hex;
  });

  // Build pixel rows
  const pixels: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const a = png.data[idx + 3];
      if (a < 128) {
        row += '.';
      } else {
        const hex = rgbToHex(png.data[idx], png.data[idx + 1], png.data[idx + 2]);
        row += hexToKey.get(hex) || '.';
      }
    }
    pixels.push(row);
  }

  return { width, height, palette, pixels };
}

/**
 * Validate pixel art args and return error message or null.
 */
export function validatePixelArtArgs(args: any): string | null {
  if (!args || typeof args !== 'object') return 'Аргументы должны быть объектом';

  const { width, height, palette, pixels } = args;

  if (typeof width !== 'number' || width < 1 || width > MAX_DIMENSION)
    return `width должен быть числом от 1 до ${MAX_DIMENSION}`;

  if (typeof height !== 'number' || height < 1 || height > MAX_DIMENSION)
    return `height должен быть числом от 1 до ${MAX_DIMENSION}`;

  if (!palette || typeof palette !== 'object')
    return 'palette должен быть объектом { символ: "#HEX" }';

  if (!Array.isArray(pixels) || pixels.length === 0)
    return 'pixels должен быть массивом строк';

  if (pixels.length > height)
    return `pixels содержит ${pixels.length} строк, но height=${height}`;

  // Check palette keys are single chars
  for (const key of Object.keys(palette)) {
    if (key.length !== 1) return `Ключ палитры "${key}" должен быть одним символом`;
  }

  // Check pixel rows don't exceed width
  for (let i = 0; i < pixels.length; i++) {
    if (typeof pixels[i] !== 'string') return `pixels[${i}] должен быть строкой`;
    if (pixels[i].length > width) return `pixels[${i}] содержит ${pixels[i].length} символов, но width=${width}`;
  }

  return null;
}
