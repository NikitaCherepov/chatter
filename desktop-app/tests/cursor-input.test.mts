import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { generateTrajectory, planIdleMotion, driftTo, click } = createRequire(import.meta.url)('../src/main/cursor-input.ts');

try {
  // Click defaults: long moves produce a rich trajectory with exact endpoints.
  const clickTrajectory = generateTrajectory({ x: 0, y: 0 }, { x: 900, y: 0 });
  assert.ok(clickTrajectory.length >= 24 && clickTrajectory.length <= 221, 'click trajectory keeps its default point bounds');
  assert.deepEqual(clickTrajectory[0], { x: 0, y: 0 }, 'trajectory starts exactly at start');
  assert.deepEqual(clickTrajectory[clickTrajectory.length - 1], { x: 900, y: 0 }, 'trajectory ends exactly at end');

  // Degenerate (sub-pixel) moves collapse to the two endpoints.
  const tiny = generateTrajectory({ x: 5, y: 5 }, { x: 5.2, y: 5.1 });
  assert.equal(tiny.length, 2, 'sub-pixel move must collapse to endpoints');

  // Idle glide options: short moves yield a handful of points, not the
  // 24-point click minimum, and stay within their own bounds.
  const glide = generateTrajectory({ x: 100, y: 100 }, { x: 109, y: 103 }, {
    minPoints: 3,
    maxPoints: 18,
    maxCurveDeviation: 6,
  });
  assert.ok(glide.length >= 4 && glide.length <= 19, 'glide trajectory respects idle bounds');
  assert.deepEqual(glide[glide.length - 1], { x: 109, y: 103 }, 'glide ends exactly at target');

  // Long glide capped by maxPoints even when distance suggests more.
  const longGlide = generateTrajectory({ x: 0, y: 0 }, { x: 900, y: 0 }, { minPoints: 3, maxPoints: 18, maxCurveDeviation: 100 });
  assert.ok(longGlide.length <= 19, 'glide trajectory respects the cap');


  const originalRandom = Math.random;
  const withRandom = (values: number[], run: () => any) => {
    let index = 0;
    Math.random = () => values[Math.min(index++, values.length - 1)]!;
    try { return run(); } finally { Math.random = originalRandom; }
  };
  const curved = withRandom([.75], () => generateTrajectory({ x: 0, y: 0 }, { x: 900, y: 0 }));
  const middle = Math.floor(curved.length / 2);
  const segment = (i: number) => Math.hypot(curved[i].x - curved[i - 1].x, curved[i].y - curved[i - 1].y);
  assert.ok(segment(1) < segment(middle) / 5, 'movement accelerates from the start');
  assert.ok(segment(curved.length - 1) < segment(middle) / 5, 'movement decelerates into the target');
  assert.ok(Math.max(...curved.map((point: any) => Math.abs(point.y))) > 10, 'long movement can have a visible gradual arc');
  assert.deepEqual(curved.at(-1), { x: 900, y: 0 }, 'curvature and easing never change the click target');

  const bounds = { width: 800, height: 600 };
  const rest = withRandom([.1, .1, .5], () => planIdleMotion({ x: 100, y: 100 }, bounds));
  assert.equal(rest.kind, 'rest'); assert.equal(rest.target, undefined);
  assert.ok(rest.pauseMs >= 45000 && rest.pauseMs <= 120000, 'long rests produce no motion target');
  const adjustment = withRandom([.7, .5], () => planIdleMotion({ x: 100, y: 100 }, bounds));
  assert.equal(adjustment.kind, 'adjustment');
  assert.ok(Math.hypot(adjustment.target.x - 100, adjustment.target.y - 100) <= 20);
  const reposition = withRandom([.95, .5], () => planIdleMotion({ x: 100, y: 100 }, bounds));
  assert.equal(reposition.kind, 'reposition');
  assert.ok(Math.hypot(reposition.target.x - 100, reposition.target.y - 100) >= 35);
  const edge = withRandom([.95, .9], () => planIdleMotion({ x: 799, y: 599 }, bounds));
  assert.ok(edge.target.x >= 1 && edge.target.x <= 799 && edge.target.y >= 1 && edge.target.y <= 599);

  const events: any[] = [];
  const contents = { isDestroyed: () => false, sendInputEvent: (event: any) => events.push(event) };
  let published = { x: 100, y: 100 };
  const reached = await driftTo(contents, published, { x: 112.5, y: 105.25 }, undefined, (point: any) => { published = point; });
  assert.deepEqual(published, reached, 'every emitted idle position is published');
  assert.deepEqual(events.at(-1), { type: 'mouseMove', x: 112.5, y: 105.25 });
  const beforeAbort = events.length;
  await driftTo(contents, reached, { x: 150, y: 150 }, () => true);
  assert.equal(events.length, beforeAbort, 'cancelled idle emits no additional mouse events');

  // Reproduce the actual browser orchestration race: another interaction
  // updates cursorPos while the drift is sleeping after its first point.
  const { ChatterBrowser } = createRequire(import.meta.url)('../src/main/browser.ts');
  const browser = Object.create(ChatterBrowser.prototype);
  Object.assign(browser, { cursorPos: { x: 100, y: 100 }, interactionInProgress: false, clickToken: null, googleAiInProgress: false });
  let interruptedEvents = 0;
  const interruptedContents = {
    isDestroyed: () => false,
    sendInputEvent: (event: any) => {
      interruptedEvents++;
      queueMicrotask(() => {
        assert.deepEqual(browser.cursorPos, { x: event.x, y: event.y }, 'interrupt sees the emitted position, not the old start');
        browser.interactionInProgress = true;
        browser.cursorPos = { x: 700, y: 500 };
      });
    },
  };
  await browser.performIdleCursorDrift(interruptedContents, { x: 150, y: 120 });
  assert.equal(interruptedEvents, 1, 'explicit interaction stops the idle path');
  assert.deepEqual(browser.cursorPos, { x: 700, y: 500 }, 'returning idle call cannot overwrite the new interaction position');

  events.length = 0;
  await click(contents, { x: 400, y: 200, width: 1, height: 1 }, { x: 100, y: 100 }, undefined, { x: 400.25, y: 200.75 });
  for (const event of events.filter((event: any) => event.type === 'mouseDown' || event.type === 'mouseUp')) {
    assert.equal(event.x, 400.25); assert.equal(event.y, 200.75);
  }
  assert.equal(events.filter((event: any) => event.type === 'mouseDown').length, 1);
  console.log('PASS: eased click paths, exact native input targets, idle rests/movement bounds and interrupted cursor handoff');

} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
