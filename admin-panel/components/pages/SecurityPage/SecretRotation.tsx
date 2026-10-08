import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import { Card } from '../../ui/Card/Card';
import { FormField } from '../../ui/FormField/FormField';
import { ConfirmModal } from '../../ui/ConfirmModal/ConfirmModal';
import styles from './SecurityPage.module.css';

type Kind = 'jwt' | 'internal' | 'encryption';
type State = { status: string; kind?: Kind; phase?: string; backup?: string; fields?: number; error?: string; reason?: string };
const queryKey = ['secret-rotation'];
const kinds: Kind[] = ['jwt', 'internal', 'encryption'];
const names = { jwt: 'API_JWT_SECRET', internal: 'BACKEND_INTERNAL_TOKEN', encryption: 'ENCRYPTION_KEY' };

export function SecretRotation() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [selected, setSelected] = useState<Kind | 'recover' | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const query = useQuery({ queryKey, queryFn: () => api<State>('/api/security/rotation'), refetchInterval: 3000, retry: false });
  const state = query.data;
  const manualRecovery = state?.error === 'secret_rotation_journal_unreadable' || state?.error === 'secret_rotation_journal_missing';
  const blocked = !state || ['queued', 'running', 'recovery_required'].includes(state.status);
  const mutation = useMutation({
    mutationFn: () => api<State>('/api/security/rotation' + (selected === 'recover' ? '/recover' : ''), {
      method: 'POST', body: JSON.stringify({ kind: selected, currentPassword: password, confirm: true }),
    }),
    onSuccess: result => {
      if (result.status) client.setQueryData(queryKey, result);
      void client.invalidateQueries({ queryKey });
      setSelected(null); setPassword(''); setError('');
    },
    onError: failure => setError(failure instanceof Error && failure.message === 'current_password_invalid'
      ? t('security.rotation.passwordInvalid') : t('security.rotation.requestFailed')),
  });
  const close = () => { if (!mutation.isPending) { setSelected(null); setPassword(''); setError(''); } };
  return (
    <Card title={t('security.rotation.title')} description={t('security.rotation.description')}>
      <div className={styles.rotationRows}>
        {kinds.map(kind => (
          <div className={styles.rotationRow} key={kind}>
            <div>
              <strong>{t(`security.rotation.${kind}.title`)}</strong>
              <p><code>{names[kind]}</code> · {t(`security.rotation.${kind}.description`)}</p>
            </div>
            <button type="button" className="buttonSecondary" disabled={blocked || mutation.isPending || query.isError}
              onClick={() => { setSelected(kind); setError(''); }}>
              {t('security.rotation.change')}
            </button>
          </div>
        ))}
      </div>
      <p className={styles.state} role="status">
        {query.isError ? t('security.rotation.statusUnavailable') : state && state.status !== 'idle' ? t(`security.rotation.status.${state.status}`) : ''}
        {state?.phase && ['queued', 'running'].includes(state.status) ? ` · ${t(`security.rotation.phase.${state.phase}`, { defaultValue: state.phase })}` : ''}
        {state?.status === 'complete' && state.fields !== undefined ? ` · ${t('security.rotation.fieldCount', { count: state.fields })}` : ''}
      </p>
      {state?.status === 'failed' && <p className={styles.state}>{t(state.error === 'rotation_failed_rolled_back' ? 'security.rotation.rolledBack' : 'security.rotation.preflightFailed')}</p>}
      {state?.reason && ['failed', 'recovery_required'].includes(state.status) && <p className={styles.state}>
        {t(`security.rotation.reason.${state.reason}`, { defaultValue: t('security.rotation.reason.operation_failed') })}
      </p>}
      {state?.status === 'recovery_required' && <div className={styles.createActions}>
        <p className={styles.state}>{t(manualRecovery ? 'security.rotation.manualRecoveryHint' : 'security.rotation.recoveryHint')}</p>
        {!manualRecovery && <button type="button" className="buttonSecondary" onClick={() => { setSelected('recover'); setError(''); }}>{t('security.rotation.recover')}</button>}
      </div>}
      {state?.backup && <p className={styles.state}>
        {t('security.rotation.backup')}:{' '}
        {!blocked ? <a href={`/api/backups/${encodeURIComponent(state.backup)}/download`}>{state.backup}</a> : state.backup}
        <br />{t('security.rotation.backupWarning')}
      </p>}
      {selected && <ConfirmModal title={t(selected === 'recover' ? 'security.rotation.recover' : `security.rotation.${selected}.title`)} onClose={close}
        actions={[
          { label: t('common.cancel'), onClick: close, disabled: mutation.isPending },
          { label: t(selected === 'recover' ? 'security.rotation.recover' : 'security.rotation.change'), onClick: () => mutation.mutate(), disabled: !password || mutation.isPending, variant: 'danger' },
        ]}>
        <p>{t(selected === 'recover' ? 'security.rotation.recoveryHint' : `security.rotation.${selected}.confirm`)}</p>
        <p>{t('security.rotation.downtime')}</p>
        <FormField label={t('security.currentPassword')}>
          <input type="password" autoComplete="current-password" autoFocus value={password} disabled={mutation.isPending}
            onChange={event => setPassword(event.target.value)} />
        </FormField>
        {error && <p role="alert">{error}</p>}
      </ConfirmModal>}
    </Card>
  );
}
