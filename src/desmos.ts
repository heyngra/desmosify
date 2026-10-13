import { CURVE_LATEX, frameShape, listLatex } from './lib/latex';
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

  pending = new Promise<DesmosApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT;
    script.onload = () => {
      const api = (window as WindowWithDesmos).Desmos;
      if (api) resolve(api);
      else reject(new Error('Desmos loaded but exported nothing.'));
    };
    script.onerror = () => reject(new Error('Could not reach desmos.com.'));
    document.head.appendChild(script);
  });

  return pending;
}

export type Player = {
  show(frame: number): void;
  destroy(): void;
};

function frameExpressions(trace: Trace, frame: number): Expression[] {
  const shape = frameShape(trace.frames[frame] ?? []);
  return [
    { id: 'X_s', latex: `X_{s}=${listLatex(shape.x.start)}`, secret: true },
    { id: 'X_c1', latex: `X_{c1}=${listLatex(shape.x.c1)}`, secret: true },
    { id: 'X_c2', latex: `X_{c2}=${listLatex(shape.x.c2)}`, secret: true },
    { id: 'X_e', latex: `X_{e}=${listLatex(shape.x.end)}`, secret: true },
    { id: 'Y_s', latex: `Y_{s}=${listLatex(shape.y.start)}`, secret: true },
    { id: 'Y_c1', latex: `Y_{c1}=${listLatex(shape.y.c1)}`, secret: true },
    { id: 'Y_c2', latex: `Y_{c2}=${listLatex(shape.y.c2)}`, secret: true },
    { id: 'Y_e', latex: `Y_{e}=${listLatex(shape.y.end)}`, secret: true },
    { id: 'S', latex: `S=${shape.count}`, secret: true },
  ];
}

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

  calc.setExpressions([
    ...frameExpressions(trace, 0),
    { id: 'curve', latex: CURVE_LATEX, color: '#2464b4', fill: false, lineWidth: 2 },
  ]);

  return {
    show: (frame: number) => calc.setExpressions(frameExpressions(trace, frame)),
    destroy: () => calc.destroy(),
  };
}
