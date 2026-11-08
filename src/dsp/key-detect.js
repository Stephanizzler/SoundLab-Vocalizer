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

/**
 * Pitch-class profile of a short window (e.g. the backing track under one
 * sung note). Returns 12 values normalised to max 1, or null if silent.
 */
export function chromaWindow(x, sampleRate, t0, t1) {
  const N = sampleRate > 32000 ? 8192 : 4096;
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const out = new Float64Array(12);
  const s0 = Math.max(0, Math.floor(t0 * sampleRate));
  const s1 = Math.min(x.length, Math.ceil(t1 * sampleRate));
  const span = s1 - s0;
  const frames = Math.max(1, Math.min(4, Math.floor(span / (N / 2))));
  for (let f = 0; f < frames; f++) {
    const c = s0 + ((f + 0.5) / frames) * span;
    const st = Math.round(c - N / 2);
    for (let i = 0; i < N; i++) {
      const idx = st + i;
      re[i] = idx >= 0 && idx < x.length ? x[idx] * win[i] : 0;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const freq = (k * sampleRate) / N;
      if (freq < 60 || freq > 2100) continue;
      const pc = ((Math.round(69 + 12 * Math.log2(freq / 440)) % 12) + 12) % 12;
      out[pc] += Math.hypot(re[k], im[k]);
    }
  }
  const max = Math.max(...out);
  if (max < 1e-6) return null;
  for (let p = 0; p < 12; p++) out[p] /= max;
  return out;
}

/** Rough tempo (BPM) from an onset-strength autocorrelation. */
export async function detectTempo(x, sampleRate, { maxSeconds = 90 } = {}) {
  const hop = Math.round(512 * (sampleRate / 44100));
  const fps = sampleRate / hop;
  const end = Math.min(x.length, Math.floor(maxSeconds * sampleRate));
  const nF = Math.floor(end / hop);
  if (nF < fps * 4) return null;
  const env = new Float64Array(nF);
  for (let f = 0; f < nF; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) e += x[i] * x[i];
    env[f] = Math.log(1 + 1000 * e / hop);
  }
  await tick();
  const onset = new Float64Array(nF);
  for (let f = 1; f < nF; f++) onset[f] = Math.max(0, env[f] - env[f - 1]);
  let mean = 0;
  for (let f = 0; f < nF; f++) mean += onset[f];
  mean /= nF;
  for (let f = 0; f < nF; f++) onset[f] -= mean;
  const lagMin = Math.floor((60 * fps) / 190);
  const lagMax = Math.ceil((60 * fps) / 60);
  const ac = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let s = 0;
    for (let f = lag; f < nF; f++) s += onset[f] * onset[f - lag];
    ac[lag] = s / (nF - lag);
  }
  let best = -1, bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.6) ** 2); // favour common tempi
    const score = ac[lag] * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (best < 0 || bestScore <= 0) return null;
  const a = ac[best - 1], b = ac[best], c = ac[best + 1];
  const d = a - 2 * b + c;
  const shift = d !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
  return Math.round((60 * fps) / (best + shift));
}
