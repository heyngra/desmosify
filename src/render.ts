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
import { frameShape } from './lib/latex';
import type { RenderPlan } from './lib/render';
import type { Contour } from './lib/types';

const CODECS = ['avc', 'vp9', 'av1'] as const;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export type RenderProgress = (done: number, total: number) => void;

export type RenderJob = {
  bounds: { width: number; height: number };
  frames: AsyncIterable<Contour[]>;
};

function frameSignature(contours: Contour[]): number {
  let hash = 2166136261;

  const mix = (value: number) => {
    hash = Math.imul(hash ^ (value * 1000000), 16777619);
  };

  for (const contour of contours) {
    mix(contour.length);
    for (const segment of contour) {
      mix(segment.p0.x);
      mix(segment.p0.y);
      mix(segment.p1.x);
      mix(segment.p1.y);
      if (segment.type === 'cubic') {
        mix(segment.c1.x);
        mix(segment.c1.y);
        mix(segment.c2.x);
        mix(segment.c2.y);
      }
    }
  }

  return hash >>> 0;
}

export async function renderVideo(
  job: RenderJob,
  plan: RenderPlan,
  onProgress: RenderProgress,
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

    for await (const contours of job.frames) {
      const signature = frameSignature(contours);
      if (signature !== previous) {
        renderer.show(frameShape(contours));
        await renderer.capture(canvas, plan.width, plan.height);
        previous = signature;
      }

      await video.add(index / plan.fps, 1 / plan.fps);
      index += 1;

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
