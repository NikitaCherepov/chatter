import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { showBrowserCursor, hideBrowserCursor } from './browser-cursor';
import { click, generateTrajectory, type CancellationToken, type Point } from './cursor-input';

type PageState = { documentId: string; url: string; width: number; height: number; scrollX: number; scrollY: number; viewportRevision: number; zoom: number };
type Shot = { id: string; at: number; state: PageState };
type Execute = <T>(code: string) => Promise<T>;
const stateScript = `(() => {
  if (!globalThis.__chatterVisual) {
    const state = globalThis.__chatterVisual = { documentId: String(performance.timeOrigin) + ':' + Math.random(), viewportRevision: 0 };
    // Track viewport changes even if it returns to the original position before the next press.
    addEventListener('scroll', () => state.viewportRevision++, true);
    addEventListener('resize', () => state.viewportRevision++);
  }
  return { documentId: globalThis.__chatterVisual.documentId, url: location.href, width: innerWidth, height: innerHeight, scrollX, scrollY, viewportRevision: globalThis.__chatterVisual.viewportRevision, zoom: visualViewport?.scale || 1 };
})()`;

/** Browser-only, one-use coordinates tied to a full PNG viewport snapshot. */
export class BrowserVisualSession {
  private shot: Shot | null = null;
  constructor(private contents: WebContents, private execute: Execute) {}
  clear() { this.shot = null; }
  private async state() { return { ...await this.execute<PageState>(stateScript), zoom: this.contents.getZoomFactor() }; }
  private async check(id: string) {
    const shot = this.shot;
    if (!shot || id !== shot.id || Date.now() - shot.at > 300_000) throw new Error('browser_screenshot_stale');
    const current = await this.state();
    if (JSON.stringify(current) !== JSON.stringify(shot.state)) throw new Error('browser_screenshot_stale');
    return shot;
  }
  async capture() {
    this.clear();
    if (!/^https?:\/\//i.test(this.contents.getURL())) throw new Error('browser_page_unavailable');
    const before = await this.state();
    const image = await this.contents.capturePage();
    if (image.isEmpty()) throw new Error('browser_screenshot_empty');
    const after = await this.state();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('browser_changed_during_screenshot');
    const png = image.toPNG();
    if (png.length > 12 * 1024 * 1024) throw new Error('browser_screenshot_too_large');
    const shot = this.shot = { id: randomUUID(), at: Date.now(), state: after };
    return { snapshot_id: shot.id, url: after.url, mime_type: 'image/png', screenshot_base64: png.toString('base64'),
      width: png.readUInt32BE(16), height: png.readUInt32BE(20), viewport_width: after.width, viewport_height: after.height, coordinate_space: 'normalized_viewport' };
  }
  async coordinates(id: string, x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('browser_coordinates_out_of_range');
    const shot = await this.check(id);
    const px = Math.min(shot.state.width - 1, x * shot.state.width);
    const py = Math.min(shot.state.height - 1, y * shot.state.height);
    return { x: px * shot.state.zoom, y: py * shot.state.zoom };
  }

  async validateBatch(id: string, points: Point[]) {
    if (!Array.isArray(points) || points.length < 1 || points.length > 20) throw new Error('browser_batch_requires_1_to_20_points');
    for (const point of points) {
      if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') throw new Error('browser_coordinates_out_of_range');
      await this.coordinates(id, point.x, point.y);
    }
  }

  private async press(id: string, x: number, y: number, currentMouse: Point, token: CancellationToken, deadline?: number) {
    const point = await this.coordinates(id, x, y);
    const trajectory = generateTrajectory(currentMouse, point);
    try {
      this.contents.focus();
      await showBrowserCursor(this.execute, currentMouse, trajectory, this.contents.getZoomFactor());
      return await click(this.contents, { x: point.x, y: point.y, width: 1, height: 1 }, currentMouse, token, point, trajectory, async () => {
        await this.check(id);
        if (deadline && Date.now() > deadline) throw new Error('browser_batch_timeout');
        return true;
      });
    } finally {
      await hideBrowserCursor(this.execute, point);
    }
  }

  async click(id: string, x: number, y: number, currentMouse: Point, token: CancellationToken) {
    try { return await this.press(id, x, y, currentMouse, token); }
    finally { this.clear(); }
  }

  async clickBatch(id: string, points: Point[], currentMouse: Point, token: CancellationToken) {
    let completed = 0;
    const started = Date.now();
    try {
      // Validate the entire packet before executing any click.
      await this.validateBatch(id, points);
      for (const point of points) {
        if (token.cancelled) throw new Error('click_cancelled');
        if (Date.now() - started > 45_000) throw new Error('browser_batch_timeout');
        currentMouse = await this.press(id, point.x, point.y, currentMouse, token, started + 45_000);
        completed++;
        // Let click handlers and subsequent rendering frames update the page.
        await new Promise(resolve => setTimeout(resolve, 100 + Math.floor(Math.random() * 151)));
        await this.check(id);
      }
      return { status: 'success' as const, completed, total: points.length, cursor: currentMouse };
    } catch (error) {
      return { status: 'stopped' as const, completed, total: Array.isArray(points) ? points.length : 0,
        reason: error instanceof Error ? error.message : String(error), cursor: currentMouse };
    } finally { this.clear(); }
  }
}
