'use client';

import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { AdminSection } from '../../AdminShell/AdminShell';
import type { Settings } from '../../../lib/types';
import { Icon } from '../../icons/icons';
import { CloudTtsPage } from './CloudTtsPage';
import { ImageGenerationPage } from './ImageGenerationPage';
import { PineconePage } from './PineconePage';
import { WebReaderPage } from './WebReaderPage';
import { WebSearchPage } from './WebSearchPage';
import styles from './IntegrationsPage.module.css';

type IntegrationId = 'pinecone' | 'web-search' | 'web-reader' | 'cloud-tts' | 'image-generation';

const INTEGRATION_IDS: Array<{ id: IntegrationId; icon: string }> = [
  { id: 'pinecone', icon: 'Pi' },
  { id: 'web-search', icon: 'WS' },
  { id: 'web-reader', icon: 'WR' },
  { id: 'cloud-tts', icon: 'TT' },
  { id: 'image-generation', icon: 'IG' },
];

export function IntegrationsPage({
  settings,
  setSettings,
  saving,
  saveState,
  onSave,
  onNavigate,
}: {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  saving: boolean;
  saveState: string;
  onSave: (event: FormEvent) => void;
  onNavigate: (section: AdminSection) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<IntegrationId | null>(null);

  if (selected === 'pinecone') {
    return (
      <PineconePage
        settings={settings.pinecone}
        onChange={(patch) =>
          setSettings((current) => ({ ...current, pinecone: { ...current.pinecone, ...patch } }))
        }
        saving={saving}
        saveState={saveState}
        onBack={() => setSelected(null)}
        onSave={onSave}
      />
    );
  }

  if (selected === 'web-search') {
    return (
      <WebSearchPage
        settings={settings.webSearch}
        onChange={(patch) =>
          setSettings((current) => ({ ...current, webSearch: { ...current.webSearch, ...patch } }))
        }
        saving={saving}
        saveState={saveState}
        onBack={() => setSelected(null)}
        onSave={onSave}
      />
    );
  }

  if (selected === 'web-reader') {
    return (
      <WebReaderPage
        settings={settings.webReader}
        onChange={(patch) =>
          setSettings((current) => ({ ...current, webReader: { ...current.webReader, ...patch } }))
        }
        saving={saving}
        saveState={saveState}
        onBack={() => setSelected(null)}
        onSave={onSave}
      />
    );
  }

  if (selected === 'cloud-tts') {
    return (
      <CloudTtsPage
        settings={settings.cloudTts}
        onChange={(patch) =>
          setSettings((current) => ({ ...current, cloudTts: { ...current.cloudTts, ...patch } }))
        }
        saving={saving}
        saveState={saveState}
        onBack={() => setSelected(null)}
        onSave={onSave}
      />
    );
  }

  if (selected === 'image-generation') {
    return (
      <ImageGenerationPage
        settings={settings.imageGeneration}
        onChange={(patch) =>
          setSettings((current) => ({
            ...current,
            imageGeneration: { ...current.imageGeneration, ...patch },
          }))
        }
        saving={saving}
        saveState={saveState}
        onBack={() => setSelected(null)}
        onSave={onSave}
      />
    );
  }

  const configured: Record<IntegrationId, boolean> = {
    pinecone: settings.pinecone.hasApiKey,
    'web-search': settings.webSearch.hasApiKey,
    'web-reader': settings.webReader.hasToken,
    'cloud-tts': settings.cloudTts.hasApiKey,
    'image-generation': settings.imageGeneration.hasApiKey,
  };

  return (
    <div className={styles.stack}>
      <section className={styles.intro}>
        <div>
          <h2>{t('integrations.title')}</h2>
          <p>{t('integrations.subtitle')}</p>
        </div>
      </section>
      <div className={styles.grid}>
        <button type="button" className={styles.card} onClick={() => onNavigate('models')}>
          <span className={styles.icon}>AI</span>
          <span className={styles.info}>
            <small>{t('integrations.modelsLink.label')}</small>
            <strong>{t('integrations.modelsLink.description')}</strong>
            <em>{settings.hasAiApiKey ? t('integrations.statusConfigured') : t('integrations.statusNotConfigured')}</em>
          </span>
          <Icon name="arrow" />
        </button>
        {INTEGRATION_IDS.map((item) => (
          <button
            type="button"
            className={styles.card}
            key={item.id}
            onClick={() => setSelected(item.id)}
          >
            <span className={styles.icon}>{item.icon}</span>
            <span className={styles.info}>
              <small>{t(`integrations.items.${item.id}.group`)}</small>
              <strong>{t(`integrations.items.${item.id}.name`)}</strong>
              <em>{configured[item.id] ? t('integrations.statusConfigured') : t(`integrations.items.${item.id}.description`)}</em>
            </span>
            <Icon name="arrow" />
          </button>
        ))}
      </div>
    </div>
  );
}
