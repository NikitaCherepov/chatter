export type SettingsSection =
  | 'account'
  | 'personas'
  | 'memory'
  | 'connections'
  | 'prompt'
  | 'data'
  | 'voice'
  | 'app'
  | 'admin'
  | 'limits'
  | 'billing'
  | 'macros'
  | 'pc'
  | 'browser'
  | 'servers'
  | 'runbooks'
  | 'sshkeys'
  | 'mail'
  | 'smart_home'
  | 'restrictions'
  | 'agents'
  | 'models'
  | 'about';

export const SETTINGS_GROUPS: { id: string; sections: SettingsSection[] }[] = [
  { id: 'profile', sections: ['account', 'personas', 'memory', 'connections', 'limits'] },
  { id: 'ai', sections: ['models', 'agents', 'prompt', 'voice', 'restrictions'] },
  {
    id: 'automation',
    sections: ['macros', 'runbooks', 'pc', 'browser', 'servers', 'sshkeys', 'mail', 'smart_home'],
  },
  { id: 'access', sections: ['data', 'billing'] },
  { id: 'application', sections: ['app', 'admin', 'about'] },
];

export function settingsSectionKey(section: SettingsSection): string {
  return `settings.sections.${section === 'smart_home' ? 'smartHome' : section}`;
}

export type SettingsSearchEntry = { section: SettingsSection; key: string; relatedKeys?: string[] };
export type SettingsSearchResult = SettingsSearchEntry & { title: string; sectionTitle: string };

export function normalizeSettingsSearch(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Index only UI copy from the current locale, never values from user forms. */
export function searchSettings(
  query: string,
  entries: readonly SettingsSearchEntry[],
  translate: (key: string) => string,
  isAdmin: boolean
): SettingsSearchResult[] {
  const tokens = normalizeSettingsSearch(query).split(' ').filter(Boolean);
  if (!tokens.length) return [];
  const results: (SettingsSearchResult & { score: number })[] = [];
  for (const entry of entries) {
    if (entry.section === 'admin' && !isAdmin) continue;
    const title = translate(entry.key);
    if (!title || title === entry.key) continue;
    const sectionTitle = translate(settingsSectionKey(entry.section));
    const heading = normalizeSettingsSearch(title);
    const corpus = normalizeSettingsSearch(
      [title, sectionTitle, ...(entry.relatedKeys ?? []).map(translate)].join(' ')
    );
    if (!tokens.every((token) => corpus.includes(token))) continue;
    const score =
      heading === normalizeSettingsSearch(query)
        ? 0
        : tokens.every((token) => heading.includes(token))
          ? 1
          : 2;
    results.push({ ...entry, title, sectionTitle, score });
  }
  return results.sort((a, b) => a.score - b.score).map(({ score: _, ...entry }) => entry);
}
