import type { ImageBlockData } from '../../types';
import { safeImageUrl } from '../../utils/media';

export function ImageBlock({ image, className }: { image: ImageBlockData; className?: string }) {
  const url = safeImageUrl(image.image_url);
  if (!url) return null;
  return <figure className={className}><img src={url} alt=""/><figcaption><strong>{image.title}</strong>{image.caption && <span>{image.caption}</span>}</figcaption></figure>;
}
