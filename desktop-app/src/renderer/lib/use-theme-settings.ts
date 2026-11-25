import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from './auth';
import * as api from './api';
import { ThemeSettingsController } from './theme-settings-controller';
import { settingsCatalog, themeSettingsSearch } from './settings-catalog';
import { appSettingsFields } from './app-settings-fields';
import { APP_SETTINGS_CHANGED, readLocalAppSettings, saveAppLanguage, saveAppLocalSetting, saveAppUiSettings, setAppZoomPercent, zoomLevelToPercent } from './app-settings';
import { settingsReads } from './settings-service';
import { createThemeSettingsSections } from './theme-settings-sections';
import { createThemeSettingsRequests } from './theme-settings-requests';
import type { ThemeSettingsSectionAdapter } from './theme-settings-controller';

export function useThemeSettings(themeId: string | null, onAuthInvalidated?: () => void, onChatCreated?:(id:number)=>void) {
  const { user, setUser, logout } = useAuth();
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();
  const isAdmin = user?.is_admin === 1 || user?.role === 'admin';
  const scope = JSON.stringify([api.API_BASE, user?.id, isAdmin, themeId]);
  const owner = useRef({ scope, epoch: 0, mounted: true });
  if (owner.current.scope !== scope) owner.current = { scope, epoch: owner.current.epoch + 1, mounted: true };
  const live = useRef({ t, isAdmin, locale: i18n.resolvedLanguage || i18n.language, base: api.API_BASE, userId: user?.id, legacyAppearance: user?.ui_settings?.appearance, reauthenticate: onAuthInvalidated ?? logout,chatCreated:onChatCreated });
  live.current = { t, isAdmin, locale: i18n.resolvedLanguage || i18n.language, base: api.API_BASE, userId: user?.id, legacyAppearance: user?.ui_settings?.appearance, reauthenticate: onAuthInvalidated ?? logout,chatCreated:onChatCreated };
  const controller = useMemo(() => {
    const epoch = owner.current.epoch, userId = user?.id, base = api.API_BASE;
    const current = () => owner.current.mounted && owner.current.epoch === epoch;
    const patchUser = (patch: Partial<api.AuthResponse['user']>) => {
      if (!current()) return;
      setUser(previous => {
        if (!current() || !previous || previous.id !== userId) return previous;
        const next = { ...previous, ...patch };
        try { localStorage.setItem('chatter_user', JSON.stringify(next)); } catch { /* Auth remains active in memory. */ }
        return next;
      });
    };
    const requests = createThemeSettingsRequests({ client: queryClient, base, userId, current, t: (key, options) => String(live.current.t(key, options)),
      locale: () => live.current.locale, legacyAppearance: () => live.current.legacyAppearance,
      chatCreated:id=>{if(current())live.current.chatCreated?.(id);},
      reauthenticate: () => { if (live.current.base === base && live.current.userId === userId) live.current.reauthenticate?.(); } });
    const withRequests = (sections: Record<string, ThemeSettingsSectionAdapter>) => Object.fromEntries(Object.entries(sections).map(([id, section]) =>
      [id, requests[id] ? { ...section, ...requests[id] } : section]));
    return new ThemeSettingsController({
      catalog: settingsCatalog(live.current.t, isAdmin),
      search: query => themeSettingsSearch(query, live.current.t, isAdmin),
      error: code => live.current.t('themeSettings.' + code),
      sections: withRequests({ ...createThemeSettingsSections({ client: queryClient, base, userId, current, patchUser, t: (key, options) => String(live.current.t(key, options)) }), app: {
      fields: (draft, saved) => appSettingsFields(draft, saved, live.current.t),
      groups: () => [{ id: 'appearance', label: live.current.t('settings.app.layout.appearance') }, { id: 'chat', label: live.current.t('settings.app.layout.chat') }],
      links: () => [],
      read: async () => {
        if (!current() || userId == null) throw new Error('settings_scope_changed');
        const [ui, zoom] = await Promise.all([
          queryClient.fetchQuery({ queryKey: ['settings', base, userId, 'ui'], queryFn: () => {
            if (!current()) throw new Error('settings_scope_changed');
            return settingsReads.ui();
          }, staleTime: 0 }),
          window.electronAPI.getZoomLevel(),
        ]);
        if (!current()) throw new Error('settings_scope_changed');
        patchUser({ ui_settings: ui.settings });
        return { ...readLocalAppSettings(), zoom: zoomLevelToPercent(zoom), showTokens: ui.settings.show_tokens !== false, diceRoll: Boolean(ui.settings.dice_roll_enabled) };
      },
      write: async (field, value, operationCurrent) => {
        const active = () => current() && operationCurrent();
        if (!active()) throw new Error('settings_scope_changed');
        if (field === 'showTokens' || field === 'diceRoll') {
          if (typeof value !== 'boolean') throw new Error('invalid_setting_value');
          const result = await saveAppUiSettings({ [field === 'showTokens' ? 'show_tokens' : 'dice_roll_enabled']: value }, active);
          if (active()) {
            patchUser({ ui_settings: result.settings });
            queryClient.setQueryData(['settings', base, userId, 'ui'], { settings: result.settings });
          }
          return field === 'showTokens' ? result.settings.show_tokens !== false : Boolean(result.settings.dice_roll_enabled);
        }
        if (field === 'language') { const result = await saveAppLanguage(String(value), active); if (active()) patchUser({ language: result.language }); return value; }
        if (field === 'zoom') return setAppZoomPercent(Number(value));
        saveAppLocalSetting(field, value); return value;
      },
      } }),
    });
  }, [scope, queryClient, setUser]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useLayoutEffect(() => {
    const epoch = owner.current.epoch;
    owner.current.mounted = true;
    controller.activate();
    return () => { if (owner.current.epoch === epoch) owner.current.mounted = false; controller.dispose(); };
  }, [controller]);
  useLayoutEffect(() => {
    controller.configure(settingsCatalog(t, isAdmin));
  }, [controller, t, i18n.resolvedLanguage, isAdmin]);
  useEffect(() => {
    const refresh = () => {
      for(const editor of Object.values(controller.getState().editors??{})){
      // Structured drafts live in the SDK; only clean scalar sessions can be refreshed here.
      if (!editor.loading && !editor.busy && !editor.dirty && editor.fields.length > 0)
        void controller.handle({ type: 'settingsAction', action: 'reload', sectionId: editor.sectionId, editorId: editor.id });
      }
    };
    const events = [APP_SETTINGS_CHANGED, 'chatter-theme-effects-changed', 'chatter-voice-settings-changed', 'chatter:wakeword-toggle', 'chatter:wakeword-config', 'focus'];
    events.forEach(event => window.addEventListener(event, refresh));
    return () => { events.forEach(event => window.removeEventListener(event, refresh)); };
  }, [controller]);
  return { state, handle: controller.handle.bind(controller), request: controller.request.bind(controller), completeRequest: controller.completeRequest };
}
