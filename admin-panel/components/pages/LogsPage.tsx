import { Card } from '../ui/Card';
import styles from './LogsPage.module.css';

export function LogsPage() {
  return <div className={styles.wrap}><Card title="Логи сервисов" description="Backend, Telegram, Notes, Voice и Manager"><div className={styles.toolbar}><select defaultValue="all" disabled><option value="all">Все сервисы</option></select><span>Live-режим будет подключён к manager API</span></div><div className={styles.console}><span>Логи пока доступны через Docker Compose.</span><code>docker compose logs -f --tail=200</code></div></Card></div>;
}
