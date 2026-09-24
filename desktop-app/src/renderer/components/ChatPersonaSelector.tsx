import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { Select } from './Select';
import s from './ChatPersonaSelector.module.scss';

type Persona = { id: number; name: string; description: string; is_primary: number; is_default: number };
type ChatMemorySettings = { persona_override_id: number | null };

export function ChatPersonaSelector({ chatId, embedded = false }: { chatId: number; embedded?: boolean }) {
  const { t } = useTranslation();
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
      toast.error(t('chat.memory.personasLoadFailed'));
    }
  }, [chatId, t]);

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
      label: t('chat.memory.personaAutomatic'),
      hint: activeGlobal
        ? t('chat.memory.personaGlobal', {
            name: activeGlobal.is_primary === 1 ? t('chat.memory.personaMain') : activeGlobal.name,
          })
        : undefined,
    },
    ...personas.map(persona => ({
      value: String(persona.id),
      label: persona.is_primary === 1 ? t('chat.memory.personaMain') : persona.name,
      hint: persona.is_primary === 1
        ? t('chat.memory.personaAccountName', { name: persona.name })
        : persona.description || undefined,
    })),
  ], [personas, activeGlobal, t]);

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
      toast.error(t('chat.memory.personaSelectFailed'));
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
