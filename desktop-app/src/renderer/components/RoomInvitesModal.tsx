import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type { RoomInvite } from '../lib/api';
import s from './RoomInvitesModal.module.scss';

type RoomInvitesModalProps = {
  open: boolean;
  invites: RoomInvite[];
  loading: boolean;
  onClose: () => void;
  onRevoke: (token: string) => void;
  onCopy: (invite: RoomInvite) => void;
  onCreate: () => void;
};

export function RoomInvitesModal({ open, invites, loading, onClose, onRevoke, onCopy, onCreate }: RoomInvitesModalProps) {
  const { t } = useTranslation();
  return (
    <motion.div
      key="room-invites-modal"
      className={s.overlay}
      onClick={onClose}
      style={{ pointerEvents: open ? 'auto' : 'none' }}
      variants={{
        hidden: { opacity: 0 },
        visible: { opacity: 1 },
        exit: { opacity: 0 },
      }}
      initial="hidden"
      animate={open ? 'visible' : 'hidden'}
      exit="exit"
    >
      <motion.div
        className={s.dialog}
        onClick={(e) => e.stopPropagation()}
        variants={{
          hidden: { opacity: 0, y: 16 },
          visible: { opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' as const } },
          exit: { opacity: 0, y: 16, transition: { duration: 0.15 } },
        }}
        initial="hidden"
        animate={open ? 'visible' : 'hidden'}
        exit="exit"
      >
        <div className={s.header}>
          <div className={s.title}>{t('chat.room.activeInvitesTitle')}</div>
          <button type="button" className={s.closeBtn} onClick={onClose} aria-label={t('common.close')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className={s.body}>
          {loading && <div className={s.hint}>{t('common.loading')}</div>}
          {!loading && invites.length === 0 && <div className={s.hint}>{t('chat.room.noInvites')}</div>}
          {!loading && invites.length > 0 && (
            <div className={s.list}>
              {invites.map((invite) => (
                <div key={invite.token} className={s.item}>
                  <div className={s.link}>{invite.token}</div>
                  <div className={s.itemActions}>
                    <button type="button" onClick={() => onCopy(invite)}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                      {t('chat.room.copyInvite')}
                    </button>
                    <button type="button" className={s.revoke} onClick={() => onRevoke(invite.token)}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>
                      {t('chat.room.revokeInvite')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className={s.footer}>
          <button type="button" className={s.createBtn} onClick={onCreate}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            {t('chat.room.newInvite')}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
