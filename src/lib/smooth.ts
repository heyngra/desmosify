import { flatten } from './sample.ts';
import type { Contour, Point, Segment } from './types';

export const SMOOTH_TRACE_PIXELS = 1.5;

const CORNER_TURN = Math.PI / 3;
const CURVE_RATIO = 0.1;
const SIZE_DIVISOR = 12;
const MAX_PROMOTIONS = 2;
const CURVE_SAMPLES = 4;

type Ring = { points: Point[]; closed: boolean };

export function smoothContours(contours: Contour[], tolerance = SMOOTH_TRACE_PIXELS): Contour[] {
  return contours.map((contour) => smoothContour(contour, tolerance));
}

function smoothContour(contour: Contour, tolerance: number): Contour {
  if (contour.length === 0) return contour;

  const ring = ringOf(contour);
  if (ring.points.length < 4) return contour;

  const epsilon = Math.min(tolerance, span(ring.points) / SIZE_DIVISOR);
  let kept = simplifiedIndices(ring, epsilon);
  if (kept.length < (ring.closed ? 3 : 2)) return contour;

  const forced = new Set<number>();
  let fitted: Segment[] = [];

  for (let attempt = 0; attempt <= MAX_PROMOTIONS; attempt++) {
    const vertices = kept.map((index) => ring.points[index]);
    const corners = cornerFlags(ring, kept).map((flag, i) => flag || forced.has(kept[i]));
    fitted = refit(vertices, corners, ring.closed);

    if (attempt === MAX_PROMOTIONS) break;

    const promote = promotionIndex(ring, kept, fitted, epsilon);
    if (promote < 0) break;

    forced.add(promote);
    kept = [...kept, promote].sort((a, b) => a - b);
  }

  return fitted.length > 0 && fitted.length < contour.length ? fitted : contour;
}

function span(points: Point[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2);
}

function ringOf(contour: Contour): Ring {
  const points = flatten(contour);
  const first = contour[0].p0;
  const last = contour[contour.length - 1].p1;
  const closed = Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6;
  return { points, closed };
}

function simplifiedIndices(ring: Ring, epsilon: number): number[] {
  const { points, closed } = ring;
  if (!closed) return rdp(points, epsilon);

  const distinct = points.length - 1;
  let split = 1;
  let farthest = -1;
  for (let i = 1; i < distinct; i++) {
    const distanceSquared = squared(points[0], points[i]);
    if (distanceSquared > farthest) {
      farthest = distanceSquared;
      split = i;
    }
  }

  const first = rdp(points.slice(0, split + 1), epsilon);
  const second = rdp(points.slice(split, distinct).concat(points[0]), epsilon);
  const kept = new Set<number>(first);
  for (const index of second) kept.add(index === distinct - split ? 0 : split + index);
  return [...kept].sort((a, b) => a - b);
}

