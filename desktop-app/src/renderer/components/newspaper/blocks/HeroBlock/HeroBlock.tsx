import type { HeroBlockData } from '../../types';
import { safeImageUrl } from '../../utils/media';

export function HeroImage({ hero, className }: { hero?: HeroBlockData; className?: string }) {
  const image = safeImageUrl(hero?.image_url);
  return image ? <img className={className} src={image} alt="" /> : null;
}
