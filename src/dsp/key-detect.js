import { fft, hann } from './fft.js';
import { tick } from './util.js';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl–Kessler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return num / Math.sqrt(da * db || 1);
}

/** 12-bin pitch-class energy profile of a mono signal. */
export async function chromagram(x, sampleRate, { maxSeconds = 240, onProgress } = {}) {
  const N = sampleRate > 32000 ? 8192 : 4096;
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const binPc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sampleRate) / N;
    if (f < 60 || f > 2100) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const chroma = new Float64Array(12);
  const frame = new Float64Array(12);
  const end = Math.min(x.length, Math.floor(maxSeconds * sampleRate));
  const frames = Math.max(0, Math.floor((end - N) / N) + 1);
  for (let f = 0; f < frames; f++) {
    const s = f * N;
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    frame.fill(0);
    let total = 0;
    for (let k = 1; k < N / 2; k++) {
      const pc = binPc[k];
      if (pc < 0) continue;
      const m = Math.hypot(re[k], im[k]);
      frame[pc] += m;
      total += m;
    }
    if (total > 1e-3) for (let p = 0; p < 12; p++) chroma[p] += frame[p] / total;
    if (f % 50 === 0) { onProgress?.(f / frames); await tick(); }
  }
  onProgress?.(1);
  return chroma;
}

export function keyFromChroma(chroma) {
  const results = [];
  for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]]) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const rotated = new Array(12);
      for (let pc = 0; pc < 12; pc++) rotated[pc] = profile[(pc - tonic + 12) % 12];
      results.push({ tonic, mode, score: pearson(chroma, rotated) });
    }
  }
  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: `${NOTE_NAMES[best.tonic]} ${best.mode}`,
    score: best.score,
    confidence: best.score - results[1].score,
    ranking: results.slice(0, 5),
  };
}

export async function detectKey(x, sampleRate, opts = {}) {
  return keyFromChroma(await chromagram(x, sampleRate, opts));
}
