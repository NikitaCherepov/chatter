import { db } from '../db.js';

export type BanRecord = {
  user_id: number;
  reason: string;
  banned_at: string;
  banned_by: number | null;
};

export const setBan = (userId: number, adminId: number, reason: string) => db.prepare(`
  INSERT INTO bans (user_id, reason, banned_by)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET
    reason = excluded.reason,
    banned_by = excluded.banned_by,
    banned_at = CURRENT_TIMESTAMP
`).run(userId, reason, adminId);

export const removeBan = (userId: number) => db
  .prepare('DELETE FROM bans WHERE user_id = ?')
  .run(userId);

export const getBanRecord = (userId: number) => db
  .prepare('SELECT * FROM bans WHERE user_id = ?')
  .get(userId) as BanRecord | undefined;
