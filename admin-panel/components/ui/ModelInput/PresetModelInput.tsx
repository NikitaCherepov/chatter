'use client';

import { useMemo, useState } from 'react';
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
 *
 * `customMode` is tracked locally so that clicking "Other…" actually switches
 * the UI to the free-text input — even when the current `value` still matches
 * a preset id (or is empty). The local mode is derived from the value on first
 * render, then owned by the user's clicks.
 */
export function PresetModelInput({ value, presets, onSelect }: Props) {
  const { t } = useTranslation();

  // Whether the value is NOT one of the known presets.
  const isValuePreset = useMemo(
    () => presets.some((m) => m.id === value),
    [presets, value],
  );

  // Local "Other…" toggle. Initialised from value: if value is already a
  // non-preset id (e.g. a previously saved custom model), start in custom mode.
  const [customMode, setCustomMode] = useState<boolean>(!isValuePreset && Boolean(value));

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

  // What the Select shows as selected: a preset id, the custom magic value,
  // or empty (placeholder).
  const selectValue = customMode
    ? CUSTOM_MODEL_VALUE
    : (isValuePreset ? value : '');

  const handleChange = (v: string) => {
    if (v === CUSTOM_MODEL_VALUE) {
      // Switching to custom mode: keep current value, do not overwrite.
      setCustomMode(true);
      // Notify parent so it knows the prices are no longer preset-derived.
      // Keep value intact so the user can edit the existing id.
      onSelect(value, null);
      return;
    }
    // Picking a preset: leave custom mode, apply preset prices.
    setCustomMode(false);
    const preset = presets.find((m) => m.id === v);
    onSelect(v, preset ? preset.prices : null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
      <Select
        options={options}
        value={selectValue}
        onChange={handleChange}
        placeholder={t('models.billing.searchModelPlaceholder') || 'Choose model…'}
        valueFallbackLabel={customMode && value ? value : undefined}
      />
      {customMode && (
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
