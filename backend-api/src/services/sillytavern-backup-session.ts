import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { db } from '../db.js';
import { extractBackupStream, availableBytes, BACKUP_RESERVE, BACKUP_UPLOAD_LIMIT, type ArchiveEntry } from './sillytavern-archive-stream.js';
import { classifyBackupPath, previewSillyTavernBackup, importSillyTavernBackup, type SillyTavernBackupImportResult } from './sillytavern-backup-import.js';

const TTL = 60 * 60 * 1000;
const root = path.resolve(process.env.UPLOADS_DIR || path.resolve(__dirname, '../../uploads'), '.sillytavern-imports');
type Session = {
  owner: number; directory: string; entries: ArchiveEntry[]; expires: number;
  status: 'ready' | 'running' | 'complete' | 'failed' | 'cancelled';
  cancelRequested?: boolean;
  stage: string; done: number; total: number;
  result?: SillyTavernBackupImportResult; error?: string; required: number;
};
const sessions = new Map<string, Session>();

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.status !== 'running' && session.expires <= now) {
      fs.rmSync(session.directory, { recursive: true, force: true });
      sessions.delete(id);
    }
  }
  // Recover abandoned temporary directories after a process restart.
  if (fs.existsSync(root)) for (const name of fs.readdirSync(root)) {
    if (!/^[0-9a-f-]{36}$/i.test(name) || sessions.has(name)) continue;
    const directory = path.join(root, name);
    if (fs.statSync(directory).mtimeMs < now - TTL) fs.rmSync(directory, { recursive: true, force: true });
  }
}
const timer = setInterval(cleanup, 10 * 60 * 1000);
timer.unref();

function getSession(userId: number, id: string): Session {
  const session = sessions.get(id);
  if (!session || session.owner !== userId || (session.status !== 'running' && session.expires <= Date.now())) throw new Error('sillytavern_backup_session_expired');
  return session;
}
function storage(required: number) {
  const uploadsAvailable = availableBytes(root);
  const dbDirectory = path.dirname(db.name);
  const dbAvailable = fs.existsSync(dbDirectory) ? availableBytes(dbDirectory) : uploadsAvailable;
  const available = Math.min(uploadsAvailable, dbAvailable);
  return { available_bytes: available, required_bytes: required, sufficient: available >= required };
}

export async function uploadBackupSession(userId: number, input: Readable, contentLength?: number) {
  cleanup();
  if ([...sessions.values()].filter(session => session.owner === userId && ['ready', 'running'].includes(session.status)).length >= 2) throw new Error('sillytavern_backup_session_limit');
  if (contentLength && contentLength > BACKUP_UPLOAD_LIMIT) throw new Error('sillytavern_backup_too_large');
  fs.mkdirSync(root, { recursive: true });
  if (availableBytes(root) < BACKUP_RESERVE + Math.min(contentLength || 0, BACKUP_UPLOAD_LIMIT)) throw new Error('sillytavern_backup_insufficient_space');
  const id = randomUUID();
  const directory = path.join(root, id);
  fs.mkdirSync(directory);
  // Reserve an ownership slot before awaiting the upload to prevent concurrent bypass.
  const session: Session = { owner: userId, directory, entries: [], expires: Date.now() + TTL, status: 'running', stage: 'upload', done: 0, total: 0, required: 0 };
  sessions.set(id, session);
  try {
    const entries = await extractBackupStream(input, directory, name => ['character', 'chat', 'settings', 'persona_avatar', 'media'].includes(classifyBackupPath(name)));
    const preview = previewSillyTavernBackup(userId, entries);
    // Raw JSONL, parsed messages, variants and provenance all consume SQLite space.
    const chatBytes = entries.filter(entry => classifyBackupPath(entry.name) === 'chat').reduce((n, entry) => n + entry.size, 0);
    const otherBytes = entries.filter(entry => ['character', 'settings', 'persona_avatar'].includes(classifyBackupPath(entry.name))).reduce((n, entry) => n + entry.size, 0);
    const required = chatBytes * 6 + otherBytes * 3 + preview.media.bytes * 2 + BACKUP_RESERVE;
    Object.assign(session, { entries, required, status: 'ready', stage: 'ready', expires: Date.now() + TTL });
    return { import_id: id, preview: { ...preview, storage: storage(required) } };
  } catch (error) {
    sessions.delete(id);
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function startBackupSession(userId: number, id: string) {
  const session = getSession(userId, id);
  if (session.status !== 'ready') throw new Error('sillytavern_backup_session_not_ready');
  if ([...sessions.values()].some(other => other !== session && other.owner === userId && other.status === 'running')) throw new Error('sillytavern_backup_import_running');
  if (!storage(session.required).sufficient) throw new Error('sillytavern_backup_insufficient_space');
  session.status = 'running';
  session.stage = 'characters';
  void importSillyTavernBackup(userId, session.entries, {
    onProgress(stage, done, total) {
      if (session.cancelRequested) throw new Error('sillytavern_backup_import_cancelled');
      Object.assign(session, { stage, done, total });
    },
  }).then(result => {
    Object.assign(session, { status: 'complete', stage: 'complete', result });
  }).catch(error => {
    const cancelled = error?.message === 'sillytavern_backup_import_cancelled';
    Object.assign(session, { status: cancelled ? 'cancelled' : 'failed', stage: cancelled ? 'cancelled' : 'failed', error: error?.message || 'sillytavern_backup_import_failed' });
  }).finally(() => {
    fs.rmSync(session.directory, { recursive: true, force: true });
    session.entries = [];
    session.expires = Date.now() + TTL;
  });
  return { import_id: id };
}
export function backupSessionStatus(userId: number, id: string) {
  const { status, stage, done, total, result, error } = getSession(userId, id);
  return { status, stage, done, total, result, error };
}
export function cancelBackupSession(userId: number, id: string) {
  const session = getSession(userId, id);
  if (session.status === 'running') {
    session.cancelRequested = true;
    session.stage = 'cancelling';
    return;
  }
  fs.rmSync(session.directory, { recursive: true, force: true });
  sessions.delete(id);
}
