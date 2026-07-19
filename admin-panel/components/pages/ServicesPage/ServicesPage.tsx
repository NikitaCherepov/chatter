import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { Service, Settings } from '../../../lib/types';
import { ActionBar } from '../../ui/ActionBar/ActionBar';
import { Card } from '../../ui/Card/Card';
import { FormField } from '../../ui/FormField/FormField';
import { SecretState } from '../../ui/SecretState/SecretState';
import { Toggle } from '../../ui/Toggle/Toggle';
import grid from '../../ui/PageGrid/PageGrid.module.css';
import styles from './ServicesPage.module.css';

type Props = {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  services: Service[];
  telegramToken: string;
  voiceToken: string;
  saving: boolean;
  saveState: string;
  onTelegramTokenChange: (value: string) => void;
  onVoiceTokenChange: (value: string) => void;
  onSave: (event: FormEvent) => void;
};

export function ServicesPage({
  settings,
  setSettings,
  services,
  telegramToken,
  voiceToken,
  saving,
  saveState,
  onTelegramTokenChange,
  onVoiceTokenChange,
  onSave,
}: Props) {
  return (
    <form className={grid.stack} onSubmit={onSave}>
      <Card
        title="Telegram-бот"
        description="Основной интерфейс Chatter в Telegram"
        aside={<ServiceBadge services={services} names={['telegram-bot']} />}
      >
        <div className={grid.fields}>
          <Toggle
            checked={settings.telegramEnabled}
            onChange={(telegramEnabled) =>
              setSettings((current) => ({ ...current, telegramEnabled }))
            }
            label="Сервис включён"
          />
          <FormField
            label="Токен Telegram-бота"
            state={<SecretState configured={settings.hasTelegramToken} />}
            hint="Этот же токен используется Webapp Notes для проверки initData"
          >
            <input
              type="password"
              value={telegramToken}
              onChange={(event) => onTelegramTokenChange(event.target.value)}
              autoComplete="off"
              placeholder="Оставь пустым, чтобы не менять"
            />
          </FormField>
        </div>
      </Card>
      <Card
        title="Webapp Notes"
        description="Отдельное Telegram Mini App для заметок"
        aside={<ServiceBadge services={services} names={['webapp-notes']} />}
      >
        <div className={grid.fields}>
          <Toggle
            checked={settings.notesEnabled}
            onChange={(notesEnabled) =>
              setSettings((current) => ({ ...current, notesEnabled }))
            }
            label="Сервис включён"
          />
          <FormField
            label="Адрес Mini App"
            hint="Установщик создаёт адрес по IP сервера автоматически. Он передаётся боту при сохранении настроек"
          >
            <div className={styles.urlRow}>
              <input type="url" value={settings.notesUrl} readOnly placeholder="https://SERVER_IP/notes" />
              <button
                type="button"
                className="buttonSecondary"
                disabled={!settings.notesUrl}
                onClick={() => void navigator.clipboard.writeText(settings.notesUrl)}
              >
                Копировать
              </button>
            </div>
          </FormField>
        </div>
      </Card>
      <Card
        title="Voice"
        description="Распознавание голосовых и озвучка ответов Telegram-бота"
        aside={<ServiceBadge services={services} names={['voice']} />}
      >
        <div className={grid.fields}>
          <FormField label="Режим">
            <select
              value={settings.voiceMode}
              onChange={(event) =>
                setSettings((current) => ({
                  ...current,
                  voiceMode: event.target.value as Settings['voiceMode'],
                }))
              }
            >
              <option value="off">Выключен</option>
              <option value="local">На этом сервере</option>
              <option value="remote" disabled>На другом сервере (скоро)</option>
            </select>
          </FormField>
          {settings.voiceMode === 'remote' && (
            <FormField label="Адрес Voice API">
              <input
                type="url"
                value={settings.voiceExternalUrl}
                onChange={(event) =>
                  setSettings((current) => ({ ...current, voiceExternalUrl: event.target.value }))
                }
                placeholder="https://voice.example.com/api/voice"
              />
            </FormField>
          )}
          <FormField
            label="Токен Voice"
            state={<SecretState configured={settings.hasVoiceToken} />}
            hint="Для локального режима токен создаётся автоматически"
          >
            <input
              type="password"
              value={voiceToken}
              onChange={(event) => onVoiceTokenChange(event.target.value)}
              autoComplete="off"
              placeholder="Оставь пустым, чтобы не менять"
            />
          </FormField>
          {settings.voiceMode === 'local' && (
            <div className={styles.notice}>
              Voice пока используется только Telegram-ботом. Первый локальный запуск может занять
              несколько минут: Docker загружает образ и модели.
            </div>
          )}
        </div>
      </Card>
      <ActionBar saving={saving} state={saveState} />
    </form>
  );
}

function ServiceBadge({ services, names }: { services: Service[]; names: string[] }) {
  const matches = services.filter((service) => names.includes(service.service));
  const running = matches.length > 0 && matches.every((service) => service.state === 'running');
  return (
    <span className={`${styles.badge} ${running ? styles.running : ''}`}>
      <span />
      {running ? 'работает' : 'не запущен'}
    </span>
  );
}
