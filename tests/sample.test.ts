import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFlat, flatten, polylineLength, resample } from '../src/lib/sample.ts';
import type { Contour, Point, Segment } from '../src/lib/types.ts';

const line = (x0: number, y0: number, x1: number, y1: number): Segment => ({
  type: 'line',
  p0: { x: x0, y: y0 },
  p1: { x: x1, y: y1 },
});

const square = (size: number): Contour => [
  line(0, 0, size, 0),
  line(size, 0, size, size),
  line(size, size, 0, size),
  line(0, size, 0, 0),
];

test('flatten emits line endpoints and closes rings', () => {
  const points = flatten(square(10));
  assert.deepEqual(points, [
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ]);
  assert.equal(polylineLength(points), 40);
});

test('flatten subdivides cubics and keeps open contours open', () => {
  const contour: Contour = [
    { type: 'cubic', p0: { x: 0, y: 0 }, c1: { x: 0, y: 10 }, c2: { x: 10, y: 10 }, p1: { x: 10, y: 0 } },
  ];
  const points = flatten(contour);
  assert.equal(points.length, 16);
  assert.deepEqual(points[points.length - 1], { x: 10, y: 0 });
});

test('resample spaces points by the step and keeps the endpoints', () => {
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
  ];
  assert.deepEqual(resample(points, 3), [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 6, y: 0 },
    { x: 9, y: 0 },
    { x: 10, y: 0 },
  ]);
});

test('resample carries the leftover distance across segments', () => {
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 8, y: 0 },
  ];
  assert.deepEqual(resample(points, 3), [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 6, y: 0 },
    { x: 8, y: 0 },
  ]);
});

test('resample leaves degenerate inputs alone', () => {
  assert.deepEqual(resample([], 1), []);
  assert.deepEqual(resample([{ x: 1, y: 2 }], 1), [{ x: 1, y: 2 }]);
});

test('buildFlat pads frames that have fewer contours with NaN', () => {
  const packed = buildFlat([[square(10)], []], 9000, 48);

  assert.equal(packed.slots.length, 1);
  assert.equal(packed.stride, packed.slots[0].length);
  assert.equal(packed.flatX.length, 2 * packed.stride);
  assert.equal(packed.flatY.length, 2 * packed.stride);

  for (let i = 0; i < packed.stride; i++) {
    assert.ok(Number.isFinite(packed.flatX[i]));
    assert.ok(Number.isNaN(packed.flatX[packed.stride + i]));
    assert.ok(Number.isNaN(packed.flatY[packed.stride + i]));
  }
});

test('buildFlat keeps the per-frame budget and contiguous slot offsets', () => {
  const frames = Array.from({ length: 4 }, () => [square(100), square(60), square(30)]);
  const budget = 400;
  const packed = buildFlat(frames, budget, 6);

  assert.ok(packed.stride <= Math.floor(budget / frames.length));

  let offset = 0;
  for (const slot of packed.slots) {
    assert.equal(slot.offset, offset);
    assert.ok(slot.length >= 4);
    offset += slot.length;
  }
  assert.equal(offset, packed.stride);
});

test('buildFlat emits whole contours, not truncated ones', () => {
  const contour = square(40);
  const expected = flatten(contour).at(-1)!;
  const packed = buildFlat([[contour]], 9000, 48);
  const slot = packed.slots[0];

  assert.equal(packed.flatX[slot.length - 1], Math.round(expected.x * 100) / 100);
  assert.equal(packed.flatY[slot.length - 1], Math.round(expected.y * 100) / 100);
});

test('buildFlat reports contours dropped past the slot limit', () => {
  const frame = Array.from({ length: 10 }, () => square(20));
  const packed = buildFlat([frame], 9000, 3);

  assert.equal(packed.slots.length, 3);
  assert.equal(packed.dropped, 7);
});

test('buildFlat handles frames without contours', () => {
  assert.deepEqual(buildFlat([], 9000, 48), { stride: 0, slots: [], flatX: [], flatY: [], dropped: 0 });
  assert.deepEqual(buildFlat([[]], 9000, 48), { stride: 0, slots: [], flatX: [], flatY: [], dropped: 0 });
});
