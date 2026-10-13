import type { SourceVideo } from './types';

export type RenderPlan = {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  lineWidth: number;
};

export function lineWidthFor(height: number, base = 3): number {
  return Math.max(1, Math.round((base * height) / 1080));
}

export function outputSize(source: SourceVideo, height: number | null): { width: number; height: number } {
  const h = height && height > 0 ? Math.min(Math.round(height), source.height) : source.height;
  return { width: Math.max(2, Math.round((h * source.width) / source.height)), height: h };
}

export function renderPlan(source: SourceVideo, overrides: Partial<RenderPlan> = {}): RenderPlan {
  const height = overrides.height ?? source.height;
  return {
    width: overrides.width ?? source.width,
    height,
    fps: overrides.fps ?? source.fps,
    frameCount: overrides.frameCount ?? source.frameCount,
    lineWidth: overrides.lineWidth ?? lineWidthFor(height),
  };
}
