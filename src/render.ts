import {
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  Input,
  MATROSKA,
  MP4,
  Mp4OutputFormat,
  Output,
  Quality,
  QTFF,
  WEBM,
  WebMOutputFormat,
} from 'mediabunny';
import type { InputAudioTrack, OutputFormat } from 'mediabunny';
import { createRenderer } from './desmos';
import type { RenderPlan } from './lib/render';
import type { FlatFrame, FrameEncodeTiming } from './lib/types';

const CODECS = ['avc', 'vp9', 'av1'] as const;
const AUDIO_CODECS = ['aac', 'opus', 'vorbis', 'mp3'] as const;
const FORMATS = [MP4, QTFF, MATROSKA, WEBM];
const MAX_AUDIO_CHANNELS = 2;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export type RenderProgress = (done: number, total: number) => void;

export type RenderTiming = (timing: FrameEncodeTiming) => void;

export type RenderJob = {
  bounds: { width: number; height: number };
  frames: AsyncIterable<FlatFrame>;
  audio?: File;
};

type AudioJob = {
  track: InputAudioTrack;
  source: AudioSampleSource;
};

async function openAudio(file: File, format: OutputFormat): Promise<AudioJob | null> {
  const input = new Input({ source: new BlobSource(file), formats: FORMATS });
  if (!(await input.canRead())) return null;

  const track = await input.getPrimaryAudioTrack();
  if (!track) return null;
  if (!(await track.canDecode())) throw new Error('This browser cannot decode the audio track.');

  const sourceChannels = await track.getNumberOfChannels();
  const numberOfChannels = Math.min(sourceChannels, MAX_AUDIO_CHANNELS);
  const sampleRate = await track.getSampleRate();
  const supported = new Set(format.getSupportedAudioCodecs());
  const codecs = AUDIO_CODECS.filter((codec) => supported.has(codec));
  const codec = await getFirstEncodableAudioCodec(codecs, {
    numberOfChannels,
    sampleRate,
    quality: new Quality('high'),
  });
  if (!codec) throw new Error('This browser cannot encode the audio track.');

  const source = new AudioSampleSource({
    codec,
    quality: new Quality('high'),
    transform: numberOfChannels < sourceChannels ? { numberOfChannels } : undefined,
  });
  return { track, source };
}

async function encodeAudio(job: AudioJob): Promise<void> {
  const sink = new AudioSampleSink(job.track);

  for await (const sample of sink.samples()) {
    try {
      await job.source.add(sample);
    } finally {
      sample.close();
    }
  }

  job.source.close();
}

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

  const audio = job.audio ? await openAudio(job.audio, format) : null;
  if (audio) output.addAudioTrack(audio.source);

  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden;';
  document.body.append(host);

  const canvas = document.createElement('canvas');
  const video = new CanvasSource(canvas, { codec, quality: new Quality('high') });
  output.addVideoTrack(video, { frameRate: plan.fps });

  let renderer: Awaited<ReturnType<typeof createRenderer>> | null = null;
  let audioTask: Promise<void> | null = null;

  try {
    renderer = await createRenderer(host, job.bounds.width, job.bounds.height, plan.lineWidth);
    await output.start();

    if (audio) {
      audioTask = encodeAudio(audio);
      void audioTask.catch(() => undefined);
    }

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
    if (audioTask) await audioTask;
    video.close();
    await output.finalize();
  } catch (error) {
    await audioTask?.catch(() => undefined);
    video.close();
    await output.cancel().catch(() => undefined);
    throw error;
  } finally {
    renderer?.destroy();
    host.remove();
  }

  return new Blob([target.buffer!], { type: await output.getMimeType() });
}
