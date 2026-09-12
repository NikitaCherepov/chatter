import { db } from '../db.js';
import type { TaskDto, TaskNotifyMode, TaskRecurrenceType, TaskStatus, TaskTargetMode, TaskType } from '../types.js';

export const MAX_PENDING_TASKS_PER_USER = 10;

const TASK_COLUMNS = `
  t.id, t.execute_at, t.task_type, t.payload, t.status,
  t.recurrence_type, t.recurrence_weekday, t.timezone_offset,
  t.notify_mode,
  t.target_mode, t.target_chat_id, uc.title AS target_chat_title
`;

const mapTaskRow = (row: any): TaskDto => ({
  id: Number(row.id),
  execute_at: Number(row.execute_at),
  task_type: row.task_type as TaskType,
  payload: String(row.payload || ''),
  status: row.status as TaskStatus,
  recurrence_type: row.recurrence_type as TaskRecurrenceType,
  recurrence_weekday: row.recurrence_weekday == null ? null : Number(row.recurrence_weekday),
  timezone_offset: row.timezone_offset == null ? null : Number(row.timezone_offset),
  notify_mode: (row.notify_mode == null ? null : row.notify_mode) as TaskNotifyMode | null,
  target_mode: (row.target_mode || 'current_chat') as TaskTargetMode,
  target_chat_id: row.target_chat_id == null ? null : Number(row.target_chat_id),
  target_chat_title: row.target_chat_title == null ? null : String(row.target_chat_title),
});

export const listTasks = (userId: number, limit = 50, status: 'pending' | 'done' | 'error' | 'all' = 'pending'): TaskDto[] => {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = status === 'all'
    ? db.prepare(`
      SELECT ${TASK_COLUMNS}
      FROM tasks t
      LEFT JOIN user_chats uc ON t.target_mode = 'id' AND uc.id = t.target_chat_id
      WHERE t.user_id = ?
      ORDER BY t.execute_at ASC, t.id ASC
      LIMIT ?
    `).all(userId, safeLimit)
    : db.prepare(`
      SELECT ${TASK_COLUMNS}
      FROM tasks t
      LEFT JOIN user_chats uc ON t.target_mode = 'id' AND uc.id = t.target_chat_id
      WHERE t.user_id = ? AND t.status = ?
      ORDER BY t.execute_at ASC, t.id ASC
      LIMIT ?
    `).all(userId, status, safeLimit);

  return (rows as any[]).map(mapTaskRow);
};

export const createTask = (
  userId: number,
  executeAt: number,
  taskType: TaskType,
  payload: string,
  recurrenceType: TaskRecurrenceType = 'once',
  recurrenceWeekday: number | null = null,
  timezoneOffset: number | null = null,
  notifyMode: TaskNotifyMode | null = null,
  targetMode: TaskTargetMode = 'current_chat',
  targetChatId: number | null = null
) => {
  const effectiveNotifyMode = notifyMode ?? (taskType === 'ai_instruction' ? null : 'always');
  const res = db.prepare(`
    INSERT INTO tasks (user_id, execute_at, task_type, payload, recurrence_type, recurrence_weekday, timezone_offset, notify_mode, target_mode, target_chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, executeAt, taskType, payload, recurrenceType, recurrenceWeekday, timezoneOffset, effectiveNotifyMode, targetMode, targetChatId);
  return Number(res.lastInsertRowid);
};

export type TaskUpdateFields = {
  execute_at?: number;
  task_type?: TaskType;
  payload?: string;
  recurrence_type?: TaskRecurrenceType;
  recurrence_weekday?: number | null;
  timezone_offset?: number | null;
  notify_mode?: TaskNotifyMode | null;
  target_mode?: TaskTargetMode;
  target_chat_id?: number | null;
};

/** Edits a pending task. Only pending tasks are editable; returns false otherwise. */
export const updatePendingTask = (userId: number, taskId: number, fields: TaskUpdateFields) => {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (fields.execute_at !== undefined) {
    const executeAt = Math.floor(Number(fields.execute_at));
    if (!Number.isFinite(executeAt) || executeAt <= 0) throw new Error('bad_execute_at');
    sets.push('execute_at = ?');
    params.push(executeAt);
  }
  if (fields.task_type !== undefined) {
    sets.push('task_type = ?');
    params.push(fields.task_type);
  }
  if (fields.payload !== undefined) {
    const payload = `${fields.payload}`;
    if (!payload.trim()) throw new Error('payload_required');
    sets.push('payload = ?');
    params.push(payload);
  }
  if (fields.recurrence_type !== undefined) {
    sets.push('recurrence_type = ?');
    params.push(fields.recurrence_type);
  }
  if (fields.recurrence_weekday !== undefined) {
    sets.push('recurrence_weekday = ?');
    params.push(fields.recurrence_weekday);
  }
  if (fields.timezone_offset !== undefined) {
    sets.push('timezone_offset = ?');
    params.push(fields.timezone_offset);
  }
  if (fields.notify_mode !== undefined) {
    sets.push('notify_mode = ?');
    params.push(fields.notify_mode);
  }
  if (fields.target_mode !== undefined) {
    sets.push('target_mode = ?');
    params.push(fields.target_mode);
  }
  if (fields.target_chat_id !== undefined) {
    sets.push('target_chat_id = ?');
    params.push(fields.target_chat_id);
  }

  if (sets.length === 0) return false;

  const res = db.prepare(`
    UPDATE tasks SET ${sets.join(', ')}
    WHERE user_id = ? AND id = ? AND status = 'pending'
  `).run(...params, userId, taskId);
  return res.changes > 0;
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
    SELECT ${TASK_COLUMNS}
    FROM tasks t
    LEFT JOIN user_chats uc ON t.target_mode = 'id' AND uc.id = t.target_chat_id
    WHERE t.user_id = ? AND t.id = ? LIMIT 1
  `).get(userId, taskId) as any;
  if (!row) return null;
  return mapTaskRow(row);
};

export const getDueTasks = (unixNow: number): Array<TaskDto & { user_id: number }> => {
  const rows = db.prepare(`
    SELECT ${TASK_COLUMNS}, t.user_id
    FROM tasks t
    LEFT JOIN user_chats uc ON t.target_mode = 'id' AND uc.id = t.target_chat_id
    WHERE t.status = 'pending' AND t.execute_at <= ?
    ORDER BY t.execute_at ASC, t.id ASC
  `).all(unixNow) as any[];

  return rows.map(row => ({
    ...mapTaskRow(row),
    user_id: Number(row.user_id),
  }));
};

export const updateTaskStatus = (taskId: number, status: TaskStatus) => db
  .prepare('UPDATE tasks SET status = ? WHERE id = ?')
  .run(status, taskId);

export const updateTaskNextExecution = (taskId: number, nextExecuteAt: number) => db
  .prepare('UPDATE tasks SET execute_at = ? WHERE id = ?')
  .run(nextExecuteAt, taskId);

/** Self-healing for target_mode='id': re-point the task at a fresh chat. */
export const updateTaskTargetChat = (taskId: number, chatId: number) => db
  .prepare('UPDATE tasks SET target_chat_id = ? WHERE id = ?')
  .run(chatId, taskId);

/** The only chats allowed as explicit task targets: the user's own personal
 *  chats. Shared rooms (room_enabled) and other users' chats are forbidden. */
export const isOwnNonRoomChat = (userId: number, chatId: number) => Boolean(db.prepare(
  'SELECT 1 FROM user_chats WHERE id = ? AND user_id = ? AND (room_enabled IS NULL OR room_enabled = 0)'
).get(chatId, userId));
