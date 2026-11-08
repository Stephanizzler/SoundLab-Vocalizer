import { fft } from './fft.js';

/**
 * Generate a stereo room impulse response.
 *  decay:     RT60 in seconds (how long the tail rings)
 *  size:      0..1 room size (spacing of early reflections)
 *  preDelayMs gap before the reverb starts
 *  damping:   0..1, how fast highs die away (soft furnishings vs. stone)
 *  width:     0..1 stereo spread of the tail
 *  direction: -1 (left) .. 0 (front) .. 1 (right): where the room "sounds"
 *  early:     0..1 level of discrete early reflections
 */
export function makeImpulse(sampleRate, opts = {}) {
  const {
    decay = 1.5, size = 0.5, preDelayMs = 20, damping = 0.4, width = 0.8, direction = 0, early = 0.5, seed = 1,
  } = opts;
  const len = Math.round((preDelayMs / 1000 + decay * 1.1 + 0.05) * sampleRate);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2147483648 - 1; };
  const pre = Math.round((preDelayMs / 1000) * sampleRate);
  const dir = Math.max(-1, Math.min(1, direction));
  const ang = ((dir + 1) * Math.PI) / 4;
  const gL = Math.cos(ang) * Math.SQRT2;
  const gR = Math.sin(ang) * Math.SQRT2;

  // Early reflections: sparse taps; the side the sound comes from hears them first.
  const nEarly = 10;
  const spread = (0.008 + size * 0.07) * sampleRate;
  for (let k = 0; k < nEarly; k++) {
    const t = pre + Math.round(((k + 1) / nEarly) * spread * (0.6 + 0.4 * Math.abs(rnd())));
    const amp = early * 0.9 * (1 - k / (nEarly + 2)) * (rnd() > 0 ? 1 : -1);
    const haas = Math.round(Math.abs(dir) * 0.0007 * sampleRate);
    const tl = t + (dir > 0 ? haas : 0);
    const tr = t + (dir < 0 ? haas : 0);
    if (tl < len) L[tl] += amp * gL * (k % 2 === 0 ? 1 : 0.6 + 0.4 * (1 - width));
    if (tr < len) R[tr] += amp * gR * (k % 2 === 1 ? 1 : 0.6 + 0.4 * (1 - width));
  }

  // Diffuse tail: decaying noise, low-passed more and more over time.
  const tailStart = pre + Math.round(spread * 0.4);
  const k60 = Math.log(1000) / (decay * sampleRate);
  let lpL = 0, lpR = 0;
  for (let i = tailStart; i < len; i++) {
    const t = i - tailStart;
    const envAmp = Math.exp(-k60 * t) * Math.min(1, t / (0.01 * sampleRate));
    const nl = rnd();
    const nr = width * rnd() + (1 - width) * nl;
    const cutoff = 12000 * Math.exp(-damping * 4 * (t / sampleRate) / Math.max(0.2, decay)) + 400;
    const k = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate);
    lpL += (nl - lpL) * k;
    lpR += (nr - lpR) * k;
    L[i] += lpL * envAmp * gL;
    R[i] += lpR * envAmp * gR;
  }
  // Normalise energy so presets have comparable loudness.
  let e = 0;
  for (let i = 0; i < len; i++) e += L[i] * L[i] + R[i] * R[i];
  const g = e > 0 ? 1 / Math.sqrt(e / 2) : 0;
  for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; }
  return [L, R];
}

/**
 * FFT overlap-add convolution of a mono signal with a stereo IR.
 * The IR pair is packed into one complex spectrum (hL + i*hR), so one
 * forward and one inverse FFT per block give both output channels.
 */
export function convolveStereo(x, hL, hR) {
  const M = hL.length;
  let N = 1;
  while (N < 4 * M) N <<= 1;
  N = Math.max(N, 8192);
  const B = N - M + 1;
  const Hre = new Float64Array(N);
  const Him = new Float64Array(N);
  Hre.set(hL); Him.set(hR);
  fft(Hre, Him);
  const outLen = x.length + M - 1;
  const outL = new Float32Array(outLen);
  const outR = new Float32Array(outLen);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let start = 0; start < x.length; start += B) {
    re.fill(0); im.fill(0);
    const end = Math.min(x.length, start + B);
    for (let i = start; i < end; i++) re[i - start] = x[i];
    fft(re, im);
    for (let k = 0; k < N; k++) {
      const a = re[k], b = im[k];
      re[k] = a * Hre[k] - b * Him[k];
      im[k] = a * Him[k] + b * Hre[k];
    }
    fft(re, im, true);
    const lim = Math.min(N, outLen - start);
    for (let j = 0; j < lim; j++) { outL[start + j] += re[j]; outR[start + j] += im[j]; }
  }
  return [outL, outR];
}

/** Stereo reverb (send style): output = dry + mix * wet. */
export function reverb([inL, inR], sampleRate, opts = {}) {
  const { mix = 0.25, lowCut = 200 } = opts;
  const n = inL.length;
  const send = new Float32Array(n);
  // High-pass the send so the low end stays clean.
  const k = 1 - Math.exp((-2 * Math.PI * lowCut) / sampleRate);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const x = (inL[i] + inR[i]) * 0.5;
    lp += (x - lp) * k;
    send[i] = x - lp;
  }
  const [hL, hR] = makeImpulse(sampleRate, opts);
  const [wL, wR] = convolveStereo(send, hL, hR);
  const len = wL.length;
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  const g = mix * 0.5;
  for (let i = 0; i < len; i++) {
    outL[i] = (i < n ? inL[i] : 0) + wL[i] * g;
    outR[i] = (i < n ? inR[i] : 0) + wR[i] * g;
  }
  return [outL, outR];
}
