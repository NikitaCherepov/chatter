import { db } from '../db.js';
import type { TaskDto, TaskNotifyMode, TaskRecurrenceType, TaskStatus, TaskType } from '../types.js';

export const listTasks = (userId: number, limit = 50, status: 'pending' | 'done' | 'error' | 'all' = 'pending'): TaskDto[] => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = status === 'all'
    ? db.prepare(`
      SELECT id, execute_at, task_type, payload, status, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, notify_condition
      FROM tasks
      WHERE user_id = ?
      ORDER BY execute_at ASC, id ASC
      LIMIT ?
    `).all(userId, safeLimit)
    : db.prepare(`
      SELECT id, execute_at, task_type, payload, status, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, notify_condition
      FROM tasks
      WHERE user_id = ? AND status = ?
      ORDER BY execute_at ASC, id ASC
      LIMIT ?
    `).all(userId, status, safeLimit);

  return (rows as any[]).map(row => ({
    id: Number(row.id),
    execute_at: Number(row.execute_at),
    task_type: row.task_type as TaskType,
    payload: String(row.payload || ''),
    status: row.status as TaskStatus,
    recurrence_type: row.recurrence_type as TaskRecurrenceType,
    recurrence_weekday: row.recurrence_weekday == null ? null : Number(row.recurrence_weekday),
    timezone_offset: row.timezone_offset == null ? null : Number(row.timezone_offset),
    notify_mode: row.notify_mode as TaskNotifyMode,
    notify_condition: row.notify_condition == null ? null : String(row.notify_condition)
  }));
};

export const createTask = (
  userId: number,
  executeAt: number,
  taskType: TaskType,
  payload: string,
  recurrenceType: TaskRecurrenceType = 'once',
  recurrenceWeekday: number | null = null,
  timezoneOffset: number | null = null,
  notifyMode: TaskNotifyMode = 'always',
  notifyCondition: string | null = null
) => {
  const res = db.prepare(`
    INSERT INTO tasks (user_id, execute_at, task_type, payload, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, notify_condition)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, executeAt, taskType, payload, recurrenceType, recurrenceWeekday, timezoneOffset, notifyMode, notifyCondition);
  return Number(res.lastInsertRowid);
};

export const deletePendingTask = (userId: number, taskId: number) => db
  .prepare('DELETE FROM tasks WHERE user_id = ? AND id = ? AND status = \'pending\'')
  .run(userId, taskId)
  .changes > 0;

export const getPendingTaskCount = (userId: number) => (
  db.prepare('SELECT COUNT(*) as count FROM tasks WHERE user_id = ? AND status = \'pending\'').get(userId) as { count: number }
).count;

export const getUserTaskById = (userId: number, taskId: number): TaskDto | null => {
  const row = db.prepare(`
    SELECT id, execute_at, task_type, payload, status, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, notify_condition
    FROM tasks WHERE user_id = ? AND id = ? LIMIT 1
  `).get(userId, taskId) as any;
  if (!row) return null;
  return {
    id: Number(row.id), execute_at: Number(row.execute_at), task_type: row.task_type,
    payload: String(row.payload || ''), status: row.status,
    recurrence_type: row.recurrence_type,
    recurrence_weekday: row.recurrence_weekday == null ? null : Number(row.recurrence_weekday),
    timezone_offset: row.timezone_offset == null ? null : Number(row.timezone_offset),
    notify_mode: row.notify_mode,
    notify_condition: row.notify_condition == null ? null : String(row.notify_condition),
  };
};

export const getDueTasks = (unixNow: number): Array<TaskDto & { user_id: number }> => {
  const rows = db.prepare(`
    SELECT id, user_id, execute_at, task_type, payload, status, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, notify_condition
    FROM tasks
    WHERE status = 'pending' AND execute_at <= ?
    ORDER BY execute_at ASC, id ASC
  `).all(unixNow) as any[];

  return rows.map(row => ({
    id: Number(row.id),
    user_id: Number(row.user_id),
    execute_at: Number(row.execute_at),
    task_type: row.task_type as TaskType,
    payload: String(row.payload || ''),
    status: row.status as TaskStatus,
    recurrence_type: row.recurrence_type as TaskRecurrenceType,
    recurrence_weekday: row.recurrence_weekday == null ? null : Number(row.recurrence_weekday),
    timezone_offset: row.timezone_offset == null ? null : Number(row.timezone_offset),
    notify_mode: row.notify_mode as TaskNotifyMode,
    notify_condition: row.notify_condition == null ? null : String(row.notify_condition)
  }));
};

export const updateTaskStatus = (taskId: number, status: TaskStatus) => db
  .prepare('UPDATE tasks SET status = ? WHERE id = ?')
  .run(status, taskId);

export const updateTaskNextExecution = (taskId: number, nextExecuteAt: number) => db
  .prepare('UPDATE tasks SET execute_at = ? WHERE id = ?')
  .run(nextExecuteAt, taskId);
