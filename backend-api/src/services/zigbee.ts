// ── Zigbee2MQTT Provider ─────────────────────────────────────────────────────
// Device discovery and control via MQTT broker (Mosquitto + Zigbee2MQTT).

import mqtt from 'mqtt';

// ── Types ───────────────────────────────────────────────────────────────────

export type ZigbeeDeviceParsed = {
  id: string;
  name: string;
  room_name: string | null;
  provider: string;
  is_group: number;
  native_id: string;
  type: string | null;
  capabilities: string;
  target_ids: string;
  writable_properties: string;
};

export type MqttPublishResult = { ok: boolean; error?: string };

export type ZigbeeWritableProperty = {
  property: string;
  name: string;
  label: string;
  type: 'binary' | 'numeric' | 'enum' | 'text' | 'composite' | 'list';
  category?: string;
  unit?: string;
  value_min?: number;
  value_max?: number;
  value_step?: number;
  values?: unknown[];
  value_on?: unknown;
  value_off?: unknown;
  value_toggle?: unknown;
  length_min?: number;
  length_max?: number;
  features?: ZigbeeWritableProperty[];
  item_type?: ZigbeeWritableProperty;
};

export type ZigbeeValueValidation =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

// ── MQTT connection pool (one client per broker URL) ────────────────────────

const mqttPool = new Map<string, mqtt.MqttClient>();

/** Masks credentials in a broker URL for safe logging, e.g. mqtt://user:pass@host → mqtt://***@host */
function maskUrl(url: string): string {
  try {
    return url.replace(/^(mqtt(s)?|ws(s)?:)\/\/[^@]+@/, '$1//***@');
  } catch {
    return '[invalid-url]';
  }
}

function getMqttClient(brokerUrl: string): mqtt.MqttClient {
  const existing = mqttPool.get(brokerUrl);
  // Return both connected and connecting clients — don't kill one mid-handshake
  if (existing) return existing;

  const client = mqtt.connect(brokerUrl, {
    connectTimeout: 5000,
    reconnectPeriod: 10000,
    clean: true,
  });
  client.on('error', (err) => {
    console.error(`[zigbee] MQTT error (${maskUrl(brokerUrl)}):`, err.message);
  });
  // Remove from pool when permanently closed (server shutdown / network loss)
  client.on('close', () => {
    // Only remove if this client is still the one in the pool
    if (mqttPool.get(brokerUrl) === client) {
      mqttPool.delete(brokerUrl);
    }
  });
  mqttPool.set(brokerUrl, client);
  return client;
}
/** For graceful shutdown (call when stopping the server) */
export function closeMqtt(): void {
  for (const client of mqttPool.values()) client.end(true);
  mqttPool.clear();
}

// ── Discovery ───────────────────────────────────────────────────────────────

/**
 * Subscribes to zigbee2mqtt/bridge/devices and collects devices.
 * Z2M docs say it's retained, but in practice retain may be missing.
 * Strategy: subscribe + wait up to 8 seconds for the first message.
 */
export async function discoverZigbeeDevices(brokerUrl: string): Promise<ZigbeeDeviceParsed[]> {
  const client = getMqttClient(brokerUrl);

  // Wait for connection if not yet connected
  if (!client.connected) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('mqtt_connect_timeout')), 8000);
      client.once('connect', () => { clearTimeout(timeout); resolve(); });
      client.once('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  return new Promise<ZigbeeDeviceParsed[]>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      client.removeListener('message', handler);
      client.unsubscribe('zigbee2mqtt/bridge/devices');
    };

    const handler = (topic: string, message: Buffer) => {
      if (topic !== 'zigbee2mqtt/bridge/devices') return;
      cleanup();

      try {
        const rawDevices = JSON.parse(message.toString());
        if (!Array.isArray(rawDevices)) {
          return reject(new Error('mqtt_unexpected_format: bridge/devices returned non-array'));
        }
        resolve(parseZigbeeData(rawDevices));
      } catch (e: any) {
        reject(new Error(`mqtt_parse_error: ${e.message}`));
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('mqtt_discovery_timeout: bridge/devices did not respond within 8 seconds. Check if Zigbee2MQTT is running.'));
    }, 8000);

    client.on('message', handler);

    client.subscribe('zigbee2mqtt/bridge/devices', { qos: 0 }, (err) => {
      if (err) {
        cleanup();
        return reject(new Error(`mqtt_subscribe_failed: ${err.message}`));
      }
    });
  });
}

