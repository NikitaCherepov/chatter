import { AvatarImage } from './AvatarImage';
import { PixelAvatar, getBaseFace, type SetDisplayStatePayload } from './PixelAvatar';
import s from './MessageAvatar.module.scss';

export function MessageAvatar({ visible = true, imageUrl = null, pixelated = false,
  live = false, thinking = false, chatId = null, state = null, alt = '' }: {
  visible?: boolean;
  imageUrl?: string | null;
  pixelated?: boolean;
  live?: boolean;
  thinking?: boolean;
  chatId?: number | null;
  state?: SetDisplayStatePayload | null;
  alt?: string;
}) {
  if (!visible) return null;
  return <div className={s.avatar} data-message-avatar>
    {live
      ? <PixelAvatar chatId={chatId} initialState={state} fallbackImageUrl={imageUrl}
          pixelated={pixelated} thinking={thinking && !imageUrl} alt={alt} variant="message" dockAlign="start" />
      : <AvatarImage src={imageUrl || getBaseFace('idle', false)} alt={alt} pixelated={pixelated} />}
  </div>;
}
