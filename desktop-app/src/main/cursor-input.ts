import type { WebContents } from 'electron';

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type ElementRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Point = { x: number; y: number };

export type CancellationToken = { cancelled: boolean };

export type MouseEventDispatcher = (
  type: 'mouseMove' | 'mouseDown' | 'mouseUp',
  x: number,
  y: number,
  button?: 'left' | 'right',
  clickCount?: number,
) => void | Promise<void>;

// ──────────────────────────────────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────────────────────────────────

const MAX_EDGE_PADDING = 14;
const BASE_FRAME_DELAY = 12;
const FRAME_JITTER = 8;
const MIN_POINTS = 24;
const POINTS_PER_PX = 0.06;
const MAX_POINTS = 220;
const PRE_CLICK_MIN = 50;
const PRE_CLICK_MAX = 150;
const HOLD_MIN = 50;
const HOLD_MAX = 100;
const MAX_CURVE_DEVIATION = 160;

// Scroll
const SCROLL_PIXELS_PER_TICK = 110;
const SCROLL_TICK_DELAY = 14;
const SCROLL_TICK_JITTER = 10;
const SCROLL_BURST_MIN = 3;
const SCROLL_BURST_MAX = 8;
const SCROLL_BURST_PAUSE_MIN = 40;
const SCROLL_BURST_PAUSE_MAX = 120;
const SCROLL_OVERSHOOT_PROBABILITY = 0.22;
const SCROLL_OVERSHOOT_MIN = 30;
const SCROLL_OVERSHOOT_MAX = 80;

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const randRange = (min: number, max: number): number =>
  min + Math.random() * (max - min);

const randInt = (min: number, max: number): number =>
  Math.floor(randRange(min, max + 1));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

// ──────────────────────────────────────────────────────────────────────────
// 1. Target point
// ──────────────────────────────────────────────────────────────────────────

/**
 * Returns a random point inside `rect`, clipped to `viewport` if provided.
 * Padding adapts to small elements and is capped at half the visible size.
 */
