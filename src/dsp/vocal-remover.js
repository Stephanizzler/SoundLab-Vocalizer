import { fft, hann } from './fft.js';
import { tick } from './util.js';

/**
 * Spectral center-channel vocal removal.
 *
 * Lead vocals are almost always mixed dead-center (identical in L and R).
 * For each STFT bin we measure how "centered" the energy is and attenuate
 * centered bins inside the vocal band, while leaving low end (kick/bass,
 * also centered) and everything panned off-center untouched.
 *
 * L and R are packed into one complex FFT (z = L + iR). Because the gain
 * is real and symmetric, it can be applied to z directly.
 */
export async function removeVocals(left, right, sampleRate, opts = {}) {
  const {
    strength = 1, // 0..1
    lowCut = 120, // Hz: keep everything below (bass, kick)
    highCut = 9000, // Hz: keep everything above (cymbals, air)
    fftSize = 2048,
    onProgress,
  } = opts;

  const N = fftSize;
  const hop = N / 4;
  const win = hann(N);
  const len = left.length;
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const gain = new Float64Array(N);
  const kLo = Math.max(1, Math.floor((lowCut / sampleRate) * N));
  const kHi = Math.min(N / 2, Math.ceil((highCut / sampleRate) * N));
  const fadeBins = 4; // soft edges at band limits
  const norm = 1 / 1.5; // hann^2 overlap-add sum at 75% overlap

  const frames = Math.ceil((len + N) / hop);
  for (let f = 0; f < frames; f++) {
    const start = f * hop - N;
    for (let i = 0; i < N; i++) {
      const idx = start + i;
      const inRange = idx >= 0 && idx < len;
      re[i] = inRange ? left[idx] * win[i] : 0;
      im[i] = inRange ? right[idx] * win[i] : 0;
    }
    fft(re, im);

    gain.fill(1);
    for (let k = kLo; k <= kHi; k++) {
      const nk = (N - k) % N;
      const a = re[k], b = im[k], c = re[nk], d = im[nk];
      // Unpack the two real spectra.
      const lr = (a + c) / 2, li = (b - d) / 2;
      const rr = (b + d) / 2, ri = (c - a) / 2;
      const pL = lr * lr + li * li;
      const pR = rr * rr + ri * ri;
      const cross = lr * rr + li * ri; // Re(L * conj(R))
      const sim = Math.max(0, (2 * cross) / (pL + pR + 1e-12));
      let edge = 1;
      if (k - kLo < fadeBins) edge = (k - kLo + 1) / (fadeBins + 1);
      else if (kHi - k < fadeBins) edge = (kHi - k + 1) / (fadeBins + 1);
      const g = 1 - strength * edge * sim * sim * sim;
      gain[k] = g;
      gain[nk] = g;
    }
    for (let k = 0; k < N; k++) { re[k] *= gain[k]; im[k] *= gain[k]; }
    fft(re, im, true);

    for (let i = 0; i < N; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= len) continue;
      outL[idx] += re[i] * win[i] * norm;
      outR[idx] += im[i] * win[i] * norm;
    }
    if (f % 400 === 0) {
      onProgress?.(f / frames);
      await tick();
    }
  }
  onProgress?.(1);
  return [outL, outR];
}

/** Rough check for whether a stereo file is effectively mono. */
export function isEffectivelyMono(left, right) {
  let diff = 0, sum = 0;
  const step = Math.max(1, Math.floor(left.length / 200000));
  for (let i = 0; i < left.length; i += step) {
    const d = left[i] - right[i];
    diff += d * d;
    sum += left[i] * left[i] + right[i] * right[i];
  }
  return sum === 0 || diff / sum < 1e-4;
}
