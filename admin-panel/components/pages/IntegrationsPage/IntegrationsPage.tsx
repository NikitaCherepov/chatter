'use client';

import { useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import type { AdminSection } from '../../AdminShell/AdminShell';
import type { Settings } from '../../../lib/types';
import { Icon } from '../../icons/icons';
import { CloudTtsPage } from './CloudTtsPage';
import { PineconePage } from './PineconePage';
import { WebReaderPage } from './WebReaderPage';
import { WebSearchPage } from './WebSearchPage';
import styles from './IntegrationsPage.module.css';

type IntegrationId = 'pinecone' | 'web-search' | 'web-reader' | 'cloud-tts';

const integrations: Array<{
  id: IntegrationId;
  name: string;
  description: string;
  group: string;
  icon: string;
}> = [
  { id: 'pinecone', name: 'Pinecone', description: 'Векторная память', group: 'Память', icon: 'Pi' },
  { id: 'web-search', name: 'Web Search', description: 'Поиск информации в интернете', group: 'Интернет', icon: 'WS' },
  { id: 'web-reader', name: 'Web Reader', description: 'Чтение и обработка веб-страниц', group: 'Интернет', icon: 'WR' },
  { id: 'cloud-tts', name: 'Cloud TTS', description: 'Облачные голоса Cartesia', group: 'Медиа', icon: 'TT' },
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

  const configured: Record<IntegrationId, boolean> = {
    pinecone: settings.pinecone.hasApiKey,
    'web-search': settings.webSearch.hasApiKey,
    'web-reader': settings.webReader.hasToken,
    'cloud-tts': settings.cloudTts.hasApiKey,
  };

  return (
    <div className={styles.stack}>
      <section className={styles.intro}>
        <div>
          <h2>Подключённые возможности</h2>
          <p>Открой интеграцию, чтобы указать ключи и параметры сервиса.</p>
        </div>
      </section>
      <div className={styles.grid}>
        <button type="button" className={styles.card} onClick={() => onNavigate('models')}>
          <span className={styles.icon}>AI</span>
          <span className={styles.info}>
            <small>Модели</small>
            <strong>OpenAI-совместимые API</strong>
            <em>{settings.hasAiApiKey ? 'Подключено' : 'Не настроено'}</em>
          </span>
          <Icon name="arrow" />
        </button>
        {integrations.map((item) => (
          <button
            type="button"
            className={styles.card}
            key={item.id}
            onClick={() => setSelected(item.id)}
          >
            <span className={styles.icon}>{item.icon}</span>
            <span className={styles.info}>
              <small>{item.group}</small>
              <strong>{item.name}</strong>
              <em>{configured[item.id] ? 'Подключено' : item.description}</em>
            </span>
            <Icon name="arrow" />
          </button>
        ))}
      </div>
    </div>
  );
}
