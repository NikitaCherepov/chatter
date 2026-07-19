import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { ProviderModelConfig, Settings } from '../../../lib/types';
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
            <small>Основные цепочки PRO и LITE</small>
          </span>
        </summary>
        <div className={styles.sectionBody}>
          <ModelListEditor
            title="PRO"
            description="Если первая модель недоступна, Chatter автоматически попробует следующую."
            models={settings.proModels}
            onChange={(proModels) => setSettings((current) => ({ ...current, proModels }))}
            required
          />
          <div className={styles.divider} />
          <div className={styles.listHeading}>
            <div>
              <h3>LITE</h3>
              <p>Быстрые модели для простых внутренних задач. Порядок работает так же.</p>
            </div>
          </div>
          <ModelListEditor
            models={settings.liteModels}
            onChange={(liteModels) => setSettings((current) => ({ ...current, liteModels }))}
            emptyText="LITE-модели пока не добавлены."
            required
          />
        </div>
      </details>

      <details className={styles.section}>
        <summary>
          <span>
            <strong>Vision</strong>
            <small>Необязательная отдельная модель; без неё используется первая PRO-модель</small>
          </span>
        </summary>
        <div className={styles.sectionBody}>
          <div className={styles.singleModel}>
            <div className={styles.modelTitle}>
              <strong>{settings.visionModel.model || 'Используется PRO-модель'}</strong>
              <span>{settings.visionModel.baseUrl || 'Отдельный Vision-провайдер не настроен'}</span>
            </div>
            <ProviderModelFields model={settings.visionModel} onChange={updateVision} required={false} />
          </div>
        </div>
      </details>

      <details className={styles.section}>
        <summary>
          <span>
            <strong>Ручные модели</strong>
            <small>Модели, которые пользователь выбирает вместо Auto</small>
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
