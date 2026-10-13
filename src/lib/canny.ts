const GAUSS = [1, 4, 6, 4, 1];
const GAUSS_SUM = 16;

function blur(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);

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

  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function angleBucket(deg: number): number {
  let a = deg % 180;
  if (a < 0) a += 180;
  if (a < 22.5 || a >= 157.5) return 0;
  if (a < 67.5) return 1;
  if (a < 112.5) return 2;
  return 3;
}

export function canny(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  highPercentile = 0.9,
): Uint8Array {
  const mask = new Uint8Array(w * h);
  if (w < 3 || h < 3) return mask;

  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  }

  const g = blur(gray, w, h);
  const mag = new Float32Array(w * h);
  const dir = new Uint8Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
      const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      mag[i] = Math.abs(gx) + Math.abs(gy);
      dir[i] = angleBucket((Math.atan2(gy, gx) * 180) / Math.PI);
    }
  }

  const thin = new Float32Array(w * h);
  const survivors: number[] = [];
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
        survivors.push(m);
      }
    }
  }

  if (survivors.length === 0) return mask;

  survivors.sort((p, q) => p - q);
  const high = survivors[clamp(Math.floor(survivors.length * highPercentile), 0, survivors.length - 1)];
  const low = high * 0.4;

  const stack: number[] = [];
  for (let i = 0; i < thin.length; i++) {
    if (thin[i] >= high) {
      mask[i] = 1;
      stack.push(i);
    }
  }

  while (stack.length > 0) {
    const i = stack.pop() as number;
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
          stack.push(j);
        }
      }
    }
  }

  return mask;
}
