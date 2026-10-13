import type { Packed } from './sample';
import type { Contour, Slot, Trace } from './types';

const value = (v: number) => (Number.isNaN(v) ? '0/0' : String(v));
const round = (v: number) => Math.round(v * 100) / 100;

export function listLatex(values: number[]): string {
  return `\\left[${values.map(value).join(',')}\\right]`;
}

export type FrameCoords = { start: number[]; c1: number[]; c2: number[]; end: number[] };
export type FrameShape = { count: number; x: FrameCoords; y: FrameCoords };
export type FrameExpression = { id: string; latex: string };

const emptyCoords = (): FrameCoords => ({ start: [], c1: [], c2: [], end: [] });

function pushLine(coords: FrameCoords, p0: number, p1: number): void {
  coords.start.push(round(p0));
  coords.c1.push(round(p0 + (p1 - p0) / 3));
  coords.c2.push(round(p0 + (2 * (p1 - p0)) / 3));
  coords.end.push(round(p1));
}

export function frameShape(contours: Contour[]): FrameShape {
  const x = emptyCoords();
  const y = emptyCoords();
  for (const contour of contours) {
    for (const segment of contour) {
      if (segment.type === 'cubic') {
        x.start.push(round(segment.p0.x));
        x.c1.push(round(segment.c1.x));
        x.c2.push(round(segment.c2.x));
        x.end.push(round(segment.p1.x));
        y.start.push(round(segment.p0.y));
        y.c1.push(round(segment.c1.y));
        y.c2.push(round(segment.c2.y));
        y.end.push(round(segment.p1.y));
      } else {
        pushLine(x, segment.p0.x, segment.p1.x);
        pushLine(y, segment.p0.y, segment.p1.y);
      }
    }
  }
  return { count: x.start.length, x, y };
}

function axisExpressions(axis: string, coords: FrameCoords): FrameExpression[] {
  return [
    { id: `${axis}_s`, latex: `${axis}_{s}=${listLatex(coords.start)}` },
    { id: `${axis}_c1`, latex: `${axis}_{c1}=${listLatex(coords.c1)}` },
    { id: `${axis}_c2`, latex: `${axis}_{c2}=${listLatex(coords.c2)}` },
    { id: `${axis}_e`, latex: `${axis}_{e}=${listLatex(coords.end)}` },
  ];
}

export function frameExpressions(shape: FrameShape): FrameExpression[] {
  return [
    ...axisExpressions('X', shape.x),
    ...axisExpressions('Y', shape.y),
    { id: 'S', latex: `S=${shape.count}` },
  ];
}

const bernstein = (axis: string) =>
  `\\left(1-t\\right)^{3}${axis}_{s}\\left[1...S\\right]+3\\left(1-t\\right)^{2}t${axis}_{c1}\\left[1...S\\right]+3\\left(1-t\\right)t^{2}${axis}_{c2}\\left[1...S\\right]+t^{3}${axis}_{e}\\left[1...S\\right]`;

export const CURVE_LATEX = `\\left(${bernstein('X')},${bernstein('Y')}\\right)`;

export function frameLatex(shape: FrameShape): string[] {
  return [...frameExpressions(shape).map((expression) => expression.latex), CURVE_LATEX];
}

function slotRangeLatex(stride: number, slot: Slot): string {
  const base = `\\left(f-1\\right)\\cdot ${stride}`;
  return `${base}+${slot.offset + 1}...${base}+${slot.offset + slot.length}`;
}

function clipShapeLatex(stride: number, slot: Slot): string {
  const from = slotRangeLatex(stride, { offset: slot.offset, length: slot.length - 1 });
  const to = slotRangeLatex(stride, { offset: slot.offset + 1, length: slot.length - 1 });
  return (
    `\\left(\\left(1-t\\right)X\\left[${from}\\right]+tX\\left[${to}\\right],` +
    `\\left(1-t\\right)Y\\left[${from}\\right]+tY\\left[${to}\\right]\\right)`
  );
}

export function clipLatex(trace: Trace, packed: Packed): string {
  return [
    `X=${listLatex(packed.flatX)}`,
    `Y=${listLatex(packed.flatY)}`,
    `f=1`,
    `K=${trace.frameCount}`,
    ...packed.slots.map((slot) => clipShapeLatex(packed.stride, slot)),
  ].join('\n');
}
