// JavaScript port of the core of WORLD (StoneMask, CheapTrick, D4C, Synthesis)
// by M. Morise, used for SoundLab's high-quality "Studio" pitch engine.
// https://github.com/mmorise/World
//
// ----------------------------------------------------------------------------
// WORLD: High-quality speech analysis, manipulation and synthesis system
// developed by M. Morise
//
// Copyright (c) 2010  M. Morise
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// - Redistributions of source code must retain the above copyright notice,
//   this list of conditions and the following disclaimer.
// - Redistributions in binary form must reproduce the above copyright notice,
//   this list of conditions and the following disclaimer in the documentation
//   and/or other materials provided with the distribution.
// - Neither the name of the M. Morise nor the names of its contributors may be
//   used to endorse or promote products derived from this software without
//   specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.
// ----------------------------------------------------------------------------
//
// Port notes: the FFTs follow FFTW conventions (forward e^-i, unnormalised
// c2r inverse) exactly as WORLD's own fft wrapper does, so the maths below
// mirrors the C++ line by line.

import { fft } from './fft.js';

const kPi = Math.PI;
const kMySafeGuardMinimum = 1e-12;
const kEps = 2.220446049250313e-16;
const kFloorF0 = 71.0;
const kDefaultF0 = 500.0;
const kFloorF0StoneMask = 40.0;
const kFrequencyInterval = 3000.0;
const kUpperLimit = 15000.0;
const kThreshold = 0.85;
const kFloorF0D4C = 47.0;
const kSafeGuardD4C = 0.000001;
const kHanning = 1;
const kBlackman = 2;

const mround = (x) => (x > 0 ? Math.trunc(x + 0.5) : Math.trunc(x - 0.5));

// ---------------------------------------------------------------- randn
class Randn {
  constructor() { this.reseed(); }
  reseed() { this.x = 123456789; this.y = 362436069; this.z = 521288629; this.w = 88675123; }
  step() {
    const t = (this.x ^ (this.x << 11)) >>> 0;
    this.x = this.y; this.y = this.z; this.z = this.w;
    this.w = ((this.w ^ (this.w >>> 19)) ^ (t ^ (t >>> 8))) >>> 0;
  }
  next() {
    this.step();
    let tmp = this.w >>> 4;
    for (let i = 0; i < 11; i++) { this.step(); tmp += this.w >>> 4; }
    return tmp / 268435456.0 - 6.0;
  }
}

// ---------------------------------------------------------------- FFT helpers
class RealFFT {
  // Real FFT of size n computed with one complex FFT of size n/2.
  constructor(n) {
    this.n = n;
    this.waveform = new Float64Array(n);
    this.specRe = new Float64Array(n / 2 + 1);
    this.specIm = new Float64Array(n / 2 + 1);
    const h = n / 2;
    this.zr = new Float64Array(h);
    this.zi = new Float64Array(h);
    this.cos = new Float64Array(h + 1);
    this.sin = new Float64Array(h + 1);
    for (let k = 0; k <= h; k++) { this.cos[k] = Math.cos((2 * kPi * k) / n); this.sin[k] = Math.sin((2 * kPi * k) / n); }
  }
  /** waveform -> spec (r2c, e^-i, unnormalised). */
  forward() {
    const { n, zr, zi, waveform: x } = this;
    const h = n / 2;
    for (let k = 0; k < h; k++) { zr[k] = x[2 * k]; zi[k] = x[2 * k + 1]; }
    fft(zr, zi);
    for (let k = 0; k <= h; k++) {
      const a = k % h, b = (h - k) % h;
      const zkr = zr[a], zki = zi[a], zcr = zr[b], zci = -zi[b]; // Z[k], conj(Z[h-k])
      const er = (zkr + zcr) / 2, ei = (zki + zci) / 2; // even part
      const odr = (zki - zci) / 2, odi = -(zkr - zcr) / 2; // (Z - conjZ) / 2i
      const c = this.cos[k], s = this.sin[k]; // e^{-i theta} = c - i s
      this.specRe[k] = er + odr * c + odi * s;
      this.specIm[k] = ei + odi * c - odr * s;
    }
    this.specIm[0] = 0; this.specIm[h] = 0;
  }
  /** spec -> waveform (c2r, unnormalised, like FFTW). */
  inverse() {
    const { n, zr, zi, specRe: R, specIm: I } = this;
    const h = n / 2;
    for (let k = 0; k < h; k++) {
      const xr = R[k], xi = k === 0 ? 0 : I[k];
      const cr = R[h - k], ci = h - k === h ? 0 : -I[h - k]; // conj(X[h-k])
      const er = (xr + cr) / 2, ei = (xi + ci) / 2;
      const dr = (xr - cr) / 2, di = (xi - ci) / 2;
      const c = this.cos[k], s = this.sin[k]; // e^{+i theta} = c + i s
      const or = dr * c - di * s, oi = dr * s + di * c;
      zr[k] = er - oi; // Z = E + i*O
      zi[k] = ei + or;
    }
    fft(zr, zi, true);
    for (let k = 0; k < h; k++) { this.waveform[2 * k] = zr[k] * n; this.waveform[2 * k + 1] = zi[k] * n; }
  }
}

