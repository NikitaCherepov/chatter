import assert from 'node:assert/strict';
import sharp from 'sharp';

// Pure mapping tests — no DB, no network.
const { resolveCloudflareDimensions, CLOUDFLARE_KLEIN_CAPABILITIES, generateCloudflare } = await import(
  '../src/services/image-generation-cloudflare.js'
);

const dims = (aspectRatio: string, quality: string) => resolveCloudflareDimensions(aspectRatio, quality);

// ── Model defaults for the `auto` ratio, independent of quality ────────────
assert.deepEqual(dims('auto', 'auto'), { width: 1024, height: 768 });
assert.deepEqual(dims('auto', 'high'), { width: 1024, height: 768 });

// ── Quality tiers define the long side (512 / 1024 / 1920) ────────────────
assert.deepEqual(dims('1:1', 'low'), { width: 512, height: 512 });
assert.deepEqual(dims('1:1', 'medium'), { width: 1024, height: 1024 });
assert.deepEqual(dims('1:1', 'high'), { width: 1920, height: 1920 });
assert.deepEqual(dims('1:1', 'auto'), { width: 1024, height: 1024 });

// ── Orientation from the ratio ─────────────────────────────────────────────
assert.deepEqual(dims('16:9', 'high'), { width: 1920, height: 1080 });
assert.deepEqual(dims('9:16', 'medium'), { width: 576, height: 1024 });
assert.deepEqual(dims('4:3', 'medium'), { width: 1024, height: 768 });
assert.deepEqual(dims('3:4', 'low'), { width: 384, height: 512 });

// ── Decimal ratios ─────────────────────────────────────────────────────────
assert.deepEqual(dims('9:19.5', 'medium'), { width: 472, height: 1024 });

// ── Extreme ratios clamp into the 256..1920 range ──────────────────────────
assert.deepEqual(dims('1:8', 'low'), { width: 256, height: 512 });
const extreme = dims('1:16', 'high');
assert.ok(extreme.width >= CLOUDFLARE_KLEIN_CAPABILITIES.width.min, 'min side respected');
assert.ok(extreme.height <= CLOUDFLARE_KLEIN_CAPABILITIES.height.max, 'max side respected');

// ── Sides are multiples of 8 (FLUX-family convention) ──────────────────────
for (const [ratio, quality] of [['16:9', 'high'], ['9:19.5', 'medium'], ['4:5', 'low']] as const) {
  const result = dims(ratio, quality);
  assert.equal(result.width % 8, 0, `${ratio} width snapped to /8`);
  assert.equal(result.height % 8, 0, `${ratio} height snapped to /8`);
}

// Oversized img2img references are normalized before they reach Cloudflare.
const oversized = await sharp({
  create: { width: 1200, height: 800, channels: 3, background: '#336699' },
}).jpeg().toBuffer();
let submitted: FormData | null = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  submitted = init?.body as FormData;
  return new Response(JSON.stringify({ success: true, result: { image: 'ZmFrZQ==' } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
try {
  const result = await generateCloudflare({
    enabled: true,
    img2imgEnabled: true,
    provider: 'cloudflare',
    openrouter: {} as never,
    cloudflare: {
      apiTokenId: 1,
      apiToken: 'token',
      accountId: 'account',
      model: {
        id: '@cf/black-forest-labs/flux-2-klein-4b',
        name: 'FLUX.2 [klein] 4B',
        capabilities: null,
        params: {
          resolution: null,
          quality: { allowed: ['auto'], default: 'auto' },
          aspectRatio: { allowed: ['auto', '1:1'], default: 'auto' },
        },
      },
    },
  }, 'test', [{ base64: oversized.toString('base64'), mimeType: 'image/jpeg' }], '1:1');
  assert.equal(result.ok, true);
  const reference = submitted?.get('input_image_0');
  assert.ok(reference instanceof Blob, 'resized reference is submitted as a multipart file');
  const normalized = await sharp(Buffer.from(await reference.arrayBuffer())).metadata();
  assert.ok((normalized.width ?? Infinity) <= 512);
  assert.ok((normalized.height ?? Infinity) <= 512);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('cloudflare dimensions and reference normalization: ok');
