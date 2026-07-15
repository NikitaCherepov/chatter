import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import * as api from '../lib/api';
import s from './TasksTool.module.scss';

const slideVariants = {
  enter: { x: 30, opacity: 0 },
  center: { x: 0, opacity: 1 },
  exit: { x: -30, opacity: 0 },
};

const slideTransition = { duration: 0.18, ease: 'easeOut' as const };

type StatusFilter = 'pending' | 'done' | 'all';

export function TasksTool() {
  const { t, i18n } = useTranslation();
  const statusLabels: Record<StatusFilter, string> = { pending: t('tools.tasks.pending'), done: t('tools.tasks.done'), all: t('tools.tasks.all') };
  const recurrenceLabels: Record<string, string> = { once: t('tools.tasks.once'), daily: t('tools.tasks.daily'), weekly: t('tools.tasks.weekly') };
  const taskTypeLabels: Record<string, string> = { message: t('tools.tasks.message'), ai_instruction: t('tools.tasks.aiTask'), smart_home: t('tools.tasks.smartHome') };
  const [tasks, setTasks] = useState<api.TaskDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');

  const loadTasks = async (status: StatusFilter) => {
    setLoading(true);
    try {
      const res = await api.listTasks(50, status);
      setTasks(res.tasks ?? []);
    } catch (err) {
      console.error('Failed to load tasks:', err);
      setTasks([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTasks(statusFilter); }, [statusFilter]);

  const formatTs = (ts: number) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(i18n.resolvedLanguage || i18n.language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  const preview = (task: api.TaskDto, max = 140) => {
    const raw = (task.payload || '').trim();

    // ai_instruction: payload may be JSON with metadata
    if (task.task_type === 'ai_instruction') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const instruction = typeof parsed.instruction === 'string'
            ? parsed.instruction
            : (typeof parsed._instruction === 'string' ? parsed._instruction : '');
          const createNewChat = parsed._create_new_chat === true;
          const targetChatId = Number.isFinite(Number(parsed._target_chat_id)) ? Math.floor(Number(parsed._target_chat_id)) : null;
          const parts: string[] = [];
          if (instruction) parts.push(instruction.replace(/\s+/g, ' ').trim());
          if (createNewChat) parts.push(t('tools.tasks.newChat'));
          if (targetChatId) parts.push(`→ чат #${targetChatId}`);
          const text = parts.join(' · ');
          if (!text) return t('tools.tasks.noDescription');
          return text.length <= max ? text : text.slice(0, max) + '…';
        }
      } catch {
        // not JSON — show as plain text
      }
    }

    // smart_home: payload is JSON like { device_id, action, color?, brightness? }
    if (task.task_type === 'smart_home') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const action = typeof parsed.action === 'string' ? parsed.action : '';
          const deviceId = typeof parsed.device_id === 'string' ? parsed.device_id : '';
          const color = typeof parsed.color === 'string' ? parsed.color : '';
          const brightness = Number.isFinite(Number(parsed.brightness)) ? Math.round(Number(parsed.brightness)) : null;

          // Human-readable action label
          const ACTION_LABELS: Record<string, string> = {
            on: t('tools.tasks.turnOn'),
            off: t('tools.tasks.turnOff'),
            set_color: t('tools.tasks.color'),
            set_brightness: t('tools.tasks.brightness'),
          };
          const actionLabel = ACTION_LABELS[action] || action;

          const parts: string[] = [];
          if (actionLabel) parts.push(actionLabel);
          if (color) parts.push(color);
          if (brightness !== null) parts.push(`${brightness}%`);
          if (deviceId) parts.push(deviceId);
          const text = parts.join(' · ');
          if (!text) return t('tools.tasks.noDescription');
          return text.length <= max ? text : text.slice(0, max) + '…';
        }
      } catch {
        // not JSON — show as plain text
      }
    }

    const compact = raw.replace(/\s+/g, ' ').trim();
    if (!compact) return t('tools.tasks.noDescription');
    return compact.length <= max ? compact : compact.slice(0, max) + '…';
  };

  const statusDot = (status: api.TaskStatus) => {
    switch (status) {
      case 'pending': return s.dotPending;
      case 'done': return s.dotDone;
      case 'error': return s.dotError;
    }
  };

  const handleDelete = async (taskId: number) => {
    try {
      await api.deleteTask(taskId);
      setTasks(prev => prev.filter(t => t.id !== taskId));
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  };

  return (
    <div className={s.root}>
      <AnimatePresence mode="wait">
        <motion.div
          key="list"
          className={s.listView}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={slideTransition}
        >
          {/* Filter tabs */}
          <div className={s.listHeader}>
            <div className={s.filterRow}>
              {(Object.entries(statusLabels) as [StatusFilter, string][]).map(([key, label]) => (
                <button
                  key={key}
                  className={`${s.filterBtn} ${statusFilter === key ? s.filterBtnActive : ''}`}
                  onClick={() => setStatusFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Tasks list */}
          <div className={s.tasksList}>
            {loading && <div className={s.hint}>{t('common.loading')}</div>}
            {!loading && tasks.length === 0 && (
              <div className={s.hint}>{t('tools.tasks.empty')}</div>
            )}
            {!loading && tasks.map((task) => (
              <div
                key={task.id}
                className={s.taskItem}
              >
                <div className={s.taskItemHeader}>
                  <div className={s.taskItemLeft}>
                    <span className={`${s.statusDot} ${statusDot(task.status)}`} />
                    <span className={s.taskItemType}>{taskTypeLabels[task.task_type] || task.task_type}</span>
                  </div>
                  <span className={s.taskItemDate}>{formatTs(task.execute_at)}</span>
                </div>
                <div className={s.taskItemPreview}>{preview(task)}</div>
                <div className={s.taskItemMeta}>
                  <span className={s.taskItemRecurrence}>
                    {recurrenceLabels[task.recurrence_type] || task.recurrence_type}
                  </span>
                  <div className={s.taskItemActions}>
                    <span className={s.taskItemId}>#{task.id}</span>
                    <button
                      className={s.taskItemDelete}
                      onClick={() => handleDelete(task.id)}
                      title={t('common.delete')}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
