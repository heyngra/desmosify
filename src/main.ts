import { createPlayer, type Player } from './desmos';
import { describeError } from './lib/error';
import { clipLatex, frameLatex, frameShape, type FrameShape } from './lib/latex';
import { lineWidthFor, renderPlan } from './lib/render';
import { buildFlat, LIST_LIMIT } from './lib/sample';
import { renderVideo } from './render';
import type {
  FlatFrame,
  FrameEncodeTiming,
  FrameTraceTiming,
  RenderMeta,
  Settings,
  Trace,
  WorkerRequest,
  WorkerResponse,
} from './lib/types';

const fileInput = document.querySelector<HTMLInputElement>('#file')!;
const runButton = document.querySelector<HTMLButtonElement>('#run')!;
const dropZone = document.querySelector<HTMLLabelElement>('#drop')!;
const fileName = document.querySelector<HTMLSpanElement>('#fileName')!;
const notice = document.querySelector<HTMLParagraphElement>('#notice')!;
const output = document.querySelector<HTMLElement>('#out')!;
const latexArea = document.querySelector<HTMLTextAreaElement>('#latex')!;
const copyButton = document.querySelector<HTMLButtonElement>('#copy')!;
const exportMode = document.querySelector<HTMLSelectElement>('#exportMode')!;
const previewCard = document.querySelector<HTMLElement>('#preview')!;
const calculator = document.querySelector<HTMLElement>('#calculator')!;
const overlay = document.querySelector<HTMLCanvasElement>('#overlay')!;
const overlayToggle = document.querySelector<HTMLInputElement>('#overlayToggle')!;
const playButton = document.querySelector<HTMLButtonElement>('#play')!;
const scrub = document.querySelector<HTMLInputElement>('#scrub')!;
const frameLabel = document.querySelector<HTMLSpanElement>('#frameLabel')!;
const renderButton = document.querySelector<HTMLButtonElement>('#render')!;
const renderInfo = document.querySelector<HTMLSpanElement>('#renderInfo')!;
const renderDialog = document.querySelector<HTMLDialogElement>('#renderDialog')!;
const renderCancel = document.querySelector<HTMLButtonElement>('#renderCancel')!;
const renderGo = document.querySelector<HTMLButtonElement>('#renderGo')!;
const renderSize = document.querySelector<HTMLSelectElement>('#renderSize')!;
const renderAudio = document.querySelector<HTMLInputElement>('#renderAudio')!;
const smoothToggle = document.querySelector<HTMLInputElement>('#smooth')!;
const cutoffInput = document.querySelector<HTMLInputElement>('#sensitivity')!;
const cutoffValue = document.querySelector<HTMLOutputElement>('#sensitivityValue')!;

function syncCutoff(): void {
  cutoffValue.value = Number(cutoffInput.value).toFixed(2);
}

const field = (id: string) => Number(document.querySelector<HTMLInputElement>(id)!.value);
const formatFps = (fps: number) => `${Math.round(fps * 100) / 100} fps`;
const sourceLabel = (source: Trace['source']) =>
  `${source.width}×${source.height} · ${formatFps(source.fps)} · ${source.frameCount} frames`;

function showNotice(message: string) {
  notice.textContent = message;
  notice.hidden = !message;
}

function syncControls() {
  const idle = !busy && !rendering;
  const hasFile = !!fileInput.files?.length;
  runButton.disabled = !idle || !hasFile;
  renderButton.disabled = !idle || !hasFile;
}