export function pickTargetPoint(
  rect: ElementRect,
  viewport?: { width: number; height: number },
): Point {
  const clipX1 = viewport ? Math.max(0, viewport.width - 1) : Infinity;
  const clipY1 = viewport ? Math.max(0, viewport.height - 1) : Infinity;

  const visibleX = Math.max(rect.x, 0);
  const visibleY = Math.max(rect.y, 0);
  const visibleRight = Math.min(rect.x + rect.width, clipX1);
  const visibleBottom = Math.min(rect.y + rect.height, clipY1);
  const visibleW = Math.max(0, visibleRight - visibleX);
  const visibleH = Math.max(0, visibleBottom - visibleY);

  if (visibleW < 1 || visibleH < 1) {
    throw new Error('element_not_visible');
  }

  const padding = Math.min(
    MAX_EDGE_PADDING,
    Math.min(visibleW, visibleH) / 2,
  );

  const minX = visibleX + padding;
  const maxX = visibleX + visibleW - padding;
  const minY = visibleY + padding;
  const maxY = visibleY + visibleH - padding;

  return {
    x: randRange(minX, Math.max(minX, maxX)),
    y: randRange(minY, Math.max(minY, maxY)),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Trajectory
// ──────────────────────────────────────────────────────────────────────────

function cubicBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): Point {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const ttt = tt * t;
  const uuu = uu * u;

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/**
 * Generates a list of points along a cubic Bezier curve from `start` to `end`.
 * Two control points add lateral curvature. Point count scales with distance.
 * `options` scales the generator down for idle glides (fewer points, gentle
 * curvature) without touching the click defaults.
 */
export type TrajectoryOptions = {
  /** Lower point-count bound (clicks use 24; idle glides use 12). */
  minPoints?: number;
  /** Upper point-count bound (clicks use 220; idle glides use 60). */
  maxPoints?: number;
  /** Maximum lateral control-point deviation; idle glides use a smaller bound. */
  maxCurveDeviation?: number;
};

export function generateTrajectory(start: Point, end: Point, options: TrajectoryOptions = {}): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);

  if (distance < 1) return [{ ...start }, { ...end }];

  const minPoints = options.minPoints ?? MIN_POINTS;
  const maxPoints = options.maxPoints ?? MAX_POINTS;
  const maxCurveDeviation = options.maxCurveDeviation ?? Math.min(MAX_CURVE_DEVIATION, distance * 0.22);

  const count = clamp(
    Math.round(minPoints + distance * POINTS_PER_PX),
    minPoints,
    maxPoints,
  );

  const perpX = -dy / distance;
  const perpY = dx / distance;

  const bend = randRange(-maxCurveDeviation, maxCurveDeviation);
  const offset1 = bend;
  const offset2 = Math.random() < 0.2
    ? -bend * randRange(0.3, 0.8)
    : bend * randRange(0.55, 1) + randRange(-maxCurveDeviation * 0.12, maxCurveDeviation * 0.12);
  const correction = distance > 160 && Math.random() < 0.3 ? randRange(-4, 4) : 0;

  const fraction1 = randRange(0.22, 0.36);
  const fraction2 = randRange(0.62, 0.78);
  const cp1: Point = {
    x: start.x + dx * fraction1 + perpX * offset1,
    y: start.y + dy * fraction1 + perpY * offset1,
  };
  const cp2: Point = {
    x: start.x + dx * fraction2 + perpX * offset2,
    y: start.y + dy * fraction2 + perpY * offset2,
  };

  const points: Point[] = [];
  for (let i = 0; i <= count; i++) {
    const time = i / count;
    // Minimum-jerk progress: smooth acceleration and deceleration, while
    // preserving the exact start/end. This is a motion heuristic, not a
    // statistically validated model of a particular user's mouse.
    const t = time * time * time * (10 + time * (-15 + 6 * time));
    const point = cubicBezier(start, cp1, cp2, end, t);
    const approach = time > 0.75 ? Math.sin(Math.PI * (time - 0.75) / 0.25) * correction : 0;
    point.x += perpX * approach;
    point.y += perpY * approach;
    points.push(point);
  }

  points[points.length - 1] = { ...end };
  return points;
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Timing
// ──────────────────────────────────────────────────────────────────────────

function frameDelayForPoint(): number {
  // Speed variation comes from eased point spacing, rather than adding
  // another long tail of delays near the target.
  return BASE_FRAME_DELAY + Math.random() * FRAME_JITTER;
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Mouse events
// ──────────────────────────────────────────────────────────────────────────

function sendMouseEvent(
  webContents: WebContents,
  type: 'mouseMove' | 'mouseDown' | 'mouseUp',
  x: number,
  y: number,
  button: 'left' | 'right' = 'left',
  clickCount = 1,
): void {
  webContents.sendInputEvent({
    type,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    ...(type === 'mouseDown' || type === 'mouseUp'
      ? { button, clickCount }
      : {}),
  } as Electron.MouseInputEvent);
}

function sendWheelEvent(
  webContents: WebContents,
  x: number,
  y: number,
  deltaY: number,
): void {
  // Chromium's injected wheel delta is inverted relative to the public API
  // (negative = scroll down). Flip the sign at the boundary.
  const nativeDeltaY = -deltaY;
  webContents.sendInputEvent({
    type: 'mouseWheel',
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    deltaY: nativeDeltaY,
    wheelTicksY: nativeDeltaY > 0 ? 1 : -1,
    canScroll: true,
  } as Electron.MouseWheelInputEvent);
}

// ──────────────────────────────────────────────────────────────────────────
// 5. Scroll
// ──────────────────────────────────────────────────────────────────────────

/**
 * Scrolls the view by `totalDeltaY` pixels via `mouseWheel` events.
 * Events are grouped into bursts with pauses between them.
 */
export async function scrollWheel(
  webContents: WebContents,
  totalDeltaY: number,
  cursorPos: Point,
  token?: CancellationToken,
): Promise<number> {
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');
  if (Math.abs(totalDeltaY) < 1) return 0;

  const direction = totalDeltaY > 0 ? 1 : -1;
  let sent = 0;

  let overshoot = 0;
  if (Math.random() < SCROLL_OVERSHOOT_PROBABILITY && Math.abs(totalDeltaY) > SCROLL_OVERSHOOT_MAX * 2) {
    overshoot = direction * randInt(SCROLL_OVERSHOOT_MIN, SCROLL_OVERSHOOT_MAX);
  }

  const totalTarget = Math.abs(totalDeltaY) + Math.abs(overshoot);

  while (sent < totalTarget) {
    const burstRemaining = totalTarget - sent;
    const burstTicks = Math.min(
      randInt(SCROLL_BURST_MIN, SCROLL_BURST_MAX),
      Math.ceil(burstRemaining / SCROLL_PIXELS_PER_TICK),
    );

    for (let t = 0; t < burstTicks && sent < totalTarget; t++) {
      if (token?.cancelled) throw new Error('scroll_cancelled');
      if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

      const tickVariance = 0.85 + Math.random() * 0.3;
      const tickDelta = direction * Math.min(
        SCROLL_PIXELS_PER_TICK * tickVariance,
        totalTarget - sent,
      );

      sendWheelEvent(webContents, cursorPos.x, cursorPos.y, Math.round(tickDelta));
      sent += Math.abs(tickDelta);

      await sleep(SCROLL_TICK_DELAY + Math.random() * SCROLL_TICK_JITTER);
    }

    if (sent < totalTarget) {
      await sleep(randInt(SCROLL_BURST_PAUSE_MIN, SCROLL_BURST_PAUSE_MAX));
    }
  }

  if (overshoot !== 0) {
    const correction = -overshoot;
    const correctionTicks = Math.ceil(Math.abs(correction) / SCROLL_PIXELS_PER_TICK);

    await sleep(randInt(120, 280));

    for (let t = 0; t < correctionTicks; t++) {
      if (token?.cancelled) throw new Error('scroll_cancelled');
      if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

      const tickDelta = -direction * Math.min(
        SCROLL_PIXELS_PER_TICK * (0.7 + Math.random() * 0.3),
        Math.abs(correction) - t * SCROLL_PIXELS_PER_TICK,
      );

      sendWheelEvent(webContents, cursorPos.x, cursorPos.y, Math.round(tickDelta));

      await sleep(SCROLL_TICK_DELAY + Math.random() * SCROLL_TICK_JITTER);
    }
  }

  return totalDeltaY;
}

// ──────────────────────────────────────────────────────────────────────────
// 7. Keyboard
// ──────────────────────────────────────────────────────────────────────────

const TYPE_FOCUS_SETTLE_MIN = 60;
const TYPE_FOCUS_SETTLE_MAX = 180;
const SELECT_ALL_TO_TYPE_MIN = 24;
const SELECT_ALL_TO_TYPE_MAX = 70;
const KEY_TO_TEXT_MIN = 16;
const KEY_TO_TEXT_MAX = 48;
const PER_CHAR_MIN = 85;
const PER_CHAR_MAX = 180;
const PAUSE_AFTER_SPACE_MIN = 40;
const PAUSE_AFTER_SPACE_MAX = 140;
const PAUSE_AFTER_PUNCT_MIN = 80;
const PAUSE_AFTER_PUNCT_MAX = 260;
const THINK_PAUSE_PROBABILITY = 0.015;
const THINK_PAUSE_MIN = 350;
const THINK_PAUSE_MAX = 1100;
const TYPO_PROBABILITY = 0.025;
const MAX_TYPOS_PER_INPUT = 3;
const TYPO_MIN_SPACING = 8;

export type HumanTypeOptions = {
  /** Select-all before typing to replace the current value. */
  clearFirst?: boolean;
  /** Rare adjacent-letter mistakes, immediately corrected before continuing. */
  typos?: boolean;
  humanTyping?: boolean;
  onProgress?: () => void;
};

const PUNCTUATION = /[.,!?;:—–…)\]}>"']/;

