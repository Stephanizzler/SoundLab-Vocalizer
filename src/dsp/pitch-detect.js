import { tick } from './util.js';

function designLowpass(cutoff, taps) {
  // Blackman-windowed sinc; cutoff in cycles/sample.
  const h = new Float32Array(taps);
  const M = taps - 1;
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - M / 2;
    const s = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / M) + 0.08 * Math.cos((4 * Math.PI * n) / M);
    h[n] = s * w;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

export function decimate(x, factor) {
  if (factor <= 1) return Float32Array.from(x);
  const h = designLowpass(0.45 / factor, 16 * factor + 1);
  const half = (h.length - 1) / 2;
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let i = 0; i < out.length; i++) {
    const c = i * factor - half;
    let acc = 0;
    const kStart = Math.max(0, -c);
    const kEnd = Math.min(h.length, x.length - c);
    for (let k = kStart; k < kEnd; k++) acc += h[k] * x[c + k];
    out[i] = acc;
  }
  return out;
}

/**
 * YIN monophonic pitch tracker.
 * Returns per-frame f0 in Hz (0 = unvoiced/silent) on a fixed hop grid:
 *   time of frame i = t0 + i * hopSec
 */
export async function detectPitch(x, sampleRate, opts = {}) {
  const {
    fmin = 70,
    fmax = 1100,
    hopSec = 0.01,
    threshold = 0.15,
    silenceDb = -40, // relative to loudest frame
    minVoicedSec = 0.04,
    onProgress,
  } = opts;

  const factor = Math.max(1, Math.floor(sampleRate / 11025));
  const y = decimate(x, factor);
  const dsr = sampleRate / factor;
  const tauMax = Math.ceil(dsr / fmin);
  const tauMin = Math.max(2, Math.floor(dsr / fmax));
  const W = Math.max(tauMax, Math.round(dsr * 0.02));
  const hop = Math.max(1, Math.round(hopSec * dsr));
  const realHop = hop / dsr;
  const nFrames = Math.max(0, Math.floor((y.length - W - tauMax) / hop) + 1);

  const rms = new Float32Array(nFrames);
  let maxRms = 0;
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    const st = f * hop;
    for (let j = 0; j < W; j++) s += y[st + j] * y[st + j];
    rms[f] = Math.sqrt(s / W);
    if (rms[f] > maxRms) maxRms = rms[f];
  }
  const gate = Math.max(1e-4, maxRms * 10 ** (silenceDb / 20));

  const f0 = new Float32Array(nFrames);
  const conf = new Float32Array(nFrames);
  const d = new Float64Array(tauMax + 2);
  const cm = new Float64Array(tauMax + 2);

  for (let f = 0; f < nFrames; f++) {
    if (f % 500 === 0) { onProgress?.(f / nFrames); await tick(); }
    if (rms[f] < gate) continue;
    const st = f * hop;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const diff = y[st + j] - y[st + j + tau];
        s += diff * diff;
      }
      d[tau] = s;
    }
    cm[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += d[tau];
      cm[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cm[t] < threshold) {
        while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) continue;
    const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
    const denom = a - 2 * b + c;
    let shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    if (shift > 1 || shift < -1) shift = 0;
    f0[f] = dsr / (tau + shift);
    conf[f] = 1 - b;
  }

  cleanUp(f0, Math.max(2, Math.round(minVoicedSec / realHop)));
  onProgress?.(1);
  return { t0: W / 2 / dsr, hopSec: realHop, f0, conf, sampleRate };
}

/** Remove tiny voiced blips and fix isolated octave jumps with a median filter. */
function cleanUp(f0, minRun) {
  const n = f0.length;
  let i = 0;
  while (i < n) {
    if (f0[i] <= 0) { i++; continue; }
    let j = i;
    while (j < n && f0[j] > 0) j++;
    if (j - i < minRun) f0.fill(0, i, j);
    else medianInPlace(f0, i, j, 2);
    i = j;
  }
}

function medianInPlace(f0, start, end, r) {
  const src = f0.slice(start, end);
  const buf = [];
  for (let i = 0; i < src.length; i++) {
    buf.length = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(src.length - 1, i + r); k++) buf.push(src[k]);
    buf.sort((p, q) => p - q);
    const med = buf[buf.length >> 1];
    // Only replace outliers (> ~a fifth away), keep natural vibrato/slides.
    if (Math.abs(12 * Math.log2(src[i] / med)) > 7) f0[start + i] = med;
  }
}
