import { useTranslation } from 'react-i18next';
import type { ProviderModelConfig } from '../../../lib/types';
import { FormField } from '../../ui/FormField/FormField';
import { SecretState } from '../../ui/SecretState/SecretState';
import styles from './ModelsPage.module.css';

type CoefficientManager = {
  /** Returns saved coefficient for the uniqueId (or undefined if not set). */
  get: (uniqueId: string | undefined | null) => number | undefined;
  /** Persists new coefficient for the uniqueId. */
  save: (uniqueId: string, coefficient: number) => void | Promise<void>;
};

type Props = {
  title?: string;
  description?: string;
  models: ProviderModelConfig[];
  onChange: (models: ProviderModelConfig[]) => void;
  required?: boolean;
  emptyText?: string;
  /** When provided, each model card gets a cost coefficient field. */
  coefficientManager?: CoefficientManager;
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
  emptyText,
  coefficientManager,
}: Props) {
  const { t } = useTranslation();
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
      {!models.length && <p className={styles.empty}>{emptyText || t('models.common.emptyText')}</p>}
      {models.map((model, index) => (
        <div className={styles.modelSequence} key={model.id}>
          {index > 0 && <span className={styles.nextLabel}>{t('models.common.nextModel')}</span>}
          <details className={styles.modelCard} open={index === 0 ? true : undefined}>
            <summary>
              <span className={styles.order}>{index + 1}</span>
              <span className={styles.modelTitle}>
                <strong>{model.model || t('models.common.newModel')}</strong>
                <span>{model.baseUrl || t('models.common.providerNotSet')}</span>
              </span>
              <SecretState configured={model.hasApiKey || Boolean(model.apiKey)} />
            </summary>
            <div className={styles.modelBody}>
              <ProviderModelFields
                model={model}
                onChange={(patch) => update(index, patch)}
                coefficientManager={coefficientManager}
              />
              <div className={styles.modelActions}>
                <button className="buttonSecondary" type="button" disabled={index === 0} onClick={() => move(index, -1)}>
                  {t('models.common.moveUp')}
                </button>
                <button className="buttonSecondary" type="button" disabled={index === models.length - 1} onClick={() => move(index, 1)}>
                  {t('models.common.moveDown')}
                </button>
                <button
                  className={styles.dangerButton}
                  type="button"
                  disabled={required && models.length === 1}
                  onClick={() => onChange(models.filter((_, itemIndex) => itemIndex !== index))}
                >
                  {t('models.common.remove')}
                </button>
              </div>
            </div>
          </details>
        </div>
      ))}
      <button className="buttonSecondary" type="button" onClick={() => onChange([...models, newModel()])}>
        {t('models.common.addModel')}
      </button>
    </div>
  );
}

export function ProviderModelFields({
  model,
  onChange,
  required = true,
  coefficientManager,
}: {
  model: ProviderModelConfig;
  onChange: (patch: Partial<ProviderModelConfig>) => void;
  required?: boolean;
  coefficientManager?: CoefficientManager;
}) {
  const { t } = useTranslation();
  return (
    <div className={styles.fields}>
      <div className={styles.twoColumns}>
        <FormField label={t('models.providerFields.baseUrl')}>
          <input
            type="url"
            value={model.baseUrl}
            onChange={(event) => onChange({ baseUrl: event.target.value })}
            placeholder="https://openrouter.ai/api/v1"
            required={required}
          />
        </FormField>
        <FormField label={t('models.providerFields.modelName')}>
          <input
            value={model.model}
            onChange={(event) => onChange({ model: event.target.value })}
            placeholder="provider/model-name"
            required={required}
          />
        </FormField>
      </div>
      <FormField
        label={t('models.providerFields.quotaId')}
        hint={t('models.providerFields.quotaIdHint')}
      >
        <input
          value={model.uniqueId ?? ''}
          onChange={(event) => onChange({ uniqueId: event.target.value })}
          placeholder={`auto-${(model.model || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model'}`}
        />
      </FormField>
      {coefficientManager && (
        <FormField
          label={t('models.providerFields.coefficient')}
          hint={t('models.providerFields.coefficientHint')}
        >
          <input
            type="number"
            min={0}
            step={0.1}
            value={coefficientManager.get(model.uniqueId) ?? 1}
            onBlur={(event) => {
              const value = Number(event.target.value);
              const coef = Number.isFinite(value) && value >= 0 ? value : 1;
              const id = model.uniqueId?.trim();
              if (id) void coefficientManager.save(id, coef);
            }}
          />
        </FormField>
      )}
      <FormField
        label={t('models.providerFields.apiKey')}
        state={<SecretState configured={model.hasApiKey || Boolean(model.apiKey)} />}
        hint={model.hasApiKey ? t('models.providerFields.apiKeyHint') : undefined}
      >
        <input
          type="password"
          value={model.apiKey}
          onChange={(event) => onChange({ apiKey: event.target.value })}
          autoComplete="off"
          placeholder={model.hasApiKey ? t('models.providerFields.apiKeyPlaceholderExisting') : t('models.providerFields.apiKeyPlaceholderNew')}
          required={required && !model.hasApiKey}
        />
      </FormField>
    </div>
  );
}
