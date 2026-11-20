import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  appearanceColors,
  contrastRatio,
  materialColors,
  mixColor,
} = require('../src/renderer/lib/appearance-colors.ts');
const { newAppearance } = require('../src/renderer/lib/appearance-schema.ts');
const textTokens = [
  '--text-primary',
  '--text-body',
  '--text-secondary',
  '--text-muted',
  '--text-hint',
  '--accent-icon',
  '--accent-icon-light',
  '--color-success',
  '--color-error',
  '--color-warning',
  '--color-info',
  '--syntax-keyword',
  '--syntax-comment',
];
function check(profile: ReturnType<typeof newAppearance>) {
  for (const mode of ['light', 'dark'] as const) {
    const colors = appearanceColors(profile, mode);
    for (const [name, tokens] of [
      ['shell', colors.shell],
      ['panel', colors.panel],
      ['chat', colors.chat],
    ] as const) {
      const surfaces = [
        '--bg-primary',
        '--bg-secondary',
        '--bg-input',
        '--bg-bubble',
        '--bg-modal-hover',
      ].map((key) => tokens[key]);
      if (name === 'chat') surfaces.push(...colors.samples);
      for (const token of textTokens)
        for (const background of surfaces)
          assert.ok(
            contrastRatio(tokens[token], background) >= 4.5,
            `${profile.name} ${mode} ${name} ${token}: ${tokens[token]} on ${background}`,
          );
      assert.ok(contrastRatio(tokens['--accent'], tokens['--accent-contrast']) >= 4.5);
      assert.ok(contrastRatio(tokens['--selection-text'], tokens['--selection-bg']) >= 4.5);
    }
  }
}
const massEffect = newAppearance('mass-effect');
massEffect.background = {
  ...massEffect.background,
  type: 'gradient',
  color: '#04101e',
  color2: '#12365a',
};
check(massEffect);
const same = appearanceColors(massEffect, 'light');
assert.equal(
  same.background,
  'linear-gradient(135deg,#04101e,#12365a)',
  'already readable gradient colors are preserved',
);
assert.notEqual(
  same.chat['--text-body'],
  same.shell['--text-body'],
  'dark chat must have its own ink in a light shell',
);
for (const [a, b] of [
  ['#000000', '#ffffff'],
  ['#ff0000', '#0000ff'],
  ['#ffffff', '#fffefe'],
  ['#000001', '#000000'],
  ['#777777', '#888888'],
]) {
  const p = newAppearance();
  p.background = { ...p.background, type: 'gradient', color: a, color2: b };
  check(p);
}
for (const bg of ['#000000', '#ffffff', '#777777', '#ff00ff']) {
  const p = newAppearance();
  p.light = { background: bg, text: bg, accent: bg };
  p.dark = { ...p.light };
  for (const type of ['solid', 'gradient', 'image'] as const) {
    p.background = {
      ...p.background,
      type,
      image: 'https://example.test/image.png',
      color: '#000000',
      color2: '#ffffff',
      dim: 0,
    };
    check(p);
  }
}
let seed = 1742;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return '#' + (seed & 0xffffff).toString(16).padStart(6, '0');
};
for (let n = 0; n < 64; n++) {
  const p = newAppearance();
  p.light = {
    background: random(),
    text: random(),
    accent: random(),
    surface: random(),
    chat: random(),
  };
  p.dark = { background: random(), text: random(), accent: random() };
  p.background = { ...p.background, type: 'gradient', color: random(), color2: random() };
  check(p);
}
console.log(
  'PASS: light/dark shells, independent chat contrast, syntax/status/link colors, images, hostile and randomized palettes',
);

const explicit = newAppearance('regions');
explicit.light = { ...explicit.light, surface: '#081a2b', chat: '#253443' };
const scoped = appearanceColors(explicit, 'light');
assert.equal(scoped.shell['--bg-secondary'], explicit.light.background);
assert.equal(scoped.panel['--bg-secondary'], '#081a2b');
assert.equal(scoped.panel['--bg-primary'], '#081a2b');
assert.equal(scoped.chat['--bg-secondary'], '#253443');
const legacy = appearanceColors(newAppearance(), 'light');
assert.deepEqual(legacy.panel, legacy.shell);

for (const fill of ['#000000', '#ffffff', '#777777', '#ff00ff', '#0d2036']) {
  for (const opacity of [0.55, 0.8, 1]) {
    const profile = newAppearance();
    const result = materialColors(
      profile.light,
      { opacity, blur: 16, shadow: 'soft', border: 'defined' },
      fill,
    );
    assert.equal(result.opacity, opacity, 'requested opacity must not be raised');
    assert.ok(result.fill.endsWith(',' + opacity + ')'));
    let poorContrast = false;
    for (const bg of ['#000000', '#ffffff'])
      for (const token of [
        '--text-body',
        '--text-muted',
        '--text-hint',
        '--accent-icon',
        '--color-error',
      ])
        if (contrastRatio(result.tokens[token], mixColor(bg, fill, result.opacity)) < 4.5)
          poorContrast = true;
    if (poorContrast)
      assert.equal(result.contrastRisk, true, 'show a hint instead of changing opacity');
    assert.equal(result.filter, 'blur(16px)');
    assert.ok(result.fill.startsWith('rgba('));
  }
}
console.log(
  'PASS: exact material alpha over unknown backdrops, contrast hints, bounded blur and opaque text tokens',
);
