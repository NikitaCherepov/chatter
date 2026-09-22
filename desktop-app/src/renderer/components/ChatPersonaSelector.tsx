import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { Select } from './Select';
import s from './ChatPersonaSelector.module.scss';

type Persona = { id: number; name: string; description: string; is_primary: number; is_default: number };
type ChatMemorySettings = { persona_override_id: number | null };

export function ChatPersonaSelector({ chatId, embedded = false }: { chatId: number; embedded?: boolean }) {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [overrideId, setOverrideId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [personaResult, settingsResult] = await Promise.all([
        api.apiFetch<{ personas: Persona[] }>('/api/v1/memory/personas'),
        api.apiFetch<{ settings: ChatMemorySettings }>(`/api/v1/chats/${chatId}/memory-settings`),
      ]);
      setPersonas(personaResult.personas);
      setOverrideId(settingsResult.settings.persona_override_id);
    } catch {
      toast.error('Не удалось загрузить персоны');
    }
  }, [chatId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener('chatter:personas-changed', refresh);
    return () => window.removeEventListener('chatter:personas-changed', refresh);
  }, [load]);

  const activeGlobal = personas.find(persona => persona.is_default === 1);
  const options = useMemo(() => [
    {
      value: '',
      label: 'Автоматически',
      hint: activeGlobal ? `Глобально: ${activeGlobal.is_primary === 1 ? 'Основное' : activeGlobal.name}` : undefined,
    },
    ...personas.map(persona => ({
      value: String(persona.id),
      label: persona.is_primary === 1 ? 'Основное' : persona.name,
      hint: persona.is_primary === 1 ? `Имя аккаунта: ${persona.name}` : persona.description || undefined,
    })),
  ], [personas, activeGlobal]);

  const handleChange = async (value: string) => {
    const next = value ? Number(value) : null;
    const previous = overrideId;
    setOverrideId(next);
    setSaving(true);
    try {
      const result = await api.apiFetch<{ settings: ChatMemorySettings }>(`/api/v1/chats/${chatId}/memory-settings`, {
        method: 'PATCH',
        body: JSON.stringify({ persona_override_id: next }),
      });
      setOverrideId(result.settings.persona_override_id);
    } catch {
      setOverrideId(previous);
      toast.error('Не удалось выбрать персону для чата');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`${s.root} ${embedded ? s.embedded : ''}`}>
      {!embedded && <span className={s.label}>Персона:</span>}
      <div className={s.select}>
        <Select options={options} value={overrideId === null ? '' : String(overrideId)} onChange={handleChange} disabled={saving} maxVisibleItems={6} />
      </div>
    </div>
  );
}
