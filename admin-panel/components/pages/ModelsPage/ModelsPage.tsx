import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderModelConfig, Settings } from '../../../lib/types';
import { useModelCoefficients } from '../../../lib/useModelCoefficients';
import { ActionBar } from '../../ui/ActionBar/ActionBar';
import grid from '../../ui/PageGrid/PageGrid.module.css';
import { ManualModelListEditor } from './ManualModelListEditor';
import { ModelListEditor, ProviderModelFields } from './ModelListEditor';
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
  const { getCoefficient, saveCoefficient, state: coeffState } = useModelCoefficients();
  const coefficientManager = { get: getCoefficient, save: saveCoefficient };
  const { t } = useTranslation();

  const updateVision = (patch: Partial<ProviderModelConfig>) => {
    setSettings((current) => ({
      ...current,
      visionModel: { ...current.visionModel, ...patch },
    }));
  };

  return (
    <form className={grid.stack} onSubmit={onSave} noValidate>
      <details className={styles.section} open>
        <summary>
          <span>
            <strong>Auto</strong>
            <small>{t('models.auto.subtitle')}</small>
          </span>
        </summary>
        <div className={styles.sectionBody}>
          <ModelListEditor
            title="PRO"
            description={t('models.pro.description')}
            models={settings.proModels}
            onChange={(proModels) => setSettings((current) => ({ ...current, proModels }))}
            required
            coefficientManager={coefficientManager}
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
          />
          {coeffState && <p className={styles.empty}>{coeffState}</p>}
        </div>
      </details>

      <details className={styles.section}>
        <summary>
          <span>
            <strong>Vision</strong>
            <small>{t('models.vision.subtitle')}</small>
          </span>
        </summary>
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
      </details>

      <details className={styles.section}>
        <summary>
          <span>
            <strong>{t('models.manual.title')}</strong>
            <small>{t('models.manual.subtitle')}</small>
          </span>
        </summary>
        <div className={styles.sectionBody}>
          <ManualModelListEditor
            models={settings.manualModels}
            onChange={(manualModels) =>
              setSettings((current) => ({ ...current, manualModels }))
            }
          />
        </div>
      </details>

      <ActionBar saving={saving} state={saveState} />
    </form>
  );
}