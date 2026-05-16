import crypto from 'node:crypto';
import { db } from '../db.js';

// ── Encryption (same pattern as mail.ts) ──────────────────────────────────

const ENCRYPTION_KEY_SOURCE = process.env.MAP_PINS_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || 'dev-default-key-change-in-prod';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_KEY_SOURCE).digest();
const IV_LENGTH = 16;
const DELIMITER = ':';

const encrypt = (text: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}${DELIMITER}${encrypted.toString('hex')}`;
};

const decrypt = (text: string): string => {
  const parts = text.split(DELIMITER);
  if (parts.length !== 2) return text; // fallback for unencrypted data
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString('utf8');
};

// ── Types ─────────────────────────────────────────────────────────────────

export type MapPinDto = {
  id: number;
  lat: number;
  lng: number;
  label: string;
  created_at: number;
  updated_at: number;
};

type MapPinRow = {
  id: number;
  user_id: number;
  lat_enc: string;
  lng_enc: string;
  label: string;
  created_at: number;
  updated_at: number;
};

// ── Ensure table ──────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS map_pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    lat_enc TEXT NOT NULL,
    lng_enc TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_map_pins_user ON map_pins(user_id)');

// ── Helpers ───────────────────────────────────────────────────────────────

const rowToDto = (row: MapPinRow): MapPinDto => ({
  id: row.id,
  lat: parseFloat(decrypt(row.lat_enc)),
  lng: parseFloat(decrypt(row.lng_enc)),
  label: row.label,
  created_at: Math.floor(row.created_at),
  updated_at: Math.floor(row.updated_at),
});

// ── CRUD ──────────────────────────────────────────────────────────────────

export const listMapPins = (userId: number): MapPinDto[] => {
  const rows = db.prepare(`
    SELECT id, user_id, lat_enc, lng_enc, label, created_at, updated_at
    FROM map_pins
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId) as MapPinRow[];
  return rows.map(rowToDto);
};

export const getMapPinById = (userId: number, pinId: number): MapPinDto | null => {
  const row = db.prepare(`
    SELECT id, user_id, lat_enc, lng_enc, label, created_at, updated_at
    FROM map_pins
    WHERE user_id = ? AND id = ?
    LIMIT 1
  `).get(userId, pinId) as MapPinRow | undefined;
  return row ? rowToDto(row) : null;
};

export const createMapPin = (userId: number, lat: number, lng: number, label: string): { ok: true; id: number } | { ok: false; error: string } => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: 'invalid_coordinates' };
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false, error: 'invalid_coordinates' };
  if (label.length > 200) return { ok: false, error: 'label_too_long' };

  const now = Math.floor(Date.now() / 1000);
  const latEnc = encrypt(String(lat));
  const lngEnc = encrypt(String(lng));

  const result = db.prepare(`
    INSERT INTO map_pins (user_id, lat_enc, lng_enc, label, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, latEnc, lngEnc, label.trim(), now, now);

  return { ok: true, id: Number(result.lastInsertRowid) };
};

export const updateMapPin = (userId: number, pinId: number, updates: { lat?: number; lng?: number; label?: string }): boolean => {
  const existing = db.prepare('SELECT id FROM map_pins WHERE user_id = ? AND id = ?').get(userId, pinId) as { id: number } | undefined;
  if (!existing) return false;

  const now = Math.floor(Date.now() / 1000);
  const setClauses: string[] = ['updated_at = ?'];
  const values: any[] = [now];

  if (updates.lat !== undefined && updates.lng !== undefined) {
    if (!Number.isFinite(updates.lat) || !Number.isFinite(updates.lng)) return false;
    if (updates.lat < -90 || updates.lat > 90 || updates.lng < -180 || updates.lng > 180) return false;
    setClauses.push('lat_enc = ?', 'lng_enc = ?');
    values.push(encrypt(String(updates.lat)), encrypt(String(updates.lng)));
  }

  if (updates.label !== undefined) {
    if (updates.label.length > 200) return false;
    setClauses.push('label = ?');
    values.push(updates.label.trim());
  }

  values.push(userId, pinId);
  db.prepare(`UPDATE map_pins SET ${setClauses.join(', ')} WHERE user_id = ? AND id = ?`).run(...values);
  return true;
};

export const deleteMapPin = (userId: number, pinId: number): boolean => {
  return db.prepare('DELETE FROM map_pins WHERE user_id = ? AND id = ?').run(userId, pinId).changes > 0;
};

// ── For bot: returns pins with decrypted coords + labels ──────────────────

export const listMapPinsForBot = (userId: number): Array<{ id: number; lat: number; lng: number; label: string }> => {
  return listMapPins(userId).map(p => ({ id: p.id, lat: p.lat, lng: p.lng, label: p.label }));
};
