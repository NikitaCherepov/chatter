import { db, getNowUnix } from '../db.js';
import { resolveAccountId } from './accounts.js';
import { ensureMemoryDefaults, setActivePersona, type Persona } from './memory-foundation.js';

export const MAX_PERSONA_BACKUP_BYTES = 2 * 1024 * 1024;
const MAX_PERSONAS_PER_IMPORT = 500;

type Descriptor = Record<string, unknown>;
type Backup = {
  personas?: Record<string, unknown>;
  persona_descriptions?: Record<string, unknown>;
  default_persona?: unknown;
};

export type PersonaImportEntry = {
  key: string;
  name: string;
  description: string;
  core_memory: string;
  is_default: boolean;
  exists: boolean;
};

export type PersonaImportPreview = {
  entries: PersonaImportEntry[];
  count: number;
  create_count: number;
  update_count: number;
  default_name: string | null;
  warnings: string[];
};

const decodeBackup = (base64: string): Backup => {
  const buffer = Buffer.from(`${base64 || ''}`.trim(), 'base64');
  if (!buffer.length) throw new Error('persona_backup_required');
  if (buffer.length > MAX_PERSONA_BACKUP_BYTES) throw new Error('persona_backup_too_large');
  try {
    const parsed = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, '')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('persona_backup_invalid');
    return parsed as Backup;
  } catch (error: any) {
    if (error?.message === 'persona_backup_invalid') throw error;
    throw new Error('persona_backup_invalid_json');
  }
};

const normalizeDescriptor = (value: unknown): Descriptor => {
  if (typeof value === 'string') return { description: value };
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Descriptor : {};
};

const buildEntries = (userId: number, parsed: Backup): PersonaImportEntry[] => {
  const personas = parsed.personas;
  if (!personas || typeof personas !== 'object' || Array.isArray(personas)) throw new Error('persona_backup_missing_personas');
  const keys = Object.keys(personas);
  if (!keys.length) throw new Error('persona_backup_empty');
  if (keys.length > MAX_PERSONAS_PER_IMPORT) throw new Error('persona_backup_too_many_personas');
  const descriptions = parsed.persona_descriptions && typeof parsed.persona_descriptions === 'object' && !Array.isArray(parsed.persona_descriptions)
    ? parsed.persona_descriptions : {};
  const defaultKey = typeof parsed.default_persona === 'string' ? parsed.default_persona : null;
  const accountId = resolveAccountId(userId);
  return keys.flatMap(key => {
    const rawName = personas[key];
    const name = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
    if (!name) return [];
    const descriptor = normalizeDescriptor((descriptions as Record<string, unknown>)[key]);
    const fullMemory = typeof descriptor.description === 'string' ? descriptor.description : '';
    const title = typeof descriptor.title === 'string' ? descriptor.title : '';
    const exists = Boolean(db.prepare(`
      SELECT 1 FROM personas WHERE user_id = ? AND import_source = 'sillytavern' AND import_key = ?
    `).get(accountId, key));
    return [{
      key,
      name,
      description: title.trim().slice(0, 240),
      core_memory: fullMemory,
      is_default: key === defaultKey,
      exists,
    }];
  });
};

export const previewSillyTavernPersonas = (userId: number, base64: string): PersonaImportPreview => {
  const entries = buildEntries(userId, decodeBackup(base64));
  if (!entries.length) throw new Error('persona_backup_empty');
  const warnings = ['avatars_not_in_backup'];
  if (entries.some(entry => entry.exists)) warnings.push('existing_personas_updated');
  return {
    entries,
    count: entries.length,
    create_count: entries.filter(entry => !entry.exists).length,
    update_count: entries.filter(entry => entry.exists).length,
    default_name: entries.find(entry => entry.is_default)?.name || null,
    warnings,
  };
};

export const importSillyTavernPersonas = (userId: number, base64: string): {
  personas: Persona[];
  active_persona_id: number | null;
  created: number;
  updated: number;
} => {
  const accountId = resolveAccountId(userId);
  ensureMemoryDefaults(accountId);
  const parsed = decodeBackup(base64);
  const entries = buildEntries(accountId, parsed);
  if (!entries.length) throw new Error('persona_backup_empty');
  return db.transaction(() => {
    const now = getNowUnix();
    const imported: Persona[] = [];
    let created = 0;
    let updated = 0;
    let activePersonaId: number | null = null;
    for (const entry of entries) {
      const descriptor = normalizeDescriptor(parsed.persona_descriptions?.[entry.key]);
      const raw = JSON.stringify({ avatar: entry.key, name: parsed.personas?.[entry.key], descriptor });
      const existing = db.prepare(`
        SELECT * FROM personas WHERE user_id = ? AND import_source = 'sillytavern' AND import_key = ?
      `).get(accountId, entry.key) as Persona | undefined;
      let id: number;
      if (existing) {
        db.prepare(`
          UPDATE personas SET name = ?, description = ?, core_memory = ?, import_raw_json = ?, updated_at = ?
          WHERE id = ? AND user_id = ?
        `).run(entry.name, entry.description, entry.core_memory, raw, now, existing.id, accountId);
        id = existing.id;
        updated += 1;
      } else {
        const result = db.prepare(`
          INSERT INTO personas (
            user_id, name, description, core_memory, allow_core_memory_update, is_primary, is_default,
            import_source, import_key, import_raw_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 1, 0, 0, 'sillytavern', ?, ?, ?, ?)
        `).run(accountId, entry.name, entry.description, entry.core_memory, entry.key, raw, now, now);
        id = Number(result.lastInsertRowid);
        created += 1;
      }
      if (entry.is_default) activePersonaId = id;
      imported.push(db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as Persona);
    }
    if (activePersonaId !== null) setActivePersona(accountId, activePersonaId);
    return { personas: imported, active_persona_id: activePersonaId, created, updated };
  })();
};
