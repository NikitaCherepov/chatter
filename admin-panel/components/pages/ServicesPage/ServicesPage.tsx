import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { Service, Settings } from '../../../lib/types';
import { Icon } from '../../icons/icons';
import { ActionBar } from '../../ui/ActionBar/ActionBar';
import { Card } from '../../ui/Card/Card';
import { FormField } from '../../ui/FormField/FormField';
import { Input } from '../../ui/Input/Input';
import { SecretState } from '../../ui/SecretState/SecretState';
import { Select } from '../../ui/Select/Select';
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
  const { t } = useTranslation();

  return (
    <form className={grid.stack} onSubmit={onSave}>
      <Card
        title={t('services.telegram.title')}
        description={t('services.telegram.description')}
        aside={<ServiceBadge services={services} names={['telegram-bot']} />}
      >
        <div className={grid.fields}>
          <Toggle
            checked={settings.telegramEnabled}
            onChange={(telegramEnabled) =>
              setSettings((current) => ({ ...current, telegramEnabled }))
            }
            label={t('services.telegram.enabled')}
          />
          <Toggle
            checked={settings.telegramRichStreaming}
            onChange={(telegramRichStreaming) =>
              setSettings((current) => ({ ...current, telegramRichStreaming }))
            }
            label={t('services.telegram.richStreaming')}
          />
          <FormField
            label={t('services.telegram.tokenLabel')}
            state={<SecretState configured={settings.hasTelegramToken} />}
            hint={t('services.telegram.tokenHint')}
          >
            <Input
              type="password"
              value={telegramToken}
              onChange={(event) => onTelegramTokenChange(event.target.value)}
              autoComplete="off"
              placeholder={t('services.telegram.tokenPlaceholder')}
            />
          </FormField>
        </div>
      </Card>
      <Card
        title={t('services.notes.title')}
        description={t('services.notes.description')}
        aside={<ServiceBadge services={services} names={['webapp-notes']} />}
      >
        <div className={grid.fields}>
          <Toggle
            checked={settings.notesEnabled}
            onChange={(notesEnabled) =>
              setSettings((current) => ({ ...current, notesEnabled }))
            }
            label={t('services.notes.enabled')}
          />
          <FormField
            label={t('services.notes.urlLabel')}
            hint={t('services.notes.urlHint')}
          >
            <div className={styles.urlRow}>
              <Input type="url" value={settings.notesUrl} disabled placeholder="https://SERVER_IP/notes" />
              <button
                type="button"
                className={styles.copyButton}
                disabled={!settings.notesUrl}
                onClick={() => void navigator.clipboard.writeText(settings.notesUrl)}
                aria-label={t('services.notes.copyAddress')}
                title={t('services.notes.copyAddress')}
              >
                <Icon name="copy" />
              </button>
            </div>
          </FormField>
        </div>
      </Card>
      <Card
        title={t('services.voice.title')}
        description={t('services.voice.description')}
        aside={<ServiceBadge services={services} names={['voice']} />}
      >
        <div className={grid.fields}>
          <FormField label={t('services.voice.modeLabel')}>
            <Select
              value={settings.voiceMode}
              onChange={(value) =>
                setSettings((current) => ({
                  ...current,
                  voiceMode: value as Settings['voiceMode'],
                }))
              }
              options={[
                { value: 'off', label: t('services.voice.modeOff') },
                { value: 'local', label: t('services.voice.modeLocal') },
                { value: 'remote', label: t('services.voice.modeRemoteSoon'), disabled: true },
              ]}
            />
          </FormField>
          {settings.voiceMode === 'remote' && (
            <FormField label={t('services.voice.apiUrlLabel')}>
              <Input
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
            label={t('services.voice.tokenLabel')}
            state={<SecretState configured={settings.hasVoiceToken} />}
            hint={t('services.voice.tokenHint')}
          >
            <Input
              type="password"
              value={voiceToken}
              onChange={(event) => onVoiceTokenChange(event.target.value)}
              autoComplete="off"
              placeholder={t('services.voice.tokenPlaceholder')}
            />
          </FormField>
          {settings.voiceMode === 'local' && (
            <div className={styles.notice}>
              {t('services.voice.notice')}
            </div>
          )}
        </div>
      </Card>
      <ActionBar saving={saving} state={saveState} />
    </form>
  );
}

function ServiceBadge({ services, names }: { services: Service[]; names: string[] }) {
  const { t } = useTranslation();
  const matches = services.filter((service) => names.includes(service.service));
  const running = matches.length > 0 && matches.every((service) => service.state === 'running');
  return (
    <span className={`${styles.badge} ${running ? styles.running : ''}`}>
      <span />
      {running ? t('services.badge.running') : t('services.badge.notRunning')}
    </span>
  );
}
