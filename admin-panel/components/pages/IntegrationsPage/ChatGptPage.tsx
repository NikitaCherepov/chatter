'use client';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import { FormField } from '../../ui/FormField/FormField';
import { Input } from '../../ui/Input/Input';
import { Select } from '../../ui/Select/Select';
import { ConfirmModal } from '../../ui/ConfirmModal/ConfirmModal';
import { Checkbox } from '../../ui/Checkbox/Checkbox';
import styles from './IntegrationsPage.module.css';
type Connection = { id: number; name: string; email: string; planUsageEnabled: boolean; shared: boolean };
type Model = { slug: string; name: string };
export function ChatGptPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [models, setModels] = useState<Record<number, Model[]>>({});
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [disconnect, setDisconnect] = useState<number | null>(null);
  const [testResult, setTestResult] = useState('');
  const load = useCallback(async () => { const value = await api<{ connections: Connection[] }>('/api/chatgpt/connections'); setConnections(value.connections); }, []);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); } catch (error: any) { setError(t('chatgpt.failed') + ' ' + (String(error?.message || '').match(/chatgpt_[a-z_]+/)?.[0] || '')); }
    finally { setBusy(false); }
  };
  useEffect(() => { void run(load); }, [load]);
  return <IntegrationDetailPage title={t('chatgpt.title')} description={t('chatgpt.adminHelp')} saving={false} saveState="" onBack={onBack} onSave={event => event.preventDefault()} showSave={false}>
    <section className={styles.fieldSection}>
      <div className={styles.sectionTitle}><h3>{t('chatgpt.firstSignIn')}</h3><p>{t('chatgpt.adminSteps')}</p></div>
      <div className={styles.fields}>
        <button type="button" className={styles.checkButton} disabled={busy} onClick={() => void run(load)}>{t('chatgpt.refresh')}</button>
        {error && <span className={styles.checkError} role="alert">{error}</span>}
        {!connections.length && !busy && <p>{t('chatgpt.empty')}</p>}
      </div>
    </section>
    {connections.map(connection => <section className={styles.fieldSection} key={connection.id}>
      <div className={styles.sectionTitle}><h3>{connection.email || connection.name}</h3><p>{t(connection.planUsageEnabled ? 'chatgpt.planEnabled' : 'chatgpt.planDisabled')}</p></div>
      <div className={styles.fields}>
        <FormField label={t('chatgpt.name')}><Input value={connection.name} disabled={busy} onChange={event => setConnections(values => values.map(value => value.id === connection.id ? { ...value, name: event.target.value } : value))} /></FormField>
        <FormField label={t('chatgpt.access')} hint={t('chatgpt.sharedHelp')}>
          <Checkbox checked={connection.shared} disabled={busy} label={t('chatgpt.sharedLabel')} onChange={shared => void run(async () => { await api('/api/chatgpt/connections/' + connection.id, { method: 'PATCH', body: JSON.stringify({ name: connection.name, shared }) }); await load(); })} />
        </FormField>
        <button type="button" className={styles.checkButton} disabled={busy || !connection.name.trim()} onClick={() => void run(async () => { await api('/api/chatgpt/connections/' + connection.id, { method: 'PATCH', body: JSON.stringify({ name: connection.name }) }); await load(); })}>{t('chatgpt.saveName')}</button>
        <button type="button" className={styles.checkButton} disabled={busy} onClick={() => void run(async () => { const value = await api<{ models: Model[] }>('/api/chatgpt/connections/' + connection.id + '/models'); setModels(values => ({ ...values, [connection.id]: value.models })); })}>{t('chatgpt.loadModels')}</button>
        {models[connection.id] && <FormField label={t('chatgpt.model')}><Select value={selected[connection.id] || ''} onChange={value => setSelected(values => ({ ...values, [connection.id]: value }))} options={models[connection.id].map(model => ({ value: model.slug, label: model.name, hint: model.slug }))} searchable /></FormField>}
        {selected[connection.id] && <>
          <p>{t('chatgpt.testHelp')}</p>
          <button type="button" className={styles.checkButton} disabled={busy} onClick={() => void run(async () => { const value = await api<{ text: string }>('/api/chatgpt/connections/' + connection.id + '/test', { method: 'POST', body: JSON.stringify({ model: selected[connection.id] }) }); setTestResult(value.text); })}>{t('chatgpt.test')}</button>
        </>}
        <button type="button" className={styles.checkButton} disabled={busy} onClick={() => setDisconnect(connection.id)}>{t('chatgpt.disconnect')}</button>
      </div>
    </section>)}
    {testResult && <section className={styles.fieldSection}><div className={styles.fields}>{testResult}</div></section>}
    {disconnect !== null && <ConfirmModal title={t('chatgpt.disconnect')} onClose={() => { if (!busy) setDisconnect(null); }} actions={[
      { label: t('common.cancel'), disabled: busy, onClick: () => setDisconnect(null) },
      { label: t('chatgpt.disconnect'), variant: 'danger', disabled: busy, onClick: () => run(async () => { await api('/api/chatgpt/connections/' + disconnect, { method: 'DELETE' }); setDisconnect(null); await load(); }) },
    ]}>{t('chatgpt.disconnectHelp')}</ConfirmModal>}
  </IntegrationDetailPage>;
}