// ── Exposes → capabilities parser ────────────────────────────────────────────

/**
 * Recursively traverses the Z2M exposes tree and returns a flat list of capabilities.
 * Exposes format: https://www.zigbee2mqtt.io/guide/usage/exposes.html
 */
function extractCapabilities(exposes: any[]): string[] {
  const caps: string[] = [];
  for (const exp of exposes) {
    if (!exp) continue;
    if (exp.features && Array.isArray(exp.features)) {
      // Specific type (light, switch, cover, lock, fan, climate) or composite
      for (const f of exp.features) {
        if (f.features && Array.isArray(f.features)) {
          // Nested composite (e.g. color_hs with {hue, saturation})
          caps.push(f.name);
        } else {
          caps.push(f.name);
        }
      }
    } else if (exp.name) {
      // Generic type (binary, numeric, enum, text)
      caps.push(exp.name);
    }
  }
  return caps;
}

const SUPPORTED_WRITABLE_TYPES = new Set(['binary', 'numeric', 'enum', 'text', 'composite', 'list']);

const isSettable = (expose: any): boolean => (Number(expose?.access) & 2) === 2;

const finiteNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const sanitizeWritableExpose = (expose: any, requireSetAccess: boolean): ZigbeeWritableProperty | null => {
  if (!expose || typeof expose !== 'object') return null;
  if (requireSetAccess && !isSettable(expose)) return null;

  const type = `${expose.type || ''}`;
  const property = `${expose.property || ''}`.trim();
  if (!property || !SUPPORTED_WRITABLE_TYPES.has(type)) return null;

  const result: ZigbeeWritableProperty = {
    property,
    name: `${expose.name || property}`,
    label: `${expose.label || expose.name || property}`,
    type: type as ZigbeeWritableProperty['type'],
  };

  if (typeof expose.category === 'string') result.category = expose.category;
  if (typeof expose.unit === 'string') result.unit = expose.unit;

  const valueMin = finiteNumber(expose.value_min);
  const valueMax = finiteNumber(expose.value_max);
  const valueStep = finiteNumber(expose.value_step);
  const lengthMin = finiteNumber(expose.length_min);
  const lengthMax = finiteNumber(expose.length_max);
  if (valueMin !== undefined) result.value_min = valueMin;
  if (valueMax !== undefined) result.value_max = valueMax;
  if (valueStep !== undefined && valueStep > 0) result.value_step = valueStep;
  if (lengthMin !== undefined) result.length_min = lengthMin;
  if (lengthMax !== undefined) result.length_max = lengthMax;

  if (Array.isArray(expose.values)) result.values = expose.values;
  if (Object.prototype.hasOwnProperty.call(expose, 'value_on')) result.value_on = expose.value_on;
  if (Object.prototype.hasOwnProperty.call(expose, 'value_off')) result.value_off = expose.value_off;
  if (Object.prototype.hasOwnProperty.call(expose, 'value_toggle')) result.value_toggle = expose.value_toggle;

  if (type === 'composite') {
    const features = Array.isArray(expose.features)
      ? expose.features
          .map((feature: any) => sanitizeWritableExpose(feature, feature?.access !== undefined))
          .filter((feature: ZigbeeWritableProperty | null): feature is ZigbeeWritableProperty => Boolean(feature))
      : [];
    if (!features.length) return null;
    result.features = features;
  }

  if (type === 'list') {
    const itemType = sanitizeWritableExpose(
      { ...(expose.item_type || {}), property: expose.item_type?.property || 'item' },
      false,
    );
    if (!itemType) return null;
    result.item_type = itemType;
  }

  return result;
};

