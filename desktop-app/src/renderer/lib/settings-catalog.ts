import { SETTINGS_GROUPS, searchSettings, settingsSectionKey, type SettingsSection, type SettingsSearchEntry } from './settings-navigation';
import entries from './settings-search-entries.json';
import { APP_SETTING_KEYS } from './app-settings-fields';
import { SECTION_SETTING_KEYS } from './settings-field-keys';
import { SETTINGS_REQUESTS } from '../../main/settings-request-types';
import type { ThemeSettingsState } from '../../main/settings-shell-types';

export function settingsCatalog(t: (key: string) => string, isAdmin: boolean): Pick<ThemeSettingsState, 'groups' | 'sections'> {
  return { groups: SETTINGS_GROUPS.map(group => ({ id: group.id, label: t(`settings.navigation.groups.${group.id}`) })),
    sections: SETTINGS_GROUPS.flatMap(group => group.sections.filter(section => isAdmin || section !== 'admin')
      .map(section => ({ id: section, groupId: group.id, label: t(settingsSectionKey(section)), mode: section === 'app' || section in SECTION_SETTING_KEYS ? 'fields' as const : 'native' as const }))) };
}
export function themeSettingsSearch(query: string, t: (key: string) => string, isAdmin: boolean): ThemeSettingsState['results'] {
  const headings: SettingsSearchEntry[] = SETTINGS_GROUPS.flatMap(group => group.sections.map(section => ({ section, key: settingsSectionKey(section) })));
  const fieldKeys: Record<string, Record<string, string>> = { app: APP_SETTING_KEYS, ...SECTION_SETTING_KEYS };
  const fieldEntries: SettingsSearchEntry[] = Object.entries(fieldKeys).flatMap(([section, fields]) => Object.values(fields).map(key => ({ section: section as SettingsSection, key })));
  const operationEntries: SettingsSearchEntry[] = Object.entries(SETTINGS_REQUESTS).flatMap(([section, operations]) => Object.values(operations).map(({ key }) => ({ section: section as SettingsSection, key })));
  const indexed = [...headings, ...entries as SettingsSearchEntry[], ...fieldEntries, ...operationEntries, { section: 'app' as const, key: 'appearance.title' }]
    .filter((entry, index, all) => all.findIndex(other => other.section === entry.section && other.key === entry.key) === index);
  return searchSettings(query, indexed, t, isAdmin)
    .map(result => { const fieldId = Object.entries(fieldKeys[result.section] ?? {}).find(([, key]) => key === result.key)?.[0] ?? null;
      return { sectionId: result.section, key: result.key, title: result.title, sectionTitle: result.sectionTitle,
        fieldId, operationId: Object.entries(SETTINGS_REQUESTS[result.section] ?? {}).find(([, operation]) => operation.key === result.key)?.[0] ?? null,
        native: !(result.section in fieldKeys) }; });
}
export function nativeSettingsTarget(sectionId: string, target: string | undefined, isAdmin: boolean, t: (key: string) => string) {
  if (!SETTINGS_GROUPS.some(group => group.sections.some(section => section === sectionId)) || sectionId === 'admin' && !isAdmin) return null;
  const section = sectionId as SettingsSection;
  const key = target ?? settingsSectionKey(section);
  if (key !== settingsSectionKey(section) && !(section === 'app' && key === 'appearance.title')
      && !(entries as SettingsSearchEntry[]).some(entry => entry.section === section && entry.key === key)) return null;
  return { section, result: { section, key, title: t(key), sectionTitle: t(settingsSectionKey(section)) } };
}
