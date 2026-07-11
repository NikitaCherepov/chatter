import sharp from 'sharp';

export type PixelArtResult = {
  base64: string;
  url: string;
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
 * Рендерит 2D массив hex-цветов в PNG buffer.
 * Каждый логический пиксель масштабируется до PIXEL_SIZE x PIXEL_SIZE физических пикселей.
 */
const renderPixelArt = (pixels: string[][]): Buffer => {
  const rows = pixels.length;
  const imgW = rows * PIXEL_SIZE;
  const imgH = rows * PIXEL_SIZE;
  const buf = Buffer.alloc(imgW * imgH * 4);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < rows; x++) {
      const [r, g, b] = hexToRgb(pixels[y][x]);
      for (let dy = 0; dy < PIXEL_SIZE; dy++) {
        for (let dx = 0; dx < PIXEL_SIZE; dx++) {
          const px = x * PIXEL_SIZE + dx;
          const py = y * PIXEL_SIZE + dy;
          const idx = (py * imgW + px) * 4;
          buf[idx] = r;
          buf[idx + 1] = g;
          buf[idx + 2] = b;
          buf[idx + 3] = 255;
        }
      }
    }
  }

  return buf;
};

/**
 * Создаёт пиксель-арт изображение из 2D массива hex-цветов.
 * Сохраняет PNG на диск через saveGeneratedImage и возвращает base64 + URL.
 */
export const createPixelArt = async (
  pixels: unknown
): Promise<PixelArtResult> => {
  const rows = validatePixels(pixels);

  const rawBuf = renderPixelArt(pixels as string[][]);

  const imgW = rows * PIXEL_SIZE;
  const imgH = rows * PIXEL_SIZE;

  const pngBuffer = await sharp(rawBuf, {
    raw: { width: imgW, height: imgH, channels: 4 },
  })
    .png()
    .toBuffer();

  const base64 = pngBuffer.toString('base64');

  const { saveGeneratedImage } = await import('./image-storage.js');
  const saved = await saveGeneratedImage(base64);

  return { base64, url: saved.url };
};