/** Minimum-phase spectrum from a log-amplitude spectrum (0..n/2). */
class MinimumPhase {
  constructor(n) {
    this.n = n;
    this.logSpectrum = new Float64Array(n);
    this.outRe = new Float64Array(n / 2 + 1);
    this.outIm = new Float64Array(n / 2 + 1);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }
  compute() {
    const { n, re, im, logSpectrum } = this;
    for (let i = n / 2 + 1; i < n; i++) logSpectrum[i] = logSpectrum[n - i];
    re.set(logSpectrum); im.fill(0);
    fft(re, im); // cepstrum (times n)
    im[0] *= -1;
    for (let i = 1; i < n / 2; i++) { re[i] *= 2; im[i] *= -2; }
    im[n / 2] *= -1;
    for (let i = n / 2 + 1; i < n; i++) { re[i] = 0; im[i] = 0; }
    // WORLD's c2c forward == standard DFT of the conjugate.
    for (let i = 0; i < n; i++) im[i] = -im[i];
    fft(re, im);
    for (let i = 0; i <= n / 2; i++) {
      const tmp = Math.exp(re[i] / n);
      this.outRe[i] = tmp * Math.cos(im[i] / n);
      this.outIm[i] = tmp * Math.sin(im[i] / n);
    }
  }
}

// ---------------------------------------------------------------- matlab-ish
function histc(x, xLength, edges, edgesLength, index) {
  let count = 1;
  let i = 0;
  for (; i < edgesLength; ++i) {
    index[i] = 1;
    if (edges[i] >= x[0]) break;
  }
  for (; i < edgesLength; ++i) {
    if (edges[i] < x[count]) index[i] = count;
    else { index[i--] = count++; }
    if (count === xLength) break;
  }
  count--;
  for (i++; i < edgesLength; ++i) index[i] = count;
}

function interp1(x, y, xLength, xi, xiLength, yi) {
  const k = new Int32Array(xiLength);
  histc(x, xLength, xi, xiLength, k);
  for (let i = 0; i < xiLength; i++) {
    const h = x[k[i]] - x[k[i] - 1];
    const s = (xi[i] - x[k[i] - 1]) / h;
    yi[i] = y[k[i] - 1] + s * (y[k[i]] - y[k[i] - 1]);
  }
}

function interp1Q(x, shift, y, xLength, xi, xiLength, yi) {
  const deltaY = new Float64Array(xLength);
  for (let i = 0; i < xLength - 1; i++) deltaY[i] = y[i + 1] - y[i];
  deltaY[xLength - 1] = 0;
  for (let i = 0; i < xiLength; i++) {
    const pos = (xi[i] - x) / shift;
    const base = Math.trunc(pos);
    yi[i] = y[base] + deltaY[base] * (pos - base);
  }
}

function dcCorrection(input, f0, fs, fftSize) {
  const upperLimit = 2 + Math.trunc((f0 * fftSize) / fs);
  const axis = new Float64Array(upperLimit);
  for (let i = 0; i < upperLimit; i++) axis[i] = (i * fs) / fftSize;
  const upperLimitReplica = upperLimit - 1;
  const replica = new Float64Array(upperLimitReplica);
  interp1Q(f0 - axis[0], -fs / fftSize, input, upperLimit + 1, axis, upperLimitReplica, replica);
  for (let i = 0; i < upperLimitReplica; i++) input[i] += replica[i];
}

