import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lineWidthFor, outputSize, renderPlan } from '../src/lib/render.ts';
import type { SourceVideo } from '../src/lib/types.ts';

const source: SourceVideo = { width: 1920, height: 1080, fps: 30, frameCount: 150 };

test('renderPlan mirrors the imported video', () => {
  assert.deepEqual(renderPlan(source), {
    width: 1920,
    height: 1080,
    fps: 30,
    frameCount: 150,
    lineWidth: 3,
  });
});

test('renderPlan keeps one output frame per source frame at native fps', () => {
  const hd = { ...source, fps: 60, frameCount: 300 };
  const plan = renderPlan(hd);

  assert.equal(plan.fps, 60);
  assert.equal(plan.frameCount, 300);
  assert.equal(plan.frameCount / plan.fps, 5);
});

test('renderPlan honors explicit overrides', () => {
  assert.deepEqual(renderPlan(source, { width: 640, height: 360, fps: 60, frameCount: 12, lineWidth: 2 }), {
    width: 640,
    height: 360,
    fps: 60,
    frameCount: 12,
    lineWidth: 2,
  });
});

test('lineWidthFor scales the base thickness with the output height', () => {
  assert.equal(lineWidthFor(1080, 3), 3);
  assert.equal(lineWidthFor(2160, 3), 6);
  assert.equal(lineWidthFor(540, 3), 2);
  assert.equal(lineWidthFor(120, 3), 1);
});

test('renderPlan derives the line width from the output height', () => {
  assert.equal(renderPlan({ ...source, height: 2160 }).lineWidth, 6);
  assert.equal(renderPlan({ ...source, height: 480 }).lineWidth, 1);
});

test('outputSize keeps the source when no height is asked for', () => {
  assert.deepEqual(outputSize(source, null), { width: 1920, height: 1080 });
});

test('outputSize scales the width to the requested height', () => {
  assert.deepEqual(outputSize(source, 480), { width: 853, height: 480 });
  assert.deepEqual(outputSize(source, 720), { width: 1280, height: 720 });
});

test('outputSize never upscales past the source', () => {
  const small: SourceVideo = { width: 640, height: 360, fps: 30, frameCount: 10 };

  assert.deepEqual(outputSize(small, 1080), { width: 640, height: 360 });
});
