import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ThemeAudioController } from './theme-audio';
import {
  readThemeEffectsPreferences,
  subscribeThemeEffects,
  setThemeEffectsPreferences,
} from './theme-effects-preferences';
import type { AppearanceShellAction } from '../../main/appearance-shell-types';
const EMPTY: Record<string, string> = {};
export function useThemeEffectsBridge(
  owner: string | undefined,
  assets: Record<string, string> | undefined,
  speech: boolean,
) {
  const preferences = useSyncExternalStore(subscribeThemeEffects, readThemeEffectsPreferences),
    [visible, setVisible] = useState(false);
  const controller = useMemo(
    () =>
      new ThemeAudioController(async (url) => {
        const result = await window.electronAPI.localAppearance({ action: 'asset', url });
        return result.data;
      }),
    [],
  );
  const audio = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useLayoutEffect(() => {
    controller.configure(owner ?? '', assets ?? EMPTY);
  }, [controller, owner, assets]);
  useEffect(() => {
    controller.setVisible(visible);
  }, [controller, visible]);
  useEffect(() => {
    controller.refresh();
  }, [controller, preferences]);
  useEffect(() => {
    controller.setSpeech(speech);
  }, [controller, speech]);
  useEffect(() => () => controller.dispose(), [controller]);
  return {
    preferences,
    audio,
    setVisible,
    handle: (action: AppearanceShellAction) => {
      if (action.type === 'themeAudio') {
        controller.handle(action);
        return true;
      }
      if (action.type === 'themePreferences') {
        setThemeEffectsPreferences(action.patch);
        return true;
      }
      return false;
    },
  };
}
