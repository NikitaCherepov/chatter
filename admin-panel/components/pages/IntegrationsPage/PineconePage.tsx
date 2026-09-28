'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiKey, PineconeSettings } from '../../../lib/types';
import { api } from '../../../lib/api';
import { FormField } from '../../ui/FormField/FormField';
import { Input } from '../../ui/Input/Input';
import { Select, type SelectOption } from '../../ui/Select/Select';
import { ConfirmModal } from '../../ui/ConfirmModal/ConfirmModal';
import { OpenRouterModelInput } from '../../ui/ModelInput/OpenRouterModelInput';
import { SecretState } from '../../ui/SecretState/SecretState';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import styles from './IntegrationsPage.module.css';

type RuntimeSettings = {
  storage: 'qdrant';
  provider: 'openrouter' | 'custom';
  baseUrl: string;
  model: string;
  apiKeyId: number | null;
  activeCollection: string;
  hasApiKey: boolean;
};

type Collection = {
  collectionName: string;
  provider: 'openrouter' | 'custom';
  baseUrl: string;
  model: string;
  apiKeyId: number | null;
  dimension: number | null;
  pointCount: number;
  status: 'active' | 'backup' | 'migrating' | 'failed';
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

type PendingAction =
  | { type: 'migrate' }
  | { type: 'activate'; collection: Collection }
  | { type: 'delete'; collection: Collection };

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

export function PineconePage({ onBack }: {
  settings: PineconeSettings;
  onChange: (patch: Partial<PineconeSettings>) => void;
  saving: boolean;
  saveState: string;
  onBack: () => void;
  onSave: (event: FormEvent) => void;
}) {
  const { t } = useTranslation();
  const [runtime, setRuntime] = useState<RuntimeSettings | null>(null);
  const [draft, setDraft] = useState<RuntimeSettings | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [showCreateKey, setShowCreateKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');

  const load = useCallback(async () => {
    const [nextRuntime, nextCollections, nextKeys] = await Promise.all([
      api<RuntimeSettings>('/api/vector-memory/settings'),
      api<Collection[]>('/api/vector-memory/collections'),
      api<ApiKey[]>('/api/api-keys'),
    ]);
    setRuntime(nextRuntime);
    setDraft(nextRuntime);
    setCollections(nextCollections);
    setApiKeys(nextKeys);
  }, []);

  useEffect(() => {
    void load().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [load]);

  const keyOptions: SelectOption[] = useMemo(() => [
    ...apiKeys.map(key => ({ value: `key:${key.id}`, label: key.name, hint: key.key_prefix })),
    { value: '__create__', label: t('security.apiKeyCreateNew') },
  ], [apiKeys, t]);

  const changed = Boolean(runtime && draft && (
    runtime.provider !== draft.provider
    || runtime.baseUrl !== draft.baseUrl
    || runtime.model !== draft.model
    || runtime.apiKeyId !== draft.apiKeyId
  ));

  const createKey = async () => {
    if (!newKeyName.trim() || !newKeyValue.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await api<ApiKey>('/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName.trim(), key: newKeyValue.trim() }),
      });
      setApiKeys(current => [...current.filter(key => key.id !== created.id), created]);
      setDraft(current => current ? { ...current, apiKeyId: created.id, hasApiKey: true } : current);
      setNewKeyName('');
      setNewKeyValue('');
      setShowCreateKey(false);
      window.dispatchEvent(new Event('chatter:api-keys-changed'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const runPendingAction = async () => {
    if (!pending || !draft) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (pending.type === 'migrate') {
        const result = await api<{ pointCount: number }>('/api/vector-memory/migrate-embedding', {
          method: 'POST',
          body: JSON.stringify({
            provider: draft.provider,
            baseUrl: draft.baseUrl,
            model: draft.model,
            apiKeyId: draft.apiKeyId,
          }),
        });
        setMessage(t('integrations.pinecone.embedding.migrationComplete', { count: result.pointCount }));
      } else if (pending.type === 'activate') {
        await api(`/api/vector-memory/collections/${encodeURIComponent(pending.collection.collectionName)}/activate`, { method: 'POST' });
        setMessage(t('integrations.pinecone.collections.rollbackComplete'));
      } else {
        await api(`/api/vector-memory/collections/${encodeURIComponent(pending.collection.collectionName)}`, { method: 'DELETE' });
        setMessage(t('integrations.pinecone.collections.deleteComplete'));
      }
      setPending(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!draft) {
    return (
      <IntegrationDetailPage
        title={t('integrations.items.pinecone.name')}
        description={t('integrations.pinecone.pageDescription')}
        saving={false}
        saveState=""
        onBack={onBack}
        onSave={event => event.preventDefault()}
        showSave={false}
      >
        <section className={styles.fieldSection}>
          <div className={styles.sectionTitle}><h3>{t('integrations.pinecone.embedding.sectionTitle')}</h3></div>
          <div className={styles.fields}>{error && <span className={styles.checkError}>{error}</span>}</div>
        </section>
      </IntegrationDetailPage>
    );
  }

  return (
    <IntegrationDetailPage
      title={t('integrations.items.pinecone.name')}
      description={t('integrations.pinecone.pageDescription')}
      saving={busy}
      saveState=""
      onBack={onBack}
      onSave={event => event.preventDefault()}
      showSave={false}
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>{t('integrations.pinecone.embedding.sectionTitle')}</h3>
          <p>{t('integrations.pinecone.embedding.sectionIntro')}</p>
        </div>
        <div className={styles.fields}>
          <FormField label={t('integrations.pinecone.embedding.providerLabel')}>
            <Select
              value={draft.provider}
              onChange={value => setDraft({
                ...draft,
                provider: value as RuntimeSettings['provider'],
                ...(value === 'openrouter' ? { baseUrl: OPENROUTER_URL } : {}),
              })}
              options={[
                { value: 'openrouter', label: 'OpenRouter' },
                { value: 'custom', label: t('models.billing.customProvider') },
              ]}
            />
          </FormField>
          <FormField label={t('integrations.pinecone.embedding.apiUrlLabel')}>
            <Input
              type="url"
              value={draft.baseUrl}
              readOnly={draft.provider === 'openrouter'}
              onChange={event => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </FormField>
          <FormField label={t('integrations.pinecone.embedding.modelLabel')}>
            {draft.provider === 'openrouter' ? (
              <OpenRouterModelInput
                value={draft.model}
                catalog="embeddings"
                onSelect={model => setDraft({ ...draft, model })}
              />
            ) : (
              <Input value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} />
            )}
          </FormField>
          {showCreateKey ? (
            <div className={styles.createKeyPanel}>
              <FormField label={t('security.apiKeyName')}>
                <Input value={newKeyName} onChange={event => setNewKeyName(event.target.value)} autoFocus />
              </FormField>
              <FormField label={t('security.apiKeyValue')}>
                <Input type="password" value={newKeyValue} onChange={event => setNewKeyValue(event.target.value)} />
              </FormField>
              <div className={styles.createKeyActions}>
                <button type="button" disabled={busy || !newKeyName.trim() || !newKeyValue.trim()} onClick={() => void createKey()}>
                  {t('security.apiKeyCreate')}
                </button>
                <button type="button" className="buttonSecondary" disabled={busy} onClick={() => setShowCreateKey(false)}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <FormField label={t('security.apiKeySelect')} state={<SecretState configured={Boolean(draft.apiKeyId)} />}>
              <Select
                value={draft.apiKeyId ? `key:${draft.apiKeyId}` : ''}
                options={keyOptions}
                onChange={value => {
                  if (value === '__create__') setShowCreateKey(true);
                  else setDraft({ ...draft, apiKeyId: value.startsWith('key:') ? Number(value.slice(4)) : null });
                }}
                placeholder={t('security.apiKeySelectPlaceholder')}
              />
            </FormField>
          )}
          <button
            type="button"
            className={styles.checkButton}
            disabled={busy || !changed || !draft.baseUrl.trim() || !draft.model.trim() || !draft.apiKeyId}
            onClick={() => setPending({ type: 'migrate' })}
          >
            {t('integrations.pinecone.embedding.migrateAction')}
          </button>
          {message && <span className={styles.checkSuccess}>{message}</span>}
          {error && <span className={styles.checkError}>{error}</span>}
        </div>
      </section>

      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>{t('integrations.pinecone.collections.title')}</h3>
          <p>{t('integrations.pinecone.collections.intro')}</p>
        </div>
        <div className={styles.collectionList}>
          {collections.map(collection => (
            <article className={styles.collectionCard} key={collection.collectionName}>
              <div className={styles.collectionHeader}>
                <strong>{collection.model}</strong>
                <span className={`${styles.collectionStatus} ${styles[`collectionStatus_${collection.status}`]}`}>
                  {t(`integrations.pinecone.collections.status.${collection.status}`)}
                </span>
              </div>
              <span>{collection.provider} · {collection.dimension || '—'}D · {t('integrations.pinecone.collections.vectorCount', { count: collection.pointCount })}</span>
              <small>{new Date(collection.createdAt).toLocaleString()}</small>
              {collection.error && <span className={styles.checkError}>{collection.error}</span>}
              {collection.status === 'backup' && (
                <div className={styles.collectionActions}>
                  <button type="button" className="buttonSecondary" disabled={busy} onClick={() => setPending({ type: 'activate', collection })}>
                    {t('integrations.pinecone.collections.rollbackAction')}
                  </button>
                  <button type="button" className="buttonDanger" disabled={busy} onClick={() => setPending({ type: 'delete', collection })}>
                    {t('common.delete')}
                  </button>
                </div>
              )}
              {collection.status === 'failed' && (
                <div className={styles.collectionActions}>
                  <button type="button" className="buttonDanger" disabled={busy} onClick={() => setPending({ type: 'delete', collection })}>
                    {t('common.delete')}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      {pending && (
        <ConfirmModal
          title={t(`integrations.pinecone.confirm.${pending.type}Title`)}
          onClose={() => { if (!busy) setPending(null); }}
          actions={[
            {
              label: busy ? t('integrations.pinecone.embedding.migrating') : t(`integrations.pinecone.confirm.${pending.type}Action`),
              onClick: runPendingAction,
              variant: pending.type === 'delete' ? 'danger' : 'primary',
              disabled: busy,
            },
            { label: t('common.cancel'), onClick: () => setPending(null), disabled: busy },
          ]}
        >
          <p>{t(`integrations.pinecone.confirm.${pending.type}Text`)}</p>
        </ConfirmModal>
      )}
    </IntegrationDetailPage>
  );
}
