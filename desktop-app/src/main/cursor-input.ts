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

/**
 * Lightweight cancellation token. Set `cancelled = true` externally to abort
 * an in-flight click sequence as early as possible.
 */
export type CancellationToken = { cancelled: boolean };

// ──────────────────────────────────────────────────────────────────────────
// Configuration constants
// ──────────────────────────────────────────────────────────────────────────

/** Maximum padding (px) — gives the random offset more room on large elements. */
const MAX_EDGE_PADDING = 14;

/** Base delay (ms) between mouseMove frames. */
const BASE_FRAME_DELAY = 12;

/** Extra random jitter (ms) added to each frame delay. */
const FRAME_JITTER = 8;

/** Minimum number of trajectory points regardless of distance. */
const MIN_POINTS = 24;

/** Extra trajectory points per pixel of distance. */
const POINTS_PER_PX = 0.06;

/** Maximum number of trajectory points (safety cap). */
const MAX_POINTS = 220;

/** Pixels (from target) within which the cursor slows down (micro-tremor). */
const TREMOR_ZONE = 14;

/** Frame delay multiplier inside the tremor zone. */
const TREMOR_SLOWDOWN = 2.4;

/** Pause before mouseDown after arriving at target (ms). */
const PRE_CLICK_MIN = 50;
const PRE_CLICK_MAX = 150;

/** Duration of mouse button hold before mouseUp (ms). */
const HOLD_MIN = 50;
const HOLD_MAX = 100;

/** Maximum perpendicular deviation of Bezier control points (px). */
const MAX_CURVE_DEVIATION = 80;

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
// 1. Target coordinate calculation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Picks a random point inside `rect` (intersected with `viewport` if given)
 * with a random margin from the edges so the click doesn't always land dead
 * centre.
 *
 * If `viewport` is provided, the rect is clipped to the visible area first,
 * so partially off-screen or oversized elements still produce valid coords.
 * Padding is automatically reduced for very small elements.
 *
 * Coordinates are **local to the WebContentsView** (i.e. CSS pixels relative
 * to the page origin), which is what `sendInputEvent` expects.
 */
export function pickTargetPoint(
  rect: ElementRect,
  viewport?: { width: number; height: number },
): Point {
  // Intersect rect with viewport so we never pick a point off-screen.
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

  // Adaptive padding: capped at half the visible dimension so the point
  // always stays inside the element, even for very small ones.
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
// 2. Cubic Bezier trajectory generation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Cubic Bezier interpolation at parameter `t` (0 → 1).
 */
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
 * Generates an array of points describing a curved path from `start` to `end`
 * using a cubic Bezier with two randomly-offset control points.
 *
 * Point count scales with distance — longer movements get more samples.
 */
export function generateTrajectory(start: Point, end: Point): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);

  if (distance < 1) return [{ ...start }, { ...end }];

  // Number of points scales with distance.
  const count = clamp(
    Math.round(MIN_POINTS + distance * POINTS_PER_PX),
    MIN_POINTS,
    MAX_POINTS,
  );

  // Unit perpendicular vector for lateral offset.
  const perpX = -dy / distance;
  const perpY = dx / distance;

  // Two control points at ~1/3 and ~2/3 along the line, offset sideways.
  const offset1 = randRange(-MAX_CURVE_DEVIATION, MAX_CURVE_DEVIATION);
  const offset2 = randRange(-MAX_CURVE_DEVIATION, MAX_CURVE_DEVIATION);

  const cp1: Point = {
    x: start.x + dx * 0.3 + perpX * offset1,
    y: start.y + dy * 0.3 + perpY * offset1,
  };
  const cp2: Point = {
    x: start.x + dx * 0.66 + perpX * offset2,
    y: start.y + dy * 0.66 + perpY * offset2,
  };

  const points: Point[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    points.push(cubicBezier(start, cp1, cp2, end, t));
  }

  // Snap the final point exactly to target to avoid floating-point drift.
  points[points.length - 1] = { ...end };
  return points;
}

// ──────────────────────────────────────────────────────────────────────────
// 3. Ease-Out timing (Fitts-style deceleration near target)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Returns the frame delay for a given point index considering ease-out and
 * micro-tremor near the target.
 *
 * Near the end of the trajectory (`TREMOR_ZONE` px from target) the delay
 * increases, simulating a user slowing down to "aim".
 */
