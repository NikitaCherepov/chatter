import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './McpSettings.module.scss';

export function McpConnectionName({
  name,
  disabled,
  onSave,
}: {
  name: string;
  disabled?: boolean;
  onSave: (name: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [composing, setComposing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const save = useRef(onSave);
  save.current = onSave;
  const pending = useRef<{ name: string; result: Promise<boolean> } | null>(null);
  const next = draft?.trim() || '';
  const persist = useCallback((value: string) => {
    if (pending.current?.name === value) return;
    setSaving(true);
    setFailed(null);
    const request = {
      name: value,
      result: Promise.resolve(pending.current?.result)
        .then(() => save.current(value))
        .catch(() => false),
    };
    pending.current = request;
    void request.result.then((saved) => {
      if (pending.current !== request) return;
      pending.current = null;
      if (!saved) setFailed(value);
      else if (document.activeElement !== input.current)
        setDraft((current) => (current?.trim() === value ? null : current));
      setSaving(false);
    });
  }, []);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!editing || disabled || composing || saving || !next || next === name || next === failed)
      return;
    const timer = setTimeout(() => persist(next), 500);
    return () => clearTimeout(timer);
  }, [composing, disabled, editing, failed, name, next, persist, saving]);

  const finish = (cancel = false) => {
    setEditing(false);
    setComposing(false);
    if (cancel) {
      setDraft(null);
      setFailed(null);
      return;
    }
    if (!disabled && next && next !== (pending.current?.name ?? name)) persist(next);
    setDraft(next && (pending.current || next !== name) ? next : null);
  };

  if (!editing) {
    return (
      <button
        type="button"
        className={styles.connectionName}
        disabled={disabled}
        title={t('mcp.name')}
        aria-invalid={!!failed && next === failed}
        aria-busy={saving}
        onClick={() => setEditing(true)}
      >
        {draft || name}
      </button>
    );
  }

  return (
    <input
      ref={input}
      className={styles.connectionName}
      aria-label={t('mcp.name')}
      aria-invalid={!!failed && next === failed}
      aria-busy={saving}
      disabled={disabled}
      value={draft ?? name}
      maxLength={120}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      onBlur={() => finish()}
      onChange={(event) => {
        setFailed(null);
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape' || event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          finish(event.key === 'Escape');
        }
      }}
    />
  );
}