function humanCharDelay(previousChar: string): number {
  if (/\s/.test(previousChar)) return randRange(PAUSE_AFTER_SPACE_MIN, PAUSE_AFTER_SPACE_MAX);
  if (PUNCTUATION.test(previousChar)) return randRange(PAUSE_AFTER_PUNCT_MIN, PAUSE_AFTER_PUNCT_MAX);
  if (Math.random() < THINK_PAUSE_PROBABILITY) return randRange(THINK_PAUSE_MIN, THINK_PAUSE_MAX);
  return randRange(PER_CHAR_MIN, PER_CHAR_MAX);
}

const isPlainAsciiPrintable = (char: string): boolean => {
  const code = char.charCodeAt(0);
  return code >= 0x21 && code <= 0x7e;
};

const LETTER_NEIGHBORS = new Map<string, string[]>();
for (const rows of [['qwertyuiop', 'asdfghjkl', 'zxcvbnm'], ['йцукенгшщзхъ', 'фывапролджэ', 'ячсмитьбю']]) {
  const keys = rows.flatMap((row, y) => Array.from(row, (letter, x) => ({ letter, x: x + [0, 0.25, 0.75][y]!, y })));
  for (const key of keys) LETTER_NEIGHBORS.set(key.letter, keys
    .filter(other => other !== key && Math.hypot(other.x - key.x, other.y - key.y) <= 1.25)
    .map(other => other.letter));
}

