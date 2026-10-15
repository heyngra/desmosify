const GAUSS = [1, 4, 6, 4, 1];
const GAUSS_SUM = 16;
const TAN_22_5 = Math.tan((22.5 * Math.PI) / 180);
const TAN_67_5 = Math.tan((67.5 * Math.PI) / 180);

const CUTOFF_MIN = 0;
const CUTOFF_MAX = 1;
const SPREAD_MAX = 2.75;
const LOW_RATIO = 0.4;

type Scratch = {
  size: number;
  gray: Float32Array;
  tmp: Float32Array;
  blurred: Float32Array;
  mag: Float32Array;
  dir: Uint8Array;
  thin: Float32Array;
  survivors: Float32Array;
  stack: Int32Array;
};

let scratch: Scratch | null = null;

function ensureScratch(size: number): Scratch {
  if (scratch && scratch.size >= size) return scratch;

  scratch = {
    size,
    gray: new Float32Array(size),
    tmp: new Float32Array(size),
    blurred: new Float32Array(size),
    mag: new Float32Array(size),
    dir: new Uint8Array(size),
    thin: new Float32Array(size),
    survivors: new Float32Array(size),
    stack: new Int32Array(size),
  };
  return scratch;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function threshold(survivors: Float32Array, count: number, cutoff: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += survivors[i];
  const mean = sum / count;

  let variance = 0;
  for (let i = 0; i < count; i++) {
    const deviation = survivors[i] - mean;
    variance += deviation * deviation;
  }

  const t = clamp((cutoff - CUTOFF_MIN) / (CUTOFF_MAX - CUTOFF_MIN), 0, 1);
  return mean + Math.sqrt(variance / count) * SPREAD_MAX * t * t;
}

function blur(src: Float32Array, tmp: Float32Array, out: Float32Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -2; i <= 2; i++) {
        acc += src[y * w + clamp(x + i, 0, w - 1)] * GAUSS[i + 2];
      }
      tmp[y * w + x] = acc / GAUSS_SUM;
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -2; i <= 2; i++) {
        acc += tmp[clamp(y + i, 0, h - 1) * w + x] * GAUSS[i + 2];
      }
      out[y * w + x] = acc / GAUSS_SUM;
    }
  }
}

function sector(gx: number, gy: number): number {
  const ax = gx < 0 ? -gx : gx;
  const ay = gy < 0 ? -gy : gy;
  if (ay <= ax * TAN_22_5) return 0;
  if (ay > ax * TAN_67_5) return 2;
  return gx * gy > 0 ? 1 : 3;
}

export function canny(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  cutoff = 0.6,
): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (w < 3 || h < 3) return mask;

  const { gray, tmp, blurred, mag, dir, thin, survivors, stack } = ensureScratch(w * h);

  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }

  blur(gray, tmp, blurred, w, h);
  mag.fill(0);
  thin.fill(0);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -blurred[i - w - 1] - 2 * blurred[i - 1] - blurred[i + w - 1] +
        blurred[i - w + 1] + 2 * blurred[i + 1] + blurred[i + w + 1];
      const gy =
        -blurred[i - w - 1] - 2 * blurred[i - w] - blurred[i - w + 1] +
        blurred[i + w - 1] + 2 * blurred[i + w] + blurred[i + w + 1];
      mag[i] = Math.abs(gx) + Math.abs(gy);
      dir[i] = sector(gx, gy);
    }
  }

  let count = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m === 0) continue;

      let n1: number;
      let n2: number;
      switch (dir[i]) {
        case 0:
          n1 = mag[i - 1];
          n2 = mag[i + 1];
          break;
        case 1:
          n1 = mag[i - w - 1];
          n2 = mag[i + w + 1];
          break;
        case 2:
          n1 = mag[i - w];
          n2 = mag[i + w];
          break;
        default:
          n1 = mag[i - w + 1];
          n2 = mag[i + w - 1];
          break;
      }

      if (m >= n1 && m >= n2) {
        thin[i] = m;
        survivors[count++] = m;
      }
    }
  }

  if (count === 0) return mask;

  const high = threshold(survivors, count, cutoff);
  const low = high * LOW_RATIO;

  let top = 0;
  for (let i = 0; i < w * h; i++) {
    if (thin[i] >= high) {
      mask[i] = 1;
      stack[top++] = i;
    }
  }

  while (top > 0) {
    const i = stack[--top];
    const x = i % w;
    const y = (i / w) | 0;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j] === 0 && thin[j] >= low) {
          mask[j] = 1;
          stack[top++] = j;
        }
      }
    }
  }

  return mask;
}
