export type ProfileCrop = { x: number; y: number; size: number };

/** Same cover/zoom/pan geometry as the native avatar editor; coordinates are source pixels. */
export function profileCropFromViewport(
  width: number,
  height: number,
  viewport: number,
  zoom: number,
  offset: { x: number; y: number },
): ProfileCrop {
  const scale = Math.max(viewport / width, viewport / height) * zoom;
  return {
    x: (width * scale - viewport) / 2 / scale - offset.x / scale,
    y: (height * scale - viewport) / 2 / scale - offset.y / scale,
    size: viewport / scale,
  };
}

export function renderProfileCrop(
  image: CanvasImageSource,
  width: number,
  height: number,
  crop: ProfileCrop,
  outputSize = 512,
) {
  const tolerance = 1e-6;
  if (
    ![width, height, crop.x, crop.y, crop.size, outputSize].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 60_000_000 ||
    crop.x < -tolerance ||
    crop.y < -tolerance ||
    crop.size <= 0 ||
    crop.x + crop.size > width + tolerance ||
    crop.y + crop.size > height + tolerance ||
    !Number.isInteger(outputSize) ||
    outputSize < 1 ||
    outputSize > 2048
  )
    throw new Error('profile_crop_invalid');
  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas_unavailable');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    image,
    Math.max(0, crop.x),
    Math.max(0, crop.y),
    crop.size,
    crop.size,
    0,
    0,
    outputSize,
    outputSize,
  );
  const previewUrl = canvas.toDataURL('image/png');
  return {
    base64: previewUrl.split(',')[1],
    mimeType: 'image/png' as const,
    previewUrl,
    width: outputSize,
    height: outputSize,
  };
}

/** Local transformation only: never opens a native modal, saves an avatar or fetches a URL. */
export async function cropProfileImage(
  input: { base64: string; mimeType: string; crop: ProfileCrop; outputSize?: number },
  current: () => void,
) {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(input.base64), (c) => c.charCodeAt(0));
  } catch {
    throw new Error('profile_image_invalid');
  }
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new Error('profile_image_invalid');
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(new Blob([bytes as BlobPart], { type: input.mimeType }));
  } catch {
    throw new Error('profile_image_invalid');
  }
  try {
    current();
    return renderProfileCrop(image, image.width, image.height, input.crop, input.outputSize);
  } finally {
    image.close();
  }
}
