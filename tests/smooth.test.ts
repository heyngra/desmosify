import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flatten } from '../src/lib/sample.ts';
import { SMOOTH_TRACE_PIXELS, smoothContours } from '../src/lib/smooth.ts';
import type { Contour, Point, Segment } from '../src/lib/types.ts';

const TOLERANCE = SMOOTH_TRACE_PIXELS;

const line = (p0: Point, p1: Point): Segment => ({ type: 'line', p0, p1 });

const ring = (points: Point[]): Contour =>
  points.map((point, index) => line(point, points[(index + 1) % points.length]));

const open = (points: Point[]): Contour =>
  points.slice(0, -1).map((point, index) => line(point, points[index + 1]));

function stairPoints(steps: number): Point[] {
  const points: Point[] = [{ x: 0, y: 0 }];
  for (let i = 1; i <= steps; i++) {
    points.push({ x: i, y: i - 1 });
    points.push({ x: i, y: i });
  }
  return points;
}

function staircaseRing(size: number): Point[] {
  const points: Point[] = [];
  for (let x = 0; x <= size; x++) points.push({ x, y: 0 });
  for (let y = 1; y <= size; y++) points.push({ x: size, y });
  for (let i = 1; i <= size; i++) points.push({ x: size - i, y: size - (i % 2) });
  for (let y = size - (size % 2) - 1; y >= 1; y--) points.push({ x: 0, y });
  return points;
}

function segmentAt(segment: Segment, t: number): Point {
  if (segment.type === 'line') {
    return {
      x: segment.p0.x + (segment.p1.x - segment.p0.x) * t,
      y: segment.p0.y + (segment.p1.y - segment.p0.y) * t,
    };
  }
  const m = 1 - t;
  return {
    x:
      m * m * m * segment.p0.x +
      3 * m * m * t * segment.c1.x +
      3 * m * t * t * segment.c2.x +
      t * t * t * segment.p1.x,
    y:
      m * m * m * segment.p0.y +
      3 * m * m * t * segment.c1.y +
      3 * m * t * t * segment.c2.y +
      t * t * t * segment.p1.y,
  };
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function maxDeviation(source: Point[], contour: Contour): number {
  let worst = 0;
  for (const segment of contour) {
    for (let i = 0; i <= 16; i++) {
      const sample = segmentAt(segment, i / 16);
      let nearest = Infinity;
      for (let k = 0; k < source.length - 1; k++) {
        const deviation = distanceToSegment(sample, source[k], source[k + 1]);
        if (deviation < nearest) nearest = deviation;
      }
      if (nearest > worst) worst = nearest;
    }
  }
  return worst;
}

function hasVertex(contour: Contour, point: Point): boolean {
  return contour.some(
    (segment) =>
      (segment.p0.x === point.x && segment.p0.y === point.y) ||
      (segment.p1.x === point.x && segment.p1.y === point.y),
  );
}

test('smoothContours flattens a pixel staircase into one segment', () => {
  const contour = open(stairPoints(20));
  const smoothed = smoothContours([contour], TOLERANCE);

  console.log(`staircase (open): ${contour.length} segments -> ${smoothed[0].length}`);

  assert.ok(smoothed[0].length < contour.length / 8);
  assert.ok(maxDeviation(flatten(contour), smoothed[0]) <= TOLERANCE + 0.01);
});

test('smoothContours keeps a 90 degree corner while simplifying its arms', () => {
  const contour = ring(staircaseRing(20));
  const smoothed = smoothContours([contour], TOLERANCE);

  console.log(`staircase ring: ${contour.length} segments -> ${smoothed[0].length}`);

  assert.ok(smoothed[0].length < contour.length / 8);
  assert.ok(smoothed[0].every((segment) => segment.type === 'line'));
  assert.ok(hasVertex(smoothed[0], { x: 20, y: 20 }));
  assert.ok(maxDeviation(flatten(contour), smoothed[0]) <= TOLERANCE + 0.01);
});

test('smoothContours closes the fitted ring exactly', () => {
  const smoothed = smoothContours([ring(staircaseRing(16))], TOLERANCE);
  const first = smoothed[0][0];
  const last = smoothed[0][smoothed[0].length - 1];

  assert.ok(smoothed[0].length < 16 * 4);
  assert.deepEqual(last.p1, first.p0);
  assert.ok(hasVertex(smoothed[0], { x: 16, y: 16 }));
});

test('smoothContours leaves an empty frame and a degenerate contour untouched', () => {
  assert.deepEqual(smoothContours([], TOLERANCE), []);

  const dot: Contour = [line({ x: 0, y: 0 }, { x: 5, y: 0 })];
  const sliver = ring([
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 1 },
    { x: 0, y: 1 },
  ]);
  const smoothed = smoothContours([dot, sliver], TOLERANCE);

  assert.equal(smoothed.length, 2);
  assert.equal(smoothed[0], dot);
  assert.equal(smoothed[1], sliver);
});

test('smoothContours falls back when the refit cannot beat the input segment count', () => {
  const square = ring([
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 40 },
    { x: 0, y: 40 },
  ]);
  const smoothed = smoothContours([square], TOLERANCE);
  assert.equal(smoothed[0], square);
});

test('smoothContours cuts the segments of the whole frame', () => {
  const frame = [open(stairPoints(30)), ring(staircaseRing(24)), ring(staircaseRing(10))];
  const before = frame.reduce((sum, contour) => sum + contour.length, 0);
  const smoothed = smoothContours(frame, TOLERANCE);
  const after = smoothed.reduce((sum, contour) => sum + contour.length, 0);

  console.log(`frame: ${before} segments -> ${after} (${Math.round((1 - after / before) * 100)}% cut)`);

  assert.ok(after < before / 2);
});
