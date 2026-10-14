import type { Contour, Point, Slot } from './types';

export const SEGMENT_BUDGET = 20000;

function span(contour: Contour): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const segment of contour) {
    for (const point of [segment.p0, segment.p1]) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }

  return Math.hypot(maxX - minX, maxY - minY);
}

export function capContours(contours: Contour[], budget = SEGMENT_BUDGET): Contour[] {
  let total = 0;
  for (const contour of contours) total += contour.length;
  if (total <= budget) return contours;

  const ranked = contours
    .map((contour) => ({ contour, span: span(contour) }))
    .sort((a, b) => b.span - a.span);

  const kept: Contour[] = [];
  let used = 0;
  for (const entry of ranked) {
    if (used + entry.contour.length > budget) continue;
    kept.push(entry.contour);
    used += entry.contour.length;
  }
  return kept;
}

const SUBDIVISIONS = 16;

function cubicAt(s: Extract<Contour[number], { type: 'cubic' }>, t: number): Point {
  const m = 1 - t;
  return {
    x: m * m * m * s.p0.x + 3 * m * m * t * s.c1.x + 3 * m * t * t * s.c2.x + t * t * t * s.p1.x,
    y: m * m * m * s.p0.y + 3 * m * m * t * s.c1.y + 3 * m * t * t * s.c2.y + t * t * t * s.p1.y,
  };
}

export function flatten(contour: Contour): Point[] {
  const points: Point[] = [];
  for (const segment of contour) {
    if (segment.type === 'line') {
      points.push(segment.p1);
    } else {
      for (let i = 1; i <= SUBDIVISIONS; i++) points.push(cubicAt(segment, i / SUBDIVISIONS));
    }
  }

  const start = contour[0]?.p0;
  const first = points[0];
  const end = points[points.length - 1];
  const closed = !!start && !!end && Math.abs(start.x - end.x) < 1e-6 && Math.abs(start.y - end.y) < 1e-6;
  if (closed && first && (first.x !== end.x || first.y !== end.y)) points.push(first);

  return points;
}

export function polylineLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

export function resample(points: Point[], step: number): Point[] {
  if (points.length < 2) return points.slice();

  const out: Point[] = [points[0]];
  let carried = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) continue;

    let travelled = step - carried;
    while (travelled <= length) {
      const t = travelled / length;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      travelled += step;
    }
    carried = (carried + length) % step;
  }

  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (tail.x !== last.x || tail.y !== last.y) out.push(last);

  return out;
}

export type Packed = {
  stride: number;
  slots: Slot[];
  flatX: number[];
  flatY: number[];
  dropped: number;
};

export const LIST_LIMIT = 9800;

const MIN_SLOT_POINTS = 4;
const BASE_STEP = 0.8;

type FlatContour = { points: Point[]; length: number };

function flattenFrame(frame: Contour[], cap: number): { lines: FlatContour[]; dropped: number } {
  const lines = frame.map((contour) => {
    const points = flatten(contour);
    return { points, length: polylineLength(points) };
  });
  lines.sort((a, b) => b.length - a.length);
  return { lines: lines.slice(0, cap), dropped: Math.max(0, lines.length - cap) };
}

function resampleFrames(
  frames: FlatContour[][],
  slotCount: number,
  step: number,
): Point[][][] {
  return frames.map((frame) =>
    frame.slice(0, slotCount).map((line) => (line.length > 0 ? resample(line.points, step) : line.points)),
  );
}

function measure(resampled: Point[][][], slotCount: number): number[] {
  const lengths = new Array<number>(slotCount).fill(0);
  for (const frame of resampled) {
    frame.forEach((line, index) => {
      lengths[index] = Math.max(lengths[index], line.length);
    });
  }
  return lengths.map((length) => Math.max(MIN_SLOT_POINTS, length));
}

