import { SETTINGS_GROUPS, searchSettings, settingsSectionKey, type SettingsSection, type SettingsSearchEntry } from './settings-navigation';
import entries from './settings-search-entries.json';
import { APP_SETTING_KEYS } from './app-settings-fields';
import type { ThemeSettingsState } from '../../main/settings-shell-types';

export function settingsCatalog(t: (key: string) => string, isAdmin: boolean): Pick<ThemeSettingsState, 'groups' | 'sections'> {
  return { groups: SETTINGS_GROUPS.map(group => ({ id: group.id, label: t(`settings.navigation.groups.${group.id}`) })),
    sections: SETTINGS_GROUPS.flatMap(group => group.sections.filter(section => isAdmin || section !== 'admin')
      .map(section => ({ id: section, groupId: group.id, label: t(settingsSectionKey(section)), mode: section === 'app' ? 'hybrid' as const : 'native' as const }))) };
}
export function themeSettingsSearch(query: string, t: (key: string) => string, isAdmin: boolean): ThemeSettingsState['results'] {
  const headings: SettingsSearchEntry[] = SETTINGS_GROUPS.flatMap(group => group.sections.map(section => ({ section, key: settingsSectionKey(section) })));
  return searchSettings(query, [...headings, ...entries as SettingsSearchEntry[], { section: 'app', key: 'appearance.title' }], t, isAdmin)
    .map(result => { const fieldId = Object.entries(APP_SETTING_KEYS).find(([, key]) => key === result.key)?.[0] ?? null;
      return { sectionId: result.section, key: result.key, title: result.title, sectionTitle: result.sectionTitle,
        fieldId, native: result.section !== 'app' || result.key !== settingsSectionKey('app') && !fieldId }; });
}
export function nativeSettingsTarget(sectionId: string, target: string | undefined, isAdmin: boolean, t: (key: string) => string) {
  if (!SETTINGS_GROUPS.some(group => group.sections.some(section => section === sectionId)) || sectionId === 'admin' && !isAdmin) return null;
  const section = sectionId as SettingsSection;
  const key = target ?? settingsSectionKey(section);
  if (key !== settingsSectionKey(section) && !(section === 'app' && key === 'appearance.title')
      && !(entries as SettingsSearchEntry[]).some(entry => entry.section === section && entry.key === key)) return null;
  return { section, result: { section, key, title: t(key), sectionTitle: t(settingsSectionKey(section)) } };
}
