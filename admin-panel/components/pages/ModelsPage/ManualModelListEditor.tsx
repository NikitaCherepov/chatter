import { useEffect, useRef, useState } from 'react';
import type { ManualModelConfig } from '../../../lib/types';
import { api } from '../../../lib/api';
import { FormField } from '../../ui/FormField/FormField';
import { Toggle } from '../../ui/Toggle/Toggle';
import { ProviderModelFields } from './ModelListEditor';
import styles from './ModelsPage.module.css';

const newManualModel = (): ManualModelConfig => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: `manual-new-${suffix}`,
    uniqueId: `manual-${suffix}`,
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    apiKey: '',
    hasApiKey: false,
    name: '',
    description: '',
    supportsVision: false,
    adminOnly: false,
    coefficient: 1,
  };
};

export function ManualModelListEditor({
  models,
  onChange,
}: {
  models: ManualModelConfig[];
  onChange: (models: ManualModelConfig[]) => void;
}) {
  // Coefficients are stored separately in backend (model_overrides table).
  // We load them ONCE on first mount and only inject values for models that
  // have NOT been touched locally since the last save (local edits win).
  const [coeffState, setCoeffState] = useState<string>('');
  const loadedOnceRef = useRef(false);
  const dirtyIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (loadedOnceRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await api<{ coefficients: Record<string, number> }>('/api/v1/admin/model-coefficients');
        if (cancelled) return;
        loadedOnceRef.current = true;
        // Only apply server values for uniqueIds the user has NOT edited locally.
        onChange(models.map(model => {
          if (dirtyIdsRef.current.has(model.uniqueId)) return model;
          const coefficient = response.coefficients?.[model.uniqueId];
          return coefficient === undefined ? model : { ...model, coefficient };
        }));
        setCoeffState('');
      } catch (err) {
        setCoeffState(`Не удалось загрузить коэффициенты: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist coefficient to backend on blur. Marks the model as "dirty" so a
  // late-fetched server value cannot overwrite the user's edit.
  const updateCoefficient = async (uniqueId: string, coefficient: number) => {
    if (!uniqueId) return;
    dirtyIdsRef.current.add(uniqueId);
    try {
      await api(`/api/v1/admin/model-coefficients/${encodeURIComponent(uniqueId)}`, {
        method: 'PUT',
        body: JSON.stringify({ coefficient }),
      });
      setCoeffState('Коэффициент сохранён');
    } catch (err) {
      setCoeffState(`Ошибка: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const update = (index: number, patch: Partial<ManualModelConfig>) => {
    onChange(models.map((model, itemIndex) => (itemIndex === index ? { ...model, ...patch } : model)));
  };

  return (
    <div className={styles.modelList}>
      <div className={styles.listHeading}>
        <div>
          <h3>Каталог</h3>
          <p>При ошибке ручной модели Chatter вернётся к Auto.</p>
        </div>
      </div>
      {!models.length && <p className={styles.empty}>Ручные модели пока не добавлены.</p>}
      {models.map((model, index) => (
        <details className={styles.modelCard} key={model.id} open={index === 0 ? true : undefined}>
          <summary>
            <span className={styles.order}>{index + 1}</span>
            <span className={styles.modelTitle}>
              <strong>{model.name || model.model || 'Новая ручная модель'}</strong>
              <span>{model.model || 'Модель не указана'}</span>
            </span>
          </summary>
          <div className={styles.modelBody}>
            <ProviderModelFields model={model} onChange={(patch) => update(index, patch)} />
            <div className={styles.twoColumns}>
              <FormField label="Название в интерфейсе">
                <input value={model.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="Например, Claude Sonnet" required />
              </FormField>
              <FormField label="Уникальный ID">
                <input value={model.uniqueId} onChange={(event) => update(index, { uniqueId: event.target.value })} required />
              </FormField>
            </div>
            <FormField label="Короткое описание">
              <input value={model.description} onChange={(event) => update(index, { description: event.target.value })} placeholder="Для каких задач подходит модель" />
            </FormField>
            <FormField label="Коэффициент стоимости" hint="0 = бесплатная (не расходует квоту), 1 = по умолчанию, 0.7 = дешевле, 1.5 = дороже">
              <input
                type="number"
                min={0}
                step={0.1}
                value={model.coefficient ?? 1}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  update(index, { coefficient: Number.isFinite(value) && value >= 0 ? value : 1 });
                }}
                onBlur={(event) => void updateCoefficient(model.uniqueId, Number(event.target.value))}
              />
            </FormField>
            <div className={styles.toggleRow}>
              <Toggle checked={model.supportsVision} onChange={(supportsVision) => update(index, { supportsVision })} label="Поддерживает изображения" />
              <Toggle checked={model.adminOnly} onChange={(adminOnly) => update(index, { adminOnly })} label="Только для администраторов" />
            </div>
            <button className={styles.dangerButton} type="button" onClick={() => onChange(models.filter((_, itemIndex) => itemIndex !== index))}>
              Удалить модель
            </button>
          </div>
        </details>
      ))}
      <button className="buttonSecondary" type="button" onClick={() => onChange([...models, newManualModel()])}>
        + Добавить ручную модель
      </button>
      {coeffState && <p className={styles.empty}>{coeffState}</p>}
    </div>
  );
}
