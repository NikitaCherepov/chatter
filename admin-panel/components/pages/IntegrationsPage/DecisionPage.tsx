'use client';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../lib/api';
import type { ApiKey } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { Input } from '../../ui/Input/Input';
import { Select } from '../../ui/Select/Select';
import { Toggle } from '../../ui/Toggle/Toggle';
import { IntegrationDetailPage } from './IntegrationDetailPage';
import styles from './IntegrationsPage.module.css';

type Settings = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKeyId: number | null;
  timeoutMs: number;
  inputPricePerMillion: number;
  hasApiKey: boolean;
};
export function DecisionPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([api<Settings>('/api/decision/settings'), api<ApiKey[]>('/api/api-keys')])
      .then(([settings, keyList]) => {
        if (active) {
          setDraft(settings);
          setSaved(settings);
          setKeys(keyList);
        }
      })
      .catch(() => {
        if (active) setState(t('decision.failed'));
      });
    return () => {
      active = false;
    };
  }, [t]);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  return (
    <IntegrationDetailPage
      title={t('decision.title')}
      description={t('decision.description')}
      onBack={onBack}
      saving={busy}
      saveState={state}
      saveDisabled={!draft || !changed}
      onSave={async (event) => {
        event.preventDefault();
        if (!draft || busy) return;
        setBusy(true);
        setState('');
        try {
          const next = await api<Settings>('/api/decision/settings', {
            method: 'PUT',
            body: JSON.stringify(draft),
          });
          setSaved(next);
          setDraft(next);
          setState(t('decision.saved'));
        } catch {
          setState(t('decision.failed'));
        } finally {
          setBusy(false);
        }
      }}
    >
      {draft ? (
        <>
          <section className={styles.fieldSection}>
            <div className={styles.sectionTitle}>
              <h3>{t('decision.connectionTitle')}</h3>
            </div>
            <div className={styles.fields}>
              <Toggle
                checked={draft.enabled}
                label={t('decision.enabled')}
                disabled={busy}
                onChange={(enabled) => setDraft({ ...draft, enabled })}
              />
              <FormField label={t('decision.url')}>
                <Input
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                />
              </FormField>
              <FormField label={t('decision.model')}>
                <Input
                  value={draft.model}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                />
              </FormField>
              <FormField label={t('decision.key')}>
                <Select
                  value={draft.apiKeyId === null ? '' : String(draft.apiKeyId)}
                  options={keys.map((key) => ({
                    value: String(key.id),
                    label: key.name,
                    hint: key.key_prefix,
                  }))}
                  onChange={(value) =>
                    setDraft({ ...draft, apiKeyId: value ? Number(value) : null })
                  }
                />
              </FormField>
            </div>
          </section>
          <section className={styles.fieldSection}>
            <div className={styles.sectionTitle}>
              <h3>{t('decision.parametersTitle')}</h3>
            </div>
            <div className={styles.fields}>
              <div className={styles.twoColumns}>
                <FormField label={t('decision.timeout')}>
                  <Input
                    type="number"
                    min={250}
                    max={30000}
                    value={draft.timeoutMs}
                    onChange={(e) => setDraft({ ...draft, timeoutMs: Number(e.target.value) })}
                  />
                </FormField>
                <FormField label={t('decision.price')}>
                  <Input
                    type="number"
                    min={0}
                    step="0.001"
                    value={draft.inputPricePerMillion}
                    onChange={(e) =>
                      setDraft({ ...draft, inputPricePerMillion: Number(e.target.value) })
                    }
                  />
                </FormField>
              </div>
              <div className={styles.createKeyActions}>
                <button
                  type="button"
                  className="buttonSecondary"
                  disabled={busy || changed || !saved?.enabled || !saved.hasApiKey}
                  onClick={async () => {
                    setBusy(true);
                    setState('');
                    try {
                      await api('/api/decision/test', { method: 'POST', body: '{}' });
                      setState(t('decision.connected'));
                    } catch {
                      setState(t('decision.failed'));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t('decision.test')}
                </button>
              </div>
            </div>
          </section>
        </>
      ) : (
        <section className={styles.fieldSection}>
          <p className={styles.checkError}>{state || t('decision.loading')}</p>
        </section>
      )}
    </IntegrationDetailPage>
  );
}
