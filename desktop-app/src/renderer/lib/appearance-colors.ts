import type { AppearanceProfile, Palette } from './appearance-schema';

const rgb = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
export const mixColor = (a: string, b: string, amount: number) =>
  '#' +
  rgb(a)
    .map((channel, i) =>
      Math.round(channel + (rgb(b)[i] - channel) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const luminance = (hex: string) =>
  rgb(hex).reduce((sum, channel, i) => {
    const s = channel / 255;
    return (
      sum + (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i]
    );
  }, 0);
export const contrastRatio = (a: string, b: string) => {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const minimumContrast = (text: string, backgrounds: string[]) =>
  Math.min(...backgrounds.map((bg) => contrastRatio(text, bg)));
const bestInk = (backgrounds: string[]) =>
  minimumContrast('#ffffff', backgrounds) > minimumContrast('#000000', backgrounds)
    ? '#ffffff'
    : '#000000';
// Preserve the requested hue wherever possible; correct only the contrast needed for reading.
const readable = (text: string, backgrounds: string[], ratio = 4.6) => {
  if (minimumContrast(text, backgrounds) >= ratio) return text;
  const ink = bestInk(backgrounds);
  if (minimumContrast(ink, backgrounds) < ratio) return ink;
  let low = 0,
    high = 1;
  for (let step = 0; step < 10; step++) {
    const middle = (low + high) / 2;
    if (minimumContrast(mixColor(text, ink, middle), backgrounds) >= ratio) high = middle;
    else low = middle;
  }
  return mixColor(text, ink, high);
};
const gradientSamples = (start: string, end: string) =>
  Array.from({ length: 33 }, (_, i) => mixColor(start, end, i / 32));

export function paletteTokens(
  palette: Palette,
  backdrops: string[] = [palette.background],
): Record<string, string> {
  const bg = palette.background,
    dark = luminance(bg) < 0.25;
  const ink = bestInk([bg]);
  const surface = (amount: number) => {
    const lifted = mixColor(bg, '#ffffff', amount);
    // Near mid-grey, lifting every surface can make neither black nor white
    // readable throughout the UI. Keep surfaces on the same side of the ink.
    return contrastRatio(ink, lifted) >= Math.min(4.6, contrastRatio(ink, bg))
      ? lifted
      : mixColor(bg, '#000000', amount);
  };
  const primary = surface(dark ? 0.06 : 0.85);
  const input = surface(0.035),
    bubble = surface(0.045),
    hover = surface(0.08);
  const surfaces = [...backdrops, bg, primary, input, bubble, hover];
  const text = readable(palette.text, surfaces);
  const shade = (amount: number) => readable(mixColor(text, bg, amount), surfaces);
  const syntax = dark
    ? ['#c5a5e8', '#c3d59d', '#e7b78e', '#94a3b5', '#e6d19b', '#9ed6ce', '#9dc4e4', '#b8b8df']
    : ['#a626a4', '#116329', '#0550ae', '#57606a', '#6639ba', '#953800', '#0550ae', '#6e5300'];
  const tokens: Record<string, string> = {
    '--bg-primary': primary,
    '--bg-secondary': bg,
    '--bg-input': input,
    '--bg-bubble': bubble,
    '--bg-modal-hover': hover,
    '--text-primary': text,
    '--text-body': text,
    '--text-secondary': shade(0.12),
    '--text-muted': shade(0.3),
    '--text-hint': shade(0.44),
    '--border-light': mixColor(bg, text, 0.17),
    '--border-medium': mixColor(bg, text, 0.3),
    '--border-input': mixColor(bg, text, 0.3),
    '--accent': palette.accent,
    '--accent-contrast': bestInk([palette.accent]),
    '--accent-icon': readable(mixColor(palette.accent, text, 0.1), surfaces),
    '--accent-icon-light': readable(mixColor(palette.accent, bg, 0.2), surfaces),
    '--accent-icon-placeholder': shade(0.35),
    '--scrollbar-thumb': mixColor(bg, text, 0.28),
    '--scrollbar-hover': mixColor(bg, text, 0.42),
    '--shadow-card': dark
      ? '0 1px 3px #0005, 0 8px 24px #0004'
      : '0 1px 3px #080f1d1a, 0 8px 24px #080f1d14',
    '--shadow-fab': dark ? '0 2px 8px #0008' : '0 2px 8px #080f1d4d',
    '--shadow-modal': dark ? '0 8px 32px #0007' : '0 8px 32px #080f1d2e',
    '--color-scheme': dark ? 'dark' : 'light',
    '--selection-bg': mixColor(bg, palette.accent, 0.3),
    '--overlay-bg': dark ? 'rgba(0,0,0,.58)' : 'rgba(0,0,0,.3)',
  };
  tokens['--selection-text'] = readable(text, [tokens['--selection-bg']]);
  for (const [name, token] of Object.entries({
    bg: '--bg-bubble',
    hover: '--bg-modal-hover',
    accent: '--accent',
    ink: '--accent-icon',
    contrast: '--accent-contrast',
  }))
    tokens['--appearance-control-' + name] = tokens[token];
  for (const [name, color] of Object.entries({
    success: dark ? '#4ade80' : '#15803d',
    error: dark ? '#f87171' : '#b91c1c',
    info: dark ? '#60a5fa' : '#2563eb',
    warning: dark ? '#facc15' : '#85530a',
  })) {
    tokens['--color-' + name] = readable(color, surfaces);
    tokens['--color-' + name + '-contrast'] = bestInk([tokens['--color-' + name]]);
  }
  ['keyword', 'string', 'number', 'comment', 'function', 'type', 'name', 'meta'].forEach(
    (name, i) => {
      tokens['--syntax-' + name] = readable(syntax[i], surfaces);
    },
  );
  return tokens;
}

export function appearanceColors(
  profile: AppearanceProfile,
  mode: 'light' | 'dark',
  resolveImage = (url: string) => url,
) {
  const p = profile[mode],
    b = profile.background,
    shell = paletteTokens(p);
  const panel = p.surface ? paletteTokens({ ...p, background: p.surface }) : shell;
  if (p.surface) panel['--bg-primary'] = p.surface;
  let background = 'none',
    samples = [p.chat ?? p.background];
  if (b.type === 'gradient') samples = gradientSamples(b.color, b.color2);
  if (b.type === 'image') {
    // An arbitrary image can contain both black and white pixels. A neutral scrim
    // bounds its worst-case contrast without canvas reads or external image access.
    const tint = luminance(p.background) < 0.25 ? '#000000' : '#ffffff';
    const opacity = Math.max(b.dim, tint === '#000000' ? 0.6 : 0.5);
    samples = gradientSamples(
      mixColor('#000000', tint, opacity),
      mixColor('#ffffff', tint, opacity),
    );
    const channels = rgb(tint).join(',');
    background = `linear-gradient(rgba(${channels},${opacity}),rgba(${channels},${opacity})),url(${JSON.stringify(resolveImage(b.image))})`;
  }
  if (b.type === 'gradient') {
    // Mixed light/dark gradients may have no single readable text color. Add only
    // as much neutral scrim as needed; uniform dark gradients keep their colors.
    const ink = bestInk(samples),
      tint = ink === '#ffffff' ? '#000000' : '#ffffff';
    let opacity = 0;
    if (minimumContrast(ink, samples) < 4.6) {
      let low = 0,
        high = 1;
      for (let step = 0; step < 10; step++) {
        const middle = (low + high) / 2;
        const candidate = gradientSamples(
          mixColor(b.color, tint, middle),
          mixColor(b.color2, tint, middle),
        );
        if (minimumContrast(ink, candidate) >= 4.6) high = middle;
        else low = middle;
      }
      opacity = high;
      samples = gradientSamples(
        mixColor(b.color, tint, opacity),
        mixColor(b.color2, tint, opacity),
      );
    }
    background = `linear-gradient(${b.angle}deg,${mixColor(b.color, tint, opacity)},${mixColor(b.color2, tint, opacity)})`;
  }
  const backgroundColor = samples[Math.floor(samples.length / 2)];
  const alternate = profile[mode === 'light' ? 'dark' : 'light'].text;
  const preferred =
    minimumContrast(p.text, samples) >= 4.5
      ? p.text
      : minimumContrast(alternate, samples) >= 4.5
        ? alternate
        : readable(p.text, samples);
  const text = readable(preferred, samples);
  return {
    shell,
    panel,
    chat: paletteTokens({ ...p, background: backgroundColor, text }, samples),
    background,
    samples,
  };
}
