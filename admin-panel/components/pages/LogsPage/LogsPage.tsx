'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../ui/Card/Card';
import { LogConsole } from './LogConsole';
import { LogToolbar, type LogService } from './LogToolbar';
import styles from './LogsPage.module.css';

export function LogsPage() {
  const { t } = useTranslation();
  const [service, setService] = useState<LogService>('all');
  const [tail, setTail] = useState(200);
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const consoleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]); setConnected(false); setError('');
    const source = new EventSource(`/api/logs/stream?service=${encodeURIComponent(service)}&tail=${tail}`);
    source.addEventListener('ready', () => { setConnected(true); setError(''); });
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { line?: string };
        const maxBufferedLines = service === 'all' ? Math.max(3000, tail * 6 + 1000) : 3000;
        if (data.line) setLines((current) => [...current, data.line as string].slice(-maxBufferedLines));
      } catch { /* Ignore malformed log events. */ }
    };
    source.addEventListener('stream-error', (event) => {
      try { setError((JSON.parse((event as MessageEvent).data) as { error?: string }).error || t('logs.streamError')); }
      catch { setError(t('logs.streamError')); }
      setConnected(false);
    });
    source.addEventListener('ended', () => setConnected(false));
    source.onerror = () => { setConnected(false); setError(t('logs.noConnection')); };
    return () => source.close();
  }, [service, tail, t]);

  const visibleLines = useMemo(() => {
    const query = search.trim().toLowerCase();
    return query ? lines.filter((line) => line.toLowerCase().includes(query)) : lines;
  }, [lines, search]);

  useEffect(() => {
    if (!paused && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [visibleLines, paused]);

  function download() {
    const blob = new Blob([`${visibleLines.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `chatter-${service}-logs.txt`; link.click();
    URL.revokeObjectURL(url);
  }

  return <div className={styles.wrap}><Card title={t('logs.title')} description={t('logs.description')}>
    <LogToolbar service={service} tail={tail} paused={paused} connected={connected} search={search} onServiceChange={setService} onTailChange={setTail} onPausedChange={setPaused} onSearchChange={setSearch} onClear={() => setLines([])} onDownload={download} />
    <LogConsole lines={visibleLines} paused={paused} error={error} consoleRef={consoleRef} />
  </Card></div>;
}
