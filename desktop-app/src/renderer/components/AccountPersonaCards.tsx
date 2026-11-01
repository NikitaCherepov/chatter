import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AvatarImage } from './AvatarImage';
import { resolveImageUrl } from '../lib/api';
import a from './AccountSettings.module.scss';

export type PersonaCardInfo = {
  id: number;
  name: string;
  description: string;
  image_url: string | null;
  is_primary: number;
  is_default: number;
};

export function AccountPersonaCards({
  personas,
  selectedId,
  disabled,
  loading,
  onSelect,
}: {
  personas: PersonaCardInfo[];
  selectedId: number | null;
  disabled: boolean;
  loading: boolean;
  onSelect: (id: number) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const gridId = useId();
  const preview = personas.slice(0, 3);
  const visiblePersonas = expanded ? personas : preview;
  const hiddenCount = Math.max(0, personas.length - preview.length);
  return (
    <div className={a.personaPicker}>
      <div className={a.personaGrid} id={gridId} aria-label={t('settings.account.redesign.personas')}>
        {loading && (
          <span className={a.help} role="status">
            {t('common.loading')}
          </span>
        )}
        {visiblePersonas.map((persona) => (
          <button
            type="button"
            key={persona.id}
            disabled={disabled}
            className={`${a.personaCard} ${selectedId === persona.id ? a.personaSelected : ''}`}
            aria-pressed={selectedId === persona.id}
            onClick={() => onSelect(persona.id)}
          >
            <span className={a.cardAvatar}>
              {persona.image_url ? (
                <AvatarImage src={resolveImageUrl(persona.image_url, 96)} />
              ) : (
                persona.name.trim().slice(0, 1).toLocaleUpperCase()
              )}
            </span>
            <span className={a.cardText}>
              <strong title={persona.name}>{persona.name}</strong>
              <small>
                {persona.description || t('settings.account.redesign.persona')}
              </small>
            </span>
            {persona.is_default === 1 && (
              <svg
                className={a.defaultCheck}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden="true"
              >
                <path d="m5 12 4 4 10-10" />
              </svg>
            )}
          </button>
        ))}
      </div>
      <div className={a.pickerActions}>
        {personas.length > 3 && (
          <button
            type="button"
            className={a.textAction}
            aria-expanded={expanded}
            aria-controls={gridId}
            disabled={disabled}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? t('settings.account.redesign.showLess')
              : t('settings.account.redesign.showMore', { count: hiddenCount })}
          </button>
        )}
        <button
          type="button"
          disabled={disabled || loading}
          className={a.textAction}
          onClick={() => onSelect(-1)}
          aria-pressed={selectedId === -1}
        >
          <span className={a.addIcon} aria-hidden="true">
            +
          </span>
          {t('settings.account.redesign.addPersona')}
        </button>
      </div>
    </div>
  );
}
