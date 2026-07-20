'use client';

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Card } from '../../ui/Card/Card';
import { useSystemInfo, useSystemMetrics } from '../../../lib/hooks/useSystemMetrics';
import type { MetricsRange } from '../../../lib/services/systemService';
import { ServerMetrics } from './ServerMetrics';
import { MetricsChart } from './MetricsChart';
import { RangeSelector } from './RangeSelector';
import { ServerUpdatePanel } from './ServerUpdatePanel';
import { formatBytes } from './types';
import styles from './SystemPage.module.css';

type MetricKey = 'cpu' | 'mem' | 'swap' | 'disk';

export function SystemPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('cpu');
  const [range, setRange] = useState<MetricsRange>('24h');

  const infoQuery = useSystemInfo();
  const metricsQuery = useSystemMetrics(range);

  const info = infoQuery.data;
  const loading = infoQuery.isLoading;

  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['system'] });
  }, [queryClient]);

  return (
    <div className={styles.stack}>
      <div className={styles.toolbar}>
        <span>{loading ? t('system.updating') : t('system.dataFrom')}</span>
        <button type="button" className="buttonSecondary" onClick={handleRefresh} disabled={loading}>
          {t('system.refresh')}
        </button>
      </div>
      {info && (
        <>
          <Card
            title={t('system.serverStatus.title')}
            description={t('system.serverStatus.description')}
            aside={<RangeSelector value={range} onChange={setRange} />}
          >
            <ServerMetrics
              info={info}
              selectedMetric={selectedMetric}
              onMetricSelect={setSelectedMetric}
            />
            <MetricsChart
              metric={selectedMetric}
              data={metricsQuery.data?.points ?? []}
              isLoading={metricsQuery.isLoading}
            />
          </Card>
          <div className={styles.storageGrid}>
            <StorageItem title={t('system.storage.database')} value={formatBytes(info.storage.databaseSize)} />
            <StorageItem title={t('system.storage.uploads')} value={formatBytes(info.storage.uploadsSize)} />
            <StorageItem title={t('system.storage.backups')} value={formatBytes(info.storage.backupsSize)} />
          </div>
        </>
      )}
      <ServerUpdatePanel />
      {infoQuery.error && <p className={styles.state}>{t('system.error', { message: infoQuery.error instanceof Error ? infoQuery.error.message : String(infoQuery.error) })}</p>}
    </div>
  );
}

function StorageItem({ title, value }: { title: string; value: string }) {
  return <article><span>{title}</span><strong>{value}</strong></article>;
}