function frameDelayForPoint(
  points: Point[],
  index: number,
  target: Point,
): number {
  const point = points[index];
  const distToTarget = Math.hypot(point.x - target.x, point.y - target.y);

  const base = BASE_FRAME_DELAY + Math.random() * FRAME_JITTER;

  if (distToTarget <= TREMOR_ZONE) {
    // Slow down progressively as we approach the target.
    const tremorFactor = 1 + (1 - distToTarget / TREMOR_ZONE) * (TREMOR_SLOWDOWN - 1);
    return base * tremorFactor;
  }

  return base;
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Event execution
// ──────────────────────────────────────────────────────────────────────────

/**
 * Sends a low-level mouse event to `webContents`.
 * Coordinates must be **local to the WebContentsView** (CSS pixels).
 */
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

// ──────────────────────────────────────────────────────────────────────────
// 5. Main entry point — `click()`
// ──────────────────────────────────────────────────────────────────────────

/**
 * Simulates a natural pointer interaction inside an isolated `WebContentsView`.
 *
 * 1. Uses the provided `target` or picks a randomized one inside `elementRect`.
 * 2. Uses the provided `trajectory` or generates one from `currentMousePos`.
 * 3. Streams `mouseMove` events with ease-out + micro-tremor near target.
 * 4. Pauses briefly, then fires `mouseDown` → hold → `mouseUp`.
 *
 * After `mouseUp` **no script-level `.click()` is invoked** — the native
 * event sequence is sufficient and avoids race conditions.
 *
 * @param webContents       The target view's webContents.
 * @param elementRect       DOMRect of the element (from `getBoundingClientRect`).
 * @param currentMousePos   Current cursor position (local coords).
 * @param token             Optional cancellation token — set `cancelled = true`
 *                          to abort mid-flight.
 * @param target            Pre-selected target point. If omitted, one is
 *                          picked randomly inside `elementRect`.
 * @param trajectory        Pre-generated trajectory points. If omitted, a new
 *                          one is generated from `currentMousePos` to `target`.
 *                          Pass this when the caller has already generated a
 *                          trajectory for a visual cursor so both stay in sync.
 * @returns The final cursor position (reuse as `currentMousePos` for the
 *          next interaction).
 */
export async function click(
  webContents: WebContents,
  elementRect: ElementRect,
  currentMousePos: Point,
  token?: CancellationToken,
  target?: Point,
  trajectory?: Point[],
): Promise<Point> {
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

  // ── Step 1: target (use provided or pick a new one) ──
  const resolvedTarget = target ?? pickTargetPoint(elementRect);

  // ── Step 2: trajectory (use provided or generate a new one) ──
  const resolvedTrajectory = trajectory ?? generateTrajectory(currentMousePos, resolvedTarget);

  // ── Step 3: stream mouseMove events ──
  for (let i = 1; i < resolvedTrajectory.length; i++) {
    if (token?.cancelled) throw new Error('click_cancelled');
    if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

    const point = resolvedTrajectory[i];
    sendMouseEvent(webContents, 'mouseMove', point.x, point.y);

    await sleep(frameDelayForPoint(resolvedTrajectory, i, resolvedTarget));
  }

  // ── Step 4: final positioning — exactly on target ──
  if (token?.cancelled) throw new Error('click_cancelled');
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

  sendMouseEvent(webContents, 'mouseMove', resolvedTarget.x, resolvedTarget.y);

  // Pre-click dwell (reaction pause).
  await sleep(randInt(PRE_CLICK_MIN, PRE_CLICK_MAX));

  // mouseDown
  if (token?.cancelled) throw new Error('click_cancelled');
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

  sendMouseEvent(webContents, 'mouseDown', resolvedTarget.x, resolvedTarget.y, 'left', 1);

  // Button hold duration.
  await sleep(randInt(HOLD_MIN, HOLD_MAX));

  // mouseUp — this completes the native event sequence; no .click() needed.
  if (webContents.isDestroyed()) throw new Error('webcontents_destroyed');

  sendMouseEvent(webContents, 'mouseUp', resolvedTarget.x, resolvedTarget.y, 'left', 1);

  return resolvedTarget;
}
