import { NOTE_NAMES } from './key-detect.js';

export const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12);

export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export function scalePitchClasses(tonic, mode) {
  return (SCALES[mode] || SCALES.chromatic).map((i) => (i + tonic) % 12);
}

export const pitchClass = (m) => ((Math.round(m) % 12) + 12) % 12;

export function noteName(m) {
  const r = Math.round(m);
  return `${NOTE_NAMES[pitchClass(r)]}${Math.floor(r / 12) - 1}`;
}

export function nearestScaleNote(m, pcs) {
  const r = Math.round(m);
  let best = r, bd = Infinity;
  for (let n = r - 2; n <= r + 2; n++) {
    if (!pcs.includes(pitchClass(n))) continue;
    const d = Math.abs(n - m);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}

/** Hz per frame -> MIDI (fractional) per frame; NaN where unvoiced. */
export function pitchToMidi(f0) {
  const out = new Float32Array(f0.length);
  for (let i = 0; i < f0.length; i++) out[i] = f0[i] > 0 ? hzToMidi(f0[i]) : NaN;
  return out;
}

/**
 * Auto-generated target notes: each voiced frame snaps to the nearest note
 * of the scale. The decision is made on a smoothed pitch (averaging out
 * vibrato) with hysteresis, so wobbles between two notes don't flicker.
 */
export function computeTargets(midi, pcs, { hysteresis = 0.2, smoothFrames = 0 } = {}) {
  const n = midi.length;
  const smooth = smoothFrames > 1 ? smoothVoiced(midi, smoothFrames) : midi;
  const target = new Float32Array(n).fill(NaN);
  let cur = null;
  for (let i = 0; i < n; i++) {
    const m = smooth[i];
    if (Number.isNaN(m)) { cur = null; continue; }
    const near = nearestScaleNote(m, pcs);
    if (cur === null) cur = near;
    else if (near !== cur && Math.abs(m - near) + hysteresis < Math.abs(m - cur)) cur = near;
    target[i] = cur;
  }
  return target;
}

/**
 * Moving average inside each note (a voiced run, split at jumps > ~1 semitone).
 * The window keeps its full width at note edges by sliding inward, so the
 * first frames of a note already see a whole vibrato cycle.
 */
function smoothVoiced(midi, width) {
  const n = midi.length;
  const out = new Float32Array(n).fill(NaN);
  const r = Math.floor(width / 2);
  let a = 0;
  while (a < n) {
    if (Number.isNaN(midi[a])) { a++; continue; }
    let b = a + 1;
    while (b < n && !Number.isNaN(midi[b]) && Math.abs(midi[b] - midi[b - 1]) < 1.2) b++;
    const prefix = new Float64Array(b - a + 1);
    for (let i = a; i < b; i++) prefix[i - a + 1] = prefix[i - a] + midi[i];
    for (let i = a; i < b; i++) {
      let lo = i - r, hi = i + r + 1;
      if (lo < a) { hi += a - lo; lo = a; }
      if (hi > b) { lo -= hi - b; hi = b; }
      lo = Math.max(lo, a);
      out[i] = (prefix[hi - a] - prefix[lo - a]) / (hi - lo);
    }
    a = b;
  }
  return out;
}

/**
 * Glide from the sung pitch toward the target pitch.
 * retuneMs = 0 is the hard, robotic effect; larger values are more natural
 * (the correction "catches up" with a time constant of retuneMs).
 */
export function applyRetune(midi, target, hopSec, retuneMs, amount = 1) {
  const out = new Float32Array(midi.length).fill(NaN);
  const tau = retuneMs / 1000;
  const alpha = tau <= 0 ? 1 : 1 - Math.exp(-hopSec / tau);
  let delta = 0;
  let active = false;
  for (let i = 0; i < midi.length; i++) {
    const m = midi[i];
    if (Number.isNaN(m)) { active = false; continue; }
    const t = target[i];
    if (Number.isNaN(t)) { out[i] = m; active = false; continue; }
    const want = t - m;
    if (!active) { delta = 0; active = true; }
    delta += (want - delta) * alpha;
    out[i] = m + delta * amount;
  }
  return out;
}

/** Contiguous runs of the same (rounded) target note — used for note blocks. */
export function segmentsFrom(target) {
  const segs = [];
  let i = 0;
  const n = target.length;
  while (i < n) {
    if (Number.isNaN(target[i])) { i++; continue; }
    const note = Math.round(target[i]);
    let j = i + 1;
    while (j < n && !Number.isNaN(target[j]) && Math.round(target[j]) === note) j++;
    segs.push({ start: i, end: j, note });
    i = j;
  }
  return segs;
}
