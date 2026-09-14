const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/svg+xml': 'svg',
};

export async function saveImageFile(src: string): Promise<boolean> {
  const response = await fetch(src);
  if (!response.ok) throw new Error('Image download failed');

  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  const urlExtension = (src.split('?')[0].match(/\.([a-zA-Z0-9]+)$/) || [])[1]?.toLowerCase();
  const extension = urlExtension && urlExtension.length <= 5
    ? urlExtension
    : (MIME_EXTENSIONS[blob.type] || 'bin');
  const date = new Date();
  const dateStamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const fileName = `image_${dateStamp}_${crypto.randomUUID().split('-')[0]}.${extension}`;

  if (window.electronAPI?.saveFile) {
    const result = await window.electronAPI.saveFile(fileName, buffer);
    return !result.canceled;
  }

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
  return true;
}

