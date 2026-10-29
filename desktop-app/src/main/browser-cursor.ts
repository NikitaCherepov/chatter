import type { Point } from './cursor-input';

type Execute = <T>(code: string) => Promise<T>;

/** Visual overlay only; native input is still dispatched by cursor-input. */
export async function showBrowserCursor(execute: Execute, currentMouse: Point, trajectory: Point[], zoom = 1) {
  const showCursorScript = `(() => {
    let cursor = document.getElementById('__cb-c');
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = '__cb-c';
      Object.assign(cursor.style, {
        position: 'fixed', width: '14px', height: '14px', borderRadius: '50%',
        background: 'rgba(34, 105, 225, 0.92)', border: '2px solid white',
        boxShadow: '0 2px 9px rgba(0,0,0,.4)', pointerEvents: 'none',
        zIndex: '2147483647', left: '0', top: '0', transform: 'translate(-50%, -50%)',
        opacity: '0', transition: 'opacity 120ms ease'
      });
      document.documentElement.appendChild(cursor);
    }
    cursor.style.left = ${currentMouse.x / zoom} + 'px';
    cursor.style.top = ${currentMouse.y / zoom} + 'px';
    cursor.style.opacity = '1';
    return true;
  })()`;
  await execute(showCursorScript).catch(() => {});

  // Animate the DOM cursor along the same trajectory (best-effort, visual only).
  await execute(`(() => {
    const cursor = document.getElementById('__cb-c');
    if (!cursor) return false;
    const points = ${JSON.stringify(trajectory.map(point => ({ x: point.x / zoom, y: point.y / zoom })))};
    let i = 0;
    const step = () => {
      if (i >= points.length) return;
      cursor.style.left = points[i].x + 'px';
      cursor.style.top = points[i].y + 'px';
      i++;
      if (i < points.length) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  })()`).catch(() => {});
}

export async function hideBrowserCursor(execute: Execute, point?: Point) {
  await execute(`(() => {
    const cursor = document.getElementById('__cb-c');
    if (cursor) cursor.style.opacity = '0';
    ${point ? 'globalThis.__cb_cp = ' + JSON.stringify(point) + ';' : ''}
    return true;
  })()`).catch(() => {});
}
