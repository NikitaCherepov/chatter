import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { openToolInLastLayout } from '../lib/tools';
import type { BackgroundActivityInput } from '../lib/backgroundActivities';
import s from './BackgroundActivityManager.module.scss';

type Activity = BackgroundActivityInput;
type Snapshot = { activeChatId: number | null; activities: Activity[] };

export function BackgroundActivityManager({ chatId }: { chatId: number | null }) {
  const { t } = useTranslation();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [stopping, setStopping] = useState<string[]>([]);
  const label = t('chat.composer.activityManager');

  useEffect(() => {
    let disposed = false;
    let receivedUpdate = false;
    setOpen(false);
    setActivities([]);
    setStopping([]);
    const apply = (snapshot: Snapshot) => {
      if (!disposed && snapshot.activeChatId === chatId) setActivities(snapshot.activities);
    };
    const unsubscribe = window.electronAPI?.onBackgroundActivitiesChanged?.(snapshot => {
      receivedUpdate = true;
      apply(snapshot);
    });
    void window.electronAPI?.setActiveBackgroundChat?.(chatId).then(snapshot => {
      if (!receivedUpdate) apply(snapshot);
    }).catch(() => {});
    return () => { disposed = true; unsubscribe?.(); };
  }, [chatId]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  const openActivity = async (activity: Activity) => {
    try {
      if (activity.openTarget.type === 'app_tool') {
        openToolInLastLayout(activity.openTarget.toolId, {
          title: activity.openTarget.title || activity.title || activity.openTarget.toolId,
          activeChatId: chatId,
        });
      } else {
        await window.electronAPI.openBrowserSession(activity.openTarget.sessionId);
      }
      setOpen(false);
    } catch {
      toast.error(t('chat.activityManager.actionFailed'));
    }
  };
  const stopActivity = async (activity: Activity) => {
    if (activity.openTarget.type !== 'browser_session') return;
    setStopping(ids => [...ids, activity.id]);
    try {
      await window.electronAPI.stopBrowserSession(activity.openTarget.sessionId);
    } catch {
      toast.error(t('chat.activityManager.actionFailed'));
    } finally {
      setStopping(ids => ids.filter(id => id !== activity.id));
    }
  };

  return <div className={s.root} ref={root}>
    <button ref={trigger} type="button" className={s.trigger} aria-label={label} title={label}
      aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M8 8h.01M8 12h.01M8 16h.01M12 8h5M12 12h5M12 16h5" />
      </svg>
    </button>
    <AnimatePresence>
      {open && <motion.section id={panelId} className={s.panel} aria-label={label}
        initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }} animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: reduceMotion ? 0 : 6 }} transition={{ duration: reduceMotion ? 0 : .16 }}>
        <div className={s.heading}>{label}<span>{activities.length}</span></div>
        {activities.length === 0 ? <p className={s.empty}>{t('chat.activityManager.empty')}</p> :
          <div className={s.list}>{activities.map(activity => <div key={activity.id} className={s.row}>
            <button type="button" className={s.activity} onClick={() => void openActivity(activity)}>
              <span className={s.thumbnail}>{activity.image
                ? <img src={activity.image} alt="" draggable={false} />
                : activity.title.slice(0, 1).toUpperCase()}</span>
              <span className={s.meta}>
                <span className={s.title} title={activity.title}>{activity.title}</span>
                <span className={`${s.status} ${s[activity.status]}`}><i />{t(`chat.activityManager.${activity.status}`)}</span>
              </span>
              <span aria-hidden="true">↗</span>
            </button>
            {activity.openTarget.type === 'browser_session' && <button type="button" className={s.stop}
              disabled={stopping.includes(activity.id)} onClick={() => void stopActivity(activity)}
              aria-label={t('chat.activityManager.stop', { title: activity.title })}
              title={t('chat.activityManager.stop', { title: activity.title })}>✕</button>}
          </div>)}</div>}
      </motion.section>}
    </AnimatePresence>
  </div>;
}
