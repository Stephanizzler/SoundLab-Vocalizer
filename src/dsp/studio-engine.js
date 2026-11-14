import { stoneMask, cheapTrick, d4c, synthesis } from './world.js';
import { hzToMidi } from './autotune.js';

/**
 * "Studio" pitch engine (WORLD vocoder).
 *
 * Analyse the take once into F0, spectral envelope and aperiodicity, then
 * re-synthesise sung phrases at the corrected pitch. The envelope is kept
 * (or warped for formant shifting), so the voice keeps its character while
 * the pitch moves, without the grain artefacts of time-domain shifting.
 *
 * Only phrases whose pitch actually changes are re-synthesised; everything
 * else (consonants, breaths, untouched phrases) is the original recording,
 * crossfaded in the gaps between notes.
 *
 * Memory: only frames inside sung phrases (plus a margin) are analysed and
 * kept, envelopes are float32, and aperiodicity is kept on a coarse grid and
 * interpolated per phrase when rendering. A 3-minute song needs ~100-200 MB.
 */
const PAD_SEC = 0.03; // context rendered around each phrase
const MARGIN_SEC = 0.05; // analysed around each phrase (must be >= PAD_SEC)

export function studioAnalyze(x, sampleRate, pitch, { framePeriod = 5, apStride = 3, onProgress } = {}) {
  const fp = framePeriod / 1000;
  const n = Math.floor(x.length / sampleRate / fp) + 1;
  const positions = new Float64Array(n);
  const f0 = new Float64Array(n);
  const { t0, hopSec, f0: track } = pitch;
  for (let i = 0; i < n; i++) {
    const t = i * fp;
    positions[i] = t;
    const pos = (t - t0) / hopSec;
    const a = Math.floor(pos), b = a + 1;
    const fa = a >= 0 && a < track.length ? track[a] : 0;
    const fb = b >= 0 && b < track.length ? track[b] : 0;
    if (fa > 0 && fb > 0) f0[i] = fa + (fb - fa) * (pos - a);
    else f0[i] = (pos - a < 0.5 ? fa : fb) || 0;
  }
  const stage = (from, to) => (p) => onProgress?.(from + (to - from) * p);

  // Frames worth analysing: sung phrases plus a margin.
  const list = phrases(f0, Math.round(0.06 / fp));
  const margin = Math.round(MARGIN_SEC / fp);
  const needed = [];
  for (const ph of list) {
    const a = Math.max(0, ph.start - margin), b = Math.min(n, ph.end + margin);
    for (let i = Math.max(a, needed.length ? needed[needed.length - 1] + 1 : 0); i < b; i++) needed.push(i);
  }
  const subPos = Float64Array.from(needed, (i) => positions[i]);
  const refinedSub = stoneMask(x, sampleRate, subPos, Float64Array.from(needed, (i) => f0[i]));
  const refined = new Float64Array(n);
  needed.forEach((i, k) => { refined[i] = refinedSub[k]; });
  stage(0, 0.08)(1);

  const { spectrogram: spSub, fftSize } = cheapTrick(x, sampleRate, subPos, refinedSub, { onProgress: stage(0.08, 0.45) });
  const spectrogram = new Array(n); // sparse: only analysed frames are filled
  needed.forEach((i, k) => { spectrogram[i] = spSub[k]; });

  // Aperiodicity changes slowly: analyse every `apStride` voiced frames.
  const apIdx = needed.filter((i) => i % apStride === 0 && refined[i] > 0);
  const apCoarse = d4c(x, sampleRate, Float64Array.from(apIdx, (i) => positions[i]), Float64Array.from(apIdx, (i) => refined[i]), fftSize, { onProgress: stage(0.45, 1) });
  // Re-detect phrases on the refined F0 so rendering uses exactly what was analysed.
  return {
    f0: refined, spectrogram, apIdx, apCoarse, fftSize, framePeriod, length: x.length, sampleRate,
    phrases: phrases(refined, Math.round(0.06 / fp)).filter((ph) => spectrogram[ph.start] && spectrogram[ph.end - 1]),
  };
}

/** Per-frame aperiodicity for frames a..b-1, interpolated from the coarse grid. */
function apSlice(an, a, b) {
  const half = an.fftSize / 2;
  const unvoiced = new Float32Array(half + 1).fill(1 - 1e-12);
  const { apIdx, apCoarse, f0 } = an;
  const out = [];
  let c = 0;
  while (c + 1 < apIdx.length && apIdx[c + 1] <= a) c++;
  for (let i = a; i < b; i++) {
    while (c + 1 < apIdx.length && apIdx[c + 1] <= i) c++;
    if (!(f0[i] > 0) || !apIdx.length) { out.push(unvoiced); continue; }
    const last = c + 1 >= apIdx.length;
    const ia = apIdx[c], ib = last ? ia : apIdx[c + 1];
    if (last || ia > i) { out.push(apCoarse[c]); continue; }
    if (ib - ia > 12) { out.push(apCoarse[i - ia <= ib - i ? c : c + 1]); continue; } // gap: nearest
    const w = (i - ia) / (ib - ia);
    const A = apCoarse[c], B = apCoarse[c + 1];
    const v = new Float32Array(half + 1);
    for (let k = 0; k <= half; k++) v[k] = A[k] + (B[k] - A[k]) * w;
    out.push(v);
  }
  return out;
}

