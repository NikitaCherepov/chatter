'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useServerUpdate } from '../../../lib/hooks/useServerUpdate';
import { serverUpdateService } from '../../../lib/services/serverUpdateService';
import { ServerUpdateModal } from '../SystemPage/ServerUpdateModal/ServerUpdateModal';
import styles from './OverviewPage.module.css';

export function UpdateStatusCard() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: info, isLoading: checking } = useServerUpdate();
  const [confirming, setConfirming] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [message, setMessage] = useState('');

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
  const updateInProgress = updating || applying;

  async function check() {
    setRefreshing(true);
    setMessage(t('system.update.fetchingInfo'));
    try {
      const fresh = await serverUpdateService.refresh();
      queryClient.setQueryData(['server-update'], fresh);
      setMessage(fresh?.available ? t('system.update.found') : t('system.update.alreadyFresh'));
    } catch (err) {
      setMessage(t('system.update.checkError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRefreshing(false);
    }
  }

  async function apply() {
    setApplying(true);
    setApplyError('');
    setMessage(t('system.update.starting'));
    try {
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
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      setApplyError(error);
      setMessage(t('system.update.updateError', { message: error }));
    } finally {
      setApplying(false);
    }
  }

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
            <button type="button" disabled={busy || updateInProgress} onClick={() => {
              setApplyError('');
              setConfirming(true);
            }}>
              {updateInProgress ? t('system.update.updating') : t('system.update.updateButton')}
            </button>
          )}
        </div>
      </div>
      {confirming && info && (
        <ServerUpdateModal
          changelog={info.changelog}
          rebuiltFromSameCommit={false}
          updating={updateInProgress}
          operationStatus={applyError ? 'failed' : operationStatus}
          operationMessage={applyError || info.operation.message}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void apply()}
        />
      )}
    </>
  );
}
