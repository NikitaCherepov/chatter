import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import type { ApiKey } from '../../../lib/types';
import { Select, type SelectOption } from '../../ui/Select/Select';
import styles from './DeleteKeyModal.module.css';

type Props = {
  keyToDelete: ApiKey;
  allKeys: ApiKey[];
  onConfirm: (replacementKeyId: number | null) => void;
  onCancel: () => void;
};

export function DeleteKeyModal({ keyToDelete, allKeys, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  const [usedByModels, setUsedByModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<'replace' | 'nullify'>('nullify');
  const [replacementId, setReplacementId] = useState('');

  useEffect(() => {
    api<{ models: string[] }>(`/api/api-keys/${keyToDelete.id}/used-by`)
      .then((data) => setUsedByModels(data.models || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [keyToDelete.id]);

  const replacementOptions: SelectOption[] = allKeys
    .filter((k) => k.id !== keyToDelete.id)
    .map((k) => ({ value: String(k.id), label: k.name, hint: k.key_prefix }));

  const handleConfirm = () => {
    if (usedByModels.length === 0) {
      onConfirm(null);
      return;
    }
    if (action === 'nullify') {
      onConfirm(null);
    } else {
      // Guard: require a replacement selection in "replace" mode
      if (!replacementId) return;
      onConfirm(Number(replacementId));
    }
  };

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.title}>{t('security.apiKeyDeleteTitle')}</h3>
        <p className={styles.description}>
          <strong>{keyToDelete.name}</strong> ({keyToDelete.key_prefix})
        </p>

        {loading ? (
          <p className={styles.loading}>…</p>
        ) : usedByModels.length > 0 ? (
          <>
            <p className={styles.label}>{t('security.apiKeyDeleteUsedBy')}</p>
            <ul className={styles.modelList}>
              {usedByModels.map((modelId) => (
                <li key={modelId}><code>{modelId}</code></li>
              ))}
            </ul>

            <p className={styles.label}>{t('security.apiKeyDeleteAction')}</p>
            <div className={styles.radioGroup}>
              <label className={styles.radio}>
                <input
                  type="radio"
                  name="deleteAction"
                  checked={action === 'nullify'}
                  onChange={() => setAction('nullify')}
                />
                <span>{t('security.apiKeyDeleteNullify')}</span>
              </label>
              <label className={styles.radio}>
                <input
                  type="radio"
                  name="deleteAction"
                  checked={action === 'replace'}
                  onChange={() => setAction('replace')}
                />
                <span>{t('security.apiKeyDeleteReplace')}</span>
              </label>
            </div>

            {action === 'replace' && replacementOptions.length > 0 && (
              <div className={styles.selectWrap}>
                <label className={styles.selectLabel}>{t('security.apiKeyDeleteSelectReplacement')}</label>
                <Select
                  options={replacementOptions}
                  value={replacementId}
                  onChange={setReplacementId}
                  placeholder={t('security.apiKeySelectPlaceholder')}
                  searchable
                />
              </div>
            )}
          </>
        ) : (
          <p className={styles.noModels}>{t('security.apiKeyNotUsed')}</p>
        )}

        <div className={styles.actions}>
          <button type="button" className="buttonSecondary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            onClick={handleConfirm}
            disabled={action === 'replace' && !replacementId}
          >
            {t('security.apiKeyDeleteConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
