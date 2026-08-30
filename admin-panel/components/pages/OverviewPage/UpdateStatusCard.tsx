'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useServerUpdate } from '../../../lib/hooks/useServerUpdate';
import { serverUpdateService } from '../../../lib/services/serverUpdateService';
import { useBackendRestartDrain } from '../../../lib/hooks/useBackendRestartDrain';
import { ServerUpdateModal } from '../SystemPage/ServerUpdateModal/ServerUpdateModal';
import styles from './OverviewPage.module.css';

export function UpdateStatusCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: info, isLoading: checking } = useServerUpdate();
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');

  // Update channel (image tag) switching
  const [tagDraft, setTagDraft] = useState('');
  const [tagEditing, setTagEditing] = useState(false);
  const [switching, setSwitching] = useState(false);

  const activeStatuses = useMemo(() => new Set(['queued', 'backup', 'restarting']), []);
  const operationMatchesLatest = Boolean(
    info?.operation.targetHash
      && info.operation.targetHash === info.latestHash,
  );
  const updating = Boolean(
    info
      && operationMatchesLatest
      && activeStatuses.has(info.operation.status),
  );
  const operationStatus = !info || !operationMatchesLatest
    ? 'idle'
    : info.operation.status === 'complete' && info.available
      ? 'idle'
      : info.operation.status;
  const busy = checking || refreshing;
  const restart = useBackendRestartDrain({
    apply: applyUpdate,
    onError: (error) => setMessage(t('system.update.updateError', { message: error })),
  });
  const updateInProgress = updating || restart.phase === 'applying';

  async function check() {
    setRefreshing(true);
    setMessage(t('system.update.fetchingInfo'));
    try {
      const fresh = await serverUpdateService.forceRefresh();
      queryClient.setQueryData(['server-update'], fresh);
      setMessage(fresh?.available ? t('system.update.found') : t('system.update.alreadyFresh'));
    } catch (err) {
      setMessage(t('system.update.checkError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRefreshing(false);
    }
  }

  // Branch names map to image tags with `/` replaced by `-` (same slug as CI).
  async function handleSwitchTag() {
    const tag = tagDraft.trim().replace(/\//g, '-');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(tag) || tag === 'local') {
      setMessage(t('system.update.channel.invalidTag'));
      return;
    }
    setSwitching(true);
    setMessage('');
    try {
      await serverUpdateService.setTag(tag);
      setTagEditing(false);
      // Immediately check the new channel so the admin sees what's there.
      setRefreshing(true);
      const fresh = await serverUpdateService.forceRefresh();
      queryClient.setQueryData(['server-update'], fresh);
      setMessage(fresh?.available
        ? t('system.update.channel.switchedFound', { tag })
        : t('system.update.channel.switchedCurrent', { tag }));
    } catch (err) {
      setMessage(t('system.update.channel.error', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRefreshing(false);
      setSwitching(false);
    }
  }

  async function applyUpdate() {
    setMessage(t('system.update.starting'));
    await serverUpdateService.apply();
    queryClient.setQueryData(['server-update'], (current: typeof info) => current ? {
      ...current,
      operation: {
        status: 'queued' as const,
        targetHash: current.latestHash,
        message: 'server_update_queued',
        updatedAt: new Date().toISOString(),
      },
    } : current);
    await queryClient.invalidateQueries({ queryKey: ['server-update'] });
  }

  // ─── Render ──────────────────────────────────────────────────────────────
  if (checking && !info) {
    return <strong className={styles.updateChecking}>{t('overview.updateStatus.checking')}</strong>;
  }

  if (!info?.supported) {
    return (
      <div className={styles.updateMini}>
        <span className={`${styles.updateDot} ${styles.updateOff}`} />
        <strong>{t('overview.updateStatus.unavailable')}</strong>
      </div>
    );
  }

  return (
    <>
      <div className={styles.updateMini}>
        <div className={styles.updateMiniInfo}>
          <span className={`${styles.updateDot} ${info.available ? styles.updateWarn : styles.updateOk}`} />
          <strong>{info.available
            ? t('overview.updateStatus.updateAvailable')
            : t('overview.updateStatus.upToDate')}</strong>
        </div>
        {message && <small className={styles.updateMsg}>{message}</small>}
        <div className={styles.updateActions}>
          <button type="button" className="buttonSecondary" disabled={busy || updateInProgress} onClick={() => void check()}>
            {t('system.update.check')}
          </button>
          {info.available && (
            <button type="button" disabled={busy || updateInProgress} onClick={() => void restart.show()}>
              {updateInProgress ? t('system.update.updating') : t('system.update.updateButton')}
            </button>
          )}
        </div>
        {/* Update channel (image tag): `latest` = production, branch tag = track a branch */}
        <div className={styles.updateChannel}>
          <button
            type="button"
            className={styles.channelChip}
            disabled={switching || updateInProgress}
            title={t('system.update.channel.hint')}
            onClick={() => { setTagDraft(info.imageTag || 'latest'); setTagEditing((prev) => !prev); }}
          >
            {t('system.update.channel.label')}: <strong>{info.imageTag || 'latest'}</strong>
          </button>
          {tagEditing && (
            <span className={styles.channelEdit}>
              <input
                value={tagDraft}
                disabled={switching}
                placeholder="latest"
                spellCheck={false}
                onChange={(event) => setTagDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void handleSwitchTag(); }}
              />
              <button type="button" disabled={switching} onClick={() => void handleSwitchTag()}>
                {switching ? t('system.update.channel.switching') : t('system.update.channel.apply')}
              </button>
            </span>
          )}
        </div>
      </div>
      {restart.open && info && (
        <ServerUpdateModal
          changelog={info.changelog}
          rebuiltFromSameCommit={false}
          updating={updateInProgress}
          operationStatus={restart.error ? 'failed' : operationStatus}
          operationMessage={restart.error || info.operation.message}
          drainPhase={restart.phase}
          drain={restart.drain}
          applyError={restart.error}
          onCancel={restart.cancel}
          onRetry={restart.retry}
          onSoftUpdate={restart.soft}
          onForceUpdate={restart.force}
        />
      )}
    </>
  );
}
