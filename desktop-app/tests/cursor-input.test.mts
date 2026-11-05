import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { generateTrajectory } = createRequire(import.meta.url)('../src/main/cursor-input.ts');

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

  console.log('cursor-input trajectory tests passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
