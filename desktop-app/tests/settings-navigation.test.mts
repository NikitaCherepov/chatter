import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  searchSettings,
  normalizeSettingsSearch,
  SETTINGS_GROUPS,
  settingsSectionKey,
} = require('../src/renderer/lib/settings-navigation.ts');
const fields = require('../src/renderer/lib/settings-search-entries.json');
const en = require('../src/renderer/i18n/locales/en/translation.json');
const ru = require('../src/renderer/i18n/locales/ru/translation.json');
const translate = (data: any) => (key: string) =>
  key.split('.').reduce((v: any, k: string) => v?.[k], data) ?? key;
const entries = [
  ...SETTINGS_GROUPS.flatMap((group: any) =>
    group.sections.map((section: string) => ({ section, key: settingsSectionKey(section) }))
  ),
  ...fields,
];
const find = (q: string, lang: any = ru, admin = false) => searchSettings(q, entries, translate(lang), admin);
assert.equal(new Set(SETTINGS_GROUPS.flatMap((g: any) => g.sections)).size, 24);
assert(SETTINGS_GROUPS.find((g: any) => g.id === 'profile').sections.includes('limits'));
assert(SETTINGS_GROUPS.find((g: any) => g.id === 'ai').sections.includes('restrictions'));
assert(!SETTINGS_GROUPS.find((g: any) => g.id === 'access').sections.includes('restrictions'));
assert.deepEqual(SETTINGS_GROUPS.find((g: any) => g.id === 'profile').sections.slice(0, 3), ['account', 'personas', 'memory']);
assert.equal(find('горячая память').find((item: any) => item.key === 'settings.account.personas.coreMemory')?.section, 'personas');
assert.equal(find('name in chat', en).find((item: any) => item.key === 'settings.account.redesign.chatName')?.section, 'personas');
assert.equal(find('пароль').find((item: any) => item.key === 'settings.account.changePassword')?.section, 'account');
assert.equal(find('модель субагентов').find((item: any) => item.key === 'settings.app.subagentModel')?.section, 'agents');
assert.equal(find('квоты').find((item: any) => item.key === 'quota.title')?.section, 'limits');

assert.equal(find('масштаб')[0].key, 'settings.app.zoom');
assert.equal(find('scale', en)[0].key, 'settings.app.zoom');
assert.equal(find('Whisper', en)[0].key, 'settings.voice.recognitionSource');
assert.equal(find('пРИЛОЖЕНИЕ   масштаб')[0].key, 'settings.app.zoom');
assert.equal(find('объём').length, find('объем').length);
assert.equal(normalizeSettingsSearch('  ÉЁ  '), 'eе');
assert.equal(find('  ').length, 0);
assert.equal(find('never-match-123').length, 0);
assert.equal(
  find('chatgpt', en, false).some((e: any) => e.section === 'admin'),
  false
);
assert.equal(
  find('chatgpt', en, true).some((e: any) => e.section === 'admin'),
  true
);
assert.equal(find('settings.app.zoom', en).length, 0, 'do not search untranslated key paths');
assert.equal(find('PRIVATE_USER_NAME', en).length, 0, 'no user values in index');
const catalogEntries = [{ section: 'agents', key: 'subagent:custom_id', label: 'Server helper', relatedText: ['Converts unusual formats'] }];
assert.equal(searchSettings('unusual', catalogEntries, translate(en), false)[0]?.title, 'Server helper');
assert.equal(searchSettings('custom_id', catalogEntries, translate(en), false).length, 0, 'do not search technical catalog IDs');

assert(find('пароль').some((e: any) => e.key === 'settings.account.changePassword'));
for (const field of fields) {
  assert.notEqual(translate(en)(field.key), field.key, field.key);
  assert(!translate(en)(field.key).includes('{{'), field.key + ' has dynamic placeholders');
}
for (const lang of ['cs', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-BR', 'ru', 'tr', 'zh-CN']) {
  const dict = require(`../src/renderer/i18n/locales/${lang}/translation.json`);
  assert.equal(typeof dict.settings.navigation.search, 'string', lang);
  for (const g of SETTINGS_GROUPS)
    assert.equal(typeof dict.settings.navigation.groups[g.id], 'string', lang + ':' + g.id);
}
console.log(
  'Settings navigation: grouping, localized labels/help, ranking, multi-word search and admin visibility passed.'
);

assert.equal(find('MCP')[0]?.section, 'mcp');
