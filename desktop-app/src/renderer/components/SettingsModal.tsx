import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import s from './SettingsModal.module.scss';

type Props = {
  onClose: () => void;
};

type Section = 'account' | 'prompt';

const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
  exit: { opacity: 0, y: 16, transition: { duration: 0.15 } },
};

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'account', label: 'Аккаунт' },
  { key: 'prompt', label: 'Промпт' },
];

export function SettingsModal({ onClose }: Props) {
  const { user, setUser } = useAuth();
  const [section, setSection] = useState<Section>('account');
  const [nameValue, setNameValue] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setNameValue(user.name || '');
    }
  }, [user]);

  const handleSaveName = async () => {
    const trimmed = nameValue.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      // TODO: add API endpoint when backend supports it
      // For now, update locally
      const updated = { ...user!, name: trimmed };
      setUser(updated);
      localStorage.setItem('chatter_user', JSON.stringify(updated));
      toast.success('Имя сохранено');
    } catch (err) {
      console.error('Failed to save name:', err);
      toast.error('Не удалось сохранить имя');
    } finally {
      setSaving(false);
    }
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveName();
    }
  };

  return (
    <motion.div
      className={s.overlay}
      onClick={onClose}
      variants={overlayVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <motion.div
        className={s.modal}
        onClick={(e) => e.stopPropagation()}
        variants={modalVariants}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        <div className={s.header}>
          <span className={s.title}>Настройки</span>
          <button className={s.closeBtn} onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className={s.body}>
          {/* Left menu */}
          <div className={s.menu}>
            {SECTIONS.map((sec) => (
              <button
                key={sec.key}
                className={`${s.menuItem} ${sec.key === section ? s.menuItemActive : ''}`}
                onClick={() => setSection(sec.key)}
              >
                {sec.label}
              </button>
            ))}
          </div>

          {/* Right panel */}
          {section === 'account' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>Аккаунт</div>
              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Имя</label>
                <input
                  className={s.fieldInput}
                  type="text"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={handleNameKeyDown}
                  placeholder="Введите имя..."
                  autoFocus
                />
              </div>
              <button
                className={s.saveBtn}
                onClick={handleSaveName}
                disabled={saving || !nameValue.trim()}
              >
                {saving ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          )}

          {section === 'prompt' && (
            <div className={s.panel}>
              <div className={s.panelTitle}>Промпт</div>
              <div className={s.promptEmpty}>
                Пока ничего нет
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
