import { psola } from './psola.js';
import { segmentsFrom, pitchClass, noteName } from './autotune.js';

/** Voice characters: formant shift (timbre) plus optional stacked doubles. */
export const VOICES = {
  natural: { label: 'Natural (like me)', formant: 1 },
  female: { label: 'Female', formant: 1.17 },
  male: { label: 'Male', formant: 0.86 },
  deep: { label: 'Deep bass', formant: 0.76 },
  bright: { label: 'Bright / young', formant: 1.3 },
  choir: { label: 'Choir (3 voices)', formant: 1, stack: 3 },
};

/**
 * Harmony intervals. `steps` are scale steps (a diatonic 3rd = 2 steps),
 * `semis` fixed semitones, `smart` = candidate steps with preference
 * weights; the one that best fits the backing chord is chosen per note.
 */
export const INTERVALS = {
  'smart-above': { label: '✨ Smart, above', smart: [[2, 1], [4, 0.8], [3, 0.55]] },
  'smart-below': { label: '✨ Smart, below', smart: [[-2, 1], [-5, 0.8], [-3, 0.7]] },
  'third-above': { label: '3rd above', steps: 2 },
  'third-below': { label: '3rd below', steps: -2 },
  'fourth-above': { label: '4th above', steps: 3 },
  'fourth-below': { label: '4th below', steps: -3 },
  'fifth-above': { label: '5th above', steps: 4 },
  'fifth-below': { label: '5th below', steps: -4 },
  'sixth-below': { label: '6th below', steps: -5 },
  'octave-above': { label: 'Octave above', semis: 12 },
  'octave-below': { label: 'Octave below', semis: -12 },
  unison: { label: 'Double (same note)', semis: 0 },
};

/** Move `steps` scale degrees from `note` within the scale `pcs`. */
export function diatonicShift(note, steps, pcs) {
  const scale = [...pcs].sort((a, b) => a - b);
  let n = Math.round(note);
  if (!scale.includes(pitchClass(n))) {
    // Snap to the nearest scale note first.
    for (let d = 1; d < 6; d++) {
      if (scale.includes(pitchClass(n - d))) { n -= d; break; }
      if (scale.includes(pitchClass(n + d))) { n += d; break; }
    }
  }
  let idx = scale.indexOf(pitchClass(n));
  let base = n - pitchClass(n);
  idx += steps;
  while (idx < 0) { idx += scale.length; base -= 12; }
  while (idx >= scale.length) { idx -= scale.length; base += 12; }
  return base + scale[idx];
}

/**
 * Per-frame semitone offset of a harmony line relative to the lead.
 * chromaFor(seg) may return the backing track's pitch-class profile under
 * that note so "smart" intervals land on chord tones.
 */
export function planOffsets(target, interval, pcs, chromaFor) {
  const def = INTERVALS[interval] || INTERVALS['third-above'];
  const out = new Float32Array(target.length).fill(NaN);
  let prev = null;
  for (const seg of segmentsFrom(target)) {
    const note = seg.note;
    let h;
    if (def.semis !== undefined) h = note + def.semis;
    else if (def.steps !== undefined) h = diatonicShift(note, def.steps, pcs);
    else {
      const chroma = chromaFor ? chromaFor(seg) : null;
      let bestScore = -Infinity;
      for (const [steps, weight] of def.smart) {
        const cand = diatonicShift(note, steps, pcs);
        let score = weight * (chroma ? 0.25 + chroma[pitchClass(cand)] : 1);
        if (steps === prev) score += 0.12; // smoother lines
        if (score > bestScore) { bestScore = score; h = cand; prev = steps; }
      }
    }
    // Keep harmonies in a singable range.
    while (h > 86) h -= 12;
    while (h < 36) h += 12;
    out.fill(h - note, seg.start, seg.end);
  }
  return out;
}

function voicedGate(pitch, sampleRate, n) {
  // Smooth 0..1 gain: harmonies only sound on sung (pitched) parts.
  const { t0, hopSec, f0 } = pitch;
  const g = new Float32Array(n);
  const k = 1 - Math.exp(-1 / (0.02 * sampleRate));
  let v = 0;
  for (let i = 0; i < n; i++) {
    const fi = Math.round((i / sampleRate - t0) / hopSec);
    const on = fi >= 0 && fi < f0.length && f0[fi] > 0 ? 1 : 0;
    v += (on - v) * k;
    g[i] = v;
  }
  return g;
}