function linearSmoothing(input, width, fs, fftSize, output) {
  const boundary = Math.trunc((width * fftSize) / fs) + 1;
  const half = fftSize / 2;
  const len = half + boundary * 2 + 1;
  const mirroring = new Float64Array(len);
  const segment = new Float64Array(len);
  const freqAxis = new Float64Array(half + 1);
  for (let i = 0; i < boundary; i++) mirroring[i] = input[boundary - i];
  for (let i = boundary; i < half + boundary; i++) mirroring[i] = input[i - boundary];
  for (let i = half + boundary; i <= half + boundary * 2; i++) mirroring[i] = input[half - (i - (half + boundary))];
  segment[0] = (mirroring[0] * fs) / fftSize;
  for (let i = 1; i < len; i++) segment[i] = (mirroring[i] * fs) / fftSize + segment[i - 1];
  for (let i = 0; i <= half; i++) freqAxis[i] = (i / fftSize) * fs - width / 2;
  const low = new Float64Array(half + 1);
  const high = new Float64Array(half + 1);
  const origin = (-(boundary - 0.5) * fs) / fftSize;
  const interval = fs / fftSize;
  interp1Q(origin, interval, segment, len, freqAxis, half + 1, low);
  for (let i = 0; i <= half; i++) freqAxis[i] += width;
  interp1Q(origin, interval, segment, len, freqAxis, half + 1, high);
  for (let i = 0; i <= half; i++) output[i] = (high[i] - low[i]) / width;
}

function nuttallWindow(n) {
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    y[i] = 0.355768 - 0.487396 * Math.cos(2 * kPi * t) + 0.144232 * Math.cos(4 * kPi * t) - 0.012604 * Math.cos(6 * kPi * t);
  }
  return y;
}

// ---------------------------------------------------------------- StoneMask
function stoneMaskOne(x, fs, position, initialF0) {
  if (initialF0 <= kFloorF0StoneMask || initialF0 > fs / 12.0) return 0;
  const halfWindowLength = Math.trunc((1.5 * fs) / initialF0 + 1.0);
  const L = halfWindowLength * 2 + 1;
  const windowLengthInTime = L / fs;
  const fftSize = 2 ** (2 + Math.trunc(Math.log(L) / Math.LN2));
  const indexRaw = new Int32Array(L);
  const mainWindow = new Float64Array(L);
  const diffWindow = new Float64Array(L);
  for (let i = 0; i < L; i++) indexRaw[i] = mround((position + (-halfWindowLength + i) / fs) * fs);
  for (let i = 0; i < L; i++) {
    const tmp = (indexRaw[i] - 1.0) / fs - position;
    mainWindow[i] = 0.42 + 0.5 * Math.cos((2 * kPi * tmp) / windowLengthInTime) + 0.08 * Math.cos((4 * kPi * tmp) / windowLengthInTime);
  }
  diffWindow[0] = -mainWindow[1] / 2;
  for (let i = 1; i < L - 1; i++) diffWindow[i] = -(mainWindow[i + 1] - mainWindow[i - 1]) / 2;
  diffWindow[L - 1] = mainWindow[L - 2] / 2;

  const f = new RealFFT(fftSize);
  const idx = (i) => Math.max(0, Math.min(x.length - 1, indexRaw[i] - 1));
  f.waveform.fill(0);
  for (let i = 0; i < L; i++) f.waveform[i] = x[idx(i)] * mainWindow[i];
  f.forward();
  const mRe = f.specRe.slice(), mIm = f.specIm.slice();
  f.waveform.fill(0);
  for (let i = 0; i < L; i++) f.waveform[i] = x[idx(i)] * diffWindow[i];
  f.forward();
  const half = fftSize / 2;
  const power = new Float64Array(half + 1);
  const numI = new Float64Array(half + 1);
  for (let j = 0; j <= half; j++) {
    numI[j] = mRe[j] * f.specIm[j] - mIm[j] * f.specRe[j];
    power[j] = mRe[j] * mRe[j] + mIm[j] * mIm[j];
  }
  const fixF0 = (f0, harmonics) => {
    let num = 0, den = 0;
    for (let i = 0; i < harmonics; i++) {
      const index = Math.min(mround(((f0 * fftSize) / fs) * (i + 1)), half);
      const inst = power[index] === 0 ? 0 : (index * fs) / fftSize + ((numI[index] / power[index]) * fs) / 2 / kPi;
      const amp = Math.sqrt(power[index]);
      num += amp * inst;
      den += amp * (i + 1);
    }
    return num / (den + kMySafeGuardMinimum);
  };
  let mean = fixF0(initialF0, 2);
  mean = mean <= 0 || mean > initialF0 * 2 ? 0 : fixF0(mean, 6);
  if (Math.abs(mean - initialF0) > initialF0 * 0.2) mean = initialF0;
  return mean;
}

