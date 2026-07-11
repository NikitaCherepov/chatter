/**
 * Pixel Art service.
 * decodePixelArtFromBuffer — reads PNG → ASCII representation for the model to "see".
 * applyCommands — applies drawing commands (set_pixel, draw_rect, draw_line, fill) to a PNG buffer.
 * Designed for small pixel art (1×1 to 64×64).
 */

import { PNG } from 'pngjs';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DecodedPixelArt {
  width: number;
  height: number;
  palette: Record<string, string>;
  pixels: string[];
}

export type DrawAction = 'set_pixel' | 'draw_rect' | 'draw_line' | 'fill';

export interface DrawCommand {
  action: DrawAction;
  color: string;       // HEX, e.g. "#FFD700" or "transparent"
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
}

export interface ApplyCommandsResult {
  buffer: Buffer;
  width: number;
  height: number;
  applied: number;
  skipped: string[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_DIMENSION = 64;
const PALETTE_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// ─── Helpers ────────────────────────────────────────────────────────────────

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

/** Parse color string → RGBA tuple. "transparent"/"none" → [0,0,0,0] */
function parseColor(color: string): [number, number, number, number] {
  const c = (typeof color === 'string' ? color : '').trim().toLowerCase();
  if (!c || c === 'transparent' || c === 'none') return [0, 0, 0, 0];
  const [r, g, b] = parseHex(c);
  return [r, g, b, 255];
}

// ─── Decode ─────────────────────────────────────────────────────────────────

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

// ─── Apply Commands ─────────────────────────────────────────────────────────

/**
 * Apply drawing commands to a PNG buffer.
 * Returns modified buffer + stats.
 */
export function applyCommands(buffer: Buffer, commands: DrawCommand[]): ApplyCommandsResult {
  const png = PNG.sync.read(buffer);
  const { width, height } = png;

  let applied = 0;
  const skipped: string[] = [];

  const setPixel = (x: number, y: number, rgba: [number, number, number, number]) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (width * y + x) << 2;
    png.data[idx] = rgba[0];
    png.data[idx + 1] = rgba[1];
    png.data[idx + 2] = rgba[2];
    png.data[idx + 3] = rgba[3];
  };

  for (const cmd of commands) {
    if (!cmd || typeof cmd !== 'object') {
      skipped.push('invalid command (not an object)');
      continue;
    }

    const rgba = parseColor(cmd.color);

    switch (cmd.action) {
      case 'set_pixel': {
        const x = cmd.x, y = cmd.y;
        if (typeof x !== 'number' || typeof y !== 'number') {
          skipped.push(`set_pixel: missing x/y`);
          continue;
        }
        setPixel(x, y, rgba);
        applied++;
        break;
      }

      case 'draw_rect': {
        const x1 = cmd.x, y1 = cmd.y, x2 = cmd.x2, y2 = cmd.y2;
        if (typeof x1 !== 'number' || typeof y1 !== 'number' || typeof x2 !== 'number' || typeof y2 !== 'number') {
          skipped.push(`draw_rect: missing x/y/x2/y2`);
          continue;
        }
        const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);
        for (let py = minY; py <= maxY; py++) {
          for (let px = minX; px <= maxX; px++) {
            setPixel(px, py, rgba);
          }
        }
        applied++;
        break;
      }

      case 'draw_line': {
        const x1 = cmd.x, y1 = cmd.y, x2 = cmd.x2, y2 = cmd.y2;
        if (typeof x1 !== 'number' || typeof y1 !== 'number' || typeof x2 !== 'number' || typeof y2 !== 'number') {
          skipped.push(`draw_line: missing x/y/x2/y2`);
          continue;
        }
        // Bresenham's line algorithm
        let dx = Math.abs(x2 - x1);
        let dy = Math.abs(y2 - y1);
        let sx = x1 < x2 ? 1 : -1;
        let sy = y1 < y2 ? 1 : -1;
        let err = dx - dy;
        let cx = x1, cy = y1;
        // Safety cap to prevent infinite loops
        let cap = MAX_DIMENSION * MAX_DIMENSION * 4;
        while (cap-- > 0) {
          setPixel(cx, cy, rgba);
          if (cx === x2 && cy === y2) break;
          const e2 = 2 * err;
          if (e2 > -dy) { err -= dy; cx += sx; }
          if (e2 < dx) { err += dx; cy += sy; }
        }
        applied++;
        break;
      }

      case 'fill': {
        // Fill entire canvas with one color
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            setPixel(x, y, rgba);
          }
        }
        applied++;
        break;
      }

      default:
        skipped.push(`unknown action: ${cmd.action}`);
    }
  }

  const outBuffer = PNG.sync.write(png);
  return { buffer: outBuffer, width, height, applied, skipped };
}
