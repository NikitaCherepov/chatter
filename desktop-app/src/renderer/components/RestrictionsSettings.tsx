import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { FeatureFlags } from '../lib/api';
import { restrictionOverride } from '../lib/restrictionState';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import shared from './SettingsModal.module.scss';
import toggle from './MemoryPopover.module.scss';
import s from './RestrictionsSettings.module.scss';

type Restriction = { key: keyof FeatureFlags; text: string; icon: string; protection?: boolean };
const groups: { title: string; rows: Restriction[] }[] = [
  { title: 'privacy', rows: [
    { key: 'disable_personal', text: 'guest', icon: 'user' },
    { key: 'disable_memory_write', text: 'memoryWrite', icon: 'database' },
  ] },
  { title: 'access', rows: [
    { key: 'disable_pc_control_full', text: 'full', icon: 'lock' },
    { key: 'disable_pc_control_lite', text: 'lite', icon: 'shield' },
    { key: 'disable_pc_commands', text: 'noPcCommands', icon: 'monitor' },
    { key: 'disable_internet', text: 'noInternet', icon: 'globe' },
  ] },
  { title: 'helpers', rows: [
    { key: 'disable_specialized_subagents', text: 'noSpecializedSubagents', icon: 'agent' },
    { key: 'disable_adhoc_subagents', text: 'noAdhocSubagents', icon: 'code' },
    { key: 'disable_avatar_control', text: 'noAvatarControl', icon: 'avatar' },
  ] },
  { title: 'security', rows: [
    { key: 'disable_prompt_injection_protection', text: 'injectionProtection', icon: 'shield', protection: true },
  ] },
];
export function RestrictionsSettings({ flags, loading, saving, loadFailed, onRetry, onToggle }: {
  flags: FeatureFlags; loading: boolean; saving: boolean; loadFailed: boolean;
  onRetry: () => void; onToggle: (key: keyof FeatureFlags) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return <div className={shared.panel}>
    <div className={shared.panelTitle}>{t('settings.sections.restrictions')}</div>
    <p className={s.intro}>{t('settings.restrictions.help')}</p>
    {loading ? <div role="status" className={shared.promptLoading}>{t('common.loading')}</div>
      : loadFailed ? <div className={s.error} role="alert"><p>{t('settings.restrictions.layout.loadFailed')}</p><button type="button" className={shared.cancelBtn} onClick={onRetry}>{t('settings.restrictions.layout.retry')}</button></div>
      : groups.map(group => <section className={s.group} key={group.title} aria-labelledby={`${id}-${group.title}`}>
        <h3 id={`${id}-${group.title}`}>{t(`settings.restrictions.layout.${group.title}`)}</h3>
        {group.rows.map(row => {
          const inherited = restrictionOverride(row.key, flags);
          const checked = row.protection ? !flags[row.key] : Boolean(flags[row.key] || inherited);
          const labelId = `${id}-${row.key}`;
          const hintId = `${labelId}-hint`;
          return <div className={`${s.row} ${checked && !row.protection ? s.restricted : ''}`} key={row.key}>
            <span className={s.icon}><Icon name={row.icon} size={18} /></span>
            <div className={s.text}>
              <span id={labelId} className={s.label}>{t(`settings.restrictions.${row.text}`)}</span>
              <p id={hintId}>{t(`settings.restrictions.${row.text}${row.protection ? 'Hint' : 'Help'}`)}</p>
              {inherited && <span className={s.inherited}>{t(`settings.restrictions.layout.${inherited === 'full' ? 'inheritedFull' : 'inheritedGuest'}`)}</span>}
              {row.protection && <Tooltip content={t('settings.restrictions.injectionProtectionHelp')}><button type="button" className={s.details}>{t('settings.restrictions.layout.details')}</button></Tooltip>}
            </div>
            <button type="button" role="switch" aria-checked={checked} aria-labelledby={labelId} aria-describedby={hintId}
              disabled={saving || Boolean(inherited)} onClick={() => onToggle(row.key)}
              className={`${toggle.toggle} ${checked ? toggle.toggleActive : ''}`}><span /></button>
          </div>;
        })}
      </section>)}
  </div>;
}
