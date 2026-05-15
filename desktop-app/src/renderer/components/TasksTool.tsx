import React, { useEffect, useState } from 'react';
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

const STATUS_LABELS: Record<StatusFilter, string> = {
  pending: 'Ожидание',
  done: 'Выполнено',
  all: 'Все',
};

const RECURRENCE_LABELS: Record<string, string> = {
  once: 'Один раз',
  daily: 'Каждый день',
  weekly: 'Каждую неделю',
};

const TASK_TYPE_LABELS: Record<string, string> = {
  message: 'Сообщение',
  ai_instruction: 'AI-задача',
  web_search: 'Поиск в сети',
  email_check: 'Проверка почты',
  smart_home: 'Умный дом',
};

export function TasksTool() {
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
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  const preview = (text: string, max = 60) => {
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) return 'Без описания';
    return compact.length <= max ? compact : compact.slice(0, max) + '...';
  };

  const statusDot = (status: api.TaskStatus) => {
    switch (status) {
      case 'pending': return s.dotPending;
      case 'done': return s.dotDone;
      case 'error': return s.dotError;
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
              {(Object.entries(STATUS_LABELS) as [StatusFilter, string][]).map(([key, label]) => (
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
            {loading && <div className={s.hint}>Загрузка...</div>}
            {!loading && tasks.length === 0 && (
              <div className={s.hint}>Нет задач</div>
            )}
            {!loading && tasks.map((task) => (
              <div
                key={task.id}
                className={s.taskItem}
              >
                <div className={s.taskItemHeader}>
                  <div className={s.taskItemLeft}>
                    <span className={`${s.statusDot} ${statusDot(task.status)}`} />
                    <span className={s.taskItemType}>{TASK_TYPE_LABELS[task.task_type] || task.task_type}</span>
                  </div>
                  <span className={s.taskItemDate}>{formatTs(task.execute_at)}</span>
                </div>
                <div className={s.taskItemPreview}>{preview(task.payload, 80)}</div>
                <div className={s.taskItemMeta}>
                  <span className={s.taskItemRecurrence}>
                    {RECURRENCE_LABELS[task.recurrence_type] || task.recurrence_type}
                  </span>
                  <span className={s.taskItemId}>#{task.id}</span>
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
