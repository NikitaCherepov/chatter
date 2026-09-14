import { motion } from 'framer-motion';
import type { ImageBlockData } from '../../types';
import { safeImageUrl } from '../../utils/media';
import { useNewspaperImageViewer } from '../../NewspaperImageViewerContext';
import s from '../../Newspaper.module.scss';

export function ImageBlock({ image, className }: { image: ImageBlockData; className?: string }) {
  const url = safeImageUrl(image.image_url);
  const openImage = useNewspaperImageViewer();
  if (!url) return null;
  return <figure className={className}><button className={s.imageOpen} type="button" onClick={() => openImage?.(url, image.title)} aria-label={`Открыть изображение: ${image.title}`}><motion.img src={url} alt="" whileHover={{ scale: 1.025 }} transition={{ duration: 0.22, ease: 'easeOut' }}/></button><figcaption><strong>{image.title}</strong>{image.caption && <span>{image.caption}</span>}</figcaption></figure>;
}
