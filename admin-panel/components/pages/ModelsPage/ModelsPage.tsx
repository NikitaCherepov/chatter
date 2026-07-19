import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { Settings } from '../../lib/types';
import { ActionBar } from '../ui/ActionBar';
import { Card } from '../ui/Card';
import { FormField } from '../ui/FormField';
import { SecretState } from '../ui/SecretState';
import grid from '../ui/PageGrid.module.css';

type Props = { settings: Settings; setSettings: Dispatch<SetStateAction<Settings>>; apiKey: string; saving: boolean; saveState: string; onApiKeyChange: (value: string) => void; onSave: (event: FormEvent) => void };

export function ModelsPage({ settings, setSettings, apiKey, saving, saveState, onApiKeyChange, onSave }: Props) {
  return <form className={grid.stack} onSubmit={onSave}><Card title="Основной провайдер" description="OpenAI-совместимый API для чата и инструментов"><div className={grid.fields}><div className={grid.twoColumns}><FormField label="Адрес API"><input type="url" value={settings.aiBaseUrl} onChange={(event) => setSettings((current) => ({ ...current, aiBaseUrl: event.target.value }))} required /></FormField><FormField label="Модель" hint="Если оставить пустым, backend использует модель по умолчанию"><input value={settings.aiModel} onChange={(event) => setSettings((current) => ({ ...current, aiModel: event.target.value }))} placeholder="По умолчанию из backend" /></FormField></div><FormField label="API-ключ" state={<SecretState configured={settings.hasAiApiKey} />} hint="Оставь поле пустым, чтобы сохранить текущий ключ"><input type="password" value={apiKey} onChange={(event) => onApiKeyChange(event.target.value)} autoComplete="off" placeholder="Оставь пустым, чтобы не менять" /></FormField></div></Card><Card title="Каталог моделей" description="Несколько моделей, коэффициенты стоимости и маршрутизация"><div className="emptyInline"><strong>Следующий этап</strong><span>Здесь появятся доступные модели провайдера и их индивидуальные настройки.</span></div></Card><ActionBar saving={saving} state={saveState} /></form>;
}
