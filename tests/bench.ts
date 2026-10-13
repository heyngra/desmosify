import { performance } from 'node:perf_hooks';
import { canny } from '../src/lib/canny.ts';
import { clipLatex, frameLatex, frameShape } from '../src/lib/latex.ts';
import { buildFlat } from '../src/lib/sample.ts';
import type { Contour, Trace } from '../src/lib/types.ts';

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function syntheticContour(random: () => number, cx: number, cy: number, radius: number): Contour {
  const segments = 12 + Math.floor(random() * 28);
  const contour: Contour = [];
  let angle = random() * Math.PI * 2;
  let x = cx + Math.cos(angle) * radius;
  let y = cy + Math.sin(angle) * radius;
  for (let i = 0; i < segments; i++) {
    angle += (Math.PI * 2) / segments;
    const nx = cx + Math.cos(angle) * (radius + random() * 8 - 4);
    const ny = cy + Math.sin(angle) * (radius + random() * 8 - 4);
    if (random() < 0.35) {
      contour.push({ type: 'line', p0: { x, y }, p1: { x: nx, y: ny } });
    } else {
      contour.push({
        type: 'cubic',
        p0: { x, y },
        c1: { x: (x + nx) / 2 + random() * 4 - 2, y: (y + ny) / 2 + random() * 4 - 2 },
        c2: { x: nx - random() * 3, y: ny + random() * 3 },
        p1: { x: nx, y: ny },
      });
    }
    x = nx;
    y = ny;
  }
  return contour;
}

function syntheticFrames(frameCount: number, perFrame: number, width: number, height: number): Contour[][] {
  const random = rng(1234);
  return Array.from({ length: frameCount }, (_, f) =>
    Array.from({ length: perFrame }, (_, c) =>
      syntheticContour(
        random,
        width * ((c + 0.5) / perFrame),
        height * (0.2 + 0.6 * Math.abs(Math.sin((f / frameCount) * Math.PI + c))),
        8 + random() * 24,
      ),
    ),
  );
}

function syntheticRgba(width: number, height: number): Uint8ClampedArray {
  const random = rng(99);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const u = (x - width / 2) / 60;
      const v = (y - height / 2) / 40;
      const blob = u * u + v * v < 1 ? 40 : 210;
      const grain = random() * 30;
      rgba[i] = blob + grain;
      rgba[i + 1] = blob + grain;
      rgba[i + 2] = blob + grain;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function median(samples: number[]): number {
  const sorted = samples.slice().sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function measure(label: string, iterations: number, run: () => void): number {
  run();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  const ms = median(samples);
  console.log(`${label.padEnd(36)} ${ms.toFixed(2).padStart(9)} ms`);
  return ms;
}

const FRAMES = 40;
const CONTOURS = 48;
const WIDTH = 640;
const HEIGHT = 360;
const BUDGET = 9000;
const SLOTS = 48;

const frames = syntheticFrames(FRAMES, CONTOURS, 200, 112);
const rgba = syntheticRgba(WIDTH, HEIGHT);
const trace: Trace = {
  width: 200,
  height: 112,
  fps: 8,
  frameCount: FRAMES,
  segmentCount: 0,
  frames,
  overlays: [],
  source: { width: 200, height: 112, fps: 8, frameCount: FRAMES },
};

console.log(`frames=${FRAMES} contours=${CONTOURS} canny=${WIDTH}x${HEIGHT}\n`);

measure('canny', 7, () => {
  canny(rgba, WIDTH, HEIGHT, 0.6);
});

measure('buildFlat', 5, () => {
  buildFlat(frames, BUDGET, SLOTS);
});

const packed = buildFlat(frames, BUDGET, SLOTS);
console.log(`\nstride=${packed.stride} slots=${packed.slots.length} dropped=${packed.dropped}`);

measure('clipLatex', 7, () => {
  clipLatex(trace, packed);
});

measure('frameShape (single frame)', 50, () => {
  frameShape(frames[0]);
});

const clipText = clipLatex(trace, packed);
console.log(`\nclip latex length=${clipText.length} chars`);

console.log('\nper-tick work, export mode = clip');
measure('before: shape + buildFlat + clipLatex', 5, () => {
  frameShape(frames[1]);
  clipLatex(trace, buildFlat(frames, BUDGET, SLOTS));
});
measure('after: shape only (clip cached)', 20, () => {
  frameShape(frames[1]);
});

console.log('\nper-tick work, export mode = frame');
measure('before: 2x shape + frameLatex', 20, () => {
  frameShape(frames[1]);
  frameLatex(frameShape(frames[1]));
});
measure('after: shape + frameLatex', 20, () => {
  frameLatex(frameShape(frames[1]));
});
