import runtimeUrl from 'esm-potrace-wasm?url';
import { SMOOTH_TRACE_PIXELS, smoothContours } from './smooth';
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

const RECYCLE_AFTER = 120;

type PotraceModule = {
  init: () => Promise<void>;
  potrace: (image: ImageData, settings: typeof PARAMS & { pathonly: boolean }) => Promise<string>;
};

let generation = 0;
let instance: Promise<PotraceModule> | null = null;
let calls = 0;

function loadInstance(): Promise<PotraceModule> {
  const url = new URL(runtimeUrl, location.origin);
  url.hash = `generation=${generation}`;
  return import(/* @vite-ignore */ url.href).then(async (module: PotraceModule) => {
    await module.init();
    return module;
  });
}

function currentInstance(): Promise<PotraceModule> {
  if (!instance) {
    calls = 0;
    instance = loadInstance();
  }
  return instance;
}

function recycle(): void {
  generation += 1;
  instance = null;
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

async function renderSvg(mask: Uint8Array, width: number, height: number): Promise<string> {
  const image = maskToImageData(mask, width, height);
  const trace = async (): Promise<string> => {
    if (calls >= RECYCLE_AFTER) recycle();
    const module = await currentInstance();
    calls += 1;
    return await module.potrace(image, { pathonly: false, ...PARAMS });
  };

  try {
    return await trace();
  } catch (error) {
    recycle();
    try {
      return await trace();
    } catch {
      throw error;
    }
  }
}

export async function traceMask(
  mask: Uint8Array,
  width: number,
  height: number,
  smoothing = false,
): Promise<Contour[]> {
  const svg = await renderSvg(mask, width, height);
  if (typeof svg !== 'string') return [];

  const transform = flipToMathSpace(parseTransform(svg), height);
  const contours: Contour[] = [];
  for (const match of svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)) {
    contours.push(...parsePath(match[1], transform));
  }
  return smoothing ? smoothContours(contours, SMOOTH_TRACE_PIXELS) : contours;
}
