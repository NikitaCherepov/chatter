import dotenv from 'dotenv';

dotenv.config();

const parseAdminId = (raw: string | undefined) => {
  if (!raw) return null;
  const normalized = raw.replace(/[^\d-]/g, '').trim();
  if (!normalized) return null;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

const parseCsv = (raw: string | undefined) => {
  if (!raw) return [] as string[];
  return raw.split(/[,\n;]+/).map(v => v.trim()).filter(Boolean);
};

const normalizeAlias = (v: string) => v.trim().toLowerCase();

const ADMIN_IDS = (() => {
  const ids = new Set<number>();
  for (const raw of (process.env.ADMIN_IDS || '').split(/[,\s;]+/)) {
    const id = parseAdminId(raw);
    if (id) ids.add(id);
  }
  const one = parseAdminId(process.env.ADMIN_ID);
  if (one) ids.add(one);
  return ids;
})();

const SMART_HOME_ALLOWED_IDS = (() => {
  const ids = new Set<number>();
  for (const raw of parseCsv(process.env.SMART_HOME_ALLOWED_IDS)) {
    const id = parseAdminId(raw);
    if (id) ids.add(id);
  }
  const one = parseAdminId(process.env.SMART_HOME_ALLOWED_ID);
  if (one) ids.add(one);
  return ids;
})();

const SMART_HOME_DEVICES_FALLBACK: Record<string, string[]> = {
  'свет': [
    '20c0fb1b-f5e4-4daf-b121-0ee0fb326586',
    '619facb9-4ce8-4ed6-b66a-923f01c8e0a4',
    'e3d027ee-3ca4-4776-9e92-f23c7e6dc926'
  ],
  'увлажнитель': [
    '65b9c366-cb0c-4dfd-8624-1473a811752f'
  ]
};

const SMART_HOME_DEVICES: Record<string, string[]> = (() => {
  const devices: Record<string, string[]> = {};
  for (const [alias, ids] of Object.entries(SMART_HOME_DEVICES_FALLBACK)) {
    devices[normalizeAlias(alias)] = ids.map(v => v.trim()).filter(Boolean);
  }

  const jsonRaw = process.env.SMART_HOME_DEVICES_JSON;
  if (jsonRaw) {
    try {
      const parsed = JSON.parse(jsonRaw) as Record<string, string[] | string>;
      for (const [alias, value] of Object.entries(parsed)) {
        const ids = Array.isArray(value) ? value.map(v => `${v}`.trim()).filter(Boolean) : parseCsv(`${value}`);
        if (!ids.length) continue;
        devices[normalizeAlias(alias)] = ids;
      }
    } catch {
      // ignore malformed JSON
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('SMART_HOME_DEVICE_')) continue;
    const alias = normalizeAlias(key.replace('SMART_HOME_DEVICE_', '').replace(/__/g, '-').replace(/_/g, ' '));
    const ids = parseCsv(value);
    if (!ids.length) continue;
    devices[alias] = ids;
  }

  return devices;
})();

type SmartHomeAction = 'on' | 'off' | 'set_color' | 'set_brightness';
export type SmartHomeArgs = {
  device_name?: string;
  action?: SmartHomeAction;
  color?: string;
  brightness?: number;
};

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

export const runSmartHomeControl = async (userId: number, args: SmartHomeArgs) => {
  const canControl = ADMIN_IDS.has(userId) || SMART_HOME_ALLOWED_IDS.has(userId);
  if (!canControl) return 'Ошибка доступа: у тебя нет прав на управление умным домом.';
  if (!process.env.YANDEX_IOT_TOKEN) return 'Ошибка конфигурации: не задан YANDEX_IOT_TOKEN.';

  const deviceName = normalizeAlias(args.device_name || '');
  if (!deviceName) return 'Ошибка инструмента: не передано имя устройства.';

  const deviceIds = SMART_HOME_DEVICES[deviceName];
  if (!deviceIds?.length) return `Ошибка: устройство "${args.device_name}" не найдено.`;

  const action = args.action;
  if (!action || !['on', 'off', 'set_color', 'set_brightness'].includes(action)) {
    return 'Ошибка инструмента: неизвестное действие.';
  }

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
    if (!args.color) return 'Ошибка инструмента: для set_color нужен параметр color.';
    const hsv = parseColorToHsv(args.color);
    if (hsv === null) return `Ошибка инструмента: не удалось распознать цвет "${args.color}".`;
    actionsPayload = [onOffPayload(true), colorPayload(hsv)];
  }
  if (action === 'set_brightness') {
    if (args.brightness === undefined) return 'Ошибка инструмента: для set_brightness нужен параметр brightness.';
    let br = Number(args.brightness);
    if (Number.isNaN(br)) br = 100;
    if (br < 1) br = 1;
    if (br > 100) br = 100;
    brightnessValue = br;
    actionsPayload = [onOffPayload(true), brightnessPayload(br)];
  }

  const devicesPayload = deviceIds.map(id => ({ id, actions: actionsPayload }));

  try {
    const response = await fetch('https://api.iot.yandex.net/v1.0/devices/actions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.YANDEX_IOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ devices: devicesPayload })
    });

    const raw = await response.text();
    let data: any = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }

    if (!response.ok) return `Ошибка API Яндекса (${response.status}): ${raw || 'пустой ответ'}`;

    const devices = Array.isArray(data?.devices) ? data.devices : [];
    const failed = devices.filter((device: any) =>
      Array.isArray(device?.capabilities)
      && device.capabilities.some((cap: any) => cap?.state?.action_result?.status === 'ERROR')
    );

    if (failed.length) {
      const failedIds = failed.map((item: any) => item?.id).filter(Boolean).join(', ');
      return `Команда выполнена частично. Ошибка у устройств: ${failedIds || 'неизвестно'}.`;
    }

    const actionText = action === 'on'
      ? 'включено'
      : action === 'off'
        ? 'выключено'
        : action === 'set_color'
          ? `цвет изменен на ${args.color}`
          : `яркость установлена на ${brightnessValue ?? args.brightness}%`;
    return `Успешно: "${args.device_name}" -> ${actionText}.`;
  } catch (err: any) {
    return `Техническая ошибка при управлении умным домом: ${err?.message || String(err)}`;
  }
};
