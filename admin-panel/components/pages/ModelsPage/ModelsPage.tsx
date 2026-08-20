import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderModelConfig, Settings } from '../../../lib/types';
import { useModelCoefficients } from '../../../lib/useModelCoefficients';
import { usePersistentOpenState } from '../../../lib/usePersistentOpenState';
import { ActionBar } from '../../ui/ActionBar/ActionBar';
import grid from '../../ui/PageGrid/PageGrid.module.css';
import { ManualModelListEditor } from './ManualModelListEditor';
import { ModelListEditor, ProviderModelFields } from './ModelListEditor';
import { OpenRouterMonitorPanel } from './OpenRouterMonitorPanel';
import { AnimatedDetails } from './AnimatedDetails';
import styles from './ModelsPage.module.css';

type Props = {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  saving: boolean;
  saveState: string;
  onSave: (event: FormEvent) => void;
};

export function ModelsPage({ settings, setSettings, saving, saveState, onSave }: Props) {
  // One shared coefficient manager for PRO / LITE / Vision (Manual has its own
  // because its editor hydrates coefficient into ManualModelConfig).
  const {
    getCoefficient,
    setCoefficient,
    saveCoefficient,
    getOverride,
    saveOverride,
    state: coeffState,
  } = useModelCoefficients();
  const coefficientManager = {
    get: getCoefficient,
    set: setCoefficient,
    save: saveCoefficient,
    getOverride,
    saveOverride,
  };
  const { t } = useTranslation();
  // Which top-level sections (Auto / Vision / Manual / Monitor) stay open — persisted.
  const { isOpen: isSectionOpen, setOpen: setSectionOpen } =
    usePersistentOpenState('models:sections');

  const updateVision = (patch: Partial<ProviderModelConfig>) => {
    setSettings((current) => ({
      ...current,
      visionModel: { ...current.visionModel, ...patch },
    }));
  };

  return (
    <form className={grid.stack} onSubmit={onSave} noValidate>
      <AnimatedDetails
        className={styles.section}
        open={isSectionOpen('auto', true)}
        onToggle={(next) => setSectionOpen('auto', next)}
        summary={
          <span>
            <strong>Auto</strong>
            <small>{t('models.auto.subtitle')}</small>
          </span>
        }
      >
        <div className={styles.sectionBody}>
          <ModelListEditor
            title="PRO"
            description={t('models.pro.description')}
            models={settings.proModels}
            onChange={(proModels) => setSettings((current) => ({ ...current, proModels }))}
            required
            coefficientManager={coefficientManager}
            storageKey="pro"
          />
          <div className={styles.divider} />
          <div className={styles.listHeading}>
            <div>
              <h3>LITE</h3>
              <p>{t('models.lite.description')}</p>
            </div>
          </div>
          <ModelListEditor
            models={settings.liteModels}
            onChange={(liteModels) => setSettings((current) => ({ ...current, liteModels }))}
            emptyText={t('models.lite.emptyText')}
            required
            coefficientManager={coefficientManager}
            storageKey="lite"
          />
          {coeffState && <p className={styles.empty}>{coeffState}</p>}
        </div>
      </AnimatedDetails>

      <AnimatedDetails
        className={styles.section}
        open={isSectionOpen('vision')}
        onToggle={(next) => setSectionOpen('vision', next)}
        summary={
          <span>
            <strong>Vision</strong>
            <small>{t('models.vision.subtitle')}</small>
          </span>
        }
      >
        <div className={styles.sectionBody}>
          <div className={styles.singleModel}>
            <div className={styles.modelTitle}>
              <strong>{settings.visionModel.model || t('models.vision.fallbackModel')}</strong>
              <span>{settings.visionModel.baseUrl || t('models.vision.fallbackProvider')}</span>
            </div>
            <ProviderModelFields
              model={settings.visionModel}
              onChange={updateVision}
              required={false}
              coefficientManager={coefficientManager}
            />
          </div>
          {coeffState && <p className={styles.empty}>{coeffState}</p>}
        </div>
      </AnimatedDetails>

      <AnimatedDetails
        className={styles.section}
        open={isSectionOpen('manual')}
        onToggle={(next) => setSectionOpen('manual', next)}
        summary={
          <span>
            <strong>{t('models.manual.title')}</strong>
            <small>{t('models.manual.subtitle')}</small>
          </span>
        }
      >
        <div className={styles.sectionBody}>
          <ManualModelListEditor
            models={settings.manualModels}
            onChange={(manualModels) => setSettings((current) => ({ ...current, manualModels }))}
          />
        </div>
      </AnimatedDetails>

      <AnimatedDetails
        className={styles.section}
        open={isSectionOpen('monitor')}
        onToggle={(next) => setSectionOpen('monitor', next)}
        summary={
          <span>
            <strong>{t('models.monitor.title') || 'OpenRouter monitoring'}</strong>
            <small>
              {t('models.monitor.subtitle') ||
                'Watch pinned providers, notify and switch automatically'}
            </small>
          </span>
        }
      >
        <OpenRouterMonitorPanel />
      </AnimatedDetails>

      <ActionBar saving={saving} state={saveState} />
    </form>
  );
}
