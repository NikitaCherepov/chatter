import sharp from 'sharp';

export type PixelArtResult = {
  /** Большая картинка для просмотра (каждый пиксель масштабирован) */
  preview: { base64: string; url: string };
  /** Оригинальный размер 1:1 (16x16 или 32x32 пикселей) */
  original: { base64: string; url: string };
};

const PIXEL_SIZE = 16;
const ALLOWED_SIZES = [16, 32];

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  if (h.length !== 6) throw new Error(`Невалидный hex (длина): ${hex}`);
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) throw new Error(`Невалидный hex: ${hex}`);
  return [r, g, b];
};

const validatePixels = (pixels: unknown): number => {
  if (!Array.isArray(pixels) || pixels.length === 0)
    throw new Error('pixels должен быть непустым 2D массивом');

  const rows = pixels.length;
  if (!ALLOWED_SIZES.includes(rows))
    throw new Error(`Поддерживаются только размеры 16x16 или 32x32, получено ${rows}x${rows}`);

  for (const row of pixels) {
    if (!Array.isArray(row) || row.length !== rows)
      throw new Error(`Массив должен быть квадратным ${rows}x${rows}`);
  }

  return rows;
};

/**
 * Рендерит 2D массив hex-цветов в raw RGBA buffer.
 * pixelScale = 1 — оригинальный размер, pixelScale > 1 — увеличенный для просмотра.
 */
const renderPixelArt = (pixels: string[][], pixelScale: number): { buf: Buffer; width: number; height: number } => {
  const rows = pixels.length;
  const imgW = rows * pixelScale;
  const imgH = rows * pixelScale;
  const buf = Buffer.alloc(imgW * imgH * 4);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < rows; x++) {
      const [r, g, b] = hexToRgb(pixels[y][x]);
      for (let dy = 0; dy < pixelScale; dy++) {
        for (let dx = 0; dx < pixelScale; dx++) {
          const px = x * pixelScale + dx;
          const py = y * pixelScale + dy;
          const idx = (py * imgW + px) * 4;
          buf[idx] = r;
          buf[idx + 1] = g;
          buf[idx + 2] = b;
          buf[idx + 3] = 255;
        }
      }
    }
  }

  return { buf, width: imgW, height: imgH };
};

const toPngBase64 = async (buf: Buffer, width: number, height: number): Promise<string> => {
  const pngBuffer = await sharp(buf, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
  return pngBuffer.toString('base64');
};

/**
 * Создаёт пиксель-арт из 2D массива hex-цветов.
 * Сохраняет два PNG на диск:
 *  - preview: увеличенный (каждый пиксель = 16x16 физических)
 *  - original: 1:1 (16x16 или 32x32 пикселей)
 */
export const createPixelArt = async (
  pixels: unknown
): Promise<PixelArtResult> => {
  validatePixels(pixels);
  const px = pixels as string[][];

  const { saveGeneratedImage } = await import('./image-storage.js');

  // Preview — увеличенный
  const previewRender = renderPixelArt(px, PIXEL_SIZE);
  const previewBase64 = await toPngBase64(previewRender.buf, previewRender.width, previewRender.height);
  const previewSaved = await saveGeneratedImage(previewBase64);

  // Original — 1:1
  const originalRender = renderPixelArt(px, 1);
  const originalBase64 = await toPngBase64(originalRender.buf, originalRender.width, originalRender.height);
  const originalSaved = await saveGeneratedImage(originalBase64);

  return {
    preview: { base64: previewBase64, url: previewSaved.url },
    original: { base64: originalBase64, url: originalSaved.url },
  };
};
