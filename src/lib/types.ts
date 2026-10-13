export type Point = { x: number; y: number };

export type Segment =
  | { type: 'line'; p0: Point; p1: Point }
  | { type: 'cubic'; p0: Point; c1: Point; c2: Point; p1: Point };

export type Contour = Segment[];

export type Slot = { offset: number; length: number };

export type Trace = {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  segmentCount: number;
  frames: Contour[][];
  overlays: ImageBitmap[];
};

export type Settings = {
  width: number;
  fps: number;
  maxFrames: number;
  detail: number;
  contours: number;
  sensitivity: number;
};

export type WorkerRequest = { file: File; settings: Settings };

export type WorkerResponse =
  | { type: 'progress'; label: string; done: number; total: number }
  | { type: 'result'; trace: Trace }
  | { type: 'error'; message: string };
