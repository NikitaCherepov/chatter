'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import { ServerMetrics } from './ServerMetrics';
import { ServerUpdatePanel } from './ServerUpdatePanel';
import type { SystemInfo } from './types';
import { formatBytes } from './types';
import styles from './SystemPage.module.css';

export function SystemPage() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const system = await api<SystemInfo>('/api/system');
      setInfo(system); setState('');
    } catch (error) {
      setState(t('system.error', { message: error instanceof Error ? error.message : String(error) }));
    } finally { setLoading(false); }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}><span>{loading ? t('system.updating') : t('system.dataFrom')}</span><button type="button" className="buttonSecondary" onClick={() => void load()} disabled={loading}>{t('system.refresh')}</button></div>
      {info && <><Card title={t('system.serverStatus.title')} description={t('system.serverStatus.description')}><ServerMetrics info={info} /></Card><div className={styles.storageGrid}><StorageItem title={t('system.storage.database')} value={formatBytes(info.storage.databaseSize)} /><StorageItem title={t('system.storage.uploads')} value={formatBytes(info.storage.uploadsSize)} /><StorageItem title={t('system.storage.backups')} value={formatBytes(info.storage.backupsSize)} /></div></>}
      <ServerUpdatePanel />
      {state && <p className={styles.state}>{state}</p>}
    </div>
  );
}

function StorageItem({ title, value }: { title: string; value: string }) {
  return <article><span>{title}</span><strong>{value}</strong></article>;
}
