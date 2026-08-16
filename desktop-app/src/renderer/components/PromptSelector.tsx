import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import s from './PromptSelector.module.scss';

/** Один элемент в селекторе — либо default-промпт, либо custom. */
export type PromptOption = {
  id: number;
  name: string;
  description: string;
  /** 'default' — системный пресет; 'custom' — создан юзером */
  kind: 'default' | 'custom';
};

type Props = {
  options: PromptOption[];
  value: number | null;
  onChange: (id: number) => void;
  disabled?: boolean;
  placeholder?: string;
  maxVisibleItems?: number;
  allowCreate?: boolean;
};

const NEW_PROMPT_ID = -1;

export function PromptSelector({ options, value, onChange, disabled = false, placeholder, maxVisibleItems = 6, allowCreate = true }: Props) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t('promptSelector.placeholder');
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const defaults = useMemo(() => options.filter(o => o.kind === 'default'), [options]);
  const customs  = useMemo(() => options.filter(o => o.kind === 'custom'),  [options]);

  const q = search.toLowerCase().trim();
  const filteredDefaults = useMemo(() => q ? defaults.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) : defaults, [q, defaults]);
  const filteredCustoms  = useMemo(() => q ? customs.filter(p  => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)) : customs,  [q, customs]);

  const selectedLabel = useMemo(() => {
    if (value === NEW_PROMPT_ID) return t('promptSelector.newPrompt');
    const found = options.find(p => p.id === value);
    return found ? found.name : resolvedPlaceholder;
  }, [value, options, resolvedPlaceholder, t]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Focus search on open
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [isOpen]);

  const handleSelect = (id: number) => {
    onChange(id);
    setIsOpen(false);
    setSearch('');
  };

  const renderBadge = (kind: 'default' | 'custom') => (
    <span className={`${s.badge} ${kind === 'default' ? s.badgeDefault : s.badgeCustom}`}>
      {kind === 'default' ? t('promptSelector.defaultBadge') : t('promptSelector.customBadge')}
    </span>
  );

  return (
    <div className={s.root} ref={rootRef}>
      <button
        className={s.trigger}
        onClick={() => { if (!disabled) setIsOpen(v => !v); }}
        disabled={disabled}
        type="button"
      >
        {value === null ? (
          <span className={s.triggerPlaceholder}>{resolvedPlaceholder}</span>
        ) : (
          <span>{selectedLabel}</span>
        )}
        <span className={`${s.triggerArrow} ${isOpen ? s.triggerArrowOpen : ''}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {isOpen && (
        <div className={s.dropdown}>
          <div className={s.searchWrap}>
            <input
              ref={searchRef}
              className={s.searchInput}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('common.searchPlaceholder')}
            />
          </div>
          <div className={s.list} style={{ maxHeight: `${maxVisibleItems * 52}px` }}>
            {filteredDefaults.map(p => (
              <button
                key={p.id}
                className={`${s.option} ${p.id === value ? s.optionActive : ''}`}
                onClick={() => handleSelect(p.id)}
                type="button"
              >
                <span className={s.optionTop}>
                  <span className={s.optionName}>{p.name}</span>
                  {renderBadge(p.kind)}
                </span>
                {p.description && <span className={s.optionDesc}>{p.description}</span>}
              </button>
            ))}

            {filteredCustoms.length > 0 && (
              <>
                <div className={s.sectionLabel}>{t('promptSelector.myPrompts')}</div>
                {filteredCustoms.map(p => (
                  <button
                    key={p.id}
                    className={`${s.option} ${p.id === value ? s.optionActive : ''}`}
                    onClick={() => handleSelect(p.id)}
                    type="button"
                  >
                    <span className={s.optionTop}>
                      <span className={s.optionName}>{p.name}</span>
                      {renderBadge(p.kind)}
                    </span>
                    {p.description && <span className={s.optionDesc}>{p.description}</span>}
                  </button>
                ))}
              </>
            )}

            {(filteredDefaults.length === 0 && filteredCustoms.length === 0) && (
              <div className={s.emptyState}>{t('common.nothingFound')}</div>
            )}

            {allowCreate && (
              <>
                <div className={s.customDivider} />
                <button
                  className={`${s.option} ${value === NEW_PROMPT_ID ? s.optionActive : ''}`}
                  onClick={() => handleSelect(NEW_PROMPT_ID)}
                  type="button"
                >
                  <span className={s.optionTop}>
                    <span className={s.optionName}>{t('promptSelector.newPrompt')}</span>
                    {renderBadge('custom')}
                  </span>
                  <span className={s.optionDesc}>{t('promptSelector.createOwn')}</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
