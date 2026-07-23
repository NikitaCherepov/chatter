'use client';

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatPricesHint,
  type ModelPrices,
  type PresetModel,
} from '../../../lib/presetModels';
import { Select, type SelectOption } from '../Select/Select';

// Magic value used in the preset dropdown to switch to free-text input.
const CUSTOM_MODEL_VALUE = '__custom__';

type Props = {
  value: string;
  presets: PresetModel[];
  onSelect: (modelId: string, prices: ModelPrices | null) => void;
};

/**
 * Dropdown of preset models for providers with a fixed lineup
 * (DeepSeek, Xiaomi). Includes an "Other…" option that reveals a free-text
 * input for custom model ids.
 */
export function PresetModelInput({ value, presets, onSelect }: Props) {
  const { t } = useTranslation();

  const options: SelectOption[] = useMemo(() => {
    const presetOpts: SelectOption[] = presets.map((m) => ({
      value: m.id,
      label: m.name,
      hint: formatPricesHint(m.prices),
    }));
    presetOpts.push({
      value: CUSTOM_MODEL_VALUE,
      label: t('models.billing.customModel') || 'Другая…',
      hint: t('models.billing.customModelHint') || 'указать вручную',
    });
    return presetOpts;
  }, [presets, t]);

  // If the current value matches a preset, show it selected. If not, treat
  // it as custom (so the user can see their id and edit it freely).
  const isPreset = presets.some((m) => m.id === value);
  const selectValue = isPreset ? value : value ? CUSTOM_MODEL_VALUE : '';

  const handleChange = (v: string) => {
    if (v === CUSTOM_MODEL_VALUE) {
      // Switching to custom: keep current value (or empty), no preset prices.
      onSelect(value, null);
      return;
    }
    const preset = presets.find((m) => m.id === v);
    onSelect(v, preset ? preset.prices : null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
      <Select
        options={options}
        value={selectValue}
        onChange={handleChange}
        placeholder={t('models.billing.searchModelPlaceholder') || 'Выбрать модель…'}
        valueFallbackLabel={isPreset ? undefined : value || undefined}
      />
      {!isPreset && (
        <input
          value={value}
          onChange={(e) => onSelect(e.target.value, null)}
          placeholder="model-id"
          autoComplete="off"
        />
      )}
    </div>
  );
}
