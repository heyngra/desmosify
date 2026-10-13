import { init, potrace } from 'esm-potrace-wasm';
import { flipToMathSpace, parsePath, parseTransform } from './svgpath';
import type { Contour } from './types';

const PARAMS = {
  turdsize: 2,
  turnpolicy: 4,
  alphamax: 1,
  opticurve: 1,
  opttolerance: 0.2,
  extractcolors: false,
};

let ready: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!ready) ready = init();
  return ready;
}

let pixels = new Uint8ClampedArray(0);

function maskToImageData(mask: Uint8Array, width: number, height: number): ImageData {
  const size = width * height;
  if (pixels.length !== size * 4) pixels = new Uint8ClampedArray(size * 4);

  for (let i = 0; i < size; i++) {
    const value = mask[i] ? 0 : 255;
    const p = i * 4;
    pixels[p] = value;
    pixels[p + 1] = value;
    pixels[p + 2] = value;
    pixels[p + 3] = 255;
  }
  return new ImageData(pixels, width, height);
}

export async function traceMask(mask: Uint8Array, width: number, height: number): Promise<Contour[]> {
  await ensureReady();
  const svg = await potrace(maskToImageData(mask, width, height), { pathonly: false, ...PARAMS });
  if (typeof svg !== 'string') return [];

  const transform = flipToMathSpace(parseTransform(svg), height);
  const contours: Contour[] = [];
  for (const match of svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)) {
    contours.push(...parsePath(match[1], transform));
  }
  return contours;
}