export function stoneMask(x, fs, positions, f0) {
  const out = new Float64Array(f0.length);
  for (let i = 0; i < f0.length; i++) out[i] = stoneMaskOne(x, fs, positions[i], f0[i]);
  return out;
}

// ---------------------------------------------------------------- CheapTrick
export function getFFTSizeForCheapTrick(fs, f0Floor = kFloorF0) {
  return 2 ** (1 + Math.trunc(Math.log((3.0 * fs) / f0Floor + 1) / Math.LN2));
}

export function cheapTrick(x, fs, positions, f0, { fftSize = getFFTSizeForCheapTrick(fs), q1 = -0.15, onProgress } = {}) {
  const randn = new Randn();
  const f0Floor = (3.0 * fs) / (fftSize - 3.0);
  const half = fftSize / 2;
  const fwd = new RealFFT(fftSize);
  const inv = new RealFFT(fftSize);
  const smoothingLifter = new Float64Array(half + 1);
  const spectrogram = [];
  const power = new Float64Array(half + 1);
  for (let fr = 0; fr < f0.length; fr++) {
    const currentF0 = f0[fr] <= f0Floor ? kDefaultF0 : f0[fr];
    // F0-adaptive windowing
    const hw = mround((1.5 * fs) / currentF0);
    const origin = mround(positions[fr] * fs + 0.001);
    const wf = fwd.waveform;
    wf.fill(0);
    let avg = 0;
    const win = new Float64Array(hw * 2 + 1);
    for (let i = 0; i <= hw * 2; i++) {
      const position = (i - hw) / 1.5 / fs;
      win[i] = 0.5 * Math.cos(kPi * position * currentF0) + 0.5;
      avg += win[i] * win[i];
    }
    avg = Math.sqrt(avg);
    let w1 = 0, w2 = 0;
    for (let i = 0; i <= hw * 2; i++) {
      win[i] /= avg;
      const si = Math.min(x.length - 1, Math.max(0, origin + i - hw));
      wf[i] = x[si] * win[i] + randn.next() * kMySafeGuardMinimum;
      w1 += wf[i]; w2 += win[i];
    }
    const wc = w1 / w2;
    for (let i = 0; i <= hw * 2; i++) wf[i] -= win[i] * wc;
    // Power spectrum with DC correction
    fwd.forward();
    for (let i = 0; i <= half; i++) power[i] = fwd.specRe[i] * fwd.specRe[i] + fwd.specIm[i] * fwd.specIm[i];
    dcCorrection(power, currentF0, fs, fftSize);
    linearSmoothing(power, (currentF0 * 2.0) / 3.0, fs, fftSize, power);
    for (let i = 0; i <= half; i++) power[i] += Math.abs(randn.next()) * kEps;
    // Smoothing (log) and recovery in the cepstrum domain
    for (let i = 0; i <= half; i++) wf[i] = Math.log(power[i]);
    for (let i = 1; i < half; i++) wf[fftSize - i] = wf[i];
    fwd.forward();
    smoothingLifter[0] = 1;
    for (let i = 0; i <= half; i++) {
      let s = 1, c = (1.0 - 2.0 * q1) + 2.0 * q1;
      if (i > 0) {
        const q = i / fs;
        s = Math.sin(kPi * currentF0 * q) / (kPi * currentF0 * q);
        c = (1.0 - 2.0 * q1) + 2.0 * q1 * Math.cos(2.0 * kPi * q * currentF0);
      }
      inv.specRe[i] = (fwd.specRe[i] * s * c) / fftSize;
      inv.specIm[i] = 0;
    }
    inv.inverse();
    const env = new Float64Array(half + 1);
    for (let i = 0; i <= half; i++) env[i] = Math.exp(inv.waveform[i]);
    spectrogram.push(env);
    if (onProgress && fr % 200 === 0) onProgress(fr / f0.length);
  }
  return { spectrogram, fftSize };
}

