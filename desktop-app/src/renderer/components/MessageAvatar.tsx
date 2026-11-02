import { AvatarImage } from './AvatarImage';
import { PixelAvatar, getBaseFace, type SetDisplayStatePayload } from './PixelAvatar';
import { AvatarPreferencesMenu } from './AvatarPreferencesMenu';
import { useFeatureFlags } from '../lib/useFeatureFlags';
import s from './MessageAvatar.module.scss';

export function MessageAvatar({ visible = true, imageUrl = null, pixelated = false,
  live = false, thinking = false, chatId = null, state = null, alt = '' }: {
  visible?: boolean; imageUrl?: string | null; pixelated?: boolean; live?: boolean;
  thinking?: boolean; chatId?: number | null; state?: SetDisplayStatePayload | null; alt?: string;
}) {
  const preferences = useFeatureFlags(visible && !imageUrl);
  if (!visible) return null;
  if (imageUrl) return <div className={s.avatar} data-message-avatar><AvatarImage src={imageUrl} alt={alt} pixelated={pixelated} /></div>;
  if (preferences.loading) return null;
  const controlled = !preferences.loadFailed && !preferences.flags.hide_pixel_avatar && !preferences.flags.disable_avatar_control;
  return <AvatarPreferencesMenu className={s.avatar} flags={preferences.flags} saving={preferences.saving || preferences.loadFailed} setFlag={preferences.setFlag}>
    {live ? <PixelAvatar chatId={chatId} initialState={controlled ? state : null} controlEnabled={controlled}
      pixelated={pixelated} thinking={thinking} alt={alt} variant="message" dockAlign="start" />
      : <AvatarImage src={getBaseFace('idle', false)} alt={alt} pixelated={pixelated} />}
  </AvatarPreferencesMenu>;
}
