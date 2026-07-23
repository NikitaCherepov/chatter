import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../ui/Card/Card';
import { FormField } from '../../ui/FormField/FormField';
import { api } from '../../../lib/api';
import type { ApiKey } from '../../../lib/types';
import grid from '../../ui/PageGrid/PageGrid.module.css';
import styles from './SecurityPage.module.css';

type Props = {
  username: string;
  currentPassword: string;
  newPassword: string;
  state: string;
  onUsernameChange: (value: string) => void;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
};

export function SecurityPage({
  username,
  currentPassword,
  newPassword,
  state,
  onUsernameChange,
  onCurrentPasswordChange,
  onNewPasswordChange,
  onSubmit,
}: Props) {
  const { t } = useTranslation();

  // API keys state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [keyState, setKeyState] = useState('');

  const loadKeys = () => {
    api<ApiKey[]>('/api/api-keys').then(setApiKeys).catch(() => {});
  };

  useEffect(() => {
    loadKeys();
  }, []);

  const handleCreate = async () => {
    if (!newKeyName.trim() || !newKeyValue.trim()) return;
    setKeyState(t('common.saving'));
    try {
      await api('/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName.trim(), key: newKeyValue.trim() }),
      });
      setNewKeyName('');
      setNewKeyValue('');
      setShowCreate(false);
      setKeyState(t('security.apiKeyCreated'));
      loadKeys();
    } catch {
      setKeyState(t('common.error'));
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api(`/api/api-keys/${id}`, { method: 'DELETE' });
      setKeyState(t('security.apiKeyDeleted'));
      loadKeys();
    } catch {
      setKeyState(t('common.error'));
    }
  };

  return (
    <div className={styles.stack}>
      <form className={styles.form} onSubmit={onSubmit}>
        <Card
          title={t('security.adminData')}
          description={t('security.reLoginHint')}
        >
          <div className={grid.fields}>
            <FormField label={t('security.usernameLabel')}>
              <input
                value={username}
                onChange={(event) => onUsernameChange(event.target.value)}
                required
              />
            </FormField>
            <FormField label={t('security.currentPassword')}>
              <input
                type="password"
                value={currentPassword}
                onChange={(event) => onCurrentPasswordChange(event.target.value)}
                autoComplete="current-password"
                required
              />
            </FormField>
            <FormField label={t('security.newPassword')} hint={t('security.passwordHint')}>
              <input
                type="password"
                value={newPassword}
                onChange={(event) => onNewPasswordChange(event.target.value)}
                minLength={12}
                autoComplete="new-password"
                required
              />
            </FormField>
            <div className={styles.actions}>
              <span>{state}</span>
              <button type="submit">{t('security.changeData')}</button>
            </div>
          </div>
        </Card>
      </form>

      <Card
        title={t('security.apiKeys')}
        description={t('security.apiKeysDescription')}
      >
        {showCreate ? (
          <div className={styles.createForm}>
            <FormField label={t('security.apiKeyName')}>
              <input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder={t('security.apiKeyNamePlaceholder')}
              />
            </FormField>
            <FormField label={t('security.apiKeyValue')}>
              <input
                type="password"
                value={newKeyValue}
                onChange={(e) => setNewKeyValue(e.target.value)}
                placeholder={t('security.apiKeyValuePlaceholder')}
              />
            </FormField>
            <div className={styles.createActions}>
              <button type="button" onClick={handleCreate}>{t('security.apiKeyCreate')}</button>
              <button type="button" className="buttonSecondary" onClick={() => { setShowCreate(false); setNewKeyName(''); setNewKeyValue(''); }}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.createActions}>
            <button type="button" className="buttonSecondary" onClick={() => setShowCreate(true)}>
              {t('security.apiKeyCreate')}
            </button>
          </div>
        )}

        {apiKeys.length > 0 && (
          <div className={styles.table}>
            <div className={styles.header}>
              <span>{t('security.apiKeyName')}</span>
              <span>{t('security.apiKeyValue')}</span>
              <span />
            </div>
            {apiKeys.map((key) => (
              <div key={key.id} className={styles.row}>
                <span><strong>{key.name}</strong></span>
                <span><code>{key.key_prefix}</code></span>
                <button type="button" className={styles.deleteBtn} onClick={() => handleDelete(key.id)}>
                  {t('security.apiKeyDelete')}
                </button>
              </div>
            ))}
          </div>
        )}
        {apiKeys.length === 0 && !showCreate && (
          <p className={styles.empty}>{t('security.apiKeyNoKeys')}</p>
        )}
        {keyState && <p className={styles.state}>{keyState}</p>}
      </Card>
    </div>
  );
}