function save(blob: Blob) {
  const name = fileInput.files?.[0]?.name ?? 'desmos';
  const base = name.replace(/\.[^.]+$/, '') || 'desmos';
  const extension = blob.type.includes('webm') ? 'webm' : 'mp4';
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${base} (desmos).${extension}`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function acceptFile(file: File | undefined) {
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  fileName.textContent = file.name;
  syncControls();
  showNotice('');
}

const worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
const perf = new URLSearchParams(location.search).has('perf');
const perfSink: { worker: FrameTraceTiming[]; encode: FrameEncodeTiming[] } | null = perf
  ? { worker: [], encode: [] }
  : null;
let busy = false;
let keepFrameOnResult = false;
let pendingReconvert = false;
let trace: Trace | null = null;
let player: Player | null = null;
let timer: number | null = null;
let frame = 0;
let clipCache: { trace: Trace; detail: number; contours: number; latex: string } | null = null;
let rendering = false;
let metaWait: { resolve: (meta: RenderMeta) => void; reject: (error: Error) => void } | null = null;
let frameWait: { resolve: (frame: FlatFrame | null) => void; reject: (error: Error) => void } | null = null;

const settings = (): Settings => ({
  width: field('#width'),
  fps: field('#fps'),
  maxFrames: field('#frames'),
  detail: field('#detail'),
  contours: field('#contours'),
  sensitivity: field('#sensitivity'),
  smoothing: smoothToggle.checked,
});

function drawOverlay() {
  if (!trace || !overlayToggle.checked) return;

  const bitmap = trace.overlays[frame];
  if (!bitmap) return;

  const context = overlay.getContext('2d');
  if (!context) return;

  if (overlay.width !== bitmap.width || overlay.height !== bitmap.height) {
    overlay.width = bitmap.width;
    overlay.height = bitmap.height;
  }

  context.clearRect(0, 0, overlay.width, overlay.height);
  context.drawImage(bitmap, 0, 0);
}

function clipText(detail: number, contours: number): string {
  if (!trace) return '';

  const cached = clipCache;
  if (cached && cached.trace === trace && cached.detail === detail && cached.contours === contours) {
    return cached.latex;
  }

  const latex = clipLatex(trace, buildFlat(trace.frames, detail, contours));
  clipCache = { trace, detail, contours, latex };
  return latex;
}

function refreshLatex(shape?: FrameShape) {
  if (!trace) return;

  const text =
    exportMode.value === 'clip'
      ? clipText(Math.min(LIST_LIMIT, field('#detail')), field('#contours'))
      : frameLatex(shape ?? frameShape(trace.frames[frame] ?? [])).join('\n');

  if (latexArea.value !== text) latexArea.value = text;
}

function paint() {
  if (!trace) return;

  const shape = frameShape(trace.frames[frame] ?? []);
  player?.show(shape);
  scrub.value = String(frame);
  frameLabel.textContent = `${frame + 1} / ${trace.frameCount}`;
  drawOverlay();
  refreshLatex(shape);
}

function stop() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  playButton.textContent = 'Play';
}

function start() {
  if (!trace) return;
  stop();
  const every = Math.max(60, 1000 / trace.fps);
  timer = window.setInterval(() => {
    if (!trace) return;
    frame = (frame + 1) % trace.frameCount;
    paint();
  }, every);
  playButton.textContent = 'Pause';
}

function releaseTrace() {
  if (trace) for (const bitmap of trace.overlays) bitmap.close();
  trace = null;
  clipCache = null;
}

fileInput.addEventListener('change', () => acceptFile(fileInput.files?.[0]));

dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('over');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));

dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('over');
  acceptFile(event.dataTransfer?.files[0]);
});

function runConvert(keepFrame: boolean): void {
  const file = fileInput.files?.[0];
  if (!file || busy || rendering) return;

  busy = true;
  keepFrameOnResult = keepFrame;
  runButton.textContent = 'Converting…';
  if (!keepFrame) {
    output.hidden = true;
    previewCard.hidden = true;
  }
  showNotice('');
  stop();
  syncControls();

  worker.postMessage({ type: 'convert', file, settings: settings() } satisfies WorkerRequest);
}

runButton.addEventListener('click', () => runConvert(false));

cutoffInput.addEventListener('input', syncCutoff);

cutoffInput.addEventListener('change', () => {
  syncCutoff();
  if (!trace) return;
  if (busy || rendering) {
    pendingReconvert = true;
    return;
  }
  runConvert(true);
});

syncCutoff();

playButton.addEventListener('click', () => {
  if (timer === null) start();
  else stop();
});

scrub.addEventListener('input', () => {
  frame = Number(scrub.value);
  paint();
});

overlayToggle.addEventListener('change', () => {
  overlay.hidden = !overlayToggle.checked;
  drawOverlay();
});

exportMode.addEventListener('change', () => refreshLatex());

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(latexArea.value);
    copyButton.textContent = 'Copied';
    setTimeout(() => {
      copyButton.textContent = 'Copy';
    }, 1200);
  } catch {
    latexArea.select();
    copyButton.textContent = 'Select + Ctrl-C';
  }
});

function startRender(file: File, detail: number, sensitivity: number): Promise<RenderMeta> {
  const height = renderSize.value === 'source' ? null : Number(renderSize.value);
  return new Promise((resolve, reject) => {
    metaWait = { resolve, reject };
    worker.postMessage({ type: 'render', file, detail, height, sensitivity, perf, smoothing: smoothToggle.checked } satisfies WorkerRequest);
  });
}

function pullFrame(): Promise<FlatFrame | null> {
  return new Promise((resolve, reject) => {
    frameWait = { resolve, reject };
    worker.postMessage({ type: 'renderNext' } satisfies WorkerRequest);
  });
}

async function* prefetchFrames(total: number): AsyncGenerator<FlatFrame> {
  let pending: Promise<FlatFrame | null> = pullFrame();

  for (let i = 0; i < total; i++) {
    const frame = await pending;
    if (!frame) return;
    pending = i + 1 < total ? pullFrame() : Promise.resolve(null);
    yield frame;
  }
}

function failRender(error: Error): void {
  metaWait?.reject(error);
  metaWait = null;
  frameWait?.reject(error);
  frameWait = null;
}

renderButton.addEventListener('click', () => {
  if (rendering || busy || !fileInput.files?.length) return;
  if (!renderDialog.open) renderDialog.showModal();
});

renderCancel.addEventListener('click', () => renderDialog.close());

renderGo.addEventListener('click', () => {
  renderDialog.close();
  void runRender();
});

async function runRender(): Promise<void> {
  const file = fileInput.files?.[0];
  if (!file || rendering || busy) return;

  const wantsAudio = renderAudio.checked;

  rendering = true;
  renderButton.textContent = 'Converting…';
  syncControls();
  showNotice('');

  let started = false;
  try {
    const meta = await startRender(file, field('#detailScale'), field('#sensitivity'));
    started = true;
    renderInfo.textContent =
      `${meta.plan.width}×${meta.plan.height} · ${formatFps(meta.source.fps)} · ${meta.source.frameCount} frames` +
      ` · trace ${meta.trace.width}×${meta.trace.height}`;

    if (wantsAudio && !meta.hasAudio) showNotice('This source has no audio track; rendering video only.');

    const plan = renderPlan(meta.source, {
      width: meta.plan.width,
      height: meta.plan.height,
      lineWidth: lineWidthFor(meta.plan.height, field('#lineWidth')),
    });
    const blob = await renderVideo(
      {
        bounds: meta.trace,
        frames: prefetchFrames(meta.source.frameCount),
        audio: wantsAudio && meta.hasAudio ? file : undefined,
      },
      plan,
      (done, total) => {
        renderButton.textContent = `Rendering ${Math.round((done / total) * 100)}%`;
      },
      perfSink ? (timing) => perfSink.encode.push(timing) : undefined,
    );
    save(blob);
  } catch (error) {
    showNotice(`Render failed (${describeError(error)}).`);
  } finally {
    if (perfSink) (window as Window & { __perf?: unknown }).__perf = perfSink;
    if (started) worker.postMessage({ type: 'renderClose' } satisfies WorkerRequest);
    rendering = false;
    renderButton.textContent = 'Render';
    syncControls();
  }
}

worker.onmessage = async (event: MessageEvent<WorkerResponse>) => {
  const message = event.data;

  if (message.type === 'renderMeta') {
    const wait = metaWait;
    metaWait = null;
    wait?.resolve(message);
    return;
  }

  if (message.type === 'renderFrame') {
    if (perfSink && message.timing) perfSink.worker.push(message.timing);
    const wait = frameWait;
    frameWait = null;
    wait?.resolve(message.frame);
    return;
  }

  if (message.type === 'renderDone') {
    const wait = frameWait;
    frameWait = null;
    wait?.resolve(null);
    return;
  }

  if (message.type === 'progress') {
    const percent = message.total > 0 ? Math.round((message.done / message.total) * 100) : 0;
    runButton.textContent = `${message.label} ${percent}%`;
    return;
  }

  if (message.type === 'error') {
    if (rendering) {
      failRender(new Error(message.message));
      return;
    }
    busy = false;
    keepFrameOnResult = false;
    pendingReconvert = false;
    runButton.textContent = 'Convert';
    showNotice(message.message);
    syncControls();
    return;
  }

  busy = false;
  runButton.textContent = 'Convert';
  const keepFrame = keepFrameOnResult;
  keepFrameOnResult = false;
  const previous = trace;
  const reuse =
    keepFrame && !!player && !!previous && previous.width === message.trace.width && previous.height === message.trace.height;

  releaseTrace();
  trace = message.trace;
  if (!reuse) {
    player?.destroy();
    player = null;
  }
  frame = keepFrame ? Math.min(frame, trace.frameCount - 1) : 0;

  latexArea.value = '';
  output.hidden = false;
  previewCard.hidden = false;
  scrub.min = '0';
  scrub.max = String(Math.max(0, trace.frameCount - 1));
  renderInfo.textContent = sourceLabel(trace.source);
  syncControls();

  try {
    if (!player) player = await createPlayer(calculator, trace);
    paint();
    if (!keepFrame) start();
  } catch (error) {
    previewCard.hidden = true;
    showNotice(`Preview unavailable (${error instanceof Error ? error.message : 'unknown error'}).`);
  }

  if (pendingReconvert) {
    pendingReconvert = false;
    runConvert(true);
  }
};
