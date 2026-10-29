import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { click, type CancellationToken, type Point } from './cursor-input';

type PageState = { documentId: string; url: string; width: number; height: number; scrollX: number; scrollY: number; revision: number; zoom: number };
type Shot = { id: string; at: number; state: PageState };
type Execute = <T>(code: string) => Promise<T>;
const stateScript = `(() => {
  if (!globalThis.__chatterVisual) {
    const state = globalThis.__chatterVisual = { documentId: String(performance.timeOrigin) + ':' + Math.random(), revision: 0, target: null };
    new MutationObserver(() => state.revision++).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    addEventListener('scroll', () => state.revision++, true);
    addEventListener('resize', () => state.revision++);
  }
  return { documentId: globalThis.__chatterVisual.documentId, url: location.href, width: innerWidth, height: innerHeight, scrollX, scrollY, revision: globalThis.__chatterVisual.revision, zoom: visualViewport?.scale || 1 };
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
    if (JSON.stringify(await this.state()) !== JSON.stringify(shot.state)) throw new Error('browser_screenshot_stale');
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
  async target(id: string, x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('browser_coordinates_out_of_range');
    const shot = await this.check(id);
    const px = Math.min(shot.state.width - 1, x * shot.state.width);
    const py = Math.min(shot.state.height - 1, y * shot.state.height);
    const target = await this.execute<{ tag: string; role: string | null; text: string; href: string | null; inputType: string | null; sensitive: boolean } | { error: string }>(`(() => {
      let node = document.elementFromPoint(${px}, ${py});
      while (node?.shadowRoot) { const deeper = node.shadowRoot.elementFromPoint(${px}, ${py}); if (!deeper || deeper === node) break; node = deeper; }
      if (!node) return { error: 'browser_visual_target_not_found' };
      if (node.closest('iframe,frame')) return { error: 'browser_visual_frame_unsupported' };
      const inputType = node.getAttribute('type');
      const sensitive = inputType === 'password' || node.getAttribute('autocomplete') === 'one-time-code';
      if (sensitive) return { error: 'browser_sensitive_field' };
      globalThis.__chatterVisual.target = node;
      return { tag: node.tagName.toLowerCase(), role: node.getAttribute('role'), text: (node.innerText || node.getAttribute('aria-label') || '').slice(0, 200), href: node.closest('a')?.href || null, inputType, sensitive };
    })()`);
    if ('error' in target) throw new Error(target.error);
    return { shot, target, point: { x: px * shot.state.zoom, y: py * shot.state.zoom } };
  }
  async click(id: string, x: number, y: number, currentMouse: Point, token: CancellationToken) {
    const prepared = await this.target(id, x, y);
    const point = prepared.point;
    try {
      this.contents.focus();
      return await click(this.contents, { x: point.x, y: point.y, width: 1, height: 1 }, currentMouse, token, point, undefined, async () => {
        try {
          await this.check(id);
          return await this.execute<boolean>(`(() => {
            const node = globalThis.__chatterVisual?.target;
            let hit = document.elementFromPoint(${point.x / prepared.shot.state.zoom}, ${point.y / prepared.shot.state.zoom});
            while (hit?.shadowRoot) { const deeper = hit.shadowRoot.elementFromPoint(${point.x / prepared.shot.state.zoom}, ${point.y / prepared.shot.state.zoom}); if (!deeper || deeper === hit) break; hit = deeper; }
            return !!node?.isConnected && hit === node;
          })()`);
        } catch { return false; }
      });
    } finally { this.clear(); }
  }
}
