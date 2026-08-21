import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ManualModelConfig } from '../../../lib/types';
import { useModelCoefficients } from '../../../lib/useModelCoefficients';
import { usePersistentOpenState } from '../../../lib/usePersistentOpenState';
import { FormField } from '../../ui/FormField/FormField';
import { Toggle } from '../../ui/Toggle/Toggle';
import { AnimatedDetails } from './AnimatedDetails';
import { DragGrip, ModelOverlaySummary, SortableModelsDnd } from './SortableModels';
import { ModelSummaryChips, ProviderModelFields, resolveProviderKind } from './ModelListEditor';
import styles from './ModelsPage.module.css';

const newManualModel = (): ManualModelConfig => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: `manual-new-${suffix}`,
    uniqueId: `manual-${suffix}`,
    baseUrl: '',
    proxyUrl: '',
    model: '',
    apiKey: '',
    hasApiKey: false,
    name: '',
    description: '',
    supportsVision: false,
    supportsTools: true,
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
  // Load coefficients once on first mount; inject server values into models
  // that have NOT been locally edited since.
  const {
    getCoefficient,
    saveCoefficient,
    getOverride,
    saveOverride,
    state: coeffState,
  } = useModelCoefficients();
  const { t } = useTranslation();
  const { isOpen, setOpen, setAll } = usePersistentOpenState('cards:manual');
  // Billing-only manager for ProviderModelFields — manual editor handles coefficients separately.
  const billingManager = { getOverride, saveOverride };
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    onChange(
      models.map((model) => {
        const fromServer = getCoefficient(model.uniqueId);
        if (fromServer === undefined) return model;
        return { ...model, coefficient: fromServer };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (index: number, patch: Partial<ManualModelConfig>) => {
    onChange(
      models.map((model, itemIndex) => (itemIndex === index ? { ...model, ...patch } : model)),
    );
  };
  const cardKey = (model: ManualModelConfig) => model.uniqueId?.trim() || model.id;

  return (
    <div className={styles.modelList}>
      <div className={styles.listHeading}>
        <div>
          <h3>{t('models.manual.catalog')}</h3>
          <p>{t('models.manual.fallbackHint')}</p>
        </div>
      </div>
      {!models.length && <p className={styles.empty}>{t('models.manual.emptyText')}</p>}
      {models.length > 1 && (
        <div className={styles.listToolbar}>
          <button
            className="buttonSecondary"
            type="button"
            onClick={() => setAll(models.map(cardKey), true)}
          >
            {t('models.common.expandAll')}
          </button>
          <button
            className="buttonSecondary"
            type="button"
            onClick={() => setAll(models.map(cardKey), false)}
          >
            {t('models.common.collapseAll')}
          </button>
        </div>
      )}
      <SortableModelsDnd
        items={models}
        onReorder={onChange}
        keyOf={cardKey}
        renderOverlay={(model, order) => (
          <ModelOverlaySummary
            order={order}
            title={model.name || model.model || t('models.manual.newModel')}
            subtitle={model.model || t('models.manual.modelNotSet')}
          />
        )}
      >
        {(model, index, dragHandleProps) => {
          const key = cardKey(model);
          return (
            <div className={styles.modelSequence}>
              {index > 0 && (
                <span className={styles.nextLabel}>{t('models.common.nextModel')}</span>
              )}
              <AnimatedDetails
                className={styles.modelCard}
                open={isOpen(key, index === 0)}
                onToggle={(next) => setOpen(key, next)}
                summary={
                  <>
                    <DragGrip
                      dragHandleProps={dragHandleProps}
                      title={t('models.common.dragToReorder')}
                    />
                    <span className={styles.order}>{index + 1}</span>
                    <span className={styles.modelTitle}>
                      <strong>{model.name || model.model || t('models.manual.newModel')}</strong>
                      <span>{model.model || t('models.manual.modelNotSet')}</span>
                    </span>
                    <ModelSummaryChips
                      providerKind={
                        getOverride(model.uniqueId)?.providerKind ||
                        resolveProviderKind(model.baseUrl)
                      }
                      prices={
                        getOverride(model.uniqueId)
                          ? {
                              input: getOverride(model.uniqueId)?.inputPricePerMillion,
                              output: getOverride(model.uniqueId)?.outputPricePerMillion,
                            }
                          : null
                      }
                      coefficient={model.coefficient}
                      badges={[
                        ...(model.supportsVision ? [t('models.manual.supportsVision')] : []),
                        ...(!model.supportsTools ? [t('models.manual.noTools')] : []),
                        ...(model.adminOnly ? [t('models.manual.adminOnly')] : []),
                      ]}
                    />
                  </>
                }
              >
                <div className={styles.modelBody}>
                  <ProviderModelFields
                    model={model}
                    onChange={(patch) => update(index, patch)}
                    coefficientManager={billingManager}
                  />
                  <div className={styles.twoColumns}>
                    <FormField label={t('models.manual.nameLabel')}>
                      <input
                        value={model.name}
                        onChange={(event) => update(index, { name: event.target.value })}
                        placeholder={t('models.manual.namePlaceholder')}
                        required
                      />
                    </FormField>
                    <FormField label={t('models.manual.uniqueIdLabel')}>
                      <input
                        value={model.uniqueId}
                        onChange={(event) => update(index, { uniqueId: event.target.value })}
                        required
                      />
                    </FormField>
                  </div>
                  <FormField label={t('models.manual.descriptionLabel')}>
                    <input
                      value={model.description}
                      onChange={(event) => update(index, { description: event.target.value })}
                      placeholder={t('models.manual.descriptionPlaceholder')}
                    />
                  </FormField>
                  <FormField
                    label={t('models.providerFields.coefficient')}
                    hint={t('models.providerFields.coefficientHint')}
                  >
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={model.coefficient ?? 1}
                      onChange={(event) => {
                        const value = Number(event.target.value);
                        update(index, {
                          coefficient: Number.isFinite(value) && value >= 0 ? value : 1,
                        });
                      }}
                      onBlur={(event) =>
                        void saveCoefficient(model.uniqueId, Number(event.target.value))
                      }
                    />
                  </FormField>
                  <div className={styles.toggleRow}>
                    <Toggle
                      checked={model.supportsVision}
                      onChange={(supportsVision) => update(index, { supportsVision })}
                      label={t('models.manual.supportsVision')}
                    />
                    {resolveProviderKind(model.baseUrl) === 'custom' && (
                      <Toggle
                        checked={!model.supportsTools}
                        onChange={(textOnly) => update(index, { supportsTools: !textOnly })}
                        label={t('models.manual.textOnly')}
                      />
                    )}
                    <Toggle
                      checked={model.adminOnly}
                      onChange={(adminOnly) => update(index, { adminOnly })}
                      label={t('models.manual.adminOnly')}
                    />
                  </div>
                  <div className={styles.modelActions}>
                    <button
                      className={styles.dangerButton}
                      type="button"
                      onClick={() => onChange(models.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      {t('models.manual.remove')}
                    </button>
                  </div>
                </div>
              </AnimatedDetails>
            </div>
          );
        }}
      </SortableModelsDnd>
      <button
        className="buttonSecondary"
        type="button"
        onClick={() => onChange([...models, newManualModel()])}
      >
        {t('models.manual.addModel')}
      </button>
      {coeffState && <p className={styles.empty}>{coeffState}</p>}
    </div>
  );
}