function nearbyLetter(letter: string): string | undefined {
  const lower = letter.toLowerCase();
  const neighbors = LETTER_NEIGHBORS.get(lower);
  if (!neighbors?.length) return undefined;
  const neighbor = neighbors[Math.floor(Math.random() * neighbors.length)]!;
  return letter === lower ? neighbor : neighbor.toUpperCase();
}

function assertKeyboardActive(webContents: WebContents, token?: CancellationToken): void {
  if (token?.cancelled) throw new Error('fill_cancelled');
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');
}

async function keyboardDelay(webContents: WebContents, delay: number, token?: CancellationToken): Promise<void> {
  assertKeyboardActive(webContents, token);
  await sleep(delay);
  assertKeyboardActive(webContents, token);
}

/** Always release a pressed key, including when cancellation happens during its hold. */
async function holdKeyboardKey(
  webContents: WebContents, keyCode: string, holdMs: number, token?: CancellationToken,
  modifiers?: Array<'control' | 'meta'>, beforeRelease?: () => void | Promise<void>,
): Promise<void> {
  assertKeyboardActive(webContents, token);
  webContents.sendInputEvent({ type: 'keyDown', keyCode, ...(modifiers ? { modifiers } : {}) });
  try {
    await keyboardDelay(webContents, holdMs, token);
    await beforeRelease?.();
  } finally {
    if (!webContents.isDestroyed()) webContents.sendInputEvent({ type: 'keyUp', keyCode, ...(modifiers ? { modifiers } : {}) });
  }
}

/**
 * Types `text` the way a person does: focus → optional select-all →
 * per-character input with a natural cadence. The characters themselves are
 * inserted via `insertText`, which produces trusted `beforeinput`/`input`
 * events (`isTrusted: true`) that React-controlled fields and anti-bot
 * scripts accept — unlike synthetic `new Event('input')` dispatches.
 * Single plain-ASCII characters also get a keyDown/keyUp pair so key-aware
 * editors observe a full keyboard flow. Every insertion contains one Unicode
 * code point, including spaces and corrections. With humanTyping=false, the
 * whole value is inserted at once.
 */