// Small deterministic PRNG so renders are repeatable.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Render harmony voices from the dry take.
 * base: per-frame MIDI pitch of the lead (the tuned pitch).
 * Returns [L, R] with the voices only (no lead).
 */
export function renderHarmony(raw, sampleRate, pitch, base, target, layers, { pcs, chromaFor } = {}) {
  const maxDelay = Math.round(0.06 * sampleRate);
  const n = raw.length + maxDelay;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const gate = voicedGate(pitch, sampleRate, raw.length);
  layers.forEach((layer, li) => {
    const offs = planOffsets(target, layer.interval, pcs, chromaFor);
    const voice = VOICES[layer.voice] || VOICES.natural;
    const stack = voice.stack || 1;
    const rand = rng(li * 7919 + 17);
    const human = layer.humanize ?? 0.4;
    for (let s = 0; s < stack; s++) {
      const spread = stack > 1 ? s - (stack - 1) / 2 : 0;
      const cents = spread * 9 + (rand() - 0.5) * 12 * human;
      const tgt = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) {
        tgt[i] = Number.isNaN(base[i]) || Number.isNaN(offs[i]) ? NaN : base[i] + offs[i] + cents / 100;
      }
      const formant = voice.formant * (1 + spread * 0.025);
      const y = psola(raw, sampleRate, pitch, tgt, { formant });
      const delay = Math.min(maxDelay, Math.round((0.004 + human * 0.018 * (1 + rand()) + Math.abs(spread) * 0.008) * sampleRate));
      const pan = Math.max(-1, Math.min(1, (layer.pan ?? 0) + spread * 0.35));
      const ang = ((pan + 1) * Math.PI) / 4;
      const gain = (layer.level ?? 0.6) / Math.sqrt(stack);
      const gl = Math.cos(ang) * gain * Math.SQRT2;
      const gr = Math.sin(ang) * gain * Math.SQRT2;
      for (let i = 0; i < y.length; i++) {
        const v = y[i] * gate[i];
        L[i + delay] += v * gl;
        R[i + delay] += v * gr;
      }
    }
  });
  return [L, R];
}

/**
 * Suggest harmony layers that suit the dry vocal: looks at where the
 * melody sits so harmonies stay in a comfortable range, and uses smart
 * (chord-aware) intervals when there is a backing track to listen to.
 */
export function recommendHarmony(midi, { hasBacking = true } = {}) {
  const sung = [...midi].filter((m) => !Number.isNaN(m)).sort((a, b) => a - b);
  const median = sung.length ? sung[sung.length >> 1] : 64;
  const above = hasBacking ? 'smart-above' : 'third-above';
  const below = hasBacking ? 'smart-below' : 'third-below';
  let layers, reason;
  if (median >= 68) {
    layers = [
      { interval: below, voice: 'natural', level: 0.6, pan: -0.45, humanize: 0.4 },
      { interval: 'fifth-below', voice: 'male', level: 0.45, pan: 0.45, humanize: 0.5 },
    ];
    reason = `Your melody sits high (around ${noteName(median)}), so the harmonies go underneath it.`;
  } else if (median <= 55) {
    layers = [
      { interval: above, voice: 'natural', level: 0.6, pan: -0.45, humanize: 0.4 },
      { interval: 'fifth-above', voice: 'bright', level: 0.4, pan: 0.45, humanize: 0.5 },
    ];
    reason = `Your melody sits low (around ${noteName(median)}), so the harmonies go above it.`;
  } else {
    layers = [
      { interval: above, voice: 'natural', level: 0.6, pan: -0.45, humanize: 0.4 },
      { interval: below, voice: 'natural', level: 0.5, pan: 0.45, humanize: 0.45 },
    ];
    reason = `Your melody sits mid-range (around ${noteName(median)}): one harmony above and one below.`;
  }
  if (hasBacking) reason += ' Each harmony note is picked to match the chord playing underneath it.';
  return { layers, reason };
}