// ---------------------------------------------------------------- D4C
function d4cWindowed(x, fs, currentF0, position, windowType, ratio, waveform, randn) {
  const hw = mround((ratio * fs) / currentF0 / 2.0);
  const origin = mround(position * fs + 0.001);
  const n = hw * 2 + 1;
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = ((2.0 * (i - hw)) / ratio) / fs;
    win[i] = windowType === kHanning
      ? 0.5 * Math.cos(kPi * p * currentF0) + 0.5
      : 0.42 + 0.5 * Math.cos(kPi * p * currentF0) + 0.08 * Math.cos(kPi * p * currentF0 * 2);
  }
  let w1 = 0, w2 = 0;
  for (let i = 0; i < n; i++) {
    const si = Math.min(x.length - 1, Math.max(0, origin + i - hw));
    waveform[i] = x[si] * win[i] + randn.next() * kSafeGuardD4C;
    w1 += waveform[i]; w2 += win[i];
  }
  const wc = w1 / w2;
  for (let i = 0; i < n; i++) waveform[i] -= win[i] * wc;
}

function getCentroid(x, fs, f0, fftSize, position, f, centroid, randn) {
  f.waveform.fill(0);
  d4cWindowed(x, fs, f0, position, kBlackman, 4.0, f.waveform, randn);
  const lim = mround((2.0 * fs) / f0) * 2;
  let power = 0;
  for (let i = 0; i <= lim; i++) power += f.waveform[i] * f.waveform[i];
  const sp = Math.sqrt(power);
  for (let i = 0; i <= lim; i++) f.waveform[i] /= sp;
  f.forward();
  const half = fftSize / 2;
  const tr = f.specRe.slice(), ti = f.specIm.slice();
  for (let i = 0; i < fftSize; i++) f.waveform[i] *= i + 1.0;
  f.forward();
  for (let i = 0; i <= half; i++) centroid[i] = f.specRe[i] * tr[i] + ti[i] * f.specIm[i];
}

export { RealFFT as _RealFFT };