export async function typeHumanText(
  webContents: WebContents,
  text: string,
  options: HumanTypeOptions = {},
  token?: CancellationToken,
): Promise<void> {
  assertKeyboardActive(webContents, token);
  const value = String(text ?? '');
  if (!value && !options.clearFirst) return;
  // Keep surrogate pairs intact while inserting one code point at a time.
  const characters = Array.from(value);

  try { webContents.focus(); } catch { /* the view may be hidden */ }
  await keyboardDelay(webContents, randRange(TYPE_FOCUS_SETTLE_MIN, TYPE_FOCUS_SETTLE_MAX), token);

  if (options.clearFirst) {
    await holdKeyboardKey(webContents, 'A', randRange(SELECT_ALL_TO_TYPE_MIN, SELECT_ALL_TO_TYPE_MAX), token,
      [process.platform === 'darwin' ? 'meta' : 'control']);
    await keyboardDelay(webContents, randRange(30, 90), token);
    if (!value) {
      await holdKeyboardKey(webContents, 'Backspace', randRange(45, 110), token);
      return;
    }
  }

  if (options.humanTyping === false) {
    assertKeyboardActive(webContents, token);
    await webContents.insertText(value);
    options.onProgress?.();
    return;
  }
  let tempo = 1;
  const delays = characters.map((_, i) => {
    const previous = i > 0 ? characters[i - 1]! : ' ';
    if (i === 0 || /\s/.test(previous)) tempo = randRange(0.75, 1.3);
    return humanCharDelay(previous) * tempo;
  });

  const insert = async (part: string) => {
    if (!part) return;
    assertKeyboardActive(webContents, token);
    if (part.length === 1 && isPlainAsciiPrintable(part)) {
      await holdKeyboardKey(webContents, part, randRange(KEY_TO_TEXT_MIN, KEY_TO_TEXT_MAX), token,
        undefined, () => webContents.insertText(part));
    } else {
      await webContents.insertText(part);
    }
  };
  let typoCount = 0;
  let lastTypo = -TYPO_MIN_SPACING;
  for (let position = 0; position < characters.length; position++) {
    const letter = characters[position]!;
    await keyboardDelay(webContents, delays[position]!, token);
    const makeTypo = options.typos !== false && typoCount < MAX_TYPOS_PER_INPUT
      && position >= 2 && position - lastTypo >= TYPO_MIN_SPACING
      && LETTER_NEIGHBORS.has(letter.toLowerCase())
      && !/[\u0300-\u036f\u200d]/.test(characters[position - 1] || '')
      && Math.random() > 1 - TYPO_PROBABILITY;
    const wrong = makeTypo ? nearbyLetter(letter) : undefined;
    if (wrong !== undefined) {
      await insert(wrong);
      await keyboardDelay(webContents, randRange(180, 520), token);
      await holdKeyboardKey(webContents, 'Backspace', randRange(45, 110), token);
      await keyboardDelay(webContents, randRange(70, 180), token);
      lastTypo = position;
      typoCount++;
    }
    await insert(letter);
    options.onProgress?.();
  }
  await keyboardDelay(webContents, randRange(24, 80), token);
}

/** Presses a single key with human timing, respecting cancellation before keyDown. */
export async function pressHumanKey(webContents: WebContents, key: 'Enter' | 'Space', token?: CancellationToken): Promise<void> {
  assertKeyboardActive(webContents, token);
  try { webContents.focus(); } catch { /* the view may be hidden */ }
  await keyboardDelay(webContents, randRange(40, 130), token);
  await holdKeyboardKey(webContents, key, randRange(45, 110), token);
  await keyboardDelay(webContents, randRange(24, 70), token);
}

// ──────────────────────────────────────────────────────────────────────────
// 5b. Idle drift glide
// ──────────────────────────────────────────────────────────────────────────

export type IdleMotionPlan = { kind: 'rest' | 'adjustment' | 'reposition'; pauseMs: number; target?: Point };

/** Independent idle episodes; no permanent anchor or obligatory periodic move. */
export function planIdleMotion(current: Point, bounds: { width: number; height: number }): IdleMotionPlan {
  const kind = Math.random();
  if (kind < 0.5) return { kind: 'rest', pauseMs: Math.random() < 0.2 ? randRange(45000, 120000) : randRange(10000, 40000) };
  const reposition = kind > 0.88;
  const distance = reposition ? randRange(35, Math.max(35, Math.min(180, Math.min(bounds.width, bounds.height) * 0.25))) : randRange(3, 20);
  const angle = randRange(-Math.PI, Math.PI);
  return {
    kind: reposition ? 'reposition' : 'adjustment',
    pauseMs: reposition ? randRange(5000, 18000) : randRange(2000, 8000),
    target: {
      x: clamp(current.x + Math.cos(angle) * distance, 1, Math.max(1, bounds.width - 1)),
      y: clamp(current.y + Math.sin(angle) * distance, 1, Math.max(1, bounds.height - 1)),
    },
  };
}

