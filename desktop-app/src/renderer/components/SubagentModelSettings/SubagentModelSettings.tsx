import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type * as api from '../../lib/api';
import { Select } from '../Select';
import Slider from '../Slider';
import styles from './SubagentModelSettings.module.scss';

type Props = {
  models: api.ModelCatalogEntry[];
  model: string | null;
  modelSaving: boolean;
  reasoningLevel: api.ReasoningLevel | null;
  reasoningLevels: (api.ReasoningLevel | null)[];
  reasoningSaving: boolean;
  onModelChange: (modelId: string) => void;
  onReasoningChange: (level: api.ReasoningLevel | null) => void;
  onReasoningCommit: () => void;
};

export function SubagentModelSettings({
  models,
  model,
  modelSaving,
  reasoningLevel,
  reasoningLevels,
  reasoningSaving,
  onModelChange,
  onReasoningChange,
  onReasoningCommit,
}: Props) {
  const { t } = useTranslation();
  const reasoningLabels = useMemo<Record<string, string>>(
    () => ({
      null: t('settings.reasoning.auto'),
      none: t('settings.reasoning.off'),
      minimal: t('settings.reasoning.minimalShort'),
      low: t('settings.reasoning.lowShort'),
      medium: t('settings.reasoning.mediumShort'),
      high: t('settings.reasoning.highShort'),
      xhigh: t('settings.reasoning.maxShort'),
    }),
    [t],
  );

  if (models.length === 0) return null;

  return (
    <section className={styles.section}>
      <div className={styles.heading}>{t('settings.app.subagentModel')}</div>
      <div className={styles.controls}>
        <Select
          options={[
            {
              value: '',
              label: t('settings.reasoning.auto'),
              hint: t('settings.app.automaticSelection'),
            },
            ...models.map((item) => ({
              value: item.id,
              label: item.name,
              hint: item.description || undefined,
            })),
          ]}
          value={model || ''}
          onChange={onModelChange}
          placeholder={t('settings.reasoning.auto')}
          disabled={modelSaving}
        />

        {reasoningLevels.length > 1 && (
          <Slider
            mode="discrete"
            label={t('settings.app.reasoning')}
            values={reasoningLevels}
            labels={reasoningLabels}
            value={reasoningLevel}
            onChange={(value) => onReasoningChange(value as api.ReasoningLevel | null)}
            onCommit={onReasoningCommit}
            disabled={reasoningSaving}
          />
        )}
      </div>
      <p className={styles.help}>{t('settings.app.subagentHelp')}</p>
    </section>
  );
}
