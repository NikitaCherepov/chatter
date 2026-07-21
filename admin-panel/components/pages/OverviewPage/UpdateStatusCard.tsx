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
  const [message, setMessage] = useState('');

  const activeStatuses = useMemo(() => new Set(['queued', 'backup', 'restarting']), []);
  const updating = info ? activeStatuses.has(info.operation.status) : false;
  const busy = checking || refreshing;
  const updateInProgress = updating || applying;

  async function check() {
    setRefreshing(true);
    setMessage(t('system.update.fetchingInfo'));
    try {
      await serverUpdateService.refresh();
      await queryClient.invalidateQueries({ queryKey: ['server-update'] });
      const fresh = queryClient.getQueryData<ReturnType<typeof useServerUpdate>['data']>(['server-update']);
      setMessage(fresh?.available ? t('system.update.found') : t('system.update.alreadyFresh'));
    } catch (err) {
      setMessage(t('system.update.checkError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setRefreshing(false);
    }
  }

  async function apply() {
    setApplying(true);
    setMessage(t('system.update.starting'));
    try {
      await serverUpdateService.apply();
      setConfirming(false);
      setMessage('');
      await queryClient.invalidateQueries({ queryKey: ['server-update'] });
    } catch (err) {
      setMessage(t('system.update.updateError', { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setApplying(false);
    }
  }

  if (checking && !info) {
    return <strong className={styles.updateBig}>{t('overview.updateStatus.checking')}</strong>;
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
            ? (info.rebuiltFromSameCommit ? t('overview.updateStatus.rebuild') : t('overview.updateStatus.updateAvailable'))
            : t('overview.updateStatus.upToDate')}</strong>
        </div>
        {message && <small className={styles.updateMsg}>{message}</small>}
        <div className={styles.updateActions}>
          <button type="button" className="buttonSecondary" disabled={busy || updateInProgress} onClick={() => void check()}>
            {t('system.update.check')}
          </button>
          {info.available && (
            <button type="button" disabled={busy || updateInProgress} onClick={() => setConfirming(true)}>
              {updateInProgress ? t('system.update.updating') : t('system.update.updateButton')}
            </button>
          )}
        </div>
      </div>
      {confirming && info && (
        <ServerUpdateModal
          changelog={info.changelog}
          changedServices={info.changedServices}
          rebuiltFromSameCommit={info.rebuiltFromSameCommit}
          updating={updateInProgress}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void apply()}
        />
      )}
    </>
  );
}
