import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
const { isValidZoomLevel, readZoomLevel, saveZoomLevel } = createRequire(import.meta.url)('../src/main/zoom-settings.ts');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatter-zoom-test-'));
try {
  assert.equal(readZoomLevel(tempDir), null);
  const level = Math.log(1.25) / Math.log(1.2);
  saveZoomLevel(tempDir, level);
  assert.equal(readZoomLevel(tempDir), level);
  saveZoomLevel(tempDir, 0);
  assert.equal(readZoomLevel(tempDir), 0, '100% must not be treated as missing');
  for (const value of [NaN, Infinity, -Infinity, '1', null, 100, -100]) {
    assert.equal(isValidZoomLevel(value), false);
    assert.throws(() => saveZoomLevel(tempDir, value), /invalid_zoom_level/);
  }
  assert.equal(readZoomLevel(tempDir), 0, 'invalid writes must preserve settings');
  for (const percent of [40, 200]) {
    saveZoomLevel(tempDir, Math.log(percent / 100) / Math.log(1.2));
    assert.ok(readZoomLevel(tempDir) !== null);
  }
  fs.writeFileSync(path.join(tempDir, 'zoom-settings.json'), 'broken json');
  assert.equal(readZoomLevel(tempDir), null);
  fs.writeFileSync(path.join(tempDir, 'zoom-settings.json'), '{"level":"1"}');
  assert.equal(readZoomLevel(tempDir), null);
  console.log('zoom-settings tests passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
