'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiKey, PineconeSettings } from '../../../lib/types';
import { api } from '../../../lib/api';
import { FormField } from '../../ui/FormField/FormField';
import { Input } from '../../ui/Input/Input';
import { Checkbox } from '../../ui/Checkbox/Checkbox';
import { Select, type SelectOption } from '../../ui/Select/Select';
import { ConfirmModal } from '../../ui/ConfirmModal/ConfirmModal';
import { OpenRouterModelInput } from '../../ui/ModelInput/OpenRouterModelInput';
import { fetchModelEndpoints, type ModelEndpointsResult } from '../ModelsPage/ModelListEditor';
import { SecretState } from '../../ui/SecretState/SecretState';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import styles from './IntegrationsPage.module.css';

type RuntimeSettings = {
  storage: 'qdrant';
  provider: 'openrouter' | 'custom';
  baseUrl: string;
  model: string;
  openrouterProviderSlug: string | null;
  inputPricePerMillion: number | null;
  apiKeyId: number | null;
  activeCollection: string;
  hasApiKey: boolean;
  reranking: {
    enabled: boolean;
    provider: 'openrouter' | 'custom';
    baseUrl: string;
    model: string;
    openrouterProviderSlug: string | null;
    pricePerSearch: number | null;
    apiKeyId: number | null;
    minScore: number;
    resultLimit: number;
    hasApiKey: boolean;
  };
};

