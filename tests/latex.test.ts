import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURVE_LATEX, clipLatex, frameExpressions, frameLatex, frameShape, listLatex } from '../src/lib/latex.ts';
import { buildFlat } from '../src/lib/sample.ts';
import type { Contour, Trace } from '../src/lib/types.ts';

const contour: Contour = [
  { type: 'line', p0: { x: 0, y: 0 }, p1: { x: 30, y: 0 } },
  { type: 'cubic', p0: { x: 30, y: 0 }, c1: { x: 40, y: 10 }, c2: { x: 50, y: 20 }, p1: { x: 60, y: 30 } },
];

test('listLatex renders NaN as an undefined Desmos value', () => {
  assert.equal(listLatex([1, Number.NaN, -2.5]), '\\left[1,0/0,-2.5\\right]');
  assert.equal(listLatex([]), '\\left[\\right]');
});

test('frameShape turns lines into cubics with third-point controls', () => {
  const shape = frameShape([contour]);

  assert.equal(shape.count, 2);
  assert.deepEqual(shape.x, { start: [0, 30], c1: [10, 40], c2: [20, 50], end: [30, 60] });
  assert.deepEqual(shape.y, { start: [0, 0], c1: [0, 10], c2: [0, 20], end: [0, 30] });
});

test('frameShape rounds coordinates to two decimals', () => {
  const shape = frameShape([[{ type: 'line', p0: { x: 0, y: 0 }, p1: { x: 1.006, y: -2.344 } }]]);
  assert.deepEqual(shape.x.end, [1.01]);
  assert.deepEqual(shape.y.end, [-2.34]);
});

test('frameExpressions lists the shared preview ids in order', () => {
  const expressions = frameExpressions(frameShape([contour]));

  assert.deepEqual(
    expressions.map((expression) => expression.id),
    ['X_s', 'X_c1', 'X_c2', 'X_e', 'Y_s', 'Y_c1', 'Y_c2', 'Y_e', 'S'],
  );
  assert.equal(expressions[0].latex, 'X_{s}=\\left[0,30\\right]');
  assert.equal(expressions[8].latex, 'S=2');
});

test('frameLatex is the expression list plus the curve', () => {
  const shape = frameShape([contour]);
  const lines = frameLatex(shape);

  assert.deepEqual(
    lines,
    frameExpressions(shape).map((expression) => expression.latex).concat(CURVE_LATEX),
  );
  assert.equal(lines[0], 'X_{s}=\\left[0,30\\right]');
  assert.equal(lines[lines.length - 1], CURVE_LATEX);
});

test('clipLatex emits the flat lists, the frame slider and one expression per slot', () => {
  const frames: Contour[][] = [[contour]];
  const packed = buildFlat(frames, 9000, 48);
  const trace: Trace = {
    width: 60,
    height: 30,
    fps: 8,
    frameCount: 1,
    segmentCount: 2,
    frames,
    overlays: [],
  };

  const lines = clipLatex(trace, packed).split('\n');

  assert.equal(lines[0], `X=${listLatex(packed.flatX)}`);
  assert.equal(lines[1], `Y=${listLatex(packed.flatY)}`);
  assert.equal(lines[2], 'f=1');
  assert.equal(lines[3], 'K=1');
  assert.equal(lines.length, 4 + packed.slots.length);

  const stride = packed.stride;
  const slot = packed.slots[0];
  assert.ok(lines[4].includes(`+${slot.offset + 1}...`));
  assert.ok(lines[4].includes(`+${slot.offset + slot.length}`));
  assert.ok(lines[4].includes(`\\left(f-1\\right)\\cdot ${stride}`));
});
