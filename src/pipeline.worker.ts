import { BlobSource, CanvasSink, Input, MATROSKA, MP4, QTFF, WEBM } from 'mediabunny';
import { canny } from './lib/canny';
import { describeError } from './lib/error';
import { FLAT_TOLERANCE, flattenContours } from './lib/flatten';
import { outputSize } from './lib/render';
import { capContours } from './lib/sample';
import { traceMask } from './lib/trace';
import type { Contour, Settings, SourceVideo, Trace, WorkerRequest, WorkerResponse } from './lib/types';

const FORMATS = [MP4, QTFF, MATROSKA, WEBM];
const OVERLAY_BYTES = 48 * 1024 * 1024;

const port = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const send = (message: WorkerResponse, transfer?: Transferable[]) => port.postMessage(message, transfer);

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function get2d(canvas: HTMLCanvasElement | OffscreenCanvas): Context2D {
  const target = canvas as { getContext(id: '2d'): Context2D | null };
  const context = target.getContext('2d');
  if (!context) throw new Error('Could not acquire a 2D context.');
  return context;
}

function overlaySize(width: number, height: number, frames: number): { w: number; h: number } {
  const bytes = frames * width * height * 4;
  if (bytes <= OVERLAY_BYTES) return { w: width, h: height };
  const scale = Math.sqrt(OVERLAY_BYTES / bytes);
  return { w: Math.max(64, Math.floor(width * scale)), h: Math.max(36, Math.floor(height * scale)) };
}

function fit(width: number, displayWidth: number, displayHeight: number): { width: number; height: number } {
  const w = Math.max(48, Math.round(width));
  return { width: w, height: Math.max(48, Math.round((w * displayHeight) / displayWidth)) };
}

type Opened = {
  track: NonNullable<Awaited<ReturnType<Input['getPrimaryVideoTrack']>>>;
  audio: Awaited<ReturnType<Input['getPrimaryAudioTrack']>>;
  duration: number;
  displayWidth: number;
  displayHeight: number;
  source: SourceVideo;
};

async function open(file: File): Promise<Opened> {
  const input = new Input({ source: new BlobSource(file), formats: FORMATS });
  if (!(await input.canRead())) {
    throw new Error('Could not read this container. Use MP4, MOV, WebM or MKV.');
  }

  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track found in this file.');
  if (!(await track.canDecode())) {
    throw new Error('Your browser cannot decode this codec.');
  }

  const displayWidth = await track.getDisplayWidth();
  const displayHeight = await track.getDisplayHeight();
  const stats = await track.computePacketStats();
  const audio = await input.getPrimaryAudioTrack().catch(() => null);

  return {
    track,
    audio,
    duration: await input.computeDuration(),
    displayWidth,
    displayHeight,
    source: {
      width: Math.round(displayWidth),
      height: Math.round(displayHeight),
      fps: Math.max(1, stats.averagePacketRate),
      frameCount: Math.max(1, stats.packetCount),
    },
  };
}

async function convert(file: File, settings: Settings): Promise<Trace> {
  const opened = await open(file);
  const { source } = opened;
  const { width, height } = fit(settings.width, opened.displayWidth, opened.displayHeight);
  const fps = Math.max(1, settings.fps);
  const total = Math.max(1, Math.min(Math.round(settings.maxFrames), Math.floor(opened.duration * fps)));

  const times = Array.from({ length: total }, (_, i) => i / fps);
  const sink = new CanvasSink(opened.track, { width, poolSize: 2 });

  const { w: ow, h: oh } = overlaySize(width, height, total);
  const stage = new OffscreenCanvas(ow, oh);
  const stageCtx = get2d(stage);

  const traced: Contour[][] = [];
  const overlays: ImageBitmap[] = [];
  let segmentCount = 0;

  send({ type: 'progress', label: 'Decoding', done: 0, total });

  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    if (!wrapped) continue;

    const { canvas } = wrapped;
    stageCtx.drawImage(canvas, 0, 0, ow, oh);
    overlays.push(stage.transferToImageBitmap());

    const image = get2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
    const mask = canny(image.data, canvas.width, canvas.height, settings.sensitivity);
    const contours = await traceMask(mask, canvas.width, canvas.height, settings.smoothing === true);

    segmentCount += contours.reduce((sum, contour) => sum + contour.length, 0);
    traced.push(contours);

    send({ type: 'progress', label: 'Tracing', done: traced.length, total });
  }

  if (traced.length === 0) throw new Error('No frames could be decoded from this file.');

  return { width, height, fps, frameCount: traced.length, segmentCount, frames: traced, overlays, source };
}