type Collection = {
  collectionName: string;
  provider: 'openrouter' | 'custom';
  baseUrl: string;
  model: string;
  openrouterProviderSlug: string | null;
  inputPricePerMillion: number | null;
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
  const [savingSettings, setSavingSettings] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [createKeyTarget, setCreateKeyTarget] = useState<'embedding' | 'reranking' | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');
  const [openrouterProviderOptions, setOpenrouterProviderOptions] = useState<SelectOption[]>([]);
  const [rankingProviderOptions, setRankingProviderOptions] = useState<SelectOption[]>([]);
  const endpointsRef = useRef<ModelEndpointsResult | null>(null);
  const rankingEndpointsRef = useRef<ModelEndpointsResult | null>(null);

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

  const modelChanged = Boolean(runtime && draft && runtime.model !== draft.model);
  const settingsChanged = Boolean(runtime && draft && (
    runtime.provider !== draft.provider
    || runtime.baseUrl !== draft.baseUrl
    || runtime.openrouterProviderSlug !== draft.openrouterProviderSlug
    || runtime.inputPricePerMillion !== draft.inputPricePerMillion
    || runtime.apiKeyId !== draft.apiKeyId
    || JSON.stringify(runtime.reranking) !== JSON.stringify(draft.reranking)
  ));

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || modelChanged || !settingsChanged) return;
    setBusy(true);
    setSavingSettings(true);
    setError('');
    setMessage('');
    try {
      await api<RuntimeSettings>('/api/vector-memory/settings', {
        method: 'PUT',
        body: JSON.stringify({
          provider: draft.provider,
          baseUrl: draft.baseUrl,
          openrouterProviderSlug: draft.openrouterProviderSlug,
          inputPricePerMillion: draft.inputPricePerMillion,
          apiKeyId: draft.apiKeyId,
          reranking: draft.reranking,
        }),
      });
      setMessage(t('integrations.pinecone.embedding.settingsSaved'));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSavingSettings(false);
      setBusy(false);
    }
  };

  const createKey = async () => {
    if (!createKeyTarget || !newKeyName.trim() || !newKeyValue.trim()) return;
    setBusy(true);
    setError('');
    try {
      const created = await api<ApiKey>('/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName.trim(), key: newKeyValue.trim() }),
      });
      setApiKeys(current => [...current.filter(key => key.id !== created.id), created]);
      setDraft(current => {
        if (!current) return current;
        return createKeyTarget === 'embedding'
          ? { ...current, apiKeyId: created.id, hasApiKey: true }
          : { ...current, reranking: { ...current.reranking, apiKeyId: created.id, hasApiKey: true } };
      });
      setNewKeyName('');
      setNewKeyValue('');
      setCreateKeyTarget(null);
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
            openrouterProviderSlug: draft.openrouterProviderSlug,
            inputPricePerMillion: draft.inputPricePerMillion,
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

  useEffect(() => {
    if (draft?.provider !== 'openrouter' || !draft.model.includes('/') || !draft.apiKeyId) {
      endpointsRef.current = null;
      setOpenrouterProviderOptions([]);
      return;
    }
    let cancelled = false;
    void fetchModelEndpoints(draft.model, draft.apiKeyId).then(result => {
      if (!result || cancelled) return;
      endpointsRef.current = result;
      setOpenrouterProviderOptions([
        { value: '', label: t('models.billing.autoRouting'), hint: 'auto-routing' },
        ...result.options,
      ]);
    }).catch(() => {
      if (!cancelled) setOpenrouterProviderOptions([]);
    });
    return () => { cancelled = true; };
  }, [draft?.apiKeyId, draft?.model, draft?.provider, t]);

  useEffect(() => {
    const ranking = draft?.reranking;
    if (!ranking || ranking.provider !== 'openrouter' || !ranking.model.includes('/') || !ranking.apiKeyId) {
      rankingEndpointsRef.current = null;
      setRankingProviderOptions([]);
      return;
    }
    let cancelled = false;
    void fetchModelEndpoints(ranking.model, ranking.apiKeyId).then(result => {
      if (!result || cancelled) return;
      rankingEndpointsRef.current = result;
      setRankingProviderOptions([
        { value: '', label: t('models.billing.autoRouting'), hint: 'auto-routing' },
        ...result.options,
      ]);
    }).catch(() => {
      if (!cancelled) setRankingProviderOptions([]);
    });
    return () => { cancelled = true; };
  }, [draft?.reranking.apiKeyId, draft?.reranking.model, draft?.reranking.provider, t]);

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

  const renderApiKeySelector = (target: 'embedding' | 'reranking', apiKeyId: number | null) => {
    if (createKeyTarget === target) {
      return (
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
            <button type="button" className="buttonSecondary" disabled={busy} onClick={() => setCreateKeyTarget(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      );
    }
    return (
      <FormField label={t('security.apiKeySelect')} state={<SecretState configured={Boolean(apiKeyId)} />}>
        <Select
          value={apiKeyId ? `key:${apiKeyId}` : ''}
          options={keyOptions}
          onChange={value => {
            if (value === '__create__') {
              setNewKeyName('');
              setNewKeyValue('');
              setCreateKeyTarget(target);
              return;
            }
            const nextId = value.startsWith('key:') ? Number(value.slice(4)) : null;
            setDraft(current => {
              if (!current) return current;
              return target === 'embedding'
                ? { ...current, apiKeyId: nextId }
                : { ...current, reranking: { ...current.reranking, apiKeyId: nextId } };
            });
          }}
          placeholder={t('security.apiKeySelectPlaceholder')}
        />
      </FormField>
    );
  };

  return (
    <IntegrationDetailPage
      title={t('integrations.items.pinecone.name')}
      description={t('integrations.pinecone.pageDescription')}
      saving={savingSettings}
      saveState={error ? `${t('common.error')}: ${error}` : message}
      onBack={onBack}
      onSave={saveSettings}
      saveActionLabel={t('common.save')}
      saveSavingLabel={t('common.savingChanges')}
      saveDisabled={busy || modelChanged || !settingsChanged || !draft.baseUrl.trim() || !draft.model.trim() || !draft.apiKeyId
        || (draft.reranking.enabled && (!draft.reranking.baseUrl.trim() || !draft.reranking.model.trim() || !draft.reranking.apiKeyId))}
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
                ...(value === 'custom'
                  ? { openrouterProviderSlug: null, inputPricePerMillion: null }
                  : {}),
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
          {renderApiKeySelector('embedding', draft.apiKeyId)}
          <FormField label={t('integrations.pinecone.embedding.modelLabel')}>
            {draft.provider === 'openrouter' ? (
              <OpenRouterModelInput
                value={draft.model}
                catalog="embeddings"
                apiKeyId={draft.apiKeyId}
                onSelect={(model, catalogPrices) => {
                  setDraft({
                    ...draft,
                    model,
                    openrouterProviderSlug: null,
                    inputPricePerMillion: catalogPrices?.inputPricePerMillion ?? null,
                  });
                }}
              />
            ) : (
              <Input value={draft.model} onChange={event => setDraft({ ...draft, model: event.target.value })} />
            )}
          </FormField>
          {draft.provider === 'openrouter' && (
            <FormField
              label={t('models.billing.openrouterProvider')}
              hint={t('models.billing.openrouterProviderHint')}
            >
              <Select
                value={draft.openrouterProviderSlug || ''}
                options={openrouterProviderOptions}
                onChange={slug => {
                  const price = slug
                    ? endpointsRef.current?.pricesBySlug.get(slug)?.inputPricePerMillion ?? null
                    : endpointsRef.current?.basePrices?.inputPricePerMillion ?? null;
                  setDraft({
                    ...draft,
                    openrouterProviderSlug: slug || null,
                    inputPricePerMillion: price,
                  });
                }}
                searchable
                placeholder={t('models.billing.autoRouting')}
                valueFallbackLabel={draft.openrouterProviderSlug || undefined}
              />
            </FormField>
          )}
          <FormField label={t('integrations.pinecone.embedding.priceLabel')}>
            <Input
              type="number"
              min="0"
              step="any"
              value={draft.inputPricePerMillion ?? ''}
              readOnly={draft.provider === 'openrouter'}
              onChange={event => {
                if (draft.provider !== 'custom') return;
                const value = event.target.value;
                setDraft({
                  ...draft,
                  inputPricePerMillion: value === '' ? null : Number(value),
                });
              }}
              placeholder="—"
            />
          </FormField>
          {modelChanged && (
            <button
              type="button"
              className={styles.checkButton}
              disabled={busy || !draft.baseUrl.trim() || !draft.model.trim() || !draft.apiKeyId}
              onClick={() => setPending({ type: 'migrate' })}
            >
              {t('integrations.pinecone.embedding.migrateAction')}
            </button>
          )}
        </div>
      </section>

      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>{t('integrations.pinecone.retrieval.sectionTitle')}</h3>
          <p>{t('integrations.pinecone.retrieval.sectionIntro')}</p>
        </div>
        <div className={styles.fields}>
          <FormField label={t('integrations.pinecone.retrieval.limitLabel')} hint={t('integrations.pinecone.retrieval.limitHint')}>
            <Input type="number" min="1" max="20" step="1" value={draft.reranking.resultLimit}
              onChange={event => setDraft({ ...draft, reranking: { ...draft.reranking, resultLimit: Number(event.target.value) } })} />
          </FormField>
        </div>
      </section>

      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>{t('integrations.pinecone.reranking.sectionTitle')}</h3>
          <p>{t('integrations.pinecone.reranking.sectionIntro')}</p>
        </div>
        <div className={styles.fields}>
          <Checkbox
            checked={draft.reranking.enabled}
            onChange={enabled => setDraft({ ...draft, reranking: { ...draft.reranking, enabled } })}
            label={t('integrations.pinecone.reranking.enabledLabel')}
          />
          {draft.reranking.enabled && (
            <>
              <FormField label={t('integrations.pinecone.embedding.providerLabel')}>
                <Select
                  value={draft.reranking.provider}
                  onChange={value => setDraft({
                    ...draft,
                    reranking: {
                      ...draft.reranking,
                      provider: value as RuntimeSettings['reranking']['provider'],
                      ...(value === 'openrouter' ? { baseUrl: OPENROUTER_URL } : {}),
                      ...(value === 'custom' ? { openrouterProviderSlug: null, pricePerSearch: null } : {}),
                    },
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
                  value={draft.reranking.baseUrl}
                  readOnly={draft.reranking.provider === 'openrouter'}
                  onChange={event => setDraft({ ...draft, reranking: { ...draft.reranking, baseUrl: event.target.value } })}
                />
              </FormField>
              {renderApiKeySelector('reranking', draft.reranking.apiKeyId)}
              <FormField label={t('integrations.pinecone.embedding.modelLabel')}>
                {draft.reranking.provider === 'openrouter' ? (
                  <OpenRouterModelInput
                    value={draft.reranking.model}
                    catalog="rerank"
                    apiKeyId={draft.reranking.apiKeyId}
                    onSelect={(model, catalogPrices) => setDraft({
                      ...draft,
                      reranking: {
                        ...draft.reranking,
                        model,
                        openrouterProviderSlug: null,
                        pricePerSearch: catalogPrices?.requestPrice ?? null,
                      },
                    })}
                  />
                ) : (
                  <Input
                    value={draft.reranking.model}
                    onChange={event => setDraft({ ...draft, reranking: { ...draft.reranking, model: event.target.value } })}
                  />
                )}
              </FormField>
              {draft.reranking.provider === 'openrouter' && (
                <FormField label={t('models.billing.openrouterProvider')} hint={t('models.billing.openrouterProviderHint')}>
                  <Select
                    value={draft.reranking.openrouterProviderSlug || ''}
                    options={rankingProviderOptions}
                    onChange={slug => {
                      const price = slug
                        ? rankingEndpointsRef.current?.pricesBySlug.get(slug)?.requestPrice ?? null
                        : rankingEndpointsRef.current?.basePrices?.requestPrice ?? null;
                      setDraft({
                        ...draft,
                        reranking: {
                          ...draft.reranking,
                          openrouterProviderSlug: slug || null,
                          pricePerSearch: price,
                        },
                      });
                    }}
                    searchable
                    placeholder={t('models.billing.autoRouting')}
                    valueFallbackLabel={draft.reranking.openrouterProviderSlug || undefined}
                  />
                </FormField>
              )}
              <FormField label={t('integrations.pinecone.reranking.priceLabel')}>
                <Input
                  type="number"
                  min="0"
                  step="any"
                  value={draft.reranking.pricePerSearch ?? ''}
                  readOnly={draft.reranking.provider === 'openrouter'}
                  onChange={event => {
                    if (draft.reranking.provider !== 'custom') return;
                    const value = event.target.value;
                    setDraft({
                      ...draft,
                      reranking: {
                        ...draft.reranking,
                        pricePerSearch: value === '' ? null : Number(value),
                      },
                    });
                  }}
                  placeholder="—"
                />
              </FormField>
              <div className={styles.twoColumns}>
                <FormField label={t('integrations.pinecone.reranking.thresholdLabel')}>
                  <Input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={draft.reranking.minScore}
                    onChange={event => setDraft({
                      ...draft,
                      reranking: { ...draft.reranking, minScore: Number(event.target.value) },
                    })}
                  />
                </FormField>
              </div>
            </>
          )}
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
              <span>
                {collection.provider}
                {collection.openrouterProviderSlug ? ` / ${collection.openrouterProviderSlug}` : ''}
                {' · '}{collection.dimension || '—'}D
                {' · '}{t('integrations.pinecone.collections.vectorCount', { count: collection.pointCount })}
                {collection.inputPricePerMillion !== null ? ` · $${collection.inputPricePerMillion}/1M` : ''}
              </span>
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
