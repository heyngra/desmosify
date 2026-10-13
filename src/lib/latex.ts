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

export function emptyFrameShape(): FrameShape {
  return { count: 0, x: emptyCoords(), y: emptyCoords() };
}

export const CHUNK_SIZE = 4000;

function sliceCoords(coords: FrameCoords, start: number, end: number): FrameCoords {
  return {
    start: coords.start.slice(start, end),
    c1: coords.c1.slice(start, end),
    c2: coords.c2.slice(start, end),
    end: coords.end.slice(start, end),
  };
}

export function shapeChunks(shape: FrameShape, size = CHUNK_SIZE): FrameShape[] {
  const chunks: FrameShape[] = [];
  for (let start = 0; start < shape.count; start += size) {
    const end = Math.min(shape.count, start + size);
    chunks.push({ count: end - start, x: sliceCoords(shape.x, start, end), y: sliceCoords(shape.y, start, end) });
  }
  return chunks.length > 0 ? chunks : [emptyFrameShape()];
}

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

function axisExpressions(axis: string, coords: FrameCoords, suffix: string): FrameExpression[] {
  return [
    { id: `${axis}_s${suffix}`, latex: `${axis}_{s${suffix}}=${listLatex(coords.start)}` },
    { id: `${axis}_c1${suffix}`, latex: `${axis}_{c1${suffix}}=${listLatex(coords.c1)}` },
    { id: `${axis}_c2${suffix}`, latex: `${axis}_{c2${suffix}}=${listLatex(coords.c2)}` },
    { id: `${axis}_e${suffix}`, latex: `${axis}_{e${suffix}}=${listLatex(coords.end)}` },
  ];
}

const countName = (suffix: string) => (suffix ? `S_{n${suffix}}` : 'S');

export function frameExpressions(shape: FrameShape, suffix = ''): FrameExpression[] {
  return [
    ...axisExpressions('X', shape.x, suffix),
    ...axisExpressions('Y', shape.y, suffix),
    { id: `S${suffix}`, latex: `${countName(suffix)}=${shape.count}` },
  ];
}

const bernstein = (axis: string, suffix: string) =>
  `\\left(1-t\\right)^{3}${axis}_{s${suffix}}\\left[1...${countName(
    suffix,
  )}\\right]+3\\left(1-t\\right)^{2}t${axis}_{c1${suffix}}\\left[1...${countName(
    suffix,
  )}\\right]+3\\left(1-t\\right)t^{2}${axis}_{c2${suffix}}\\left[1...${countName(
    suffix,
  )}\\right]+t^{3}${axis}_{e${suffix}}\\left[1...${countName(suffix)}\\right]`;

export function curveLatex(suffix = ''): string {
  return `\\left(${bernstein('X', suffix)},${bernstein('Y', suffix)}\\right)`;
}

export const CURVE_LATEX = curveLatex();

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
