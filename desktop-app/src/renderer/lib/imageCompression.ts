export const DEFAULT_MAX_IMAGE_ATTACHMENTS_TOTAL_BYTES = 32 * 1024 * 1024;

const MAX_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_PREPARED_IMAGE_BYTES = 8 * 1024 * 1024;

export type PreparedImage = {
  file: File;
  preview: string;
  base64: string;
  mime_type: string;
  size_bytes: number;
};

const blobToBase64 = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    const value = `${reader.result || ''}`;
    resolve(value.split(',')[1] || value);
  };
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

const canvasToBlob = (
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob> => new Promise((resolve, reject) => {
  canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('image_encode_failed')),
    type,
    quality,
  );
});

export async function prepareImageForUpload(file: File): Promise<PreparedImage> {
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error('image_source_too_large');
  }

  const bitmap = await createImageBitmap(file);
  try {
    let scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    let output: Blob | null = null;

    for (const quality of [0.84, 0.74, 0.64]) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('image_canvas_unavailable');
      context.drawImage(bitmap, 0, 0, width, height);
      output = await canvasToBlob(canvas, 'image/webp', quality);
      if (output.size <= MAX_PREPARED_IMAGE_BYTES) break;
      scale *= 0.8;
    }

    if (!output) throw new Error('image_encode_failed');

    // Preserve an already compact original when resizing/encoding would make it larger.
    const sourceFitsDimensions = bitmap.width <= MAX_IMAGE_DIMENSION && bitmap.height <= MAX_IMAGE_DIMENSION;
    const preparedBlob = sourceFitsDimensions && file.size <= output.size ? file : output;
    const mimeType = preparedBlob.type || file.type || 'image/webp';
    const preparedFile = preparedBlob instanceof File
      ? preparedBlob
      : new File([preparedBlob], file.name, { type: mimeType, lastModified: file.lastModified });

    return {
      file: preparedFile,
      preview: URL.createObjectURL(preparedBlob),
      base64: await blobToBase64(preparedBlob),
      mime_type: mimeType,
      size_bytes: preparedBlob.size,
    };
  } finally {
    bitmap.close();
  }
}
