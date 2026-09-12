import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import * as api from '../lib/api';
import { registerToolNav } from '../lib/tools';
import { Select, type SelectOption } from './Select';
import s from './TasksTool.module.scss';

const slideVariants = {
  enter: { x: 24, opacity: 0 },
  center: { x: 0, opacity: 1 },
  exit: { x: -24, opacity: 0 },
};

const slideTransition = { duration: 0.18, ease: 'easeOut' as const };

type View = 'list' | 'editor';
type StatusFilter = 'pending' | 'done' | 'all';
type ToolMode = 'all' | 'none' | 'selected';
type NotifySelection = 'auto' | api.TaskNotifyMode;

const timezoneOffsetForTask = (task: api.TaskDto) => (
  task.timezone_offset ?? -new Date().getTimezoneOffset() / 60
);

const toDateTimeInput = (unixSeconds: number, offsetHours: number) => (
  new Date((unixSeconds + offsetHours * 3600) * 1000).toISOString().slice(0, 16)
);

const fromDateTimeInput = (value: string, offsetHours: number) => {
  const localAsUtc = Date.parse(`${value}:00Z`);
  return Number.isFinite(localAsUtc) ? Math.floor(localAsUtc / 1000 - offsetHours * 3600) : 0;
};

const formatOffset = (offset: number) => {
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  const hours = Math.floor(absolute);
  const minutes = Math.round((absolute - hours) * 60);
  return `UTC${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const compactText = (value: string, max: number) => {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
};

export function TasksTool() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage || i18n.language;
  const statusLabels: Record<StatusFilter, string> = {
    pending: t('tools.tasks.pending'),
    done: t('tools.tasks.done'),
    all: t('tools.tasks.all'),
  };
  const recurrenceLabels: Record<api.TaskRecurrenceType, string> = {
    once: t('tools.tasks.once'),
    daily: t('tools.tasks.daily'),
    weekly: t('tools.tasks.weekly'),
  };
  const taskTypeLabels: Record<api.TaskType, string> = {
    message: t('tools.tasks.message'),
    ai_instruction: t('tools.tasks.aiTask'),
    smart_home: t('tools.tasks.smartHome'),
  };

  const [view, setView] = useState<View>('list');
  const [tasks, setTasks] = useState<api.TaskDto[]>([]);
  const [options, setOptions] = useState<api.TaskOptions>({ active_chat_id: 0, chats: [], tools: [] });
  const [loading, setLoading] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [selectedTask, setSelectedTask] = useState<api.TaskDto | null>(null);

  const [payload, setPayload] = useState('');
  const [executeAt, setExecuteAt] = useState('');
  const [timezoneOffset, setTimezoneOffset] = useState(0);
  const [recurrenceType, setRecurrenceType] = useState<api.TaskRecurrenceType>('once');
  const [recurrenceWeekday, setRecurrenceWeekday] = useState(1);
  const [notifyMode, setNotifyMode] = useState<NotifySelection>('auto');
  const [targetMode, setTargetMode] = useState<api.TaskTargetMode>('chat');
  const [targetChatId, setTargetChatId] = useState('');
  const [toolMode, setToolMode] = useState<ToolMode>('all');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [toolQuery, setToolQuery] = useState('');

  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const monday = new Date(Date.UTC(2024, 0, 1 + index));
    return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(monday);
  }), [locale]);

  const weekdayOptions = useMemo<SelectOption[]>(() => weekdays.map((label, index) => ({
    value: String(index + 1),
    label,
  })), [weekdays]);

  const chatOptions = useMemo<SelectOption[]>(() => options.chats.map(chat => ({
    value: String(chat.id),
    label: chat.title || `#${chat.id}`,
    hint: chat.id === options.active_chat_id ? t('tools.tasks.activeChat') : undefined,
  })), [options.active_chat_id, options.chats, t]);

  const notifyOptions = useMemo<SelectOption[]>(() => [
    ...(selectedTask?.task_type === 'ai_instruction'
      ? [{ value: 'auto', label: t('tools.tasks.notifyAuto') }]
      : []),
    { value: 'always', label: t('tools.tasks.notifyAlways') },
    { value: 'on_error', label: t('tools.tasks.notifyOnError') },
    { value: 'never', label: t('tools.tasks.notifyNever') },
  ], [selectedTask?.task_type, t]);

  const toolModeOptions = useMemo<SelectOption[]>(() => [
    { value: 'all', label: t('tools.tasks.tools.all') },
    { value: 'selected', label: t('tools.tasks.tools.selected') },
    { value: 'none', label: t('tools.tasks.tools.none') },
  ], [t]);

  const filteredTools = useMemo(() => {
    const query = toolQuery.trim().toLowerCase();
    return query ? options.tools.filter(tool => tool.toLowerCase().includes(query)) : options.tools;
  }, [options.tools, toolQuery]);

  const loadTasks = async (status: StatusFilter) => {
    setLoading(true);
    try {
      const res = await api.listTasks(50, status);
      setTasks(res.tasks ?? []);
    } catch (err) {
      console.error('Failed to load tasks:', err);
      setTasks([]);
      toast.error(t('tools.tasks.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const loadOptions = async () => {
    setOptionsLoading(true);
    try {
      const result = await api.getTaskOptions();
      setOptions({
        active_chat_id: result.active_chat_id || 0,
        chats: result.chats ?? [],
        tools: result.tools ?? [],
      });
    } catch (err) {
      console.error('Failed to load task options:', err);
      toast.error(t('tools.tasks.optionsFailed'));
    } finally {
      setOptionsLoading(false);
    }
  };

  useEffect(() => { void loadTasks(statusFilter); }, [statusFilter]);
  useEffect(() => { void loadOptions(); }, []);

  const backToList = () => {
    setView('list');
    setSelectedTask(null);
    setToolQuery('');
  };

  useEffect(() => {
    registerToolNav('tasks', view === 'editor' ? backToList : null);
    return () => { registerToolNav('tasks', null); };
  }, [view]);

  const openTask = (task: api.TaskDto) => {
    const offset = timezoneOffsetForTask(task);
    setSelectedTask(task);
    setPayload(task.payload || '');
    setTimezoneOffset(offset);
    setExecuteAt(toDateTimeInput(task.execute_at, offset));
    setRecurrenceType(task.recurrence_type);
    setRecurrenceWeekday(task.recurrence_weekday ?? 1);
    setNotifyMode(task.notify_mode == null
      ? (task.task_type === 'ai_instruction' ? 'auto' : 'always')
      : task.notify_mode);
    setTargetMode(task.target_mode);
    setTargetChatId(task.target_chat_id ? String(task.target_chat_id) : '');
    setSelectedTools(task.allowed_tools ?? []);
    setToolMode(task.allowed_tools == null ? 'all' : task.allowed_tools.length === 0 ? 'none' : 'selected');
    setToolQuery('');
    setView('editor');
  };

  const formatTs = (task: api.TaskDto) => {
    const offset = timezoneOffsetForTask(task);
    return new Date((task.execute_at + offset * 3600) * 1000).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    });
  };

  const preview = (task: api.TaskDto, max = 120) => {
    const raw = (task.payload || '').trim();
    if (!raw) return t('tools.tasks.noDescription');
    if (task.task_type === 'ai_instruction') {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const instruction = typeof parsed.instruction === 'string'
            ? parsed.instruction
            : typeof parsed._instruction === 'string' ? parsed._instruction : '';
          if (instruction.trim()) return compactText(instruction, max);
        }
      } catch {
        // Current payloads are plain text.
      }
    }
    if (task.task_type === 'smart_home') {
      try {
        const parsed = JSON.parse(raw);
        const actionLabels: Record<string, string> = {
          on: t('tools.tasks.turnOn'),
          off: t('tools.tasks.turnOff'),
          set_color: t('tools.tasks.color'),
          set_brightness: t('tools.tasks.brightness'),
        };
        const parts = [
          actionLabels[String(parsed.action || '')] || String(parsed.action || ''),
          parsed.color ? String(parsed.color) : '',
          Number.isFinite(Number(parsed.brightness)) ? `${Math.round(Number(parsed.brightness))}%` : '',
          parsed.device_id ? String(parsed.device_id) : '',
        ].filter(Boolean);
        if (parts.length) return compactText(parts.join(' · '), max);
      } catch {
        // Show malformed legacy payload as text.
      }
    }
    return compactText(raw, max);
  };

  const statusDot = (status: api.TaskStatus) => {
    if (status === 'done') return s.dotDone;
    if (status === 'error') return s.dotError;
    return s.dotPending;
  };

  const targetLabel = (task: api.TaskDto) => {
    if (task.target_mode === 'new_chat') return t('tools.tasks.newChat');
    if (task.target_chat_title) return t('tools.tasks.toChatTitled', { title: task.target_chat_title });
    if (task.target_chat_id) return t('tools.tasks.toChat', { id: task.target_chat_id });
    return t('tools.tasks.currentChat');
  };

  const toggleTool = (tool: string) => {
    setSelectedTools(current => (
      current.includes(tool) ? current.filter(item => item !== tool) : [...current, tool]
    ));
  };

  const handleSave = async () => {
    if (!selectedTask || selectedTask.status !== 'pending') return;
    if (!payload.trim()) {
      toast.error(t('tools.tasks.textRequired'));
      return;
    }
    const timestamp = fromDateTimeInput(executeAt, timezoneOffset);
    if (!timestamp) {
      toast.error(t('tools.tasks.timeRequired'));
      return;
    }
    const chatId = targetMode === 'chat' ? Number(targetChatId) : null;
    if (targetMode === 'chat' && (!Number.isFinite(chatId) || Number(chatId) <= 0)) {
      toast.error(t('tools.tasks.chatRequired'));
      return;
    }

    setSaving(true);
    try {
      const result = await api.updateTask(selectedTask.id, {
        payload: payload.trim(),
        execute_at: timestamp,
        timezone_offset: timezoneOffset,
        recurrence_type: recurrenceType,
        recurrence_weekday: recurrenceType === 'weekly' ? recurrenceWeekday : null,
        notify_mode: notifyMode === 'auto' ? null : notifyMode,
        target_mode: targetMode,
        target_chat_id: targetMode === 'chat' ? chatId : null,
        allowed_tools: selectedTask.task_type === 'ai_instruction'
          ? toolMode === 'all' ? null : toolMode === 'none' ? [] : selectedTools
          : undefined,
      });
      setTasks(current => current.map(task => task.id === result.task.id ? result.task : task));
      toast.success(t('tools.tasks.saved'));
      backToList();
      await loadTasks(statusFilter);
    } catch (err) {
      console.error('Failed to update task:', err);
      toast.error(t('tools.tasks.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (taskId: number) => {
    if (!window.confirm(t('tools.tasks.deleteConfirm'))) return;
    try {
      await api.deleteTask(taskId);
      setTasks(current => current.filter(task => task.id !== taskId));
      toast.success(t('tools.tasks.deleted'));
      backToList();
    } catch (err) {
      console.error('Failed to delete task:', err);
      toast.error(t('tools.tasks.deleteFailed'));
    }
  };

  const editable = selectedTask?.status === 'pending';

  return (
    <div className={s.root}>
      <AnimatePresence mode="wait" initial={false}>
        {view === 'list' ? (
          <motion.div
            key="list"
            className={s.listView}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={slideTransition}
          >
            <div className={s.listHeader}>
              <div className={s.filterRow}>
                {(Object.entries(statusLabels) as [StatusFilter, string][]).map(([key, label]) => (
                  <button
                    type="button"
                    key={key}
                    className={`${s.filterBtn} ${statusFilter === key ? s.filterBtnActive : ''}`}
                    onClick={() => setStatusFilter(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className={s.tasksList}>
              {loading && <div className={s.hint}>{t('common.loading')}</div>}
              {!loading && tasks.length === 0 && <div className={s.hint}>{t('tools.tasks.empty')}</div>}
              {!loading && tasks.map(task => (
                <button type="button" key={task.id} className={s.taskItem} onClick={() => openTask(task)}>
                  <div className={s.taskItemHeader}>
                    <div className={s.taskItemLeft}>
                      <span className={`${s.statusDot} ${statusDot(task.status)}`} />
                      <span className={s.taskItemType}>{taskTypeLabels[task.task_type]}</span>
                    </div>
                    <span className={s.taskItemDate}>{formatTs(task)}</span>
                  </div>
                  <div className={s.taskItemPreview}>{preview(task)}</div>
                  <div className={s.taskItemMeta}>
                    <div className={s.taskItemTags}>
                      <span className={s.taskTag}>{recurrenceLabels[task.recurrence_type]}</span>
                      <span className={s.taskTag}>{targetLabel(task)}</span>
                    </div>
                    <span className={s.taskChevron} aria-hidden="true">›</span>
                  </div>
                </button>
              ))}
            </div>
          </motion.div>
        ) : selectedTask ? (
          <motion.div
            key="editor"
            className={s.editorView}
            variants={slideVariants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={slideTransition}
          >
            <div className={s.editorHeader}>
              <div>
                <span className={s.editorEyebrow}>{taskTypeLabels[selectedTask.task_type]} · #{selectedTask.id}</span>
                <strong>{editable ? t('tools.tasks.editTask') : t('tools.tasks.taskDetails')}</strong>
              </div>
              {editable && (
                <button
                  type="button"
                  className={s.iconDangerButton}
                  onClick={() => void handleDelete(selectedTask.id)}
                  title={t('common.delete')}
                  disabled={saving}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
            </div>

            <div className={s.editorBody}>
              <section className={s.formSection}>
                <label className={s.fieldLabel} htmlFor="task-payload">
                  {selectedTask.task_type === 'ai_instruction'
                    ? t('tools.tasks.instruction')
                    : selectedTask.task_type === 'message'
                      ? t('tools.tasks.messageText')
                      : t('tools.tasks.commandPayload')}
                </label>
                <textarea
                  id="task-payload"
                  className={s.textarea}
                  value={payload}
                  onChange={event => setPayload(event.target.value)}
                  disabled={!editable}
                  rows={5}
                />
              </section>

              <section className={s.formSection}>
                <div className={s.sectionTitle}>{t('tools.tasks.schedule')}</div>
                <label className={s.fieldLabel} htmlFor="task-time">{t('tools.tasks.runAt')}</label>
                <input
                  id="task-time"
                  className={s.input}
                  type="datetime-local"
                  value={executeAt}
                  onChange={event => setExecuteAt(event.target.value)}
                  disabled={!editable}
                />
                <span className={s.fieldHint}>{formatOffset(timezoneOffset)}</span>

                <div className={s.segmented}>
                  {(Object.keys(recurrenceLabels) as api.TaskRecurrenceType[]).map(value => (
                    <button
                      type="button"
                      key={value}
                      className={recurrenceType === value ? s.segmentActive : ''}
                      onClick={() => setRecurrenceType(value)}
                      disabled={!editable}
                    >
                      {recurrenceLabels[value]}
                    </button>
                  ))}
                </div>

                {recurrenceType === 'weekly' && (
                  <Select
                    options={weekdayOptions}
                    value={String(recurrenceWeekday)}
                    onChange={value => setRecurrenceWeekday(Number(value))}
                    disabled={!editable}
                  />
                )}
              </section>

              <section className={s.formSection}>
                <div className={s.sectionTitle}>{t('tools.tasks.destination')}</div>
                <div className={s.segmented}>
                  <button
                    type="button"
                    className={targetMode === 'chat' ? s.segmentActive : ''}
                    onClick={() => setTargetMode('chat')}
                    disabled={!editable}
                  >
                    {t('tools.tasks.existingChat')}
                  </button>
                  <button
                    type="button"
                    className={targetMode === 'new_chat' ? s.segmentActive : ''}
                    onClick={() => setTargetMode('new_chat')}
                    disabled={!editable}
                  >
                    {t('tools.tasks.newChatOption')}
                  </button>
                </div>

                {targetMode === 'chat' && (
                  <Select
                    options={chatOptions}
                    value={targetChatId}
                    onChange={setTargetChatId}
                    placeholder={optionsLoading ? t('common.loading') : t('tools.tasks.selectChat')}
                    disabled={!editable || optionsLoading}
                    searchable
                  />
                )}
              </section>

              <section className={s.formSection}>
                <label className={s.fieldLabel} htmlFor="task-notify">{t('tools.tasks.notifications')}</label>
                <Select
                  options={notifyOptions}
                  value={notifyMode}
                  onChange={value => setNotifyMode(value as NotifySelection)}
                  disabled={!editable}
                />
              </section>

              {selectedTask.task_type === 'ai_instruction' && (
                <section className={s.formSection}>
                  <div className={s.sectionTitle}>{t('tools.tasks.aiTools')}</div>
                  <Select
                    options={toolModeOptions}
                    value={toolMode}
                    onChange={value => setToolMode(value as ToolMode)}
                    disabled={!editable}
                  />
                  {toolMode === 'selected' && (
                    <>
                      <input
                        className={s.input}
                        type="search"
                        value={toolQuery}
                        onChange={event => setToolQuery(event.target.value)}
                        placeholder={t('tools.tasks.searchTools')}
                        disabled={!editable || optionsLoading}
                      />
                      <div className={s.toolsList}>
                        {filteredTools.map(tool => (
                          <label className={s.toolOption} key={tool}>
                            <input
                              type="checkbox"
                              checked={selectedTools.includes(tool)}
                              onChange={() => toggleTool(tool)}
                              disabled={!editable}
                            />
                            <span>{tool}</span>
                          </label>
                        ))}
                        {!optionsLoading && filteredTools.length === 0 && (
                          <div className={s.toolsEmpty}>{t('tools.tasks.noToolsFound')}</div>
                        )}
                      </div>
                    </>
                  )}
                </section>
              )}
            </div>

            <div className={s.editorFooter}>
              <button type="button" className={s.secondaryButton} onClick={backToList} disabled={saving}>
                {editable ? t('common.cancel') : t('common.back')}
              </button>
              {editable && (
                <button type="button" className={s.saveButton} onClick={() => void handleSave()} disabled={saving}>
                  {saving ? t('common.saving') : t('common.save')}
                </button>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
