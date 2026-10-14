import type { Contour, FlatFrame, FlatGroup, Point } from './types';

export const FLAT_TOLERANCE = 0.2;

const MAX_POINTS = 90_000;

const MAX_ATTEMPTS = 6;

const CHUNK_POINTS = 9000;

const GAP_POINTS = 4;

const MAX_DEPTH = 12;

type PackedGroup = { x: number[]; y: number[]; points: number };

function distanceSq(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return (point.x - a.x) ** 2 + (point.y - a.y) ** 2;
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq;
  const qx = a.x + t * dx;
  const qy = a.y + t * dy;
  return (point.x - qx) ** 2 + (point.y - qy) ** 2;
}

type Emit = (x: number, y: number) => void;

function emitCubic(
  p0: Point,
  c1: Point,
  c2: Point,
  p1: Point,
  toleranceSq: number,
  depth: number,
  emit: Emit,
): void {
  const m01 = { x: (p0.x + c1.x) / 2, y: (p0.y + c1.y) / 2 };
  const m12 = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 };
  const m23 = { x: (c2.x + p1.x) / 2, y: (c2.y + p1.y) / 2 };
  const m012 = { x: (m01.x + m12.x) / 2, y: (m01.y + m12.y) / 2 };
  const m123 = { x: (m12.x + m23.x) / 2, y: (m12.y + m23.y) / 2 };
  const mid = { x: (m012.x + m123.x) / 2, y: (m012.y + m123.y) / 2 };

  if (depth >= MAX_DEPTH) {
    emit(p1.x, p1.y);
    return;
  }

  if (Math.max(distanceSq(m012, p0, p1), distanceSq(m123, p0, p1)) <= toleranceSq) {
    emit(p1.x, p1.y);
    return;
  }

  emitCubic(p0, m01, m012, mid, toleranceSq, depth + 1, emit);
  emitCubic(mid, m123, m23, p1, toleranceSq, depth + 1, emit);
}

function contourPoints(contour: Contour, tolerance: number): number[] {
  const points: number[] = [];
  if (contour.length === 0) return points;

  points.push(contour[0].p0.x, contour[0].p0.y);
  const toleranceSq = tolerance * tolerance;

  for (const segment of contour) {
    if (segment.type === 'line') {
      points.push(segment.p1.x, segment.p1.y);
    } else {
      emitCubic(segment.p0, segment.c1, segment.c2, segment.p1, toleranceSq, 0, (x, y) => points.push(x, y));
    }
  }

  return points;
}

function decimate(points: number[], limit: number): void {
  let count = points.length / 2;
  if (count <= limit) return;

  const step = Math.ceil(count / limit);
  let write = 0;
  for (let read = 0; read < count; read += step) {
    points[write * 2] = points[read * 2];
    points[write * 2 + 1] = points[read * 2 + 1];
    write++;
  }
  points.length = write * 2;
}

function pack(contours: Contour[], tolerance: number): PackedGroup[] {
  const groups: PackedGroup[] = [];
  const closing = GAP_POINTS + 1;
  let group: PackedGroup | null = null;

  for (const contour of contours) {
    if (contour.length === 0) continue;

    const points = contourPoints(contour, tolerance);
    decimate(points, CHUNK_POINTS - closing);
    const count = points.length / 2;

    if (group && group.points + GAP_POINTS + count + closing > CHUNK_POINTS) group = null;
    if (!group) {
      group = { x: [], y: [], points: 0 };
      groups.push(group);
    } else {
      for (let i = 0; i < GAP_POINTS; i++) {
        group.x.push(Number.NaN);
        group.y.push(Number.NaN);
      }
      group.points += GAP_POINTS;
    }

    for (let i = 0; i < count; i++) {
      group.x.push(points[i * 2]);
      group.y.push(points[i * 2 + 1]);
    }
    group.points += count;
  }

  for (const packed of groups) {
    if (packed.points === 0) continue;
    for (let i = 0; i < GAP_POINTS; i++) {
      packed.x.push(Number.NaN);
      packed.y.push(Number.NaN);
    }
    packed.x.push(packed.x[0]);
    packed.y.push(packed.y[0]);
    packed.points += closing;
  }

  return groups;
}

function totalPoints(groups: PackedGroup[]): number {
  return groups.reduce((sum, group) => sum + group.points, 0);
}

const quantize = (value: number) => Math.round(value * 100) / 100;

function finish(groups: PackedGroup[]): FlatFrame {
  let hash = 2166136261;
  const mix = (value: number) => {
    hash = Math.imul(hash ^ value, 16777619);
  };

  const packedGroups: FlatGroup[] = groups
    .filter((group) => group.points > 0)
    .map((group) => {
      const x = new Float64Array(group.x.length);
      const y = new Float64Array(group.y.length);
      for (let i = 0; i < group.x.length; i++) {
        const rawX = group.x[i];
        const rawY = group.y[i];
        const roundedX = Number.isNaN(rawX) ? Number.NaN : quantize(rawX);
        const roundedY = Number.isNaN(rawY) ? Number.NaN : quantize(rawY);
        x[i] = roundedX;
        y[i] = roundedY;
        mix(Number.isNaN(roundedX) ? 0x7fffffff : (roundedX * 100) | 0);
        mix(Number.isNaN(roundedY) ? 0x7fffffff : (roundedY * 100) | 0);
      }
      return { x, y, points: group.points };
    });

  return { groups: packedGroups, points: totalPoints(groups), signature: hash >>> 0 };
}

export function flattenContours(contours: Contour[], tolerance: number, maxPoints = MAX_POINTS): FlatFrame {
  let groups = pack(contours, tolerance);
  let current = tolerance;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const points = totalPoints(groups);
    if (points <= maxPoints) break;
    current *= Math.sqrt(points / maxPoints) * 1.15;
    groups = pack(contours, current);
  }

  return finish(groups);
}