export function d4c(x, fs, positions, f0, fftSize, { threshold = kThreshold, onProgress } = {}) {
  const randn = new Randn();
  const half = fftSize / 2;
  const aperiodicity = [];
  for (let i = 0; i < f0.length; i++) aperiodicity.push(new Float64Array(half + 1).fill(1.0 - kMySafeGuardMinimum));

  const fftSizeD4C = 2 ** (1 + Math.trunc(Math.log((4.0 * fs) / kFloorF0D4C + 1) / Math.LN2));
  const f = new RealFFT(fftSizeD4C);
  const halfD = fftSizeD4C / 2;
  const nAp = Math.trunc(Math.min(kUpperLimit, fs / 2.0 - kFrequencyInterval) / kFrequencyInterval);
  const windowLength = Math.trunc((kFrequencyInterval * fftSizeD4C) / fs) * 2 + 1;
  const window = nuttallWindow(windowLength);

  // Love train: VUV-like check from the energy ratio below 4 kHz / below 7.9 kHz.
  const lowestF0 = 40.0;
  const fftSizeLT = 2 ** (1 + Math.trunc(Math.log((3.0 * fs) / lowestF0 + 1) / Math.LN2));
  const fLT = new RealFFT(fftSizeLT);
  const b0 = Math.ceil((100.0 * fftSizeLT) / fs);
  const b1 = Math.ceil((4000.0 * fftSizeLT) / fs);
  const b2 = Math.ceil((7900.0 * fftSizeLT) / fs);
  const ap0 = new Float64Array(f0.length);
  const psLT = new Float64Array(fftSizeLT);
  for (let i = 0; i < f0.length; i++) {
    if (f0[i] === 0) { ap0[i] = 0; continue; }
    const cf0 = Math.max(f0[i], lowestF0);
    const wl = mround((1.5 * fs) / cf0) * 2 + 1;
    fLT.waveform.fill(0);
    d4cWindowed(x, fs, cf0, positions[i], kBlackman, 3.0, fLT.waveform, randn);
    for (let k = wl; k < fftSizeLT; k++) fLT.waveform[k] = 0;
    fLT.forward();
    psLT.fill(0);
    for (let k = b0 + 1; k < fftSizeLT / 2 + 1; k++) psLT[k] = fLT.specRe[k] * fLT.specRe[k] + fLT.specIm[k] * fLT.specIm[k];
    for (let k = b0; k <= b2; k++) psLT[k] += psLT[k - 1];
    ap0[i] = psLT[b1] / psLT[b2];
  }

  const coarseAp = new Float64Array(nAp + 2);
  coarseAp[0] = -60.0;
  coarseAp[nAp + 1] = -kMySafeGuardMinimum;
  const coarseAxis = new Float64Array(nAp + 2);
  for (let i = 0; i <= nAp; i++) coarseAxis[i] = i * kFrequencyInterval;
  coarseAxis[nAp + 1] = fs / 2.0;
  const freqAxis = new Float64Array(half + 1);
  for (let i = 0; i <= half; i++) freqAxis[i] = (i * fs) / fftSize;

  const c1 = new Float64Array(halfD + 1), c2 = new Float64Array(halfD + 1);
  const staticCentroid = new Float64Array(halfD + 1);
  const smoothedPower = new Float64Array(halfD + 1);
  const sgd = new Float64Array(halfD + 1);
  const smoothedGd = new Float64Array(halfD + 1);
  const psCoarse = new Float64Array(halfD + 1);
  const boundary = mround((fftSizeD4C * 8.0) / windowLength);
  const hwl = Math.trunc(windowLength / 2);

  for (let i = 0; i < f0.length; i++) {
    if (f0[i] === 0 || ap0[i] <= threshold) continue;
    const cf0 = Math.max(kFloorF0D4C, f0[i]);
    const pos = positions[i];
    // Static centroid
    getCentroid(x, fs, cf0, fftSizeD4C, pos - 0.25 / cf0, f, c1, randn);
    getCentroid(x, fs, cf0, fftSizeD4C, pos + 0.25 / cf0, f, c2, randn);
    for (let k = 0; k <= halfD; k++) staticCentroid[k] = c1[k] + c2[k];
    dcCorrection(staticCentroid, cf0, fs, fftSizeD4C);
    // Smoothed power spectrum
    f.waveform.fill(0);
    d4cWindowed(x, fs, cf0, pos, kHanning, 4.0, f.waveform, randn);
    f.forward();
    for (let k = 0; k <= halfD; k++) smoothedPower[k] = f.specRe[k] * f.specRe[k] + f.specIm[k] * f.specIm[k];
    dcCorrection(smoothedPower, cf0, fs, fftSizeD4C);
    linearSmoothing(smoothedPower, cf0, fs, fftSizeD4C, smoothedPower);
    // Static group delay
    for (let k = 0; k <= halfD; k++) sgd[k] = staticCentroid[k] / smoothedPower[k];
    linearSmoothing(sgd, cf0 / 2.0, fs, fftSizeD4C, sgd);
    linearSmoothing(sgd, cf0, fs, fftSizeD4C, smoothedGd);
    for (let k = 0; k <= halfD; k++) sgd[k] -= smoothedGd[k];
    // Coarse aperiodicity
    f.waveform.fill(0);
    for (let b = 0; b < nAp; b++) {
      const center = Math.trunc((kFrequencyInterval * (b + 1) * fftSizeD4C) / fs);
      for (let j = 0; j <= hwl * 2; j++) f.waveform[j] = sgd[center - hwl + j] * window[j];
      f.forward();
      for (let j = 0; j <= halfD; j++) psCoarse[j] = f.specRe[j] * f.specRe[j] + f.specIm[j] * f.specIm[j];
      psCoarse.sort();
      for (let j = 1; j <= halfD; j++) psCoarse[j] += psCoarse[j - 1];
      const v = 10 * Math.log10(psCoarse[halfD - boundary - 1] / psCoarse[halfD]);
      coarseAp[b + 1] = Math.min(0.0, v + (cf0 - 100) / 50.0);
    }
    const ap = aperiodicity[i];
    interp1(coarseAxis, coarseAp, nAp + 2, freqAxis, half + 1, ap);
    for (let k = 0; k <= half; k++) ap[k] = 10 ** (ap[k] / 20.0);
    if (onProgress && i % 100 === 0) onProgress(i / f0.length);
  }
  return aperiodicity;
}

