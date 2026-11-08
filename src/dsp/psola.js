import { hzToMidi } from './autotune.js';

/**
 * Time-domain pitch-synchronous overlap-add (TD-PSOLA) pitch shifter.
 * Keeps timing and (roughly) the singer's formants while moving pitch
 * frame-by-frame from the detected pitch to the corrected pitch.
 *
 * pitch:     { t0, hopSec, f0 } from detectPitch
 * corrected: per-frame MIDI pitch to render (NaN = leave as is)
 * formant:   >1 moves formants up (brighter, "female"), <1 down ("male").
 *            Applied to voiced grains only so consonants stay natural.
 */
export function psola(x, sampleRate, pitch, corrected, { formant = 1 } = {}) {
  const N = x.length;
  const { t0, hopSec, f0 } = pitch;
  const F = f0.length;
  const out = new Float32Array(N);
  const wsum = new Float32Array(N);
  if (F === 0) return Float32Array.from(x);

  const frameAt = (n) => {
    const i = Math.round((n / sampleRate - t0) / hopSec);
    return i < 0 ? 0 : i >= F ? F - 1 : i;
  };
  const ratioAt = (i) => {
    if (!(f0[i] > 0) || Number.isNaN(corrected[i])) return 1;
    const r = 2 ** ((corrected[i] - hzToMidi(f0[i])) / 12);
    return r < 0.5 ? 0.5 : r > 2 ? 2 : r;
  };
  const unvoicedPeriod = sampleRate * 0.005;

  // Analysis marks, one pitch period apart in voiced regions.
  const marks = [];
  const periods = [];
  for (let n = 0; n < N; ) {
    const i = frameAt(n);
    const P = f0[i] > 0 ? sampleRate / f0[i] : unvoicedPeriod;
    marks.push(n);
    periods.push(P);
    n += P;
  }

  // Synthesis marks spaced by the *new* period; each gets the nearest grain.
  let k = 0;
  for (let s = 0; s < N; ) {
    while (k + 1 < marks.length && Math.abs(marks[k + 1] - s) <= Math.abs(marks[k] - s)) k++;
    const i = frameAt(s);
    const P = periods[k];
    const voiced = f0[i] > 0;
    if (formant === 1 || !voiced) {
      const L = Math.max(2, Math.round(P));
      const a = Math.round(marks[k]);
      const c = Math.round(s);
      for (let j = -L; j <= L; j++) {
        const src = a + j, dst = c + j;
        if (src < 0 || src >= N || dst < 0 || dst >= N) continue;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * j) / L);
        out[dst] += x[src] * w;
        wsum[dst] += w;
      }
    } else {
      // Resample the grain: squeezing it raises the formants, stretching lowers them.
      const L = Math.max(2, Math.round(P / formant));
      const a = marks[k];
      const c = Math.round(s);
      for (let j = -L; j <= L; j++) {
        const dst = c + j;
        if (dst < 0 || dst >= N) continue;
        const pos = a + j * formant;
        const i0 = Math.floor(pos);
        if (i0 < 0 || i0 + 1 >= N) continue;
        const v = x[i0] + (x[i0 + 1] - x[i0]) * (pos - i0);
        const w = 0.5 + 0.5 * Math.cos((Math.PI * j) / L);
        out[dst] += v * w;
        wsum[dst] += w;
      }
    }
    s += P / ratioAt(i);
  }
  // Normalise build-up where grains overlap more than 50% (pitch up).
  for (let n = 0; n < N; n++) if (wsum[n] > 1) out[n] /= wsum[n];
  return out;
}