/** Returns only properties whose Zigbee2MQTT access mask includes SET (bit 2). */
export function extractWritableProperties(exposes: any[]): ZigbeeWritableProperty[] {
  const properties: ZigbeeWritableProperty[] = [];

  const visit = (expose: any) => {
    if (!expose || typeof expose !== 'object') return;

    const direct = sanitizeWritableExpose(expose, true);
    if (direct) {
      properties.push(direct);
      return;
    }

    if (Array.isArray(expose.features)) {
      for (const feature of expose.features) visit(feature);
    }
  };

  for (const expose of Array.isArray(exposes) ? exposes : []) visit(expose);

  const seen = new Set<string>();
  return properties.filter((property) => {
    const key = `${property.property}:${property.type}:${JSON.stringify(property.features || [])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Maps Z2M exposes names → unified capabilities (matching Yandex format).
 * This lets the AI tool work identically with both providers.
 */
export function mapZ2mCapsToUnified(caps: string[]): string[] {
  const unified: string[] = [];
  if (caps.includes('state')) unified.push('on_off');
  if (caps.includes('brightness')) unified.push('range');
  if (caps.includes('color_temp') || caps.includes('color_hs') || caps.includes('color_xy') || caps.includes('color')) {
    unified.push('color_setting');
  }
  return unified.length ? unified : caps; // fallback — keep original names
}

// ── Data parser ─────────────────────────────────────────────────────────────

function parseZigbeeData(rawDevices: any[]): ZigbeeDeviceParsed[] {
  const entities: ZigbeeDeviceParsed[] = [];

  for (const d of rawDevices) {
    // Skip coordinator (USB stick) and disabled devices
    if (d.type === 'Coordinator') continue;
    if (d.disabled) continue;

    const friendlyName: string = d.friendly_name || d.ieee_address;
    const rawCaps = d.definition?.exposes ? extractCapabilities(d.definition.exposes) : [];
    const unifiedCaps = mapZ2mCapsToUnified(rawCaps);
    const writableProperties = extractWritableProperties(d.definition?.exposes || []);

    // Detect device type from exposes
    const deviceType = d.definition?.exposes?.find((e: any) =>
      ['light', 'switch', 'cover', 'lock', 'fan', 'climate', 'thermostat'].includes(e.type)
    )?.type || d.type || null;

    entities.push({
      id: `zigbee_${d.ieee_address}`,
      name: d.description || friendlyName,
      room_name: null, // Z2M has no rooms out of the box
      provider: 'zigbee',
      is_group: 0,
      native_id: friendlyName, // Used for the MQTT topic
      type: deviceType,
      capabilities: JSON.stringify(unifiedCaps),
      target_ids: JSON.stringify([friendlyName]),
      writable_properties: JSON.stringify(writableProperties),
    });
  }

  return entities;
}

// ── Groups parser ───────────────────────────────────────────────────────────

export async function discoverZigbeeGroups(brokerUrl: string): Promise<ZigbeeDeviceParsed[]> {
  const client = getMqttClient(brokerUrl);

  if (!client.connected) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('mqtt_connect_timeout')), 8000);
      client.once('connect', () => { clearTimeout(timeout); resolve(); });
      client.once('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  return new Promise<ZigbeeDeviceParsed[]>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      client.removeListener('message', handler);
      client.unsubscribe('zigbee2mqtt/bridge/groups');
    };

    const handler = (topic: string, message: Buffer) => {
      if (topic !== 'zigbee2mqtt/bridge/groups') return;
      cleanup();

      try {
        const rawGroups = JSON.parse(message.toString());
        if (!Array.isArray(rawGroups)) return resolve([]);

        const groups: ZigbeeDeviceParsed[] = rawGroups
          .filter((g: any) => g.friendly_name && Array.isArray(g.members) && g.members.length > 0)
          .map((g: any) => ({
            id: `zigbee_group_${g.id}`,
            name: g.friendly_name,
            room_name: null,
            provider: 'zigbee',
            is_group: 1,
            native_id: g.friendly_name,
            type: 'light', // Groups are typically lights
            capabilities: JSON.stringify(['on_off', 'brightness', 'color_setting']),
            target_ids: JSON.stringify([g.friendly_name]),
            writable_properties: JSON.stringify([]),
          }));

        resolve(groups);
      } catch {
        resolve([]);
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve([]); // Groups may be absent — not an error
    }, 8000);

    client.on('message', handler);

    client.subscribe('zigbee2mqtt/bridge/groups', { qos: 0 }, (err) => {
      if (err) {
        cleanup();
        return resolve([]);
      }
    });
  });
}

// ── Control ─────────────────────────────────────────────────────────────────

/**
 * Maps unified capabilities → Z2M exposes names for set commands.
 */
const CAPABILITY_TO_Z2M_SET: Record<string, string> = {
  on_off: 'state',
  range: 'brightness',
  color_setting: 'color',
};

/**
 * Converts HSV (h:0-360, s:0-100, v:0-100) → Z2M payload.
 * Z2M accepts color_hs = {h, s} and brightness (0-254) separately.
 */
function buildZ2mPayload(action: string, args: { color?: string; brightness?: number }): Record<string, any> {
  if (action === 'on') return { state: 'ON' };
  if (action === 'off') return { state: 'OFF' };

  if (action === 'set_color') {
    if (!args.color) return { state: 'ON' };
    const hsv = parseColorToHsv(args.color);
    if (!hsv) return { state: 'ON' };
    return {
      state: 'ON',
      color: { h: hsv.h, s: hsv.s },
      brightness: Math.round((hsv.v / 100) * 254),
    };
  }

  if (action === 'set_brightness') {
    const raw = Number(args.brightness);
    const br = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 100;
    return { state: 'ON', brightness: Math.round((br / 100) * 254) };
  }
  return {};
}

const decodeToolValue = (rawValue: unknown): unknown => {
  if (typeof rawValue !== 'string') return rawValue;
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
};

const matchAllowedValue = (value: unknown, allowedValues: unknown[]): unknown | undefined => {
  const exact = allowedValues.find(allowed => Object.is(allowed, value));
  if (exact !== undefined) return exact;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return allowedValues.find(allowed => typeof allowed === 'string' && allowed.toLowerCase() === normalized);
};

export function validateZigbeePropertyValue(
  schema: ZigbeeWritableProperty,
  rawValue: unknown,
): ZigbeeValueValidation {
  const value = decodeToolValue(rawValue);

  if (schema.type === 'numeric') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return { ok: false, error: 'value_must_be_numeric' };
    if (schema.value_min !== undefined && numeric < schema.value_min) {
      return { ok: false, error: `value_below_minimum_${schema.value_min}` };
    }
    if (schema.value_max !== undefined && numeric > schema.value_max) {
      return { ok: false, error: `value_above_maximum_${schema.value_max}` };
    }
    if (schema.value_step !== undefined) {
      const base = schema.value_min || 0;
      const steps = (numeric - base) / schema.value_step;
      if (Math.abs(steps - Math.round(steps)) > 1e-7) {
        return { ok: false, error: `value_must_follow_step_${schema.value_step}` };
      }
    }
    return { ok: true, value: numeric };
  }

  if (schema.type === 'binary') {
    const allowed = [schema.value_on, schema.value_off, schema.value_toggle]
      .filter(candidate => candidate !== undefined);
    const matched = matchAllowedValue(value, allowed);
    if (matched === undefined) {
      return { ok: false, error: `value_must_be_one_of_${JSON.stringify(allowed)}` };
    }
    return { ok: true, value: matched };
  }

  if (schema.type === 'enum') {
    const allowed = Array.isArray(schema.values) ? schema.values : [];
    const matched = matchAllowedValue(value, allowed);
    if (matched === undefined) {
      return { ok: false, error: `value_must_be_one_of_${JSON.stringify(allowed)}` };
    }
    return { ok: true, value: matched };
  }

  if (schema.type === 'text') {
    if (typeof value !== 'string') return { ok: false, error: 'value_must_be_text' };
    return { ok: true, value };
  }

  if (schema.type === 'composite') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'value_must_be_json_object' };
    }
    const features = schema.features || [];
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(input)) {
      const nestedSchema = features.find(feature => feature.property === key);
      if (!nestedSchema) return { ok: false, error: `unknown_nested_property_${key}` };
      const nestedResult = validateZigbeePropertyValue(nestedSchema, nestedValue);
      if (nestedResult.ok === false) return { ok: false, error: `${key}_${nestedResult.error}` };
      output[key] = nestedResult.value;
    }
    if (!Object.keys(output).length) return { ok: false, error: 'composite_value_is_empty' };
    return { ok: true, value: output };
  }

  if (schema.type === 'list') {
    if (!Array.isArray(value)) return { ok: false, error: 'value_must_be_json_array' };
    if (schema.length_min !== undefined && value.length < schema.length_min) {
      return { ok: false, error: `list_shorter_than_${schema.length_min}` };
    }
    if (schema.length_max !== undefined && value.length > schema.length_max) {
      return { ok: false, error: `list_longer_than_${schema.length_max}` };
    }
    if (!schema.item_type) return { ok: false, error: 'list_item_schema_missing' };
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const itemResult = validateZigbeePropertyValue(schema.item_type, value[index]);
      if (itemResult.ok === false) return { ok: false, error: `item_${index}_${itemResult.error}` };
      output.push(itemResult.value);
    }
    return { ok: true, value: output };
  }

  return { ok: false, error: 'unsupported_property_type' };
}

export async function publishZigbeeProperty(
  brokerUrl: string,
  friendlyName: string,
  property: string,
  value: unknown,
): Promise<MqttPublishResult> {
  return publishZigbeePayload(brokerUrl, friendlyName, { [property]: value });
}

async function publishZigbeePayload(
  brokerUrl: string,
  friendlyName: string,
  payload: Record<string, unknown>,
): Promise<MqttPublishResult> {
  try {
    const client = getMqttClient(brokerUrl);

    if (!client.connected) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('mqtt_connect_timeout')), 8000);
        client.once('connect', () => { clearTimeout(timeout); resolve(); });
        client.once('error', (err) => { clearTimeout(timeout); reject(err); });
      });
    }

    const topic = `zigbee2mqtt/${friendlyName}/set`;
    return new Promise<MqttPublishResult>((resolve) => {
      client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) return resolve({ ok: false, error: err.message });
        resolve({ ok: true });
      });
    });
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Publishes an MQTT command for a zigbee device.
 * Topic: zigbee2mqtt/{FRIENDLY_NAME}/set
 */
export async function publishZigbeeCommand(
  brokerUrl: string,
  friendlyName: string,
  action: string,
  args: { color?: string; brightness?: number },
): Promise<MqttPublishResult> {
  return publishZigbeePayload(brokerUrl, friendlyName, buildZ2mPayload(action, args));
}

// ── Color helper (duplicated from smart-home.ts to avoid circular import) ───

const COLOR_NAME_TO_HEX: Record<string, string> = {
  red: '#FF0000', green: '#00FF00', blue: '#0000FF', white: '#FFFFFF', black: '#000000',
  yellow: '#FFFF00', purple: '#800080', violet: '#800080', pink: '#FFC0CB', orange: '#FFA500',
  cyan: '#00FFFF', teal: '#008080', warmwhite: '#FFD8A8', coolwhite: '#DCEBFF',
  // Russian color names
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
  'холодный белый': '#DCEBFF',
};

function parseColorToHsv(value: string): { h: number; s: number; v: number } | null {
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
}
