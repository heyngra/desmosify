import type { Contour, Point, Segment } from './types';

export type Transform = { tx: number; ty: number; sx: number; sy: number };

export function parseTransform(svg: string): Transform {
  const match = svg.match(
    /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)\s*scale\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/,
  );
  if (!match) return { tx: 0, ty: 0, sx: 0.1, sy: -0.1 };
  return {
    tx: Number(match[1]),
    ty: Number(match[2]),
    sx: Number(match[3]),
    sy: Number(match[4]),
  };
}

export function parsePath(d: string, t: Transform): Contour[] {
  const tokens = d.match(/[MmLlCcZz]|-?\d*\.?\d+/g) ?? [];
  const contours: Contour[] = [];
  const toImage = (x: number, y: number): Point => ({ x: t.tx + t.sx * x, y: t.ty + t.sy * y });

  let contour: Segment[] = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let index = 0;
  let previous = '';

  const flush = () => {
    if (contour.length > 0) contours.push(contour);
    contour = [];
  };

  while (index < tokens.length) {
    const token = tokens[index];
    const isCommand = /[A-Za-z]/.test(token);

    if (isCommand && (token === 'z' || token === 'Z')) {
      index++;
      if (cx !== startX || cy !== startY) {
        contour.push({ type: 'line', p0: toImage(cx, cy), p1: toImage(startX, startY) });
        cx = startX;
        cy = startY;
      }
      continue;
    }

    let command: string;
    if (isCommand) {
      command = token;
      index++;
    } else {
      command = previous;
      if (!command) {
        index++;
        continue;
      }
    }

    const read = () => Number(tokens[index++]);

    switch (command) {
      case 'M': {
        flush();
        cx = read();
        cy = read();
        startX = cx;
        startY = cy;
        previous = 'L';
        break;
      }
      case 'm': {
        flush();
        cx += read();
        cy += read();
        startX = cx;
        startY = cy;
        previous = 'l';
        break;
      }
      case 'L':
      case 'l': {
        const relative = command === 'l';
        const x = read();
        const y = read();
        const nx = relative ? cx + x : x;
        const ny = relative ? cy + y : y;
        contour.push({ type: 'line', p0: toImage(cx, cy), p1: toImage(nx, ny) });
        cx = nx;
        cy = ny;
        previous = command;
        break;
      }
      case 'C':
      case 'c': {
        const relative = command === 'c';
        const x1 = read();
        const y1 = read();
        const x2 = read();
        const y2 = read();
        const x3 = read();
        const y3 = read();
        const ax = relative ? cx + x1 : x1;
        const ay = relative ? cy + y1 : y1;
        const bx = relative ? cx + x2 : x2;
        const by = relative ? cy + y2 : y2;
        const ex = relative ? cx + x3 : x3;
        const ey = relative ? cy + y3 : y3;
        contour.push({
          type: 'cubic',
          p0: toImage(cx, cy),
          c1: toImage(ax, ay),
          c2: toImage(bx, by),
          p1: toImage(ex, ey),
        });
        cx = ex;
        cy = ey;
        previous = command;
        break;
      }
      default:
        index++;
        break;
    }
  }

  flush();
  return contours;
}

export function parseTracePath(d: string, height: number): Contour[] {
  return parsePath(d, { tx: 0, ty: height, sx: 0.1, sy: -0.1 });
}

export function flipToMathSpace(t: Transform, height: number): Transform {
  return { tx: t.tx, ty: height - t.ty, sx: t.sx, sy: -t.sy };
}
