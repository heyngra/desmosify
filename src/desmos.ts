import { CURVE_LATEX, frameExpressions, frameShape, type FrameShape } from './lib/latex';
import type { Trace } from './lib/types';

const API_KEY = 'dcb31709b452b1cf9dc26972add0fda6';
const SCRIPT = `https://www.desmos.com/api/v1.11/calculator.js?apiKey=${API_KEY}`;

type Expression = Record<string, unknown>;

type Calculator = {
  setExpression(expression: Expression): void;
  setExpressions(expressions: Expression[]): void;
  removeExpression(expression: { id: string }): void;
  setMathBounds(bounds: { left: number; right: number; bottom: number; top: number }): void;
  updateSettings(settings: Expression): void;
  destroy(): void;
};

type DesmosApi = { GraphingCalculator(element: HTMLElement): Calculator };
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

export type Player = {
  show(shape: FrameShape): void;
  destroy(): void;
};

const CURVE: Expression = { id: 'curve', latex: CURVE_LATEX, color: '#2464b4', fill: false, lineWidth: 2 };

const secretExpressions = (shape: FrameShape): Expression[] =>
  frameExpressions(shape).map((expression) => ({ ...expression, secret: true }));

export async function createPlayer(element: HTMLElement, trace: Trace): Promise<Player> {
  const Desmos = await loadDesmos();
  const calc = Desmos.GraphingCalculator(element);

  element.style.aspectRatio = `${trace.width} / ${trace.height}`;
  calc.updateSettings({
    showGrid: false,
    showXAxis: false,
    showYAxis: false,
    expressions: false,
  });
  calc.setMathBounds({ left: 0, right: trace.width, bottom: 0, top: trace.height });
  calc.setExpressions([...secretExpressions(frameShape(trace.frames[0] ?? [])), CURVE]);

  return {
    show: (shape: FrameShape) => calc.setExpressions(secretExpressions(shape)),
    destroy: () => calc.destroy(),
  };
}
