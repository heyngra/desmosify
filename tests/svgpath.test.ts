import assert from 'node:assert/strict';
import { test } from 'node:test';
import { flipToMathSpace, parsePath, parseTransform } from '../src/lib/svgpath.ts';

test('parseTransform reads the potrace wrapper transform', () => {
  const svg = '<svg><g transform="translate(0.000000,120.000000) scale(0.100000,-0.100000)">';
  assert.deepEqual(parseTransform(svg), { tx: 0, ty: 120, sx: 0.1, sy: -0.1 });
});

test('parseTransform falls back when the transform is missing', () => {
  assert.deepEqual(parseTransform('<svg></svg>'), { tx: 0, ty: 0, sx: 0.1, sy: -0.1 });
});

test('parsePath turns absolute commands into line and cubic segments', () => {
  const contours = parsePath('M 10 20 L 30 20 C 40 20 50 30 60 40 Z', { tx: 0, ty: 0, sx: 1, sy: 1 });

  assert.equal(contours.length, 1);
  assert.deepEqual(contours[0], [
    { type: 'line', p0: { x: 10, y: 20 }, p1: { x: 30, y: 20 } },
    {
      type: 'cubic',
      p0: { x: 30, y: 20 },
      c1: { x: 40, y: 20 },
      c2: { x: 50, y: 30 },
      p1: { x: 60, y: 40 },
    },
    { type: 'line', p0: { x: 60, y: 40 }, p1: { x: 10, y: 20 } },
  ]);
});

test('parsePath resolves relative commands and splits contours', () => {
  const contours = parsePath('m 5 5 l 10 0 l 0 10 z m 20 20 l 1 1', { tx: 0, ty: 0, sx: 1, sy: 1 });

  assert.equal(contours.length, 2);
  assert.deepEqual(contours[0][0], { type: 'line', p0: { x: 5, y: 5 }, p1: { x: 15, y: 5 } });
  assert.deepEqual(contours[0][2], { type: 'line', p0: { x: 15, y: 15 }, p1: { x: 5, y: 5 } });
  assert.deepEqual(contours[1][0], { type: 'line', p0: { x: 25, y: 25 }, p1: { x: 26, y: 26 } });
});

test('parsePath applies the transform to every point', () => {
  const [contour] = parsePath('M 10 10 L 20 10', { tx: 1, ty: 2, sx: 0.5, sy: -0.5 });
  assert.deepEqual(contour[0], { type: 'line', p0: { x: 6, y: -3 }, p1: { x: 11, y: -3 } });
});

test('flipToMathSpace mirrors y about the image height', () => {
  const flipped = flipToMathSpace({ tx: 0, ty: 120, sx: 0.1, sy: -0.1 }, 120);
  assert.deepEqual(flipped, { tx: 0, ty: 0, sx: 0.1, sy: 0.1 });
});
