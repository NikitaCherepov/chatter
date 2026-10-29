import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { showBrowserCursor, hideBrowserCursor } from './browser-cursor';
import { click, generateTrajectory, type CancellationToken, type Point } from './cursor-input';

type PageState = { documentId: string; url: string; width: number; height: number; scrollX: number; scrollY: number; zoom: number };
type Shot = { id: string; at: number; state: PageState };
type Execute = <T>(code: string) => Promise<T>;
const stateScript = `(() => {
  if (!globalThis.__chatterVisual) {
    globalThis.__chatterVisual = { documentId: String(performance.timeOrigin) + ':' + Math.random() };
  }
  return { documentId: globalThis.__chatterVisual.documentId, url: location.href, width: innerWidth, height: innerHeight, scrollX, scrollY, zoom: visualViewport?.scale || 1 };
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

  async click(id: string, x: number, y: number, currentMouse: Point, token: CancellationToken) {
    const point = await this.coordinates(id, x, y);
    const trajectory = generateTrajectory(currentMouse, point);
    try {
      this.contents.focus();
      await showBrowserCursor(this.execute, currentMouse, trajectory, this.contents.getZoomFactor());
      return await click(this.contents, { x: point.x, y: point.y, width: 1, height: 1 }, currentMouse, token, point, trajectory, async () => {
        await this.check(id);
        return true;
      });
    } finally {
      this.clear();
      await hideBrowserCursor(this.execute, point);
    }
  }
}
