'use client';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import type { ProviderModelConfig } from '../../../lib/types';
import { Select } from '../../ui/Select/Select';
import { FormField } from '../../ui/FormField/FormField';
type User = { id: number; name: string | null; role: string; is_admin: boolean };
export function ModelAccessFields({ model, onChange }: { model: ProviderModelConfig; onChange: (patch: Partial<ProviderModelConfig>) => void }) {
  const { t } = useTranslation();
  const mode = model.accessMode || (model.adminOnly ? 'admins' : 'all');
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (mode !== 'selected') return;
    let active = true; setError(false);
    void api<{ users: User[] }>('/api/model-access-users').then(value => { if (active) setUsers(value.users); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [mode]);
  return <>
    <FormField label={t('models.access.label')}>
      <Select value={mode} options={['all', 'admins', 'selected'].map(value => ({ value, label: t('models.access.' + value) }))}
        onChange={value => onChange({ accessMode: value as ProviderModelConfig['accessMode'], adminOnly: value === 'admins' })} />
    </FormField>
    {mode === 'selected' && <FormField label={t('models.access.users')} hint={t('models.access.hint')}>
      <Select value="" onChange={() => {}} options={users.map(user => ({ value: String(user.id), label: user.name || '#' + user.id,
        hint: '#' + user.id + (user.is_admin || user.role === 'admin' ? ' · ' + t('models.access.admin') : '') }))}
        selectedValues={(model.allowedUserIds || []).map(String)} onSelectionChange={values => onChange({ allowedUserIds: values.map(Number) })}
        searchable placeholder={t('models.access.choose')} searchPlaceholder={t('models.access.search')} emptyText={t(error ? 'models.access.failed' : 'models.access.empty')} />
    </FormField>}
  </>;
}
