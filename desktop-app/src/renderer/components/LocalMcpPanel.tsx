import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocalMcp } from '../lib/useMcp';
import * as api from '../lib/mcp-service';
import { emptyMcpApproval } from '../../main/local-mcp-spec';
import { Select } from './Select';
import { McpToggle, McpTools } from './McpControls';
import { Icon } from './Icon';
import { AnimatedDetails } from './AnimatedDisclosure';
import { ConfirmDialog } from './ConfirmDialog';
import s from './SettingsModal.module.scss';
import styles from './McpSettings.module.scss';

export function LocalMcpPanel({ allowed }: { allowed: boolean }) {
  const { t } = useTranslation(),
    { query, mutation, available } = useLocalMcp();
  const [error, setError] = useState(''),
    [remove, setRemove] = useState<string | null>(null);
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
    } catch (e: any) {
      setError(String(e?.message || t('mcp.error')));
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
          <article className={styles.connection} key={row.id}>
            <div className={styles.cardHeading}>
              <span className={styles.icon}>
                <Icon name="monitor" />
              </span>
              <strong>{row.name}</strong>
              <McpToggle
                checked={row.enabled}
                disabled={busy}
                label={t('mcp.connectionEnabled')}
                onChange={(enabled) => void run(() => api.configureLocalMcp(row.id, { enabled }))}
              />
            </div>
            <p className={styles.url}>{row.source}</p>
            <p className={styles.url}>
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
            </div>
            <AnimatedDetails
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

                <form
                  className={`${styles.settingsForm} ${styles.settingsGrid}`}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    void run(async () =>
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
                  <label className={styles.fullWidth}>
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
              </div>
            </AnimatedDetails>
            <McpTools
              tools={row.tools}
              selected={row.selected_tools}
              approval={approval}
              disabled={busy}
              saveSelected={(selected_tools) =>
                void run(() => api.configureLocalMcp(row.id, { selected_tools }))
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