// ---------------------------------------------------------------- Synthesis
const safeAp = (x) => Math.max(0.001, Math.min(0.999999999999, x));

export function synthesis(f0, spectrogram, aperiodicity, fftSize, framePeriodMs, fs, yLength, { onProgress } = {}) {
  const randn = new Randn();
  const y = new Float64Array(yLength);
  const half = fftSize / 2;
  const mp = new MinimumPhase(fftSize);
  const inv = new RealFFT(fftSize);
  const fwd = new RealFFT(fftSize);
  const f0Length = f0.length;
  const fp = framePeriodMs / 1000.0;
  const lowestF0 = fs / fftSize + 1.0;

  // --- time base: pulse locations from the integrated F0
  const coarseTime = new Float64Array(f0Length + 1);
  const coarseF0 = new Float64Array(f0Length + 1);
  const coarseVuv = new Float64Array(f0Length + 1);
  for (let i = 0; i < f0Length; i++) {
    coarseTime[i] = i * fp;
    coarseF0[i] = f0[i] < lowestF0 ? 0.0 : f0[i];
    coarseVuv[i] = coarseF0[i] === 0 ? 0.0 : 1.0;
  }
  coarseTime[f0Length] = f0Length * fp;
  coarseF0[f0Length] = coarseF0[f0Length - 1] * 2 - coarseF0[f0Length - 2];
  coarseVuv[f0Length] = coarseVuv[f0Length - 1] * 2 - coarseVuv[f0Length - 2];
  const timeAxis = new Float64Array(yLength);
  for (let i = 0; i < yLength; i++) timeAxis[i] = i / fs;
  const iF0 = new Float64Array(yLength);
  const iVuv = new Float64Array(yLength);
  interp1(coarseTime, coarseF0, f0Length + 1, timeAxis, yLength, iF0);
  interp1(coarseTime, coarseVuv, f0Length + 1, timeAxis, yLength, iVuv);
  for (let i = 0; i < yLength; i++) {
    iVuv[i] = iVuv[i] > 0.5 ? 1.0 : 0.0;
    iF0[i] = iVuv[i] === 0 ? kDefaultF0 : iF0[i];
  }
  const pulseIndex = [];
  const pulseShift = [];
  let total = (2.0 * kPi * iF0[0]) / fs;
  let prevWrap = total % (2.0 * kPi);
  for (let i = 1; i < yLength; i++) {
    total += (2.0 * kPi * iF0[i]) / fs;
    const wrap = total % (2.0 * kPi);
    if (Math.abs(wrap - prevWrap) > kPi) {
      const y1 = prevWrap - 2.0 * kPi;
      const y2 = wrap;
      pulseIndex.push(i - 1);
      pulseShift.push(-y1 / (y2 - y1) / fs);
    }
    prevWrap = wrap;
  }

  // --- DC remover
  const dcRemover = new Float64Array(fftSize);
  let dcSum = 0;
  for (let i = 0; i < half; i++) {
    dcRemover[i] = 0.5 - 0.5 * Math.cos((2.0 * kPi * (i + 1.0)) / (1.0 + fftSize));
    dcRemover[fftSize - i - 1] = dcRemover[i];
    dcSum += dcRemover[i] * 2.0;
  }
  for (let i = 0; i < half; i++) { dcRemover[i] /= dcSum; dcRemover[fftSize - i - 1] = dcRemover[i]; }

  const env = new Float64Array(half + 1);
  const apr = new Float64Array(half + 1);
  const periodic = new Float64Array(fftSize);
  const aperiodic = new Float64Array(fftSize);
  const nP = pulseIndex.length;
  for (let p = 0; p < nP; p++) {
    const idx = pulseIndex[p];
    const noiseSize = pulseIndex[Math.min(nP - 1, p + 1)] - idx;
    const t = idx / fs;
    const vuv = iVuv[idx];
    // Interpolated envelope and aperiodicity
    const ff = Math.min(f0Length - 1, Math.floor(t / fp));
    const fc = Math.min(f0Length - 1, Math.ceil(t / fp));
    const a = t / fp - ff;
    const spF = spectrogram[ff], spC = spectrogram[fc], apF = aperiodicity[ff], apC = aperiodicity[fc];
    if (ff === fc) {
      for (let k = 0; k <= half; k++) { env[k] = Math.abs(spF[k]); apr[k] = safeAp(apF[k]) ** 2; }
    } else {
      for (let k = 0; k <= half; k++) {
        env[k] = (1 - a) * Math.abs(spF[k]) + a * Math.abs(spC[k]);
        apr[k] = ((1 - a) * safeAp(apF[k]) + a * safeAp(apC[k])) ** 2;
      }
    }
    // Periodic response
    if (vuv <= 0.5 || apr[0] > 0.999) periodic.fill(0);
    else {
      for (let k = 0; k <= half; k++) mp.logSpectrum[k] = Math.log(env[k] * (1.0 - apr[k]) + kMySafeGuardMinimum) / 2.0;
      mp.compute();
      const coef = (2.0 * kPi * pulseShift[p] * fs) / fftSize;
      for (let k = 0; k <= half; k++) {
        const re = mp.outRe[k], im = mp.outIm[k];
        const re2 = Math.cos(coef * k);
        const im2 = Math.sqrt(Math.max(0, 1.0 - re2 * re2));
        inv.specRe[k] = re * re2 + im * im2;
        inv.specIm[k] = im * re2 - re * im2;
      }
      inv.inverse();
      for (let k = 0; k < half; k++) { periodic[k] = inv.waveform[k + half]; periodic[k + half] = inv.waveform[k]; }
      let dc = 0;
      for (let k = half; k < fftSize; k++) dc += periodic[k];
      for (let k = 0; k < half; k++) periodic[k] = -dc * dcRemover[k];
      for (let k = half; k < fftSize; k++) periodic[k] -= dc * dcRemover[k];
    }
    // Aperiodic response: shaped noise
    fwd.waveform.fill(0);
    if (noiseSize > 0) {
      let avg = 0;
      for (let k = 0; k < noiseSize; k++) { fwd.waveform[k] = randn.next(); avg += fwd.waveform[k]; }
      avg /= noiseSize;
      for (let k = 0; k < noiseSize; k++) fwd.waveform[k] -= avg;
    }
    fwd.forward();
    if (vuv !== 0) for (let k = 0; k <= half; k++) mp.logSpectrum[k] = Math.log(env[k] * apr[k]) / 2.0;
    else for (let k = 0; k <= half; k++) mp.logSpectrum[k] = Math.log(env[k]) / 2.0;
    mp.compute();
    for (let k = 0; k <= half; k++) {
      inv.specRe[k] = mp.outRe[k] * fwd.specRe[k] - mp.outIm[k] * fwd.specIm[k];
      inv.specIm[k] = mp.outRe[k] * fwd.specIm[k] + mp.outIm[k] * fwd.specRe[k];
    }
    inv.inverse();
    for (let k = 0; k < half; k++) { aperiodic[k] = inv.waveform[k + half]; aperiodic[k + half] = inv.waveform[k]; }
    // Overlap-add
    const sq = Math.sqrt(noiseSize);
    const offset = idx - half + 1;
    const lo = Math.max(0, -offset);
    const hi = Math.min(fftSize, yLength - offset);
    for (let j = lo; j < hi; j++) y[j + offset] += (periodic[j] * sq + aperiodic[j]) / fftSize;
    if (onProgress && p % 500 === 0) onProgress(p / nP);
  }
  return y;
}
