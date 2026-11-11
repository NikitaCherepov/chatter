import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocalMcp, useLocalMcpSettings } from '../lib/useMcp';
import * as api from '../lib/mcp-service';
import {
  emptyMcpApproval,
  packageFields,
  parseLocalMcpEnvironment,
  type LocalMcpInstallPhase,
} from '../../main/local-mcp-spec';
import { Select } from './Select';
import { McpToggle, McpTools } from './McpControls';
import { McpConnectionName } from './McpConnectionName';
import { Icon } from './Icon';
import { AnimatedDetails } from './AnimatedDisclosure';
import { ConfirmDialog } from './ConfirmDialog';
import s from './SettingsModal.module.scss';
import styles from './McpSettings.module.scss';

export function LocalMcpPanel({ allowed }: { allowed: boolean }) {
  const { t } = useTranslation(),
    { query, mutation, available } = useLocalMcp();
  const [error, setError] = useState(''),
    [remove, setRemove] = useState<string | null>(null),
    [expandedSettings, setExpandedSettings] = useState<Set<string>>(() => new Set());
  const [updating, setUpdating] = useState<{ id: string; phase: LocalMcpInstallPhase } | null>(
    null,
  );
  useEffect(() => {
    const handler = (event: Event) => {
      const error = (event as CustomEvent).detail?.error;
      if (error) setError(String(error));
    };
    window.addEventListener('mcp-local-sync', handler);
    return () => window.removeEventListener('mcp-local-sync', handler);
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await mutation.mutateAsync(action);
      return true;
    } catch (e: any) {
      setError(String(e?.message || t('mcp.error')));
      return false;
    }
  };
  if (!available) return null;
  const busy = mutation.isPending;
  return (
    <section className={styles.localSection}>
      <div className={styles.localHeading}>
        <h3>{t('mcp.local.title')}</h3>
        <p className={s.connectionsHelp}>{t('mcp.local.help')}</p>
      </div>
      {query.isPending && (
        <p className={styles.empty} role="status">
          {t('common.loading')}
        </p>
      )}
      {(error || query.isError) && (
        <p className={styles.empty} role="alert">
          {error || t('mcp.error')}
        </p>
      )}
      {(query.data || []).map((row) => {
        const approval = row.approval_policy || emptyMcpApproval();
        const saveApproval = (patch: Partial<typeof approval>) =>
          run(() => api.configureLocalMcp(row.id, { approval_policy: { ...approval, ...patch } }));
        return (
          <article
            className={styles.connection}
            key={row.id}
            id={'mcp-local-' + row.id}
            tabIndex={-1}
          >
            <div className={styles.cardHeading}>
              <span className={styles.icon}>
                <Icon name="monitor" />
              </span>
              <McpConnectionName
                name={row.name}
                disabled={!allowed}
                onSave={(name) => run(() => api.configureLocalMcp(row.id, { name }))}
              />
              <McpToggle
                checked={row.enabled}
                disabled={busy}
                label={t('mcp.connectionEnabled')}
                onChange={(enabled) => void run(() => api.configureLocalMcp(row.id, { enabled }))}
              />
            </div>
            <p className={styles.url}>
              {row.source}
              {row.installed_version && ' · ' + row.installed_version}
              {row.git_commit && ' · ' + row.git_commit.slice(0, 12)}
            </p>
            <p className={styles.url}>
              {t('mcp.tools')}: {row.tools.length} · {t('mcp.resources')}: {row.resources.length}
            </p>
            {row.error && (
              <p role="alert" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {row.error}
              </p>
            )}
            <div className={styles.actions}>
              <button
                className={s.cancelBtn}
                disabled={busy || !row.enabled || !allowed}
                onClick={() => void run(() => api.refreshLocalMcp(row.id))}
              >
                {t('mcp.refresh')}
              </button>
              {row.updatable && (
                <button
                  className={s.cancelBtn}
                  disabled={busy || !allowed}
                  onClick={() => {
                    setUpdating({ id: row.id, phase: 'installing' });
                    void run(() =>
                      api.updateLocalMcp(row.id, (phase) => setUpdating({ id: row.id, phase })),
                    ).finally(() => setUpdating(null));
                  }}
                >
                  {t(
                    updating?.id === row.id
                      ? 'mcp.local.' + updating.phase
                      : 'mcp.local.updatePackage',
                  )}
                </button>
              )}
            </div>
            <AnimatedDetails
              open={expandedSettings.has(row.id)}
              locked={busy}
              onOpenChange={(open) =>
                setExpandedSettings((previous) => {
                  const next = new Set(previous);
                  if (open) next.add(row.id);
                  else next.delete(row.id);
                  return next;
                })
              }
              className={styles.details}
              summary={
                <>
                  <Icon name="key" size={14} />
                  {t('mcp.settings')}
                </>
              }
            >
              <div className={styles.detailBody}>
                <McpToggle
                  label={t('mcp.approvals.allowAll')}
                  hint={t('mcp.approvals.allowAllHint')}
                  checked={approval.allow_all}
                  disabled={busy}
                  onChange={(allow_all) => void saveApproval({ allow_all })}
                />
                {approval.resources.map((uri) => (
                  <div className={styles.tool} key={uri}>
                    <McpToggle
                      label={t('mcp.approvals.alwaysResource') + ': ' + uri}
                      checked
                      disabled={busy || approval.allow_all}
                      onChange={() =>
                        void saveApproval({
                          resources: approval.resources.filter((value) => value !== uri),
                        })
                      }
                    />
                  </div>
                ))}

                {expandedSettings.has(row.id) && (
                  <LocalMcpConfiguration row={row} busy={busy} run={run} />
                )}
              </div>
            </AnimatedDetails>
            <McpTools
              tools={row.tools}
              selected={row.selected_tools}
              eagerByDefault={row.mode === 'eager'}
              modeExceptions={row.tool_mode_exceptions}
              approval={approval}
              disabled={busy}
              saveSelected={(selected_tools) =>
                void run(() => api.configureLocalMcp(row.id, { selected_tools }))
              }
              saveModeExceptions={(tool_mode_exceptions) =>
                void run(() => api.configureLocalMcp(row.id, { tool_mode_exceptions }))
              }
              saveApproval={(patch) => void saveApproval(patch)}
            />
            <div className={styles.connectionFooter}>
              <button
                className={styles.removeButton}
                disabled={busy}
                onClick={() => setRemove(row.id)}
              >
                {t('mcp.remove')}
              </button>
            </div>
          </article>
        );
      })}
      {remove !== null && (
        <ConfirmDialog
          open
          title={t('mcp.local.remove')}
          text={t('mcp.local.removeHelp')}
          confirmDisabled={busy}
          onCancel={() => {
            if (!busy) setRemove(null);
          }}
          onConfirm={() =>
            void run(async () => {
              await api.removeLocalMcp(remove!);
              setRemove(null);
            })
          }
        />
      )}
    </section>
  );
}

