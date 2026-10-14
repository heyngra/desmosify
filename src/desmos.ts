import {
  curveLatex,
  emptyFrameShape,
  frameExpressions,
  polygonFrame,
  shapeChunks,
  type FrameShape,
} from './lib/latex';
import type { FlatFrame, Trace } from './lib/types';

const API_KEY = 'dcb31709b452b1cf9dc26972add0fda6';
const SCRIPT = `https://www.desmos.com/api/v1.11/calculator.js?apiKey=${API_KEY}`;

type Expression = Record<string, unknown>;

type ScreenshotOptions = {
  width: number;
  height: number;
  targetPixelRatio: number;
  transparentBackground: boolean;
  preserveAxisNumbers: boolean;
};

type Calculator = {
  setExpression(expression: Expression): void;
  setExpressions(expressions: Expression[]): void;
  removeExpression(expression: { id: string }): void;
  setMathBounds(bounds: { left: number; right: number; bottom: number; top: number }): void;
  updateSettings(settings: Expression): void;
  screenshot(options: ScreenshotOptions): string;
  destroy(): void;
};

type ScreenGrapher = {
  screenshotToCanvas(canvas: HTMLCanvasElement, options: ScreenshotOptions): void;
};

type Controller = {
  getEvaluator(): { notifyWhenSynced(callback: () => void): void };
};

type Tick = (time: number, pause: boolean) => void;

type DesmosApi = { GraphingCalculator(element: HTMLElement, options?: Expression): Calculator };
type WindowWithDesmos = Window & { Desmos?: DesmosApi };

let pending: Promise<DesmosApi> | null = null;

function loadDesmos(): Promise<DesmosApi> {
  const existing = (window as WindowWithDesmos).Desmos;
  if (existing) return Promise.resolve(existing);
  if (pending) return pending;

  const load = new Promise<DesmosApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.onload = () => {
      const api = (window as WindowWithDesmos).Desmos;
      if (api) resolve(api);
      else reject(new Error('Desmos loaded but exported nothing.'));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Could not reach desmos.com.'));
    };
    document.head.appendChild(script);
  });

  pending = load.catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

const PREVIEW_LINE_WIDTH = 2;

const shapeFor = (shape: FrameShape, index: number, lineWidth: number): Expression[] => {
  const suffix = String(index);
  return [
    ...frameExpressions(shape, suffix).map((expression) => ({ ...expression, secret: true })),
    { id: `curve${suffix}`, latex: curveLatex(suffix), color: '#2464b4', fill: false, lineWidth },
  ];
};

const idsFor = (index: number): string[] => {
  const suffix = String(index);
  return [
    ...frameExpressions(emptyFrameShape(), suffix).map((expression) => expression.id),
    `curve${suffix}`,
  ];
};

function createPolygonLayer(calc: Calculator, lineWidth: number): (frame: FlatFrame) => number {
  let previous = new Map<string, string>();

  return (frame) => {
    const expressions = polygonFrame(frame, { color: '#2464b4', lineWidth });
    const changed = expressions.filter((expression) => previous.get(expression.id) !== expression.latex);
    if (changed.length > 0) calc.setExpressions(changed);

    const next = new Set(expressions.map((expression) => expression.id));
    for (const id of previous.keys()) {
      if (!next.has(id)) calc.removeExpression({ id });
    }

    previous = new Map(expressions.map((expression) => [expression.id, expression.latex]));
    return changed.length;
  };
}

function createLayer(calc: Calculator, lineWidth: number): (shape: FrameShape) => void {
  let mounted = 0;

  return (shape) => {
    const chunks = shapeChunks(shape);
    calc.setExpressions(chunks.flatMap((chunk, index) => shapeFor(chunk, index, lineWidth)));

    for (let index = chunks.length; index < mounted; index++) {
      for (const id of idsFor(index)) calc.removeExpression({ id });
    }
    mounted = chunks.length;
  };
}

