import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocalMcp } from '../lib/useMcp';
import * as api from '../lib/mcp-service';
import { packageFields, emptyMcpApproval } from '../../main/local-mcp-spec';
import { Select } from './Select';
import Checkbox from './Checkbox';
import { ConfirmDialog } from './ConfirmDialog';
import s from './SettingsModal.module.scss';
import styles from './McpSettings.module.scss';

export function LocalMcpPanel({
  allowed,
  draft,
  onClose,
}: {
  allowed: boolean;
  draft: api.CatalogItem | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(),
    { query, mutation, available } = useLocalMcp();
  const [source, setSource] = useState(''),
    [name, setName] = useState(''),
    [env, setEnv] = useState('');
  const [values, setValues] = useState<Record<string, string>>({}),
    [error, setError] = useState(''),
    [remove, setRemove] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const handler = (event: Event) => {
      const error = (event as CustomEvent).detail?.error;
      if (error) setError(String(error));
    };
    window.addEventListener('mcp-local-sync', handler);
    return () => window.removeEventListener('mcp-local-sync', handler);
  }, []);
  useEffect(() => {
    setValues({});
    if (draft) {
      setName(draft.title || draft.name);
      form.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [draft]);
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await mutation.mutateAsync(action);
    } catch (e: any) {
      setError(String(e?.message || t('mcp.error')));
    }
  };
  if (!available) return null;
  const busy = mutation.isPending;
  return (
    <section>
      <h3>{t('mcp.local.title')}</h3>
      <p className={s.connectionsHelp}>{t('mcp.local.help')}</p>
      {(error || query.isError) && <p role="alert">{error || t('mcp.error')}</p>}
      {(query.data || []).map((row) => {
        const approval = row.approval_policy || emptyMcpApproval();
        const saveApproval = (patch: Partial<typeof approval>) =>
          run(() => api.configureLocalMcp(row.id, { approval_policy: { ...approval, ...patch } }));
        return (
          <article className={s.macroCard} key={row.id}>
            <div className={s.macroHeader}>
              <strong>{row.name}</strong>
              <Checkbox
                checked={row.enabled}
                disabled={busy}
                label={t('mcp.connectionEnabled')}
                onChange={(enabled) => void run(() => api.configureLocalMcp(row.id, { enabled }))}
              />
            </div>
            <p className={styles.url}>{row.source}</p>
            <p>
              {t('mcp.tools')}: {row.tools.length} · {t('mcp.resources')}: {row.resources.length}
            </p>
            {row.error && <p role="alert">{row.error}</p>}
            <div className={styles.actions}>
              <button
                className={s.cancelBtn}
                disabled={busy || !row.enabled || !allowed}
                onClick={() => void run(() => api.refreshLocalMcp(row.id))}
              >
                {t('mcp.refresh')}
              </button>
              <button className={s.cancelBtn} disabled={busy} onClick={() => setRemove(row.id)}>
                {t('mcp.remove')}
              </button>
            </div>
            <details>
              <summary>{t('mcp.settings')}</summary>
              <Checkbox
                label={t('mcp.approvals.allowAll')}
                checked={approval.allow_all}
                disabled={busy}
                onChange={(allow_all) => void saveApproval({ allow_all })}
              />
              <p className={s.connectionsHelp}>{t('mcp.approvals.allowAllHint')}</p>
              {approval.resources.map((uri) => (
                <div className={styles.tool} key={uri}>
                  <Checkbox
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

              <label>
                {t('mcp.mode')}
                <Select
                  value={row.mode}
                  disabled={busy}
                  onChange={(mode) => void run(() => api.configureLocalMcp(row.id, { mode }))}
                  options={[
                    { value: 'search', label: t('mcp.searchMode') },
                    { value: 'eager', label: t('mcp.eagerMode') },
                  ]}
                />
              </label>
              <form
                className={styles.form}
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void run(() =>
                    api.configureLocalMcp(row.id, {
                      timeout_seconds: Number(data.get('timeout')),
                      ...(String(data.get('env') || '').trim()
                        ? { env: JSON.parse(String(data.get('env'))) }
                        : {}),
                    }),
                  );
                }}
              >
                <label>
                  {t('mcp.timeout')}
                  <input
                    className={s.fieldInput}
                    type="number"
                    name="timeout"
                    min={10}
                    max={3600}
                    defaultValue={row.timeout_seconds}
                  />
                </label>
                <label>
                  {t('mcp.local.env')}
                  <input
                    className={s.fieldInput}
                    name="env"
                    type="password"
                    placeholder='{"API_KEY":"..."}'
                    autoComplete="off"
                  />
                </label>
                <button className={s.cancelBtn} disabled={busy}>
                  {t('mcp.save')}
                </button>
              </form>
              <p>
                {t('mcp.tools')}: {row.tools.length}
              </p>
              {row.tools.map((tool) => (
                <div className={styles.tool} key={tool.name}>
                  <Checkbox
                    checked={row.selected_tools === null || row.selected_tools.includes(tool.name)}
                    disabled={busy}
                    label={tool.name}
                    onChange={(checked) => {
                      const selected = row.selected_tools ?? row.tools.map((x) => x.name);
                      void run(() =>
                        api.configureLocalMcp(row.id, {
                          selected_tools: checked
                            ? [...selected, tool.name]
                            : selected.filter((x) => x !== tool.name),
                        }),
                      );
                    }}
                  />
                  <Checkbox
                    label={t('mcp.approvals.withoutConfirmation')}
                    checked={approval.allow_all || approval.tools.includes(tool.name)}
                    disabled={busy || approval.allow_all}
                    onChange={(checked) =>
                      void saveApproval({
                        tools: checked
                          ? [...new Set([...approval.tools, tool.name])]
                          : approval.tools.filter((name) => name !== tool.name),
                      })
                    }
                  />
                  <small>{tool.description}</small>
                </div>
              ))}
            </details>
          </article>
        );
      })}
      {allowed && (
        <form
          ref={form}
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.installLocalMcp({
                name: name || undefined,
                description: draft?.description,
                ...(draft?.package ? { package: draft.package, values } : { source }),
                env: env ? JSON.parse(env) : {},
              });
              setSource('');
              setName('');
              setEnv('');
              onClose();
            });
          }}
        >
          <h4>
            {draft
              ? t('mcp.local.install') + ': ' + (draft.title || draft.name)
              : t('mcp.local.add')}
          </h4>
          {!draft && (
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
            <input
              className={s.fieldInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {draft?.package &&
            packageFields(draft.package).map((field) => (
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
            <input
              className={s.fieldInput}
              type="password"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder='{"API_KEY":"..."}'
              autoComplete="off"
            />
          </label>
          <button className={s.saveBtn} disabled={busy}>
            {t(busy ? 'mcp.local.installing' : 'mcp.local.install')}
          </button>
          {draft && (
            <button type="button" className={s.cancelBtn} disabled={busy} onClick={onClose}>
              {t('mcp.cancel')}
            </button>
          )}
          <small className={s.connectionsHelp}>{t('mcp.local.formHelp')}</small>
        </form>
      )}
      <ConfirmDialog
        open={remove !== null}
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
    </section>
  );
}
