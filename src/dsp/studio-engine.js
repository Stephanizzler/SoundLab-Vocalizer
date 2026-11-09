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
 */
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
  const refined = stoneMask(x, sampleRate, positions, f0);
  stage(0, 0.08)(1);
  const { spectrogram, fftSize } = cheapTrick(x, sampleRate, positions, refined, { onProgress: stage(0.08, 0.45) });

  // Aperiodicity changes slowly: analyse every `apStride` frames and interpolate.
  const cIdx = [];
  for (let i = 0; i < n; i += apStride) cIdx.push(i);
  if (cIdx[cIdx.length - 1] !== n - 1) cIdx.push(n - 1);
  const coarse = d4c(x, sampleRate, Float64Array.from(cIdx, (i) => positions[i]), Float64Array.from(cIdx, (i) => refined[i]), fftSize, { onProgress: stage(0.45, 1) });
  const half = fftSize / 2;
  const unvoicedAp = new Float64Array(half + 1).fill(1 - 1e-12);
  const aperiodicity = new Array(n);
  let c = 0;
  for (let i = 0; i < n; i++) {
    while (c + 1 < cIdx.length && cIdx[c + 1] <= i) c++;
    if (!(refined[i] > 0)) { aperiodicity[i] = unvoicedAp; continue; }
    const a = cIdx[c], b = cIdx[Math.min(cIdx.length - 1, c + 1)];
    const va = refined[a] > 0, vb = refined[b] > 0;
    if (a === i || !vb || b === a) { aperiodicity[i] = va ? coarse[c] : vb ? coarse[c + 1] : unvoicedAp; continue; }
    if (!va) { aperiodicity[i] = coarse[c + 1]; continue; }
    const w = (i - a) / (b - a);
    const A = coarse[c], B = coarse[c + 1];
    const out = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) out[k] = A[k] + (B[k] - A[k]) * w;
    aperiodicity[i] = out;
  }
  return { f0: refined, spectrogram, aperiodicity, fftSize, framePeriod, length: x.length, sampleRate };
}

/** Warp an envelope along frequency: factor > 1 moves formants up. */
function warpEnvelope(env, factor) {
  const n = env.length;
  const out = new Float64Array(n);
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
  const pad = Math.round(0.03 / fp); // 30 ms of context around each phrase
  const fadeLen = Math.round(0.02 * sr);
  const list = phrases(an.f0, Math.round(0.06 / fp));
  const used = new Set();
  list.forEach((ph, pi) => {
    let maxShift = 0;
    for (let i = ph.start; i < ph.end; i++) maxShift = Math.max(maxShift, Math.abs(shift[i]));
    if (maxShift < 0.005 && formant === 1) return; // untouched: keep the original
    const a = Math.max(0, ph.start - pad);
    const b = Math.min(nF, ph.end + pad);
    const key = hashF0(newF0, a, b, formant);
    used.add(key);
    let seg = cache?.get(key);
    if (!seg) {
      const sp = an.spectrogram.slice(a, b).map((e, k) => (formant !== 1 && an.f0[a + k] > 0 ? warpEnvelope(e, formant) : e));
      const len = Math.round((b - a) * fp * sr);
      seg = Float32Array.from(synthesis(newF0.slice(a, b), sp, an.aperiodicity.slice(a, b), an.fftSize, an.framePeriod, sr, len));
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
    onProgress?.((pi + 1) / list.length);
  });
  if (cache) for (const k of [...cache.keys()]) if (!used.has(k)) cache.delete(k);
  return out;
}
