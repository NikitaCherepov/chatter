import crypto from 'node:crypto';
import { db, getNowUnix } from '../db.js';
import { getEncryptionKey } from '../utils/encryption.js';
import { discoverZigbeeDevices, discoverZigbeeGroups, publishZigbeeCommand } from './zigbee.js';

// ── Encryption (uses shared ENCRYPTION_KEY, same as mail.ts) ─────────────────

const IV_LENGTH = 16;
const DELIMITER = ':';

const encrypt = (text: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}${DELIMITER}${encrypted.toString('hex')}`;
};

const decrypt = (text: string): string => {
  const parts = text.split(DELIMITER);
  if (parts.length !== 2) return text;
  const iv = Buffer.from(parts[0], 'hex');
  const encryptedText = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getEncryptionKey(['ENCRYPTION_KEY']), iv);
  const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);
  return decrypted.toString('utf8');
};

// ── DB Tables ───────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS smart_home_settings (
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'yandex',
    token_enc TEXT NOT NULL,
    synced_at INTEGER,
    PRIMARY KEY (user_id, provider)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS smart_devices (
    id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    room_name TEXT,
    provider TEXT NOT NULL DEFAULT 'yandex',
    is_group INTEGER NOT NULL DEFAULT 0,
    native_id TEXT NOT NULL,
    type TEXT,
    capabilities TEXT NOT NULL DEFAULT '[]',
    target_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_smart_devices_user ON smart_devices(user_id)');

// ── Types ───────────────────────────────────────────────────────────────────

export type SmartHomeAction = 'on' | 'off' | 'set_color' | 'set_brightness';

export type SmartHomeArgs = {
  device_id?: string;
  action?: SmartHomeAction;
  color?: string;
  brightness?: number;
};

export type SmartDeviceDto = {
  id: string;
  name: string;
  room_name: string | null;
  provider: string;
  is_group: boolean;
  type: string | null;
  capabilities: string[];
};

export type SmartHomeSettingsDto = {
  provider: string;
  has_token: boolean;
  synced_at: number | null;
};

type SmartDeviceRow = {
  id: string;
  user_id: number;
  name: string;
  room_name: string | null;
  provider: string;
  is_group: number;
  native_id: string;
  type: string | null;
  capabilities: string;
  target_ids: string;
  created_at: number;
};

type SmartHomeSettingsRow = {
  user_id: number;
  provider: string;
  token_enc: string;
  synced_at: number | null;
};

// ── Color helpers (unchanged) ───────────────────────────────────────────────

const COLOR_NAME_TO_HEX: Record<string, string> = {
  red: '#FF0000',
  green: '#00FF00',
  blue: '#0000FF',
  white: '#FFFFFF',
  black: '#000000',
  yellow: '#FFFF00',
  purple: '#800080',
  violet: '#800080',
  pink: '#FFC0CB',
  orange: '#FFA500',
  cyan: '#00FFFF',
  teal: '#008080',
  warmwhite: '#FFD8A8',
  coolwhite: '#DCEBFF',
  'красный': '#FF0000',
  'зеленый': '#00FF00',
  'зелёный': '#00FF00',
  'синий': '#0000FF',
  'белый': '#FFFFFF',
  'черный': '#000000',
  'чёрный': '#000000',
  'желтый': '#FFFF00',
  'жёлтый': '#FFFF00',
  'фиолетовый': '#800080',
  'розовый': '#FFC0CB',
  'оранжевый': '#FFA500',
  'голубой': '#00FFFF',
  'бирюзовый': '#00FFFF',
  'теплый белый': '#FFD8A8',
  'тёплый белый': '#FFD8A8',
  'холодный белый': '#DCEBFF'
};

const parseColorToHsv = (value: string) => {
  const normalized = value.trim().toLowerCase();
  const mapped = COLOR_NAME_TO_HEX[normalized] || normalized;
  const compact = mapped.replace(/\s+/g, '');
  if (!/^#?[0-9a-f]{6}$/i.test(compact)) return null;
  const hex = compact.startsWith('#') ? compact.slice(1) : compact;

  const r = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const g = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const b = Number.parseInt(hex.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), v: Math.round(v * 100) };
};

// ── Yandex data parser ──────────────────────────────────────────────────────

type YandexCapability = {
  type: string;
  parameters?: any;
  state?: any;
};

type YandexDevice = {
  id: string;
  name: string;
  type: string;
  room?: string;
  capabilities?: YandexCapability[];
};

type YandexGroup = {
  id: string;
  name: string;
  type: string;
  devices: string[];
  capabilities?: YandexCapability[];
};

type YandexRoom = {
  id: string;
  name: string;
  devices?: string[];
};

type YandexInfoResponse = {
  rooms?: YandexRoom[];
  groups?: YandexGroup[];
  devices?: YandexDevice[];
};

type ParsedDevice = {
  id: string;
  name: string;
  room_name: string | null;
  provider: string;
  is_group: number;
  native_id: string;
  type: string | null;
  capabilities: string;
  target_ids: string;
};

/** Strip "devices.capabilities." prefix → short name */
const capShort = (type: string): string => type.replace('devices.capabilities.', '');

/**
 * Parse Yandex /user/info response into flat device list.
 * Groups take priority — devices already inside a group are skipped as standalone.
 */
function parseYandexData(userId: number, data: YandexInfoResponse): ParsedDevice[] {
  const entities: ParsedDevice[] = [];
  const now = getNowUnix();

  // room_id → room_name
  const roomMap = new Map<string, string>();
  for (const r of data.rooms || []) roomMap.set(r.id, r.name);

  // device_id → device object
  const deviceMap = new Map<string, YandexDevice>();
  for (const d of data.devices || []) deviceMap.set(d.id, d);

  // Track UUIDs already inside groups (to skip standalone)
  const groupedDeviceIds = new Set<string>();

  // 1. Groups first (e.g. "Свет" containing 3 lamps)
  for (const g of data.groups || []) {
    for (const id of g.devices || []) groupedDeviceIds.add(id);

    // Resolve room from first member device
    const firstDevice = deviceMap.get(g.devices?.[0] || '');
    const roomName = firstDevice?.room ? roomMap.get(firstDevice.room) || null : null;

    const caps = (g.capabilities || []).map(c => capShort(c.type));

    entities.push({
      id: `yandex_group_${g.id}`,
      name: g.name,
      room_name: roomName,
      provider: 'yandex',
      is_group: 1,
      native_id: g.id,
      type: g.type || null,
      capabilities: JSON.stringify(caps),
      target_ids: JSON.stringify(g.devices || []),
    });
  }

  // 2. Standalone devices not in any group (e.g. "Увлажнитель")
  for (const d of data.devices || []) {
    if (groupedDeviceIds.has(d.id)) continue;

    const roomName = d.room ? roomMap.get(d.room) || null : null;
    const caps = (d.capabilities || []).map(c => capShort(c.type));

    entities.push({
      id: `yandex_device_${d.id}`,
      name: d.name,
      room_name: roomName,
      provider: 'yandex',
      is_group: 0,
      native_id: d.id,
      type: d.type || null,
      capabilities: JSON.stringify(caps),
      target_ids: JSON.stringify([d.id]),
    });
  }

  return entities;
}

export const getSmartHomeSettings = (userId: number, provider?: string): SmartHomeSettingsDto[] => {
  if (provider) {
    const row = db.prepare(`SELECT * FROM smart_home_settings WHERE user_id = ? AND provider = ?`)
      .get(userId, provider) as SmartHomeSettingsRow | undefined;
    if (!row) return [];
    return [{ provider: row.provider, has_token: !!row.token_enc, synced_at: row.synced_at ?? null }];
  }
  const rows = db.prepare(`SELECT * FROM smart_home_settings WHERE user_id = ?`)
    .all(userId) as SmartHomeSettingsRow[];
  return rows.map(r => ({ provider: r.provider, has_token: !!r.token_enc, synced_at: r.synced_at ?? null }));
};

export const getYandexToken = (userId: number): string | null => {
  const row = db.prepare(`SELECT token_enc FROM smart_home_settings WHERE user_id = ? AND provider = 'yandex'`)
    .get(userId) as SmartHomeSettingsRow | undefined;
  if (!row?.token_enc) return null;
  try {
    return decrypt(row.token_enc);
  } catch {
    return null;
  }
};

export const setSmartHomeToken = (userId: number, token: string): void => {
  const enc = encrypt(token);
  db.prepare(`
    INSERT INTO smart_home_settings (user_id, provider, token_enc, synced_at)
    VALUES (?, 'yandex', ?, NULL)
    ON CONFLICT (user_id, provider) DO UPDATE SET token_enc = excluded.token_enc, synced_at = NULL
  `).run(userId, enc);
};

export const deleteSmartHomeToken = (userId: number): void => {
  db.prepare(`DELETE FROM smart_home_settings WHERE user_id = ? AND provider = 'yandex'`).run(userId);
  db.prepare(`DELETE FROM smart_devices WHERE user_id = ? AND provider = 'yandex'`).run(userId);
};

// ── Zigbee (MQTT) settings ──────────────────────────────────────────────────

export const getZigbeeBrokerUrl = (userId: number): string | null => {
  const row = db.prepare(`SELECT token_enc FROM smart_home_settings WHERE user_id = ? AND provider = 'zigbee'`)
    .get(userId) as SmartHomeSettingsRow | undefined;
  if (!row?.token_enc) return null;
  try {
    return decrypt(row.token_enc);
  } catch {
    return null;
  }
};

export const setZigbeeToken = (userId: number, brokerUrl: string): void => {
  const enc = encrypt(brokerUrl);
  db.prepare(`
    INSERT INTO smart_home_settings (user_id, provider, token_enc, synced_at)
    VALUES (?, 'zigbee', ?, NULL)
    ON CONFLICT (user_id, provider) DO UPDATE SET token_enc = excluded.token_enc, synced_at = NULL
  `).run(userId, enc);
};

export const deleteZigbeeToken = (userId: number): void => {
  db.prepare(`DELETE FROM smart_home_settings WHERE user_id = ? AND provider = 'zigbee'`).run(userId);
  db.prepare(`DELETE FROM smart_devices WHERE user_id = ? AND provider = 'zigbee'`).run(userId);
};

// ── Sync from Zigbee2MQTT ───────────────────────────────────────────────────

export const syncZigbeeDevices = async (userId: number): Promise<{ synced: number }> => {
  const brokerUrl = getZigbeeBrokerUrl(userId);
  if (!brokerUrl) throw new Error('no_broker');

  const [devices, groups] = await Promise.all([
    discoverZigbeeDevices(brokerUrl),
    discoverZigbeeGroups(brokerUrl),
  ]);

  const allParsed = [...groups, ...devices]; // группы первыми

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM smart_devices WHERE user_id = ? AND provider = 'zigbee'`).run(userId);
    const now = getNowUnix();
    const insert = db.prepare(`
      INSERT INTO smart_devices (id, user_id, name, room_name, provider, is_group, native_id, type, capabilities, target_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const d of allParsed) {
      insert.run(d.id, userId, d.name, d.room_name, d.provider, d.is_group, d.native_id, d.type, d.capabilities, d.target_ids, now);
    }
    db.prepare(`UPDATE smart_home_settings SET synced_at = ? WHERE user_id = ? AND provider = 'zigbee'`)
      .run(now, userId);
  });
  tx();

  return { synced: allParsed.length };
};
// ── Device CRUD ─────────────────────────────────────────────────────────────

const rowToDto = (row: SmartDeviceRow): SmartDeviceDto => ({
  id: row.id,
  name: row.name,
  room_name: row.room_name,
  provider: row.provider,
  is_group: row.is_group === 1,
  type: row.type,
  capabilities: JSON.parse(row.capabilities || '[]'),
});

export const listSmartDevices = (userId: number): SmartDeviceDto[] => {
  const rows = db.prepare(`SELECT * FROM smart_devices WHERE user_id = ? ORDER BY name COLLATE NOCASE`)
    .all(userId) as SmartDeviceRow[];
  return rows.map(rowToDto);
};

/** Compact JSON for AI tool response (get_smart_devices) */
export const listSmartDevicesForAi = (userId: number): string => {
  const devices = listSmartDevices(userId);
  if (!devices.length) return 'No devices found. Ask the user to add a token and sync devices in settings.';
  const compact = devices.map(d => ({
    id: d.id,
    name: d.name,
    room: d.room_name,
    type: d.type,
    capabilities: d.capabilities,
  }));
  return JSON.stringify(compact, null, 2);
};

// ── Sync dispatcher ──────────────────────────────────────────────────────────

export const syncSmartHomeDevices = async (userId: number, provider: string = 'yandex'): Promise<{ synced: number }> => {
  if (provider === 'zigbee') {
    return syncZigbeeDevices(userId);
  }

  // ── Yandex sync ──
  const token = getYandexToken(userId);
  if (!token) throw new Error('no_token');

  const response = await fetch('https://api.iot.yandex.net/v1.0/user/info', {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    throw new Error(`yandex_api_${response.status}: ${raw || 'empty'}`);
  }

  const data = await response.json() as YandexInfoResponse;
  const parsed = parseYandexData(userId, data);

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM smart_devices WHERE user_id = ? AND provider = 'yandex'`).run(userId);
    const now = getNowUnix();
    const insert = db.prepare(`
      INSERT INTO smart_devices (id, user_id, name, room_name, provider, is_group, native_id, type, capabilities, target_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const d of parsed) {
      insert.run(d.id, userId, d.name, d.room_name, d.provider, d.is_group, d.native_id, d.type, d.capabilities, d.target_ids, now);
    }
    db.prepare(`UPDATE smart_home_settings SET synced_at = ? WHERE user_id = ? AND provider = 'yandex'`)
      .run(now, userId);
  });
  tx();

  return { synced: parsed.length };
};
// ── Control ─────────────────────────────────────────────────────────────────

const findDeviceById = (userId: number, deviceId: string): SmartDeviceRow | null => {
  return (db.prepare(`SELECT * FROM smart_devices WHERE user_id = ? AND id = ?`)
    .get(userId, deviceId) as SmartDeviceRow | undefined) || null;
};

export const runSmartHomeControl = async (userId: number, args: SmartHomeArgs): Promise<string> => {
  const deviceId = (args.device_id || '').trim();
  if (!deviceId) return 'Tool error: device_id not provided. Call get_smart_devices first.';

  const device = findDeviceById(userId, deviceId);
  if (!device) return `Error: device with id "${deviceId}" not found. Run sync in settings.`;

  const action = args.action;
  if (!action || !['on', 'off', 'set_color', 'set_brightness'].includes(action)) {
    return 'Tool error: unknown action.';
  }

  // ── Zigbee: MQTT publish ──
  if (device.provider === 'zigbee') {
    const brokerUrl = getZigbeeBrokerUrl(userId);
    if (!brokerUrl) return 'Error: Zigbee MQTT broker not configured. Add it in settings.';

    const targetIds: string[] = JSON.parse(device.target_ids);
    const friendlyName = targetIds[0]; // zigbee uses friendly_name for MQTT topic
    if (!friendlyName) return 'Error: device has no MQTT address.';

    const result = await publishZigbeeCommand(brokerUrl, friendlyName, action, {
      color: args.color,
      brightness: args.brightness,
    });

    if (!result.ok) return `MQTT error: ${result.error}`;

    const actionText = action === 'on'
      ? 'turned on'
      : action === 'off'
        ? 'turned off'
        : action === 'set_color'
          ? `color changed to ${args.color}`
          : `brightness set to ${args.brightness}%`;
    return `Success: "${device.name}" → ${actionText}.`;
  }

  // ── Yandex: HTTP API ──
  const token = getYandexToken(userId);
  if (!token) return 'Error: Yandex token not configured. Add it in settings.';

  const onOffPayload = (value: boolean) => ({
    type: 'devices.capabilities.on_off',
    state: { instance: 'on', value }
  });
  const colorPayload = (hsv: { h: number; s: number; v: number }) => ({
    type: 'devices.capabilities.color_setting',
    state: { instance: 'hsv', value: hsv }
  });
  const brightnessPayload = (value: number) => ({
    type: 'devices.capabilities.range',
    state: { instance: 'brightness', value }
  });

  let actionsPayload: any[] = [];
  let brightnessValue: number | null = null;

  if (action === 'on') actionsPayload = [onOffPayload(true)];
  if (action === 'off') actionsPayload = [onOffPayload(false)];
  if (action === 'set_color') {
    if (!args.color) return 'Tool error: color parameter required for set_color.';
    const hsv = parseColorToHsv(args.color);
    if (hsv === null) return `Tool error: could not parse color "${args.color}".`;
    actionsPayload = [onOffPayload(true), colorPayload(hsv)];
  }
  if (action === 'set_brightness') {
    if (args.brightness === undefined) return 'Tool error: brightness parameter required for set_brightness.';
    let br = Number(args.brightness);
    if (Number.isNaN(br)) br = 100;
    if (br < 1) br = 1;
    if (br > 100) br = 100;
    brightnessValue = br;
    actionsPayload = [onOffPayload(true), brightnessPayload(br)];
  }

  const targetIds: string[] = JSON.parse(device.target_ids);
  const devicesPayload = targetIds.map(id => ({ id, actions: actionsPayload }));

  try {
    const response = await fetch('https://api.iot.yandex.net/v1.0/devices/actions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ devices: devicesPayload })
    });

    const raw = await response.text();
    let data: any = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

    if (!response.ok) return `Yandex API error (${response.status}): ${raw || 'empty response'}`;

    const resultDevices = Array.isArray(data?.devices) ? data.devices : [];
    const failed = resultDevices.filter((d: any) =>
      Array.isArray(d?.capabilities) &&
      d.capabilities.some((cap: any) => cap?.state?.action_result?.status === 'ERROR')
    );

    if (failed.length) {
      const failedIds = failed.map((d: any) => d?.id).filter(Boolean).join(', ');
      return `Command partially completed. Error on devices: ${failedIds || 'unknown'}.`;
    }

    const actionText = action === 'on'
      ? 'turned on'
      : action === 'off'
        ? 'turned off'
        : action === 'set_color'
          ? `color changed to ${args.color}`
          : `brightness set to ${brightnessValue ?? args.brightness}%`;
    return `Success: "${device.name}" → ${actionText}.`;
  } catch (err: any) {
    return `Smart home control error: ${err?.message || String(err)}`;
  }
};
