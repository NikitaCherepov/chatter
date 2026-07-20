import { useTranslation } from 'react-i18next';
import type { SystemInfo } from './types';
import { formatBytes, formatUptime } from './types';
import styles from './SystemPage.module.css';

export function ServerMetrics({ info }: { info: SystemInfo }) {
  const { t } = useTranslation();
  return (
    <>
      <div className={styles.metricGrid}>
        <Metric title={t('system.serverStatus.cpu')} value={`${info.cpu.usagePercent}%`} detail={t('system.serverStatus.cores', { count: info.cpu.cores })} percent={info.cpu.usagePercent} />
        <Metric title={t('system.serverStatus.memory')} value={`${formatBytes(info.memory.used)} / ${formatBytes(info.memory.total)}`} detail={t('system.serverStatus.available', { size: formatBytes(info.memory.available) })} percent={percent(info.memory.used, info.memory.total)} />
        <Metric title={t('system.serverStatus.swap')} value={info.swap.total ? `${formatBytes(info.swap.used)} / ${formatBytes(info.swap.total)}` : t('system.serverStatus.swapNotConfigured')} detail={info.swap.total ? t('system.serverStatus.available', { size: formatBytes(info.swap.available) }) : t('system.serverStatus.swapRecommended')} percent={percent(info.swap.used, info.swap.total)} />
        <Metric title={t('system.serverStatus.disk')} value={`${formatBytes(info.disk.used)} / ${formatBytes(info.disk.total)}`} detail={t('system.serverStatus.free', { size: formatBytes(info.disk.available) })} percent={percent(info.disk.used, info.disk.total)} />
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

function Metric({ title, value, detail, percent: valuePercent }: { title: string; value: string; detail: string; percent: number }) {
  return (
    <article className={styles.metric}>
      <span>{title}</span><strong>{value}</strong><small>{detail}</small>
      <div className={styles.meter}><span style={{ width: `${valuePercent}%` }} /></div>
    </article>
  );
}

function percent(used: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
}
