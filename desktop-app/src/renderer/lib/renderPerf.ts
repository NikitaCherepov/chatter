/**
 * Chat message list render performance.
 * Defines the character budget for lazy rendering.
 * Stored in localStorage, defaults to "medium".
 */

export type RenderPerfLevel = 'low' | 'medium' | 'high' | 'ultra';

const STORAGE_KEY = 'chatter_render_perf';

const DEFAULT: RenderPerfLevel = 'medium';

/** Character budget for each level. */
const PERF_BUDGETS: Record<RenderPerfLevel, number> = {
  low: 15_000,
  medium: 30_000,
  high: 50_000,
  ultra: 80_000,
};

const VALID: RenderPerfLevel[] = ['low', 'medium', 'high', 'ultra'];

export function getRenderPerfLevel(): RenderPerfLevel {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value && VALID.includes(value as RenderPerfLevel)) {
      return value as RenderPerfLevel;
    }
  } catch { /* ignore */ }
  return DEFAULT;
}

export function setRenderPerfLevel(level: RenderPerfLevel): void {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch { /* ignore */ }
}

/** Current character budget for visible render. */
export function getRenderPerfBudget(): number {
  return PERF_BUDGETS[getRenderPerfLevel()];
}

/** Reveal step when clicking "Show more". */
export function getRenderPerfStep(): number {
  return PERF_BUDGETS[getRenderPerfLevel()];
}
