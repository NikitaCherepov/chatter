'use client';

import { useCallback, useEffect, useState } from 'react';
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
  changelog: string;
  rebuiltFromSameCommit: boolean;
  checkedAt: string | null;
  operation: UpdateOperation;
};

const activeStatuses = new Set(['queued', 'backup', 'restarting']);
const statusText: Record<UpdateOperation['status'], string> = {
  idle: '',
  queued: 'Обновление запускается…',
  backup: 'Создаём резервную копию базы данных…',
  restarting: 'Перезапускаем серверные сервисы. Панель ненадолго отключится…',
  complete: 'Сервер обновлён.',
  failed: 'Обновление не удалось.',
};

export function ServerUpdatePanel() {
  const [info, setInfo] = useState<ServerUpdateInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    const next = await api<ServerUpdateInfo>('/api/server-update');
    setInfo(next);
    const active = activeStatuses.has(next.operation.status);
    setUpdating(active);
    if (next.operation.status === 'failed') setMessage(`${statusText.failed} ${next.operation.message}`);
    else if (next.operation.status === 'complete') setMessage(statusText.complete);
    else if (active) setMessage(statusText[next.operation.status]);
    return next;
  }, []);

  useEffect(() => {
    load().catch(error => setMessage(`Ошибка: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => setChecking(false));
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
    setMessage('Скачиваем сведения о свежих серверных образах…');
    try {
      const next = await api<ServerUpdateInfo>('/api/server-update?refresh=1');
      setInfo(next);
      setMessage(next.available ? 'Найдены новые серверные образы.' : 'Сервер уже использует свежие образы.');
    } catch (error) {
      setMessage(`Ошибка проверки: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setChecking(false);
    }
  }

  async function update() {
    setUpdating(true);
    setMessage('Запускаем обновление…');
    try {
      await api('/api/server-update', { method: 'POST', body: '{}' });
      setConfirming(false);
      await load();
    } catch (error) {
      setUpdating(false);
      setMessage(`Ошибка обновления: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const statusLabel = checking
    ? 'Проверяем…'
    : !info
      ? 'Не удалось проверить'
      : !info.supported
        ? 'Недоступно локально'
    : info?.available
      ? info.rebuiltFromSameCommit ? 'Образ пересобран' : 'Доступно обновление'
      : 'Обновлений нет';

  return (
    <>
      <Card title="Обновление сервера" description="Проверяются только Docker-образы серверных сервисов. Desktop не затрагивается.">
      <div className={styles.updateContent}>
        <div className={styles.versionGrid}>
          <HashItem label="Запущенная сборка" value={info?.installedHash || '—'} />
          <HashItem label="Свежая сборка" value={info?.latestHash || '—'} />
          <div className={styles.versionStatus}>
            <span className={info?.available || !info?.supported ? styles.updateAvailable : styles.updateCurrent} />
            <strong>{statusLabel}</strong>
          </div>
        </div>
        {!info?.supported && !checking && (
          <p className={styles.operationState}>Обновление доступно только для серверной установки, работающей на Docker-образах latest.</p>
        )}
        {info?.changedServices.length ? (
          <p className={styles.operationState}>Изменились: {info.changedServices.join(', ')}</p>
        ) : null}
        {message && <p className={styles.operationState}>{message}</p>}
        <div className={styles.updateActions}>
          <small>«Проверить» скачивает образы, но не перезапускает сервисы.</small>
          <div>
            <button type="button" className="buttonSecondary" disabled={checking || updating || !info?.supported} onClick={() => void check()}>Проверить</button>
            <button type="button" disabled={!info?.available || updating || checking} onClick={() => setConfirming(true)}>{updating ? 'Обновляем…' : 'Обновить сервер'}</button>
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
