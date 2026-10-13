export type Point = { x: number; y: number };

export type Segment =
  | { type: 'line'; p0: Point; p1: Point }
  | { type: 'cubic'; p0: Point; c1: Point; c2: Point; p1: Point };

export type Contour = Segment[];

export type Slot = { offset: number; length: number };

export type SourceVideo = {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
};

export type Trace = {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  segmentCount: number;
  frames: Contour[][];
  overlays: ImageBitmap[];
  source: SourceVideo;
};

export type Settings = {
  width: number;
  fps: number;
  maxFrames: number;
  detail: number;
  contours: number;
  sensitivity: number;
};

export type WorkerRequest =
  | { type: 'convert'; file: File; settings: Settings }
  | { type: 'render'; file: File; detail: number; height: number | null; sensitivity: number }
  | { type: 'renderNext' }
  | { type: 'renderClose' };

export type RenderMeta = {
  type: 'renderMeta';
  source: SourceVideo;
  plan: { width: number; height: number };
  trace: { width: number; height: number };
};

export type WorkerResponse =
  | { type: 'progress'; label: string; done: number; total: number }
  | { type: 'result'; trace: Trace }
  | RenderMeta
  | { type: 'renderFrame'; contours: Contour[]; index: number; total: number }
  | { type: 'renderDone' }
  | { type: 'error'; message: string };
