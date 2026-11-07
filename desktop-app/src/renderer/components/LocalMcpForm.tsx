import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocalMcp } from '../lib/useMcp';
import * as api from '../lib/mcp-service';
import {
  packageFields,
  packageFromSource,
  parseLocalMcpEnvironment,
  type LocalMcpInstallPhase,
} from '../../main/local-mcp-spec';
import s from './SettingsModal.module.scss';
import styles from './McpSettings.module.scss';

export function LocalMcpForm({
  draft,
  onClose,
}: {
  draft: api.CatalogItem | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { mutation } = useLocalMcp();
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [env, setEnv] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<LocalMcpInstallPhase>('installing');
  const busy = mutation.isPending;
  const packageData = draft?.package || packageFromSource(source);
  useEffect(() => {
    setValues({});
    setSource(draft?.source || '');
    setName(draft ? draft.title || draft.name : '');
    setEnv('');
    setError('');
  }, [draft]);
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await mutation.mutateAsync(action);
    } catch (error: any) {
      setError(String(error?.message || t('mcp.error')));
    }
  };
  return (
    <>
      {error && error !== t('mcp.local.envInvalid') && (
        <p
          className={styles.empty}
          role="alert"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {error}
        </p>
      )}
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          let environment: Record<string, string>;
          try {
            environment = parseLocalMcpEnvironment(env);
          } catch {
            setError(t('mcp.local.envInvalid'));
            return;
          }
          setPhase('installing');
          void run(async () => {
            await api.installLocalMcp(
              {
                name: name || undefined,
                description: draft?.description,
                ...(packageData ? { package: packageData, values } : { source }),
                env: environment,
              },
              setPhase,
            );
            setSource('');
            setName('');
            setEnv('');
            onClose();
          });
        }}
      >
        <h4>
          {draft ? t('mcp.local.install') + ': ' + (draft.title || draft.name) : t('mcp.local.add')}
        </h4>
        {(!draft || draft.source) && (
          <label>
            {t('mcp.local.source')}
            <input
              className={s.fieldInput}
              required
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="npx -y @scope/server@1.0.0"
            />
          </label>
        )}
        <label>
          {t('mcp.name')}
          <input className={s.fieldInput} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {packageData &&
          packageFields(packageData).map((field) => (
            <label key={field.key}>
              {field.label}
              <input
                className={s.fieldInput}
                required={field.required}
                type={field.secret ? 'password' : 'text'}
                value={values[field.key] ?? field.default}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              />
            </label>
          ))}
        <label>
          {t('mcp.local.env')}
          <textarea
            className={s.textareaInput}
            rows={5}
            spellCheck={false}
            value={env}
            onChange={(e) => {
              setEnv(e.target.value);
              setError('');
            }}
            placeholder='{"API_KEY":"..."}'
            autoComplete="off"
            aria-invalid={error === t('mcp.local.envInvalid')}
          />
          <small className={s.connectionsHelp}>{t('mcp.local.envHint')}</small>
          {error === t('mcp.local.envInvalid') && (
            <small
              role="alert"
              className={s.connectionsHelp}
              style={{ color: 'var(--color-error)' }}
            >
              {error}
            </small>
          )}
        </label>
        <button className={s.saveBtn} disabled={busy}>
          {t(busy ? 'mcp.local.' + phase : 'mcp.local.install')}
        </button>
        <button type="button" className={s.cancelBtn} disabled={busy} onClick={onClose}>
          {t('mcp.cancel')}
        </button>
        <small className={s.connectionsHelp}>{t('mcp.local.formHelp')}</small>
      </form>
    </>
  );
}