const DRIFT_POINT_DELAY_MIN = 12;
const DRIFT_POINT_DELAY_MAX = 26;
const DRIFT_MAX_POINTS = 60;

/**
 * Glides the pointer smoothly to a nearby point along a short curved path.
 * Idle pointer presence must not be a stream of single-event jumps — those
 * read as teleports in mousemove recordings. A person either rests the hand
 * (no events at all) or glides it, so every drift step streams a small
 * bezier trajectory of native mouseMove events with human inter-event
 * timing and eased point spacing for acceleration and deceleration.
 * Returns the point actually reached (an aborted glide stops mid-way).
 */
export async function driftTo(
  webContents: WebContents,
  currentMouse: Point,
  target: Point,
  shouldAbort?: () => boolean,
  onMove?: (point: Point) => void,
): Promise<Point> {
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');
  const dx = target.x - currentMouse.x;
  const dy = target.y - currentMouse.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.5) return { ...currentMouse };

  // The same trajectory generator the clicks use, scaled to idle
  // proportions: a handful of points and lateral curvature proportional
  // to the glide distance instead of the click-sized 80px arcs.
  const trajectory = generateTrajectory(currentMouse, target, {
    minPoints: 12,
    maxPoints: DRIFT_MAX_POINTS,
    maxCurveDeviation: Math.min(18, distance * 0.22),
  });

  let last = { ...currentMouse };
  for (let i = 1; i < trajectory.length; i += 1) {
    // An explicit interaction wins over the drift instantly.
    if (shouldAbort?.()) break;
    if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');
    const point = trajectory[i]!;
    last = { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
    sendMouseEvent(webContents, 'mouseMove', last.x, last.y);
    // Publish synchronously, before yielding: an interrupting click starts
    // from the last emitted position and cannot be overwritten on return.
    onMove?.({ ...last });
    await sleep(randRange(DRIFT_POINT_DELAY_MIN, DRIFT_POINT_DELAY_MAX));
  }
  return last;
}

// ──────────────────────────────────────────────────────────────────────────
// 6. Click
// ──────────────────────────────────────────────────────────────────────────

/**
 * Moves the cursor along a trajectory to a target point, then sends
 * `mouseDown` and `mouseUp` events via `sendInputEvent`.
 *
 * `target` and `trajectory` can be provided externally to keep them in sync
 * with a visual cursor overlay.
 */
export async function click(
  webContents: WebContents,
  elementRect: ElementRect,
  currentMousePos: Point,
  token?: CancellationToken,
  target?: Point,
  trajectory?: Point[],
  validateTarget?: () => boolean | Promise<boolean>,
  eventDispatcher?: MouseEventDispatcher,
): Promise<Point> {
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

  const resolvedTarget = target ?? pickTargetPoint(elementRect);
  const resolvedTrajectory = trajectory ?? generateTrajectory(currentMousePos, resolvedTarget);
  const dispatch: MouseEventDispatcher = eventDispatcher
    || ((type, x, y, button, clickCount) => sendMouseEvent(webContents, type, x, y, button, clickCount));

  for (let i = 1; i < resolvedTrajectory.length; i++) {
    if (token?.cancelled) throw new Error('click_cancelled');
    if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

    const point = resolvedTrajectory[i];
    await dispatch('mouseMove', point.x, point.y);

    await sleep(frameDelayForPoint());
  }

  if (token?.cancelled) throw new Error('click_cancelled');
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

  await dispatch('mouseMove', resolvedTarget.x, resolvedTarget.y);

  await sleep(randInt(PRE_CLICK_MIN, PRE_CLICK_MAX));

  if (token?.cancelled) throw new Error('click_cancelled');
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');
  if (validateTarget && !(await validateTarget())) throw new Error('click_target_moved');

  if (token?.cancelled) throw new Error('click_cancelled');
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

  await dispatch('mouseDown', resolvedTarget.x, resolvedTarget.y, 'left', 1);

  await sleep(randInt(HOLD_MIN, HOLD_MAX));

  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

  await dispatch('mouseUp', resolvedTarget.x, resolvedTarget.y, 'left', 1);

  return resolvedTarget;
}
