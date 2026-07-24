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
};

export type MqttPublishResult = { ok: boolean; error?: string };

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
  try {
    const client = getMqttClient(brokerUrl);

    if (!client.connected) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('mqtt_connect_timeout')), 8000);
        client.once('connect', () => { clearTimeout(timeout); resolve(); });
        client.once('error', (err) => { clearTimeout(timeout); reject(err); });
      });
    }

    const payload = buildZ2mPayload(action, args);
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
