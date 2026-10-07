import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import s from './SettingsModal.module.scss';
type Connection = { id: number; name: string; email: string };
export function ChatGptSettings() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => api.apiFetch<{ connections: Connection[] }>('/api/v1/admin/chatgpt/connections').then(value => setConnections(value.connections));
  useEffect(() => { void load().catch(() => toast.error(t('chatgpt.failed'))); }, []);
  const connect = async (connectionId?: number) => {
    const connection = api.loadServerConnection();
    const tokens = api.loadTokens();
    if (!connection || !tokens) { toast.error(t('chatgpt.serverRequired')); return; }
    setBusy(true);
    try {
      await window.electronAPI.connectChatGpt({ apiBase: api.API_BASE, accessToken: tokens.access_token, serverKey: connection.key, connectionId });
      await load();
      toast.success(t('chatgpt.connected'));
    } catch (error: any) {
      const code = String(error?.message || '').match(/chatgpt_[a-z_]+/)?.[0];
      toast.error(t('chatgpt.errors.' + code, { defaultValue: t('chatgpt.failed') }));
    } finally { setBusy(false); }
  };
  return <>
    <div className={s.voiceDivider} />
    <div className={s.voiceSectionTitle}>{t('chatgpt.title')}</div>
    <div className={s.fieldGroup}>
      <span className={s.voiceHint}>{t('chatgpt.desktopHelp')}</span>
      <button type="button" className={s.cancelBtn} disabled={busy} onClick={() => void connect()}>{busy ? t('chatgpt.waiting') : t('chatgpt.signIn')}</button>
      {connections.map(connection => <div key={connection.id} className={s.voiceRow}>
        <span className={s.fieldLabel}>{connection.name}{connection.email !== connection.name ? ' · ' + connection.email : ''}</span>
        <button type="button" className={s.cancelBtn} disabled={busy} onClick={() => void connect(connection.id)}>{t('chatgpt.reconnect')}</button>
      </div>)}
    </div>
  </>;
}