function LocalMcpConfiguration({
  row,
  busy,
  run,
}: {
  row: api.LocalMcpSummary;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const query = useLocalMcpSettings(row.id);
  const [feedback, setFeedback] = useState<'invalid' | 'invalidArgs' | 'saved' | 'failed' | null>(
    null,
  );
  if (query.isPending) return <p role="status">{t('common.loading')}</p>;
  if (query.isError)
    return (
      <div role="alert">
        <p>{t('mcp.error')}</p>
        <button className={s.cancelBtn} onClick={() => void query.refetch()}>
          {t('mcp.refresh')}
        </button>
      </div>
    );
  const config = query.data,
    disabled = busy || query.isFetching;
  const manifest = config.manifest;
  const fields = manifest ? packageFields(manifest.package) : [];
  const additionalEnv = Object.fromEntries(
    Object.entries(config.env).filter(
      ([name]) => !fields.some((field) => field.key === 'env:' + name),
    ),
  );
  return (
    <form
      key={config.config_revision || row.id}
      className={styles.settingsForm + ' ' + styles.settingsGrid}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        let env: Record<string, string>;
        let args: string[] | undefined;
        try {
          env = parseLocalMcpEnvironment(String(data.get('env') || ''));
        } catch {
          setFeedback('invalid');
          event.currentTarget.querySelector<HTMLTextAreaElement>('textarea[name=env]')?.focus();
          return;
        }
        if (config.args !== undefined) {
          try {
            const parsed: unknown = JSON.parse(String(data.get('args') || '[]'));
            if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== 'string'))
              throw new Error();
            args = parsed;
          } catch {
            setFeedback('invalidArgs');
            event.currentTarget.querySelector<HTMLTextAreaElement>('textarea[name=args]')?.focus();
            return;
          }
        }
        setFeedback(null);
        void run(() =>
          api.configureLocalMcp(row.id, {
            expected_revision: config.config_revision,
            timeout_seconds: Number(data.get('timeout')),
            env,
            ...(args && { args }),
            ...(manifest && {
              manifest_values: Object.fromEntries(
                fields.map((field) => [field.key, String(data.get(field.key) ?? '')]),
              ),
            }),
          }),
        ).then((saved) => setFeedback(saved ? 'saved' : 'failed'));
      }}
    >
      <label>
        {t('mcp.mode')}
        <Select
          value={config.mode}
          disabled={disabled}
          onChange={(mode) => void run(() => api.configureLocalMcp(row.id, { mode }))}
          options={[
            { value: 'search', label: t('mcp.searchMode') },
            { value: 'eager', label: t('mcp.eagerMode') },
          ]}
        />
      </label>
      <label>
        {t('mcp.timeout')}
        <input
          className={s.fieldInput}
          type="number"
          name="timeout"
          min={10}
          max={3600}
          defaultValue={config.timeout_seconds}
          disabled={disabled}
        />
      </label>
      {fields.map((field) => (
        <label key={field.key}>
          {field.label}
          <input
            className={s.fieldInput}
            name={field.key}
            type={field.secret ? 'password' : 'text'}
            required={field.required}
            autoComplete="off"
            disabled={disabled}
            defaultValue={manifest?.values[field.key] ?? field.default}
            onChange={() => setFeedback(null)}
          />
        </label>
      ))}
      {config.args !== undefined && (
        <label className={styles.fullWidth}>
          {t('mcp.local.args')}
          <textarea
            className={s.textareaInput}
            rows={2}
            name="args"
            spellCheck={false}
            disabled={disabled}
            defaultValue={JSON.stringify(config.args)}
            placeholder='["serve"]'
            aria-invalid={feedback === 'invalidArgs'}
            onChange={() => setFeedback(null)}
          />
          {feedback === 'invalidArgs' && <small role="alert">{t('mcp.local.argsInvalid')}</small>}
        </label>
      )}
      <label className={styles.fullWidth}>
        {t(
          fields.some((field) => field.key.startsWith('env:'))
            ? 'mcp.local.extraEnv'
            : 'mcp.local.env',
        )}
        <textarea
          className={s.textareaInput}
          name="env"
          rows={5}
          spellCheck={false}
          defaultValue={JSON.stringify(additionalEnv, null, 2)}
          disabled={disabled}
          placeholder='{"API_KEY":"..."}'
          autoComplete="off"
          aria-invalid={feedback === 'invalid'}
          aria-describedby={row.id + '-env-feedback'}
          onChange={() => setFeedback(null)}
        />
        <small className={s.connectionsHelp}>{t('mcp.local.envHint')}</small>
        <small
          id={row.id + '-env-feedback'}
          className={s.connectionsHelp}
          role={feedback === 'saved' ? 'status' : 'alert'}
          style={feedback && feedback !== 'saved' ? { color: 'var(--color-error)' } : undefined}
        >
          {feedback && feedback !== 'invalidArgs'
            ? t(
                feedback === 'invalid'
                  ? 'mcp.local.envInvalid'
                  : feedback === 'saved'
                    ? 'mcp.local.envSaved'
                    : 'mcp.error',
              )
            : ''}
        </small>
      </label>
      <button className={s.cancelBtn} disabled={disabled}>
        {t('mcp.save')}
      </button>
    </form>
  );
}