function rdp(points: Point[], epsilon: number): number[] {
  const count = points.length;
  if (count === 0) return [];

  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;

  const epsilonSquared = epsilon * epsilon;
  const stack: [number, number][] = [[0, count - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;

    const a = points[first];
    const b = points[last];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;

    let worst = -1;
    let worstSquared = 0;
    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      const distanceSquared =
        lengthSquared < 1e-12 ? squared(a, p) : perpendicular(p, a, dx, dy, lengthSquared);
      if (distanceSquared > worstSquared) {
        worstSquared = distanceSquared;
        worst = i;
      }
    }

    if (worst > 0 && worstSquared > epsilonSquared) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  const kept: number[] = [];
  for (let i = 0; i < count; i++) if (keep[i]) kept.push(i);
  return kept;
}

function perpendicular(p: Point, a: Point, dx: number, dy: number, lengthSquared: number): number {
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  const qx = a.x + t * dx - p.x;
  const qy = a.y + t * dy - p.y;
  return qx * qx + qy * qy;
}

function squared(a: Point, b: Point): number {
  return (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
}

function cornerFlags(ring: Ring, kept: number[]): boolean[] {
  const { points, closed } = ring;
  const count = kept.length;
  return kept.map((index, i) => {
    if (!closed && (i === 0 || i === count - 1)) return false;
    const previous = kept[(i - 1 + count) % count];
    const next = kept[(i + 1) % count];
    if (turnAngle(points[previous], points[index], points[next]) <= CORNER_TURN) return false;
    return !edgeCurved(points, previous, index) && !edgeCurved(points, index, next);
  });
}

function edgeCurved(points: Point[], from: number, to: number): boolean {
  const a = points[from];
  const b = points[to];
  const chord = Math.sqrt(squared(a, b));
  if (chord < 1e-6) return true;
  let worst = 0;
  const stop = to <= from ? points.length - 1 : to;
  for (let i = from + 1; i < stop; i++) {
    const deviation = distanceToSegment(points[i], a, b);
    if (deviation > worst) worst = deviation;
  }
  return worst > CURVE_RATIO * chord;
}

function turnAngle(previous: Point, vertex: Point, next: Point): number {
  const ax = vertex.x - previous.x;
  const ay = vertex.y - previous.y;
  const bx = next.x - vertex.x;
  const by = next.y - vertex.y;
  const lengthA = Math.sqrt(ax * ax + ay * ay);
  const lengthB = Math.sqrt(bx * bx + by * by);
  if (lengthA === 0 || lengthB === 0) return 0;
  const cosine = (ax * bx + ay * by) / (lengthA * lengthB);
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

function refit(vertices: Point[], corners: boolean[], closed: boolean): Segment[] {
  const count = vertices.length;
  const edges = closed ? count : count - 1;
  const segments: Segment[] = [];

  for (let i = 0; i < edges; i++) {
    const p0 = vertices[i];
    const p1 = vertices[(i + 1) % count];
    const before = closed ? vertices[(i - 1 + count) % count] : i > 0 ? vertices[i - 1] : null;
    const after = closed ? vertices[(i + 2) % count] : i + 2 < count ? vertices[i + 2] : null;
    const limit = Math.sqrt(squared(p0, p1)) / 3;

    const c1 = corners[i] || !before ? chord(p0, p1, limit) : catmull(p0, p1, before, limit);
    const c2 = corners[(i + 1) % count] || !after ? chord(p1, p0, limit) : catmull(p1, p0, after, limit);

    segments.push(
      onChord(p0, p1, c1) && onChord(p0, p1, c2)
        ? { type: 'line', p0, p1 }
        : { type: 'cubic', p0, c1, c2, p1 },
    );
  }

  return segments;
}

function chord(anchor: Point, toward: Point, limit: number): Point {
  const dx = toward.x - anchor.x;
  const dy = toward.y - anchor.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return { x: anchor.x, y: anchor.y };
  const scale = limit / length;
  return { x: anchor.x + dx * scale, y: anchor.y + dy * scale };
}

function catmull(anchor: Point, toward: Point, other: Point, limit: number): Point {
  const dx = (toward.x - other.x) / 6;
  const dy = (toward.y - other.y) / 6;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) return { x: anchor.x, y: anchor.y };
  const scale = Math.min(1, limit / length);
  return { x: anchor.x + dx * scale, y: anchor.y + dy * scale };
}

function onChord(p0: Point, p1: Point, c: Point): boolean {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) return squared(p0, c) < 1e-12;

  const cross = (c.x - p0.x) * dy - (c.y - p0.y) * dx;
  if (cross * cross > 1e-12 * lengthSquared) return false;

  const t = ((c.x - p0.x) * dx + (c.y - p0.y) * dy) / lengthSquared;
  return t >= 0 && t <= 1;
}

function promotionIndex(ring: Ring, kept: number[], fitted: Segment[], tolerance: number): number {
  const { points, closed } = ring;
  const count = kept.length;
  const edges = closed ? count : count - 1;

  for (let i = 0; i < edges; i++) {
    const start = kept[i];
    const end = closed && i === count - 1 ? points.length - 1 : kept[(i + 1) % count];
    if (exceedsTolerance(fitted[i], points, start, end, tolerance)) {
      return farthestFromCurve(fitted, kept, points, closed);
    }
  }

  return -1;
}

function exceedsTolerance(
  segment: Segment,
  points: Point[],
  start: number,
  end: number,
  tolerance: number,
): boolean {
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    if (distanceToRange(points, start, end, segmentAt(segment, i / CURVE_SAMPLES)) > tolerance) {
      return true;
    }
  }
  return false;
}

function farthestFromCurve(fitted: Segment[], kept: number[], points: Point[], closed: boolean): number {
  const count = kept.length;
  const edges = closed ? count : count - 1;
  let worst = 0;
  let index = -1;

  for (let i = 0; i < edges; i++) {
    const start = kept[i];
    const end = closed && i === count - 1 ? points.length - 1 : kept[(i + 1) % count];
    for (let k = start + 1; k < end; k++) {
      const deviation = distanceToCurve(points[k], fitted[i]);
      if (deviation > worst) {
        worst = deviation;
        index = k;
      }
    }
  }

  return index;
}

function distanceToRange(points: Point[], start: number, end: number, p: Point): number {
  if (start === end) return distanceToPoint(p, points[start]);

  let best = Infinity;
  for (let i = start; i < end; i++) {
    const deviation = distanceToSegment(p, points[i], points[i + 1]);
    if (deviation < best) best = deviation;
  }
  return best;
}

function distanceToCurve(p: Point, segment: Segment): number {
  let best = Infinity;
  let previous = segment.p0;
  for (let i = 1; i <= CURVE_SAMPLES; i++) {
    const current = segmentAt(segment, i / CURVE_SAMPLES);
    const deviation = distanceToSegment(p, previous, current);
    if (deviation < best) best = deviation;
    previous = current;
  }
  return best;
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

function distanceToPoint(point: Point, other: Point): number {
  return Math.sqrt(squared(point, other));
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-12) return distanceToPoint(point, a);

  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  const qx = point.x - (a.x + t * dx);
  const qy = point.y - (a.y + t * dy);
  return Math.sqrt(qx * qx + qy * qy);
}