const NO_CHROME: Expression = {
  expressions: false,
  settingsMenu: false,
  zoomButtons: false,
  expressionsTopbar: false,
  keypad: false,
  border: false,
  pointsOfInterest: false,
  trace: false,
  lockViewport: true,
};

async function mountCalculator(
  element: HTMLElement,
  width: number,
  height: number,
  grid: boolean,
): Promise<Calculator> {
  const Desmos = await loadDesmos();
  const calc = Desmos.GraphingCalculator(element, NO_CHROME);

  calc.updateSettings({ showGrid: grid, showXAxis: grid, showYAxis: grid });
  calc.setMathBounds({ left: 0, right: width, bottom: 0, top: height });
  return calc;
}

export type Player = {
  show(shape: FrameShape): void;
  destroy(): void;
};

export async function createPlayer(element: HTMLElement, trace: Trace): Promise<Player> {
  element.style.aspectRatio = `${trace.width} / ${trace.height}`;
  const calc = await mountCalculator(element, trace.width, trace.height, false);
  const show = createLayer(calc, PREVIEW_LINE_WIDTH);

  return {
    show: (shape: FrameShape) => show(shape),
    destroy: () => calc.destroy(),
  };
}

export type CaptureTiming = { sync: number; draw: number };

export type Renderer = {
  show(frame: FlatFrame): number;
  capture(canvas: HTMLCanvasElement, width: number, height: number): Promise<CaptureTiming>;
  destroy(): void;
};

const SHOT = { targetPixelRatio: 1, transparentBackground: false, preserveAxisNumbers: true };

const HARD_TIMEOUT = 180_000;
const STALL_AFTER = 200;
const PUMP_INTERVAL = 0;

function whenSynced(controller: Controller | undefined, tick: Tick | undefined): Promise<void> {
  if (!controller) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let timer: number | null = null;
    let guard = window.setTimeout(() => {
      guard = 0;
      reject(new Error('Desmos stopped responding while rendering this frame.'));
    }, HARD_TIMEOUT);

    const stop = () => {
      if (timer !== null) window.clearTimeout(timer);
      if (guard !== 0) window.clearTimeout(guard);
      timer = null;
      guard = 0;
    };

    controller.getEvaluator().notifyWhenSynced(() => {
      stop();
      resolve();
    });

    if (!tick) return;

    const step = () => {
      tick(performance.now(), false);
      timer = window.setTimeout(step, PUMP_INTERVAL);
    };

    timer = window.setTimeout(step, document.hidden ? 0 : STALL_AFTER);
  });
}

function drawDirect(
  grapher: ScreenGrapher,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  canvas.width = width;
  canvas.height = height;
  grapher.screenshotToCanvas(canvas, { ...SHOT, width, height });
}

function drawViaDataUrl(
  calc: Calculator,
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): Promise<void> {
  const url = calc.screenshot({ ...SHOT, width, height });

  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Could not acquire a 2D context.'));
        return;
      }
      context.clearRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      resolve();
    };
    image.onerror = () => reject(new Error('Desmos returned an unreadable screenshot.'));
    image.src = url;
  });
}

export async function createRenderer(
  element: HTMLElement,
  width: number,
  height: number,
  lineWidth: number,
): Promise<Renderer> {
  const calc = await mountCalculator(element, width, height, true);
  const internals = calc as Calculator & {
    _calc?: { grapher?: ScreenGrapher; controller?: Controller; tick?: Tick };
  };
  const grapher = internals._calc?.grapher;
  const controller = internals._calc?.controller;
  const tick = internals._calc?.tick?.bind(internals._calc);
  const show = createPolygonLayer(calc, lineWidth);

  return {
    show: (frame: FlatFrame) => show(frame),
    capture: async (canvas, width, height) => {
      const syncStart = performance.now();
      await whenSynced(controller, tick);
      const drawStart = performance.now();
      if (grapher) drawDirect(grapher, canvas, width, height);
      else await drawViaDataUrl(calc, canvas, width, height);
      return { sync: drawStart - syncStart, draw: performance.now() - drawStart };
    },
    destroy: () => calc.destroy(),
  };
}
