import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocalMcp } from '../lib/useMcp';
import * as api from '../lib/mcp-service';
import {
  packageFields,
  packageFromSource,
  localMcpLaunchArgs,
  parseLocalMcpEnvironment,
  resolveLocalInput,
  type LocalMcpInstallPhase,
} from '../../main/local-mcp-spec';
import s from './SettingsModal.module.scss';
import styles from './McpSettings.module.scss';

export function LocalMcpForm({
  draft,
  onClose,
  reuseExisting,
  onAskMcpHelp,
}: {
  draft: api.CatalogItem | null;
  onClose: () => void;
  reuseExisting?: boolean;
  onAskMcpHelp?: (message: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const { mutation } = useLocalMcp();
  const [source, setSource] = useState('');
  const [editSource, setEditSource] = useState(false);
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState('');
  const [env, setEnv] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<LocalMcpInstallPhase>('installing');
  const busy = mutation.isPending;
  const packageData = editSource
    ? packageFromSource(source)
    : draft?.package || packageFromSource(source);
  const documentation = draft?.setup_url || draft?.repository_url;
  const hasSecretArguments =
    packageData &&
    packageFields(packageData).some((field) => field.secret && !field.key.startsWith('env:'));
  let launch: { command: string; args: string[] } | undefined;
  let launchEnv: Record<string, string> | undefined;
  if (draft?.package && packageData === draft.package) {
    try {
      const config = resolveLocalInput({ package: packageData, values });
      launch = config.pypi
        ? { command: 'uvx', args: [config.pypi, ...localMcpLaunchArgs(config)] }
        : { command: 'npx', args: ['-y', config.npm!, ...config.args] };
      launchEnv = config.env;
    } catch {}
  }
  useEffect(() => {
    setValues({});
    setSource(draft?.source || '');
    setEditSource(false);
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
                catalog_id: draft?.id,
                reuse_existing: reuseExisting,
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
        {draft?.package && (
          <p className={s.connectionsHelp}>
            {draft.package.registryType === 'pypi' ? 'PyPI' : 'npm'} · {draft.package.identifier}
            {draft.package.version && ' · ' + draft.package.version}
          </p>
        )}
        {documentation && (
          <a href={documentation} target="_blank" rel="noreferrer" className={s.connectionsHelp}>
            {t('mcp.github.instructions')}
          </a>
        )}
        {launch && !hasSecretArguments && (
          <div className={styles.actions}>
            <code>
              {[
                launch.command,
                ...launch.args.map((arg) => (/\s|["']/.test(arg) ? JSON.stringify(arg) : arg)),
              ].join(' ')}
            </code>
            <button
              className={s.cancelBtn}
              type="button"
              onClick={() => {
                try {
                  setEnv(
                    JSON.stringify({ ...launchEnv, ...parseLocalMcpEnvironment(env) }, null, 2),
                  );
                  setSource(JSON.stringify(launch));
                  setEditSource(true);
                } catch {
                  setError(t('mcp.local.envInvalid'));
                }
              }}
            >
              {t('mcp.github.editCommand')}
            </button>
          </div>
        )}
        {!!draft?.readme_examples?.length && (
          <div className={styles.actions}>
            <span>{t('mcp.github.examples')}</span>
            {draft.readme_examples.map((example) => (
              <button
                type="button"
                className={s.cancelBtn}
                key={example}
                onClick={() => {
                  setSource(example);
                  setEditSource(true);
                }}
              >
                <code>{example}</code>
              </button>
            ))}
          </div>
        )}
        {(!draft || draft.source || editSource) && (
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
        <div className={styles.actions}>
          <button className={s.saveBtn} disabled={busy}>
            {t(busy ? 'mcp.local.' + phase : 'mcp.local.install')}
          </button>
          {onAskMcpHelp && documentation && (
            <button
              className={s.cancelBtn}
              type="button"
              disabled={busy || asking}
              onClick={() => {
                setAsking(true);
                void onAskMcpHelp(t('mcp.github.prompt') + '\n' + documentation).finally(() =>
                  setAsking(false),
                );
              }}
            >
              {t('mcp.github.ask')}
            </button>
          )}
        </div>
        <button type="button" className={s.cancelBtn} disabled={busy} onClick={onClose}>
          {t('mcp.cancel')}
        </button>
        <small className={s.connectionsHelp}>{t('mcp.local.formHelp')}</small>
      </form>
    </>
  );
}
