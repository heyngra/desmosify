import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import { createRenderer } from './desmos';
import type { RenderPlan } from './lib/render';
import type { FlatFrame, FrameEncodeTiming } from './lib/types';

const CODECS = ['avc', 'vp9', 'av1'] as const;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export type RenderProgress = (done: number, total: number) => void;

export type RenderTiming = (timing: FrameEncodeTiming) => void;

export type RenderJob = {
  bounds: { width: number; height: number };
  frames: AsyncIterable<FlatFrame>;
};

export async function renderVideo(
  job: RenderJob,
  plan: RenderPlan,
  onProgress: RenderProgress,
  onTiming?: RenderTiming,
): Promise<Blob> {
  const codec = await getFirstEncodableVideoCodec([...CODECS], {
    width: plan.width,
    height: plan.height,
    frameRate: plan.fps,
  });
  if (!codec) throw new Error('This browser cannot encode video.');

  const format = codec === 'vp9' ? new WebMOutputFormat() : new Mp4OutputFormat();
  const target = new BufferTarget();
  const output = new Output({ format, target });

  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
  document.body.append(host);

  const canvas = document.createElement('canvas');
  const video = new CanvasSource(canvas, { codec, quality: new Quality('high') });
  output.addVideoTrack(video, { frameRate: plan.fps });

  let renderer: Awaited<ReturnType<typeof createRenderer>> | null = null;

  try {
    renderer = await createRenderer(host, job.bounds.width, job.bounds.height, plan.lineWidth);
    await output.start();

    let index = 0;
    let previous: number | null = null;
    const frames = job.frames[Symbol.asyncIterator]();

    for (;;) {
      const waitStart = performance.now();
      const { value: frame, done } = await frames.next();
      const wait = performance.now() - waitStart;
      if (done) break;

      let show = 0;
      let sync = 0;
      let draw = 0;
      let changed = 0;
      if (frame.signature !== previous) {
        const showStart = performance.now();
        changed = renderer.show(frame);
        show = performance.now() - showStart;

        const capture = await renderer.capture(canvas, plan.width, plan.height);
        sync = capture.sync;
        draw = capture.draw;
        previous = frame.signature;
      }

      const encodeStart = performance.now();
      await video.add(index / plan.fps, 1 / plan.fps);
      const encode = performance.now() - encodeStart;
      index += 1;

      onTiming?.({ index, wait, show, changed, sync, draw, encode, total: wait + show + sync + draw + encode });

      if (index % 8 === 0) {
        onProgress(index, plan.frameCount);
        await tick();
      }
    }

    if (index === 0) throw new Error('No frames could be traced from this file.');

    onProgress(index, Math.max(index, plan.frameCount));
    video.close();
    await output.finalize();
  } catch (error) {
    video.close();
    await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    renderer?.destroy();
    host.remove();
  }

  return new Blob([target.buffer!], { type: await output.getMimeType() });
}
