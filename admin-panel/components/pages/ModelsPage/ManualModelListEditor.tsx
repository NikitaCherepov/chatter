import type { ManualModelConfig } from '../../../lib/types';
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
  };
};

export function ManualModelListEditor({
  models,
  onChange,
}: {
  models: ManualModelConfig[];
  onChange: (models: ManualModelConfig[]) => void;
}) {
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
    </div>
  );
}
