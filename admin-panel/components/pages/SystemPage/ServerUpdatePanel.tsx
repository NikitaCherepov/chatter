'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import { ServerUpdateModal } from './ServerUpdateModal/ServerUpdateModal';
import styles from './SystemPage.module.css';

type UpdateOperation = {
  status: 'idle' | 'queued' | 'backup' | 'restarting' | 'complete' | 'failed';
  targetHash: string;
  message: string;
  updatedAt: string | null;
};

type ServerUpdateInfo = {
  supported: boolean;
  installedHash: string;
  latestHash: string;
  available: boolean;
  changedServices: string[];
  changelog: Record<string, string[]>;
  rebuiltFromSameCommit: boolean;
  checkedAt: string | null;
  operation: UpdateOperation;
};

const activeStatuses = new Set(['queued', 'backup', 'restarting']);

export function ServerUpdatePanel() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<ServerUpdateInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');

  const statusText: Record<UpdateOperation['status'], string> = {
    idle: '',
    queued: t('system.update.stages.queued'),
    backup: t('system.update.stages.backup'),
    restarting: t('system.update.stages.restarting'),
    complete: t('system.update.stages.complete'),
    failed: t('system.update.stages.failed'),
  };

  const load = useCallback(async () => {
    const next = await api<ServerUpdateInfo>('/api/server-update');
    setInfo(next);
    const active = activeStatuses.has(next.operation.status);
    setUpdating(active);
    if (next.operation.status === 'failed') setMessage(`${statusText.failed} ${next.operation.message}`);
    else if (next.operation.status === 'complete') setMessage(statusText.complete);
    else if (active) setMessage(statusText[next.operation.status]);
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  useEffect(() => {
    load().catch(error => setMessage(t('system.error', { message: error instanceof Error ? error.message : String(error) })))
      .finally(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    if (!updating) return;
    const timer = window.setInterval(() => {
      load().catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [load, updating]);

  async function check() {
    setChecking(true);
    setMessage(t('system.update.fetchingInfo'));
    try {
      const next = await api<ServerUpdateInfo>('/api/server-update?refresh=1');
      setInfo(next);
      setMessage(next.available ? t('system.update.found') : t('system.update.alreadyFresh'));
    } catch (error) {
      setMessage(t('system.update.checkError', { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setChecking(false);
    }
  }

  async function update() {
    setUpdating(true);
    setMessage(t('system.update.starting'));
    try {
      await api('/api/server-update', { method: 'POST', body: '{}' });
      setConfirming(false);
      await load();
    } catch (error) {
      setUpdating(false);
      setMessage(t('system.update.updateError', { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  const statusLabel = checking
    ? t('system.update.checking')
    : !info
      ? t('system.update.checkFailed')
      : !info.supported
        ? t('system.update.unavailable')
    : info?.available
      ? info.rebuiltFromSameCommit ? t('system.update.rebuild') : t('system.update.updateAvailable')
      : t('system.update.upToDate');

  return (
    <>
      <Card title={t('system.update.title')} description={t('system.update.description')}>
      <div className={styles.updateContent}>
        <div className={styles.versionGrid}>
          <HashItem label={t('system.update.installedBuild')} value={info?.installedHash || '\u2014'} />
          <HashItem label={t('system.update.latestBuild')} value={info?.latestHash || '\u2014'} />
          <div className={styles.versionStatus}>
            <span className={info?.available || !info?.supported ? styles.updateAvailable : styles.updateCurrent} />
            <strong>{statusLabel}</strong>
          </div>
        </div>
        {!info?.supported && !checking && (
          <p className={styles.operationState}>{t('system.update.updateDockerOnly')}</p>
        )}
        {info?.changedServices.length ? (
          <p className={styles.operationState}>{t('system.update.changes.changed', { services: info.changedServices.join(', ') })}</p>
        ) : null}
        {message && <p className={styles.operationState}>{message}</p>}
        <div className={styles.updateActions}>
          <small>{t('system.update.checkHint')}</small>
          <div>
            <button type="button" className="buttonSecondary" disabled={checking || updating || !info?.supported} onClick={() => void check()}>{t('system.update.check')}</button>
            <button type="button" disabled={!info?.available || updating || checking} onClick={() => setConfirming(true)}>{updating ? t('system.update.updating') : t('system.update.updateButton')}</button>
          </div>
        </div>
      </div>
      </Card>
      {confirming && info && (
        <ServerUpdateModal
          changelog={info.changelog}
          changedServices={info.changedServices}
          rebuiltFromSameCommit={info.rebuiltFromSameCommit}
          updating={updating}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void update()}
        />
      )}
    </>
  );
}

function HashItem({ label, value }: { label: string; value: string }) {
  return <div className={styles.versionItem}><span>{label}</span><strong>{value}</strong></div>;
}
