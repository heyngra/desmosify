import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canny } from '../src/lib/canny.ts';

function render(width: number, height: number, shade: (x: number, y: number) => number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const value = shade(x, y);
      rgba[i] = value;
      rgba[i + 1] = value;
      rgba[i + 2] = value;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function count(mask: Uint8Array): number {
  let total = 0;
  for (const value of mask) total += value;
  return total;
}

test('canny returns an empty mask for images too small to filter', () => {
  const rgba = render(2, 5, () => 0);
  assert.deepEqual(canny(rgba, 2, 5), new Uint8Array(10));
});

test('canny finds nothing in a flat image', () => {
  const rgba = render(64, 48, () => 120);
  assert.equal(count(canny(rgba, 64, 48)), 0);
});

test('canny keeps the step edge and ignores the flat regions', () => {
  const width = 64;
  const height = 48;
  const rgba = render(width, height, (x) => (x < 32 ? 20 : 235));
  const mask = canny(rgba, width, height, 0.6);

  assert.ok(count(mask) > 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) assert.ok(Math.abs(x - 32) <= 2, `edge pixel at x=${x}`);
    }
  }
});

test('canny is stable when scratch buffers are reused across sizes', () => {
  const first = render(96, 96, (x, y) => (Math.hypot(x - 48, y - 48) < 25 ? 30 : 220));
  const other = render(40, 30, (x) => (x < 20 ? 10 : 240));

  const expected = canny(first, 96, 96, 0.6);
  canny(other, 40, 30, 0.6);
  const again = canny(first, 96, 96, 0.6);

  assert.deepEqual(again, expected);
});

test('canny is deterministic', () => {
  const rgba = render(80, 60, (x, y) => (x * y) % 255);
  assert.deepEqual(canny(rgba, 80, 60, 0.7), canny(rgba, 80, 60, 0.7));
});

test('canny keeps fewer pixels at a higher cutoff', () => {
  const rgba = render(96, 72, (x, y) => 128 + Math.sin(x / 6) * 40 + Math.cos(y / 5) * 40);
  assert.ok(count(canny(rgba, 96, 72, 0.95)) <= count(canny(rgba, 96, 72, 0.3)));
});

test('canny ignores low-amplitude noise beside a real edge', () => {
  const width = 96;
  const height = 72;
  const rgba = render(width, height, (x, y) => (x < 48 ? 60 : 200) + ((x * 7 + y * 13) % 11) - 5);
  const mask = canny(rgba, width, height, 0.6);

  assert.ok(count(mask) > 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) assert.ok(Math.abs(x - 48) <= 2, `noise pixel at x=${x}, y=${y}`);
    }
  }
});