/** Warp an envelope along frequency: factor > 1 moves formants up. */
function warpEnvelope(env, factor) {
  const n = env.length;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const src = k / factor;
    const i = Math.floor(src);
    out[k] = i + 1 < n ? env[i] + (env[i + 1] - env[i]) * (src - i) : env[n - 1];
  }
  return out;
}

/** Voiced phrases (frame ranges), merging gaps shorter than `minGap` frames. */
function phrases(f0, minGap) {
  const out = [];
  let i = 0;
  while (i < f0.length) {
    if (!(f0[i] > 0)) { i++; continue; }
    let j = i;
    while (j < f0.length && f0[j] > 0) j++;
    const last = out[out.length - 1];
    if (last && i - last.end < minGap) last.end = j; else out.push({ start: i, end: j });
    i = j;
  }
  return out;
}

function hashF0(arr, a, b, formant) {
  let h = 2166136261 ^ Math.round(formant * 1000);
  for (let i = a; i < b; i++) { h ^= Math.round(arr[i] * 100); h = Math.imul(h, 16777619); }
  return `${a}:${b}:${h >>> 0}`;
}

/**
 * Render the take at a new pitch.
 * x:         the original take (used outside re-synthesised phrases)
 * corrected: per-frame MIDI on the pitch-track grid (NaN = keep)
 * formant:   envelope scale for voiced frames (1 = natural)
 * cache:     optional Map reused between renders (phrase -> audio)
 */
export function studioRender(an, x, pitch, corrected, { formant = 1, cache = null, onProgress } = {}) {
  const fp = an.framePeriod / 1000;
  const sr = an.sampleRate;
  const { t0, hopSec, f0: track } = pitch;
  const nF = an.f0.length;
  const newF0 = new Float64Array(nF);
  const shift = new Float64Array(nF);
  for (let i = 0; i < nF; i++) {
    if (!(an.f0[i] > 0)) continue;
    const fi = Math.round((i * fp - t0) / hopSec);
    let s = 0;
    if (fi >= 0 && fi < track.length && track[fi] > 0 && !Number.isNaN(corrected[fi])) s = corrected[fi] - hzToMidi(track[fi]);
    shift[i] = s;
    newF0[i] = an.f0[i] * 2 ** (s / 12);
  }
  const out = Float32Array.from(x);
  const pad = Math.round(PAD_SEC / fp);
  const fadeLen = Math.round(0.02 * sr);
  const used = new Set();
  an.phrases.forEach((ph, pi) => {
    let maxShift = 0;
    for (let i = ph.start; i < ph.end; i++) maxShift = Math.max(maxShift, Math.abs(shift[i]));
    if (maxShift < 0.005 && formant === 1) return; // untouched: keep the original
    let a = Math.max(0, ph.start - pad);
    let b = Math.min(nF, ph.end + pad);
    while (!an.spectrogram[a]) a++;
    while (!an.spectrogram[b - 1]) b--;
    const key = hashF0(newF0, a, b, formant);
    used.add(key);
    let seg = cache?.get(key);
    if (!seg) {
      const sp = [];
      for (let i = a; i < b; i++) sp.push(formant !== 1 && an.f0[i] > 0 ? warpEnvelope(an.spectrogram[i], formant) : an.spectrogram[i]);
      const len = Math.round((b - a) * fp * sr);
      seg = Float32Array.from(synthesis(newF0.slice(a, b), sp, apSlice(an, a, b), an.fftSize, an.framePeriod, sr, len));
      cache?.set(key, seg);
    }
    const s0 = Math.round(a * fp * sr);
    const fadeIn = a > 0 ? fadeLen : 0;
    const fadeOut = b < nF ? fadeLen : 0;
    for (let j = 0; j < seg.length && s0 + j < out.length; j++) {
      let w = 1;
      if (j < fadeIn) w = j / fadeIn;
      else if (j > seg.length - fadeOut) w = (seg.length - j) / fadeOut;
      out[s0 + j] = x[s0 + j] * (1 - w) + seg[j] * w;
    }
    onProgress?.((pi + 1) / an.phrases.length);
  });
  if (cache) for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
  return out;
}
