'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiKey } from '../../../lib/types';
import { api } from '../../../lib/api';
import { FormField } from '../../ui/FormField/FormField';
import { Input } from '../../ui/Input/Input';
import { Checkbox } from '../../ui/Checkbox/Checkbox';
import { Select, type SelectOption } from '../../ui/Select/Select';
import { OpenRouterModelInput } from '../../ui/ModelInput/OpenRouterModelInput';
import { SecretState } from '../../ui/SecretState/SecretState';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import styles from './IntegrationsPage.module.css';

type Settings = {
  enabled: boolean;
  provider: 'openrouter' | 'custom';
  baseUrl: string;
  model: string;
  apiKeyId: number | null;
  audioPricePerSecond: number | null;
  inputPricePerMillion: number | null;
  hasApiKey: boolean;
};

type Status = {
  enabled: boolean;
  available: boolean;
  provider: string;
  model: string;
  error: string | null;
};

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

export function TranscriptionPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyValue, setNewKeyValue] = useState('');

  const load = useCallback(async () => {
    const [settings, keys] = await Promise.all([
      api<Settings>('/api/transcription/settings'),
      api<ApiKey[]>('/api/api-keys'),
    ]);
    setSaved(settings);
    setDraft(settings);
    setApiKeys(keys);
  }, []);

  useEffect(() => {
    void load().catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [load]);

  const changed = Boolean(saved && draft && JSON.stringify(saved) !== JSON.stringify(draft));
  const keyOptions: SelectOption[] = useMemo(
    () => [
      ...apiKeys.map((key) => ({ value: `key:${key.id}`, label: key.name, hint: key.key_prefix })),
      { value: '__create__', label: t('security.apiKeyCreateNew') },
    ],
    [apiKeys, t],
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !changed) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const next = await api<Settings>('/api/transcription/settings', {
        method: 'PUT',
        body: JSON.stringify(draft),
      });
      setSaved(next);
      setDraft(next);
      setMessage(t('integrations.transcription.saved'));
      setStatus(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setError('');
    try {
      setStatus(await api<Status>('/api/transcription/status'));
    } catch (reason) {
      setStatus(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChecking(false);
    }
  };

  const createKey = async () => {
    if (!newKeyName.trim() || !newKeyValue.trim()) return;
    setBusy(true);
    try {
      const created = await api<ApiKey>('/api/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName.trim(), key: newKeyValue.trim() }),
      });
      setApiKeys((current) => [...current.filter((key) => key.id !== created.id), created]);
      setDraft((current) =>
        current ? { ...current, apiKeyId: created.id, hasApiKey: true } : current,
      );
      setCreatingKey(false);
      setNewKeyName('');
      setNewKeyValue('');
      window.dispatchEvent(new Event('chatter:api-keys-changed'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <IntegrationDetailPage
      title={t('integrations.items.transcription.name')}
      description={t('integrations.transcription.pageDescription')}
      saving={busy}
      saveState={error ? `${t('common.error')}: ${error}` : message}
      onBack={onBack}
      onSave={save}
      saveActionLabel={t('common.save')}
      saveSavingLabel={t('common.savingChanges')}
      saveDisabled={
        !draft ||
        !changed ||
        busy ||
        (draft.enabled && (!draft.baseUrl || !draft.model || !draft.apiKeyId))
      }
    >
      <section className={styles.fieldSection}>
        <div className={styles.sectionTitle}>
          <h3>{t('integrations.transcription.sectionTitle')}</h3>
          <p>{t('integrations.transcription.sectionIntro')}</p>
        </div>
        {draft && (
          <div className={styles.fields}>
            <Checkbox
              checked={draft.enabled}
              onChange={(enabled) => setDraft({ ...draft, enabled })}
              label={t('integrations.transcription.enabled')}
            />
            <FormField label={t('integrations.transcription.provider')}>
              <Select
                value={draft.provider}
                options={[
                  { value: 'openrouter', label: 'OpenRouter' },
                  { value: 'custom', label: t('models.billing.customProvider') },
                ]}
                onChange={(value) =>
                  setDraft({
                    ...draft,
                    provider: value as Settings['provider'],
                    ...(value === 'openrouter' ? { baseUrl: OPENROUTER_URL } : {}),
                  })
                }
              />
            </FormField>
            <FormField label={t('integrations.transcription.apiUrl')}>
              <Input
                type="url"
                value={draft.baseUrl}
                readOnly={draft.provider === 'openrouter'}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </FormField>
            {creatingKey ? (
              <div className={styles.createKeyPanel}>
                <FormField label={t('security.apiKeyName')}>
                  <Input
                    value={newKeyName}
                    onChange={(event) => setNewKeyName(event.target.value)}
                    autoFocus
                  />
                </FormField>
                <FormField label={t('security.apiKeyValue')}>
                  <Input
                    type="password"
                    value={newKeyValue}
                    onChange={(event) => setNewKeyValue(event.target.value)}
                  />
                </FormField>
                <div className={styles.createKeyActions}>
                  <button
                    type="button"
                    disabled={busy || !newKeyName.trim() || !newKeyValue.trim()}
                    onClick={() => void createKey()}
                  >
                    {t('security.apiKeyCreate')}
                  </button>
                  <button
                    type="button"
                    className="buttonSecondary"
                    disabled={busy}
                    onClick={() => setCreatingKey(false)}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </div>
            ) : (
              <FormField
                label={t('security.apiKeySelect')}
                state={<SecretState configured={Boolean(draft.apiKeyId)} />}
              >
                <Select
                  value={draft.apiKeyId ? `key:${draft.apiKeyId}` : ''}
                  options={keyOptions}
                  onChange={(value) => {
                    if (value === '__create__') {
                      setCreatingKey(true);
                      return;
                    }
                    setDraft({
                      ...draft,
                      apiKeyId: value.startsWith('key:') ? Number(value.slice(4)) : null,
                    });
                  }}
                  placeholder={t('security.apiKeySelectPlaceholder')}
                />
              </FormField>
            )}
            <FormField label={t('integrations.transcription.model')}>
              {draft.provider === 'openrouter' ? (
                <OpenRouterModelInput
                  value={draft.model}
                  catalog="transcription"
                  apiKeyId={draft.apiKeyId}
                  onSelect={(model, prices) =>
                    setDraft({
                      ...draft,
                      model,
                      audioPricePerSecond: prices?.audioPricePerSecond ?? null,
                      inputPricePerMillion: prices?.inputPricePerMillion ?? null,
                    })
                  }
                />
              ) : (
                <Input
                  value={draft.model}
                  onChange={(event) => setDraft({ ...draft, model: event.target.value })}
                />
              )}
            </FormField>
            <FormField label={t('integrations.transcription.audioPrice')}>
              <Input
                type="number"
                min="0"
                step="any"
                value={draft.audioPricePerSecond ?? ''}
                readOnly={draft.provider === 'openrouter'}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    audioPricePerSecond:
                      event.target.value === '' ? null : Number(event.target.value),
                  })
                }
                placeholder="—"
              />
            </FormField>
            <FormField label={t('integrations.transcription.tokenPrice')}>
              <Input
                type="number"
                min="0"
                step="any"
                value={draft.inputPricePerMillion ?? ''}
                readOnly={draft.provider === 'openrouter'}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    inputPricePerMillion:
                      event.target.value === '' ? null : Number(event.target.value),
                  })
                }
                placeholder="—"
              />
            </FormField>
            <button
              type="button"
              className={styles.checkButton}
              disabled={checking || changed || !draft.enabled}
              onClick={() => void check()}
            >
              {checking
                ? t('integrations.transcription.checking')
                : t('integrations.transcription.check')}
            </button>
            {status && (
              <span className={status.available ? styles.checkSuccess : styles.checkError}>
                {status.available
                  ? t('integrations.transcription.available', { model: status.model })
                  : t('integrations.transcription.unavailable', {
                      error: status.error || 'unknown',
                    })}
              </span>
            )}
          </div>
        )}
      </section>
    </IntegrationDetailPage>
  );
}
