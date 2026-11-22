import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppearanceShell } from '../lib/appearance-schema';
import { APPEARANCE_PROJECT_LIMITS, isAppearanceFilePath } from '../lib/appearance-project';
import { Select } from './Select';
import a from './SettingsModal.module.scss';
import s from './AppearancePanel.module.scss';

export function AppearanceShellEditor({
  shell,
  onChange,
}: {
  shell: AppearanceShell;
  onChange: (shell: AppearanceShell) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState('');
  const [newPath, setNewPath] = useState('');
  const files = shell.files;
  const path =
    files && Object.prototype.hasOwnProperty.call(files, selected) ? selected : shell.entry;
  const paths = files ? Object.keys(files).sort() : [];
  const validNewPath =
    isAppearanceFilePath(newPath) &&
    !paths.includes(newPath) &&
    paths.length < APPEARANCE_PROJECT_LIMITS.files;
  const source = files && path ? files[path] : (shell.source ?? '');
  const length = files
    ? Object.values(files).reduce((sum, text) => sum + text.length, 0)
    : source.length;
  return (
    <>
      {files ? (
        <>
          <div className={s.fields}>
            <label className={s.field}>
              {t('appearance.shellFile')}
              <Select
                ariaLabel={t('appearance.shellFile')}
                value={path!}
                options={paths.map((value) => ({ value, label: value }))}
                onChange={setSelected}
              />
            </label>
            <label className={s.field}>
              {t('appearance.shellEntry')}
              <Select
                ariaLabel={t('appearance.shellEntry')}
                value={shell.entry}
                options={paths
                  .filter((file) => /\.[jt]sx?$/.test(file))
                  .map((value) => ({ value, label: value }))}
                onChange={(entry) => onChange({ ...shell, entry })}
              />
            </label>
          </div>
          <div className={s.actions}>
            <label className={s.field}>
              {t('appearance.shellNewFile')}
              <input
                className={a.fieldInput}
                value={newPath}
                maxLength={180}
                placeholder="components/ChatList.tsx"
                onChange={(event) => setNewPath(event.target.value)}
              />
            </label>
            <button
              type="button"
              className={a.cancelBtn}
              disabled={!validNewPath}
              onClick={() => {
                onChange({ ...shell, files: { ...files, [newPath]: '' } });
                setSelected(newPath);
                setNewPath('');
              }}
            >
              {t('appearance.shellAddFile')}
            </button>
            <button
              type="button"
              className={a.cancelBtn}
              disabled={!path || path === shell.entry}
              onClick={() => {
                if (!path || path === shell.entry) return;
                const updated = { ...files };
                delete updated[path];
                onChange({ ...shell, files: updated });
                setSelected(shell.entry);
              }}
            >
              {t('appearance.shellDeleteFile')}
            </button>
          </div>
          <p className={s.hint}>{t('appearance.shellProjectHelp')}</p>
        </>
      ) : (
        <>
          <label className={s.field}>
            {t('appearance.shellLanguage')}
            <Select
              ariaLabel={t('appearance.shellLanguage')}
              value={shell.language}
              options={['html', 'tsx'].map((value) => ({ value, label: value }))}
              onChange={(language) => onChange({ ...shell, language: language as 'html' | 'tsx' })}
            />
          </label>
          {shell.language === 'tsx' && (
            <div className={s.actions}>
              <button
                type="button"
                className={a.cancelBtn}
                onClick={() =>
                  onChange({
                    version: 1,
                    language: 'tsx',
                    scope: shell.scope,
                    entry: 'App.tsx',
                    files: { 'App.tsx': shell.source! },
                  })
                }
              >
                {t('appearance.shellMakeProject')}
              </button>
            </div>
          )}
        </>
      )}
      <label className={s.field}>
        {files ? path : t('appearance.shellSource')}
        <textarea
          className={`${a.fieldInput} ${s.shellSource}`}
          rows={14}
          spellCheck={false}
          maxLength={APPEARANCE_PROJECT_LIMITS.sourceLength - length + source.length}
          value={source}
          onChange={(event) =>
            onChange(
              files && path
                ? { ...shell, files: { ...files, [path]: event.target.value } }
                : {
                    version: 1,
                    language: shell.language,
                    scope: shell.scope,
                    source: event.target.value,
                  },
            )
          }
        />
      </label>
      {files && (
        <p className={s.hint}>
          {paths.length} / {APPEARANCE_PROJECT_LIMITS.files} · {length.toLocaleString()} /{' '}
          {APPEARANCE_PROJECT_LIMITS.sourceLength.toLocaleString()}
        </p>
      )}
    </>
  );
}
