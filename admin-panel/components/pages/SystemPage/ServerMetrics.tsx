import { useTranslation } from 'react-i18next';
import type { SystemInfo } from './types';
import { formatBytes, formatUptime } from './types';
import styles from './SystemPage.module.css';

type MetricKey = 'cpu' | 'mem' | 'swap' | 'disk';

type Props = {
  info: SystemInfo;
  selectedMetric: MetricKey;
  onMetricSelect: (key: MetricKey) => void;
};

export function ServerMetrics({ info, selectedMetric, onMetricSelect }: Props) {
  const { t } = useTranslation();
  return (
    <>
      <div className={styles.metricGrid}>
        <Metric
          title={t('system.serverStatus.cpu')}
          value={`${info.cpu.usagePercent}%`}
          detail={t('system.serverStatus.cores', { count: info.cpu.cores })}
          percent={info.cpu.usagePercent}
          active={selectedMetric === 'cpu'}
          onClick={() => onMetricSelect('cpu')}
        />
        <Metric
          title={t('system.serverStatus.memory')}
          value={`${formatBytes(info.memory.used)} / ${formatBytes(info.memory.total)}`}
          detail={t('system.serverStatus.available', { size: formatBytes(info.memory.available) })}
          percent={percent(info.memory.used, info.memory.total)}
          active={selectedMetric === 'mem'}
          onClick={() => onMetricSelect('mem')}
        />
        <Metric
          title={t('system.serverStatus.swap')}
          value={info.swap.total ? `${formatBytes(info.swap.used)} / ${formatBytes(info.swap.total)}` : t('system.serverStatus.swapNotConfigured')}
          detail={info.swap.total ? t('system.serverStatus.available', { size: formatBytes(info.swap.available) }) : t('system.serverStatus.swapRecommended')}
          percent={percent(info.swap.used, info.swap.total)}
          active={selectedMetric === 'swap'}
          onClick={() => onMetricSelect('swap')}
        />
        <Metric
          title={t('system.serverStatus.disk')}
          value={`${formatBytes(info.disk.used)} / ${formatBytes(info.disk.total)}`}
          detail={t('system.serverStatus.free', { size: formatBytes(info.disk.available) })}
          percent={percent(info.disk.used, info.disk.total)}
          active={selectedMetric === 'disk'}
          onClick={() => onMetricSelect('disk')}
        />
      </div>
      <div className={styles.serverMeta}>
        <span><small>{t('system.serverStatus.server')}</small><strong>{info.hostname}</strong></span>
        <span><small>{t('system.serverStatus.system')}</small><strong>{info.platform}</strong></span>
        <span><small>Uptime</small><strong>{formatUptime(info.uptimeSeconds)}</strong></span>
        <span><small>{t('system.serverStatus.processor')}</small><strong>{info.cpu.model}</strong></span>
      </div>
    </>
  );
}

function Metric({ title, value, detail, percent: valuePercent, active, onClick }: {
  title: string;
  value: string;
  detail: string;
  percent: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <article
      className={`${styles.metric} ${active ? styles.metricActive : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
      <span>{title}</span><strong>{value}</strong><small>{detail}</small>
      <div className={styles.meter}><span style={{ width: `${valuePercent}%` }} /></div>
    </article>
  );
}

function percent(used: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
}
