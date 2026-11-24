import type { SettingValue, ThemeSettingField } from '../../main/settings-shell-types';

export type SettingsValues = Record<string, SettingValue>;
export type SettingsTranslate = (key: string, options?: Record<string, unknown>) => string;
type Spec = Pick<ThemeSettingField, 'id' | 'groupId' | 'type'> & Partial<Pick<ThemeSettingField, 'visible' | 'help' | 'options' | 'min' | 'max' | 'step' | 'maxLength'>> & {
  key: string; validate?: (value: SettingValue) => boolean;
};

/** Metadata only; themes decide which controls to display and how to render them. */
export function settingsFields(specs: Spec[], draft: SettingsValues, saved: SettingsValues, t: SettingsTranslate): ThemeSettingField[] {
  if (!Object.keys(saved).length) return [];
  return specs.map(({ key, validate, ...spec }) => {
    const value = draft[spec.id];
    const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
    const normalized = spec.type === 'number' ? numeric : value;
    const dirty = normalized !== saved[spec.id];
    const valid = validate ? validate(value) : spec.type === 'select'
      ? spec.options!.some(option => option.value === value && (!option.disabled || !dirty))
      : spec.type === 'number' ? typeof numeric === 'number' && Number.isFinite(numeric)
        && numeric >= (spec.min ?? -Infinity) && numeric <= (spec.max ?? Infinity)
        && (numeric === saved[spec.id] || Math.abs(numeric / (spec.step ?? 1) - Math.round(numeric / (spec.step ?? 1))) < 1e-7)
      : spec.type === 'toggle' ? typeof value === 'boolean'
      : typeof value === 'string' && value.length <= (spec.maxLength ?? 500);
    return { ...spec, label: t(key), help: spec.help ?? '', visible: spec.visible ?? true, value, savedValue: saved[spec.id], dirty,
      error: valid ? null : t('themeSettings.invalid', { field: t(key) }) };
  });
}
