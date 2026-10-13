import { BlobSource, CanvasSink, Input, MATROSKA, MP4, QTFF, WEBM } from 'mediabunny';
import { canny } from './lib/canny';
import { traceMask } from './lib/trace';
import type { Contour, Settings, Trace, WorkerRequest, WorkerResponse } from './lib/types';

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

async function convert(file: File, settings: Settings): Promise<Trace> {
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
  const width = Math.max(48, Math.round(settings.width));
  const height = Math.max(48, Math.round((width * displayHeight) / displayWidth));

  const duration = await input.computeDuration();
  const fps = Math.max(1, settings.fps);
  const total = Math.max(1, Math.min(Math.round(settings.maxFrames), Math.floor(duration * fps)));

  const times = Array.from({ length: total }, (_, i) => i / fps);
  const sink = new CanvasSink(track, { width, poolSize: 2 });

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
    const contours = await traceMask(mask, canvas.width, canvas.height);

    segmentCount += contours.reduce((sum, contour) => sum + contour.length, 0);
    traced.push(contours);

    send({ type: 'progress', label: 'Tracing', done: traced.length, total });
  }

  if (traced.length === 0) throw new Error('No frames could be decoded from this file.');

  return {
    width,
    height,
    fps,
    frameCount: traced.length,
    segmentCount,
    frames: traced,
    overlays,
  };
}

port.onmessage = (event) => {
  const { file, settings } = event.data;
  convert(file, settings)
    .then((trace) => send({ type: 'result', trace }, trace.overlays))
    .catch((error: unknown) =>
      send({ type: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
};
