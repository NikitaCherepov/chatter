import type { SystemInfo } from './types';
import { formatBytes, formatUptime } from './types';
import styles from './SystemPage.module.css';

export function ServerMetrics({ info }: { info: SystemInfo }) {
  return (
    <>
      <div className={styles.metricGrid}>
        <Metric title="CPU" value={`${info.cpu.usagePercent}%`} detail={`${info.cpu.cores} ядер`} percent={info.cpu.usagePercent} />
        <Metric title="Оперативная память" value={`${formatBytes(info.memory.used)} / ${formatBytes(info.memory.total)}`} detail={`${formatBytes(info.memory.available)} доступно`} percent={percent(info.memory.used, info.memory.total)} />
        <Metric title="Swap" value={info.swap.total ? `${formatBytes(info.swap.used)} / ${formatBytes(info.swap.total)}` : 'Не настроен'} detail={info.swap.total ? `${formatBytes(info.swap.available)} доступно` : 'Для малых VPS swap рекомендуется'} percent={percent(info.swap.used, info.swap.total)} />
        <Metric title="Диск" value={`${formatBytes(info.disk.used)} / ${formatBytes(info.disk.total)}`} detail={`${formatBytes(info.disk.available)} свободно`} percent={percent(info.disk.used, info.disk.total)} />
      </div>
      <div className={styles.serverMeta}>
        <span><small>Сервер</small><strong>{info.hostname}</strong></span>
        <span><small>Система</small><strong>{info.platform}</strong></span>
        <span><small>Uptime</small><strong>{formatUptime(info.uptimeSeconds)}</strong></span>
        <span><small>Процессор</small><strong>{info.cpu.model}</strong></span>
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