type SinkFrames = ReturnType<CanvasSink['canvasesAtTimestamps']>;

type RenderSession = {
  frames: SinkFrames;
  sensitivity: number;
  tolerance: number;
  smoothing: boolean;
  index: number;
  total: number;
  perf: boolean;
};

let session: RenderSession | null = null;

function closeRender(): void {
  const current = session;
  session = null;
  void current?.frames.return?.();
}

async function startRender(
  file: File,
  detail: number,
  height: number | null,
  sensitivity: number,
  tolerance: number,
  perf: boolean,
  smoothing: boolean,
): Promise<void> {
  const opened = await open(file);
  const { source } = opened;
  const plan = outputSize(source, height);
  const trace = fit(plan.width * detail, opened.displayWidth, opened.displayHeight);
  const total = Math.max(1, Math.min(source.frameCount, Math.floor(opened.duration * source.fps)));
  const times = Array.from({ length: total }, (_, i) => i / source.fps);
  const sink = new CanvasSink(opened.track, { width: trace.width, poolSize: 2 });

  session = {
    frames: sink.canvasesAtTimestamps(times),
    sensitivity,
    tolerance: Math.max(0.01, tolerance) * (trace.width / plan.width),
    smoothing,
    index: 0,
    total,
    perf,
  };
  send({ type: 'renderMeta', source, plan, trace, hasAudio: opened.audio !== null });
}

async function nextRenderFrame(): Promise<void> {
  const current = session;
  if (!current) return;

  const perf = current.perf;
  const started = perf ? performance.now() : 0;

  const { value, done } = await current.frames.next();
  if (session !== current) return;

  if (done || !value) {
    session = null;
    send({ type: 'renderDone' });
    return;
  }

  const afterDecode = perf ? performance.now() : 0;
  const { canvas } = value;
  const image = get2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
  const afterRead = perf ? performance.now() : 0;
  const mask = canny(image.data, canvas.width, canvas.height, current.sensitivity);
  const afterCanny = perf ? performance.now() : 0;
  const contours = capContours(await traceMask(mask, canvas.width, canvas.height, current.smoothing));
  const afterTrace = perf ? performance.now() : 0;
  const frame = flattenContours(contours, current.tolerance);
  if (session !== current) return;

  const transfer = frame.groups.flatMap((group) => [group.x.buffer, group.y.buffer]);
  send(
    {
      type: 'renderFrame',
      frame,
      index: current.index++,
      total: current.total,
      timing: perf
        ? {
            decode: afterDecode - started,
            read: afterRead - afterDecode,
            canny: afterCanny - afterRead,
            trace: afterTrace - afterCanny,
            segments: contours.reduce((sum, contour) => sum + contour.length, 0),
            contours: contours.length,
          }
        : undefined,
    },
    transfer,
  );
}

port.onmessage = async (event) => {
  const message = event.data;

  try {
    if (message.type === 'convert') {
      const trace = await convert(message.file, message.settings);
      send({ type: 'result', trace }, trace.overlays);
    } else if (message.type === 'render') {
      closeRender();
      await startRender(
        message.file,
        message.detail,
        message.height,
        message.sensitivity,
        message.tolerance ?? FLAT_TOLERANCE,
        message.perf ?? false,
        message.smoothing === true,
      );
    } else if (message.type === 'renderNext') {
      await nextRenderFrame();
    } else {
      closeRender();
    }
  } catch (error) {
    closeRender();
    send({ type: 'error', message: describeError(error) });
  }
};
