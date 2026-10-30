import s from './AvatarImage.module.scss';

export function AvatarImage({ src, alt = '', pixelated = false, visible = true }: {
  src?: string | null;
  alt?: string;
  pixelated?: boolean;
  visible?: boolean;
}) {
  if (!visible || !src) return null;
  return <img className={`${s.image} ${pixelated ? s.pixelated : ''}`}
    src={src} alt={alt} draggable={false} />;
}