function fitBudget(lengths: number[], perFrame: number): number[] {
  const fitted = lengths.slice();
  let total = fitted.reduce((sum, length) => sum + length, 0);
  while (total > perFrame) {
    let widest = 0;
    for (let i = 1; i < fitted.length; i++) {
      if (fitted[i] > fitted[widest]) widest = i;
    }
    if (fitted[widest] <= MIN_SLOT_POINTS) break;
    fitted[widest] -= 1;
    total -= 1;
  }
  return fitted;
}

function seedStep(lines: FlatContour[][], slotCount: number, perFrame: number): number {
  const longest = new Array<number>(slotCount).fill(0);
  for (const frame of lines) {
    const count = Math.min(frame.length, slotCount);
    for (let i = 0; i < count; i++) {
      if (frame[i].length > longest[i]) longest[i] = frame[i].length;
    }
  }

  const room = perFrame - 2 * slotCount;
  if (room <= 0) return BASE_STEP;

  const span = longest.reduce((sum, length) => sum + length, 0);
  return Math.max(BASE_STEP, span / room);
}

type Sampling = { step: number; resampled: Point[][][]; lengths: number[]; total: number };

function sampleAt(lines: FlatContour[][], slotCount: number, step: number): Sampling {
  const resampled = resampleFrames(lines, slotCount, step);
  const lengths = measure(resampled, slotCount);
  return { step, resampled, lengths, total: lengths.reduce((sum, length) => sum + length, 0) };
}

function fitStep(lines: FlatContour[][], slotCount: number, perFrame: number): Sampling {
  let sample = sampleAt(lines, slotCount, seedStep(lines, slotCount, perFrame));

  for (let attempt = 0; attempt < 3 && sample.total > perFrame; attempt++) {
    sample = sampleAt(lines, slotCount, sample.step * (sample.total / perFrame));
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const finer = Math.max(BASE_STEP, sample.step * (sample.total / perFrame));
    if (finer >= sample.step) break;

    const candidate = sampleAt(lines, slotCount, finer);
    if (candidate.total > perFrame) break;
    sample = candidate;
  }

  return sample;
}

export function buildFlat(frames: Contour[][], budget: number, maxSlots: number): Packed {
  const frameCount = Math.max(1, frames.length);
  const perFrame = Math.max(1, Math.floor(budget / frameCount));
  const cap = Math.max(1, Math.floor(maxSlots));

  const flattened = frames.map((frame) => flattenFrame(frame, cap));
  const slotCount = Math.min(
    Math.max(0, ...flattened.map((frame) => frame.lines.length)),
    Math.max(1, Math.floor(perFrame / MIN_SLOT_POINTS)),
  );

  if (slotCount === 0) {
    return {
      stride: 0,
      slots: [],
      flatX: [],
      flatY: [],
      dropped: flattened.reduce((sum, frame) => sum + frame.dropped, 0),
    };
  }

  const lines = flattened.map((frame) => frame.lines);
  const sampled = fitStep(lines, slotCount, perFrame);
  const resampled = sampled.resampled;
  const lengths = fitBudget(sampled.lengths, perFrame);

  const slots: Slot[] = [];
  let offset = 0;
  for (const length of lengths) {
    slots.push({ offset, length });
    offset += length;
  }
  const stride = offset;

  const flatX = new Array<number>(frameCount * stride).fill(Number.NaN);
  const flatY = new Array<number>(frameCount * stride).fill(Number.NaN);

  resampled.forEach((frame, f) => {
    frame.forEach((line, index) => {
      const slot = slots[index];
      const base = f * stride + slot.offset;
      const count = Math.min(line.length, slot.length);
      for (let i = 0; i < count; i++) {
        flatX[base + i] = Math.round(line[i].x * 100) / 100;
        flatY[base + i] = Math.round(line[i].y * 100) / 100;
      }
    });
  });

  const dropped = flattened.reduce(
    (sum, frame) => sum + frame.dropped + Math.max(0, frame.lines.length - slotCount),
    0,
  );

  return { stride, slots, flatX, flatY, dropped };
}
