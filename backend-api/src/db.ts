import path from 'node:path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

dotenv.config();

const resolvedDbPath = path.resolve(
  process.cwd(),
  process.env.API_DB_PATH || process.env.NOTES_DB_PATH || '../chatter.db'
);

export const db = new Database(resolvedDbPath);

export const toUnix = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }
  return Math.floor(Date.now() / 1000);
};

export const getNowUnix = () => Math.floor(Date.now() / 1000);
