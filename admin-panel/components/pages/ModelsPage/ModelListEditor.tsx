import type { ProviderModelConfig } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { SecretState } from '../../ui/SecretState/SecretState';
import styles from './ModelsPage.module.css';

type Props = {
  title?: string;
  description?: string;
  models: ProviderModelConfig[];
  onChange: (models: ProviderModelConfig[]) => void;
  required?: boolean;
  emptyText?: string;
};

const newModel = (): ProviderModelConfig => ({
  id: `new-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  baseUrl: 'https://openrouter.ai/api/v1',
  model: '',
  apiKey: '',
  hasApiKey: false,
});

export function ModelListEditor({
  title,
  description,
  models,
  onChange,
  required = false,
  emptyText = 'Модели пока не добавлены.',
}: Props) {
  const update = (index: number, patch: Partial<ProviderModelConfig>) => {
    onChange(models.map((model, itemIndex) => (itemIndex === index ? { ...model, ...patch } : model)));
  };

  const move = (index: number, offset: number) => {
    const target = index + offset;
    if (target < 0 || target >= models.length) return;
    const next = [...models];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className={styles.modelList}>
      {(title || description) && (
        <div className={styles.listHeading}>
          <div>
            {title && <h3>{title}</h3>}
            {description && <p>{description}</p>}
          </div>
        </div>
      )}
      {!models.length && <p className={styles.empty}>{emptyText}</p>}
      {models.map((model, index) => (
        <div className={styles.modelSequence} key={model.id}>
          {index > 0 && <span className={styles.nextLabel}>следующая модель</span>}
          <details className={styles.modelCard} open={index === 0 ? true : undefined}>
            <summary>
              <span className={styles.order}>{index + 1}</span>
              <span className={styles.modelTitle}>
                <strong>{model.model || 'Новая модель'}</strong>
                <span>{model.baseUrl || 'Провайдер не указан'}</span>
              </span>
              <SecretState configured={model.hasApiKey || Boolean(model.apiKey)} />
            </summary>
            <div className={styles.modelBody}>
              <ProviderModelFields model={model} onChange={(patch) => update(index, patch)} />
              <div className={styles.modelActions}>
                <button className="buttonSecondary" type="button" disabled={index === 0} onClick={() => move(index, -1)}>
                  Выше
                </button>
                <button className="buttonSecondary" type="button" disabled={index === models.length - 1} onClick={() => move(index, 1)}>
                  Ниже
                </button>
                <button
                  className={styles.dangerButton}
                  type="button"
                  disabled={required && models.length === 1}
                  onClick={() => onChange(models.filter((_, itemIndex) => itemIndex !== index))}
                >
                  Удалить
                </button>
              </div>
            </div>
          </details>
        </div>
      ))}
      <button className="buttonSecondary" type="button" onClick={() => onChange([...models, newModel()])}>
        + Добавить модель
      </button>
    </div>
  );
}

export function ProviderModelFields({
  model,
  onChange,
  required = true,
}: {
  model: ProviderModelConfig;
  onChange: (patch: Partial<ProviderModelConfig>) => void;
  required?: boolean;
}) {
  return (
    <div className={styles.fields}>
      <div className={styles.twoColumns}>
        <FormField label="Ссылка на провайдера">
          <input
            type="url"
            value={model.baseUrl}
            onChange={(event) => onChange({ baseUrl: event.target.value })}
            placeholder="https://openrouter.ai/api/v1"
            required={required}
          />
        </FormField>
        <FormField label="Название модели">
          <input
            value={model.model}
            onChange={(event) => onChange({ model: event.target.value })}
            placeholder="provider/model-name"
            required={required}
          />
        </FormField>
      </div>
      <FormField
        label="API-ключ"
        state={<SecretState configured={model.hasApiKey || Boolean(model.apiKey)} />}
        hint={model.hasApiKey ? 'Оставь пустым, чтобы сохранить текущий ключ' : undefined}
      >
        <input
          type="password"
          value={model.apiKey}
          onChange={(event) => onChange({ apiKey: event.target.value })}
          autoComplete="off"
          placeholder={model.hasApiKey ? 'Оставь пустым, чтобы не менять' : 'Вставь API-ключ'}
          required={required && !model.hasApiKey}
        />
      </FormField>
    </div>
  );
}
