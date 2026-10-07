'use client';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import type { ProviderModelConfig } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { Input } from '../../ui/Input/Input';
import { Select, type SelectOption } from '../../ui/Select/Select';
import styles from './ModelsPage.module.css';
export function ChatGptModelFields({ model, onChange, providerOptions, onProviderChange }: {
  model: ProviderModelConfig; onChange: (patch: Partial<ProviderModelConfig>) => void;
  providerOptions: SelectOption[]; onProviderChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<{ id: number; name: string; email: string; shared: boolean }[]>([]);
  const [models, setModels] = useState<{ slug: string; name: string }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { void api<{ connections: typeof connections }>('/api/chatgpt/connections').then(value => setConnections(value.connections)).catch(() => setError(t('chatgpt.failed'))); }, [t]);
  useEffect(() => {
    let active = true; setModels([]); setError('');
    if (model.chatGptConnectionId) void api<{ models: typeof models }>('/api/chatgpt/connections/' + model.chatGptConnectionId + '/models')
      .then(value => { if (active) setModels(value.models); }).catch(() => { if (active) setError(t('chatgpt.failed')); });
    return () => { active = false; };
  }, [model.chatGptConnectionId, t]);
  const connection = connections.find(value => value.id === model.chatGptConnectionId);
  return <div className={styles.fields}>
    <FormField label={t('models.providerFields.providerKind')}><Select value="chatgpt" onChange={onProviderChange} options={providerOptions} /></FormField>
    <FormField label={t('chatgpt.name')} hint={t('chatgpt.adminSteps')}>
      <Select value={model.chatGptConnectionId ? String(model.chatGptConnectionId) : ''} onChange={value => onChange({ chatGptConnectionId: Number(value), model: '' })}
        options={connections.map(value => ({ value: String(value.id), label: value.name, hint: value.email }))} />
    </FormField>
    <FormField label={t('chatgpt.model')}>
      <Select value={model.model} onChange={value => onChange({ model: value })} searchable
        options={models.map(value => ({ value: value.slug, label: value.name, hint: value.slug }))}
        valueFallbackLabel={model.model || undefined} />
    </FormField>
    {!connection?.shared && <p>{t('chatgpt.privateModels')}</p>}
    <p>{t('chatgpt.requestLimitations')}</p>
    <FormField label={t('models.providerFields.quotaId')}><Input value={model.uniqueId || ''} onChange={event => onChange({ uniqueId: event.target.value })} /></FormField>
    {error && <p role="alert">{error}</p>}
  </div>;
}
