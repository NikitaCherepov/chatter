import { useQuery } from '@tanstack/react-query';
import { API_BASE } from './api';
import { settingsReads } from './settings-service';

export function useSettingsRead<K extends keyof typeof settingsReads>(key: K, userId: number | undefined, enabled: boolean) {
  const queryFn = settingsReads[key] as () => Promise<Awaited<ReturnType<(typeof settingsReads)[K]>>>;
  return useQuery({
    queryKey: ['settings', API_BASE, userId, key],
    queryFn,
    enabled: enabled && userId != null,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useSettingsQueries(userId: number | undefined, section: string) {
  return {
    models: useSettingsRead('models', userId, ['models', 'agents', 'app'].includes(section)),
    modelSettings: useSettingsRead('modelSettings', userId, section === 'models'),
    agentModel: useSettingsRead('agentModel', userId, section === 'agents'),
    agentReasoning: useSettingsRead('agentReasoning', userId, section === 'agents'),
    ui: useSettingsRead('ui', userId, section === 'app'),
    link: useSettingsRead('link', userId, section === 'connections'),
    context: useSettingsRead('context', userId, section === 'limits'),
    attachment: useSettingsRead('attachment', userId, section === 'limits'),
    prompts: useSettingsRead('prompts', userId, section === 'prompt' || section === 'data'),
    desktopBrowser: useSettingsRead('desktopBrowser', userId, section === 'limits' && Boolean(window.electronAPI?.getDesktopBrowserSettings)),
  };
}
