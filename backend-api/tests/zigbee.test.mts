import assert from 'node:assert/strict';

const {
  extractWritableProperties,
  validateZigbeePropertyValue,
} = await import('../src/services/zigbee.js') as typeof import('../src/services/zigbee.js');

const writable = extractWritableProperties([
  {
    type: 'climate',
    features: [
      {
        type: 'numeric',
        name: 'occupied_heating_setpoint',
        property: 'occupied_heating_setpoint',
        access: 7,
        value_min: 5,
        value_max: 30,
        value_step: 0.5,
        unit: '°C',
      },
      {
        type: 'numeric',
        name: 'local_temperature',
        property: 'local_temperature',
        access: 1,
        unit: '°C',
      },
      {
        type: 'enum',
        name: 'system_mode',
        property: 'system_mode',
        access: 7,
        values: ['off', 'heat', 'auto'],
      },
    ],
  },
  {
    type: 'composite',
    name: 'color_xy',
    property: 'color',
    access: 7,
    features: [
      { type: 'numeric', name: 'x', property: 'x', access: 7, value_min: 0, value_max: 1 },
      { type: 'numeric', name: 'y', property: 'y', access: 7, value_min: 0, value_max: 1 },
      { type: 'numeric', name: 'debug', property: 'debug', access: 1 },
    ],
  },
]);

assert.deepEqual(
  writable.map(item => item.property),
  ['occupied_heating_setpoint', 'system_mode', 'color'],
  'read-only properties must not be exposed as writable',
);

const setpoint = writable.find(item => item.property === 'occupied_heating_setpoint');
assert.ok(setpoint);
assert.deepEqual(validateZigbeePropertyValue(setpoint, '21.5'), { ok: true, value: 21.5 });
assert.equal(validateZigbeePropertyValue(setpoint, '21.2').ok, false);
assert.equal(validateZigbeePropertyValue(setpoint, '31').ok, false);

const mode = writable.find(item => item.property === 'system_mode');
assert.ok(mode);
assert.deepEqual(validateZigbeePropertyValue(mode, 'HEAT'), { ok: true, value: 'heat' });
assert.equal(validateZigbeePropertyValue(mode, 'cool').ok, false);

const color = writable.find(item => item.property === 'color');
assert.ok(color);
assert.deepEqual(validateZigbeePropertyValue(color, '{"x":0.4,"y":0.3}'), {
  ok: true,
  value: { x: 0.4, y: 0.3 },
});
assert.equal(validateZigbeePropertyValue(color, '{"debug":1}').ok, false);

console.log('Zigbee writable exposes and validation: OK');
