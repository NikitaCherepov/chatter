import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  profileCropFromViewport,
  renderProfileCrop,
  cropProfileImage,
} = require('../src/renderer/lib/profile-image-crop.ts');
assert.deepEqual(profileCropFromViewport(800, 400, 320, 1, { x: 0, y: 0 }), {
  x: 200,
  y: 0,
  size: 400,
});
assert.deepEqual(profileCropFromViewport(400, 800, 320, 2, { x: 0, y: 160 }), {
  x: 100,
  y: 200,
  size: 200,
});
const draws: any[] = [],
  closed: any[] = [];
Object.assign(globalThis, {
  document: {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: (...args: any[]) => draws.push(args) }),
      toDataURL: () => 'data:image/png;base64,AQID',
    }),
  },
  createImageBitmap: async (blob: Blob) => {
    assert.equal(blob.type, 'image/png');
    return { width: 800, height: 400, close: () => closed.push(true) };
  },
});
const rendered = renderProfileCrop('fixture', 800, 400, { x: 200, y: 0, size: 400 });
assert.equal(rendered.mimeType, 'image/png');
assert.equal(rendered.width, 512);
assert.deepEqual(draws.at(-1), ['fixture', 200, 0, 400, 400, 0, 0, 512, 512]);
assert.throws(
  () => renderProfileCrop('fixture', 800, 400, { x: 500, y: 0, size: 400 }),
  /profile_crop_invalid/,
);
assert.throws(
  () => renderProfileCrop('fixture', 800, 400, { x: 0, y: 0, size: Infinity }),
  /profile_crop_invalid/,
);
assert.throws(
  () => renderProfileCrop('fixture', 800, 400, { x: 0, y: 0, size: 100 }, 2049),
  /profile_crop_invalid/,
);
await assert.rejects(
  cropProfileImage(
    {
      base64: 'data:image/png;base64,AQID',
      mimeType: 'image/png',
      crop: { x: 0, y: 0, size: 100 },
    },
    () => {},
  ),
  /profile_image_invalid/,
);
await assert.rejects(
  cropProfileImage(
    { base64: 'AQID', mimeType: 'image/png', crop: { x: 0, y: 0, size: 100 } },
    () => {
      throw new Error('settings_scope_changed');
    },
  ),
  /settings_scope_changed/,
);
assert.equal(closed.length, 1);
const result = await cropProfileImage(
  { base64: 'AQID', mimeType: 'image/png', crop: { x: 0, y: 0, size: 100 }, outputSize: 256 },
  () => {},
);
assert.equal(result.width, 256);
assert.equal(closed.length, 2);
console.log(
  'PASS: shared native crop geometry, source bounds, output validation, raw-base64 isolation and bitmap cleanup on scope cancellation',
);
