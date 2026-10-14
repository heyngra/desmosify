import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flattenContours } from '../src/lib/flatten.ts';
import { polygonFrame } from '../src/lib/latex.ts';
import type { Contour, FlatFrame, Point } from '../src/lib/types.ts';

function cubic(p0: Point, c1: Point, c2: Point, p1: Point): Contour {
  return [{ type: 'cubic', p0, c1, c2, p1 }];
}

function lineContour(points: number): Contour {
  return Array.from({ length: points - 1 }, (_, index) => ({
    type: 'line' as const,
    p0: { x: index * 0.5, y: index % 2 },
    p1: { x: (index + 1) * 0.5, y: (index + 1) % 2 },
  }));
}

function cubicAt(segment: Extract<Contour[number], { type: 'cubic' }>, t: number): Point {
  const m = 1 - t;
  return {
    x: m * m * m * segment.p0.x + 3 * m * m * t * segment.c1.x + 3 * m * t * t * segment.c2.x + t * t * t * segment.p1.x,
    y: m * m * m * segment.p0.y + 3 * m * m * t * segment.c1.y + 3 * m * t * t * segment.c2.y + t * t * t * segment.p1.y,
  };
}

function distanceToPolyline(point: Point, x: Float64Array, y: Float64Array): number {
  let best = Infinity;
  for (let i = 1; i < x.length; i++) {
    const dx = x[i] - x[i - 1];
    const dy = y[i] - y[i - 1];
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - x[i - 1]) * dx + (point.y - y[i - 1]) * dy) / lengthSq));
    const d = Math.hypot(point.x - (x[i - 1] + t * dx), point.y - (y[i - 1] + t * dy));
    if (d < best) best = d;
  }
  return best;
}

test('flattenContours subdivides a cubic within the tolerance', () => {
  const segment = cubic({ x: 0, y: 0 }, { x: 0, y: 90 }, { x: 90, y: 90 }, { x: 90, y: 0 })[0];
  const frame = flattenContours([cubic({ x: 0, y: 0 }, { x: 0, y: 90 }, { x: 90, y: 90 }, { x: 90, y: 0 })], 0.2);
  const group = frame.groups[0];

  assert.equal(frame.groups.length, 1);
  assert.ok(group.x.length > 2, 'a curve needs more than its two endpoints');
  for (let i = 0; i <= 200; i++) {
    const point = cubicAt(segment, i / 200);
    assert.ok(distanceToPolyline(point, group.x, group.y) <= 0.21, `deviation at t=${i / 200}`);
  }
});

test('flattenContours keeps line segments as single hops and closes the path', () => {
  const contour: Contour = [
    { type: 'line', p0: { x: 0, y: 0 }, p1: { x: 10, y: 0 } },
    { type: 'line', p0: { x: 10, y: 0 }, p1: { x: 10, y: 10 } },
  ];
  const frame = flattenContours([contour], 0.2);
  const x = Array.from(frame.groups[0].x);
  const y = Array.from(frame.groups[0].y);

  assert.deepEqual(x.slice(0, 3), [0, 10, 10]);
  assert.deepEqual(y.slice(0, 3), [0, 0, 10]);
  assert.ok(x.slice(3, x.length - 1).every((value) => Number.isNaN(value)));
  assert.equal(x[x.length - 1], 0);
  assert.equal(y[y.length - 1], 0);
});

test('flattenContours separates contours with NaN gaps', () => {
  const line = (x: number): Contour => [{ type: 'line', p0: { x, y: 0 }, p1: { x: x + 10, y: 0 } }];
  const frame = flattenContours([line(0), line(100)], 0.2);
  const x = Array.from(frame.groups[0].x);

  assert.ok(x.some((value) => Number.isNaN(value)));
  const gap = x.findIndex((value) => Number.isNaN(value));
  assert.deepEqual(x.slice(0, gap), [0, 10]);
  assert.deepEqual(x.slice(gap).filter((value) => !Number.isNaN(value)), [100, 110, 0]);
});

test('flattenContours keeps a contour inside one group', () => {
  const frames = flattenContours(Array.from({ length: 12 }, () => lineContour(1600)), 0.2);

  assert.ok(frames.groups.length > 1, 'the frame should need more than one list chunk');
  for (const group of frames.groups) {
    assert.ok(group.points <= 9000);
    assert.equal(group.x.length, group.points);
    assert.equal(group.y.length, group.points);
  }
});

test('flattenContours decimates a contour past the list limit', () => {
  const points = Array.from({ length: 12_000 }, (_, index) => ({ x: index, y: Math.sin(index / 40) * 30 }));
  const contour: Contour = points.slice(1).map((point, index) => ({ type: 'line', p0: points[index], p1: point }));
  const frame = flattenContours([contour], 0.2);

  assert.equal(frame.groups.length, 1);
  assert.ok(frame.groups[0].points <= 9000);
  assert.equal(frame.groups[0].x.filter((value) => !Number.isNaN(value)).length < 12_000, true);
});

test('flattenContours tracks a changing signature', () => {
  const first = flattenContours([cubic({ x: 0, y: 0 }, { x: 0, y: 90 }, { x: 90, y: 90 }, { x: 90, y: 0 })], 0.2);
  const same = flattenContours([cubic({ x: 0, y: 0 }, { x: 0, y: 90 }, { x: 90, y: 90 }, { x: 90, y: 0 })], 0.2);
  const moved = flattenContours([cubic({ x: 0, y: 0 }, { x: 0, y: 90 }, { x: 90, y: 90 }, { x: 90.5, y: 0 })], 0.2);

  assert.equal(first.signature, same.signature);
  assert.notEqual(first.signature, moved.signature);
});

test('polygonFrame emits a list pair and one polygon per group', () => {
  const frame: FlatFrame = flattenContours(
    [
      cubic({ x: 0, y: 0 }, { x: 0, y: 90 }, { x: 90, y: 90 }, { x: 90, y: 0 }),
      cubic({ x: 200, y: 0 }, { x: 200, y: 90 }, { x: 290, y: 90 }, { x: 290, y: 0 }),
    ],
    0.2,
  );
  const expressions = polygonFrame(frame, { color: '#2464b4', lineWidth: 1 });

  assert.equal(frame.groups.length, 1);
  assert.equal(expressions.length, 3);
  assert.equal(expressions[0].id, 'X_p');
  assert.ok(expressions[0].secret);
  assert.equal(expressions[1].id, 'Y_p');
  assert.equal(expressions[2].id, 'poly');
  assert.match(String(expressions[2].latex), /^\\operatorname\{polygon\}/);
  assert.ok(String(expressions[2].latex).includes('X_{p},Y_{p}'));
  assert.equal(expressions[2].fill, false);
  assert.equal(expressions[2].lineWidth, 1);
});

test('polygonFrame gives each group its own lists', () => {
  const contours: Contour[] = Array.from({ length: 12 }, () => lineContour(1600));
  const frame = flattenContours(contours, 0.2);
  const expressions = polygonFrame(frame, { color: '#2464b4', lineWidth: 1 });

  assert.ok(frame.groups.length > 1);
  assert.equal(expressions.length, frame.groups.length * 3);
  assert.equal(expressions.filter((expression) => String(expression.latex).includes('operatorname{polygon}')).length, frame.groups.length);
});
