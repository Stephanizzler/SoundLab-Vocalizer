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

/**
 * Split pitch into a smooth line (note centre + slow drift) and the fast part
 * (vibrato / wobble). Smoothing restarts at every target-note change so note
 * transitions aren't smeared. Two box passes = triangular window, which
 * removes typical 4.5–7 Hz vibrato well; the window shrinks symmetrically at
 * note edges so slides and scoops aren't biased.
 */
export function smoothPitch(midi, target, hopSec, windowSec = 0.15) {
  const n = midi.length;
  const width = Math.max(3, Math.round(windowSec / hopSec));
  const r = Math.floor(width / 2);
  let cur = midi;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(n).fill(NaN);
    let a = 0;
    while (a < n) {
      if (Number.isNaN(cur[a])) { a++; continue; }
      const note = target && !Number.isNaN(target[a]) ? Math.round(target[a]) : null;
      let b = a + 1;
      while (
        b < n && !Number.isNaN(cur[b]) && Math.abs(cur[b] - cur[b - 1]) < 1.2 &&
        (target ? (Number.isNaN(target[b]) ? null : Math.round(target[b])) === note : true)
      ) b++;
      const prefix = new Float64Array(b - a + 1);
      for (let i = a; i < b; i++) prefix[i - a + 1] = prefix[i - a] + cur[i];
      for (let i = a; i < b; i++) {
        // Symmetric window that shrinks at note edges (unbiased on slides).
        const rr = Math.min(r, i - a, b - 1 - i);
        out[i] = (prefix[i + rr + 1 - a] - prefix[i - rr - a]) / (2 * rr + 1);
      }
      a = b;
    }
    cur = out;
  }
  return cur;
}

/**
 * Natural pitch correction.
 *
 *  retuneMs   how fast the pitch is pulled to the target (0 = instant, robotic)
 *  amount     0..1 how much of the distance to the target is corrected
 *  humanize   0..1 sustained notes are retuned more slowly than short ones,
 *             so long notes keep their life while quick notes stay tight
 *  keepBends  0..1 leave deliberate expression alone: the further the sung
 *             line is from the target, the less it's corrected (0 = off)
 *  vibrato    0..2 vibrato depth in the output (0 = flat, 1 = as sung)
 *  noteAmount / noteVibrato  optional per-frame overrides (NaN = use global)
 *
 * Correction acts on the smooth line; vibrato is added back on top.
 */
export function correctPitch(midi, target, hopSec, opts = {}) {
  const {
    retuneMs = 25, amount = 1, humanize = 0, keepBends = 0, vibrato = 1,
    noteAmount = null, noteVibrato = null,
  } = opts;
  const n = midi.length;
  const smooth = smoothPitch(midi, target, hopSec);
  const out = new Float32Array(n).fill(NaN);
  const th = keepBends > 0 ? 2 - 1.75 * keepBends : Infinity; // semitones
  let delta = 0, active = false, prevNote = null, segStart = 0;
  for (let i = 0; i < n; i++) {
    const m = midi[i];
    if (Number.isNaN(m)) { active = false; prevNote = null; continue; }
    const t = target[i];
    if (Number.isNaN(t)) { out[i] = m; active = false; prevNote = null; continue; }
    const s = smooth[i];
    const vib = m - s;
    const note = Math.round(t);
    if (note !== prevNote) { segStart = i; prevNote = note; }
    const age = (i - segStart) * hopSec;
    const dev = Math.abs(s - t);
    const gate = dev <= th * 0.6 ? 1 : dev >= th ? 0 : (th - dev) / (th * 0.4);
    const na = noteAmount && !Number.isNaN(noteAmount[i]) ? noteAmount[i] : amount;
    const nv = noteVibrato && !Number.isNaN(noteVibrato[i]) ? noteVibrato[i] : vibrato;
    const want = (t - s) * na * gate;
    const ramp = Math.min(1, Math.max(0, (age - 0.15) / 0.5));
    const tau = (retuneMs + humanize * 160 * ramp) / 1000;
    const alpha = tau <= 0 ? 1 : 1 - Math.exp(-hopSec / tau);
    if (!active) { delta = 0; active = true; }
    delta += (want - delta) * alpha;
    out[i] = s + delta + nv * vib;
  }
  return out;
}

/** Correction styles (like starting points in a pro tuner). */
export const TUNE_STYLES = {
  natural: { label: 'Natural', retuneMs: 50, humanize: 0.6, keepBends: 0.5, vibrato: 1, amount: 1 },
  pop: { label: 'Pop polish', retuneMs: 20, humanize: 0.35, keepBends: 0.25, vibrato: 0.85, amount: 1 },
  hard: { label: 'Hard tune', retuneMs: 0, humanize: 0, keepBends: 0, vibrato: 0, amount: 1 },
};
