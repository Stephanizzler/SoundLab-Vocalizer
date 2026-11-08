import { diatonicShift } from './harmony.js';

/**
 * Channel vocoder. The vocal (modulator) is split into bands; the loudness
 * of each band shapes the same band of a synth (carrier), so the synth
 * "talks" with your words.
 *
 * carrier:  'pitch' follows your (tuned) melody, 'chord' plays a triad on
 *           your melody in key, 'drone' holds the song's root, 'noise' whispers.
 */
export function vocode([inL, inR], sampleRate, opts = {}) {
  const {
    bands = 20,
    carrier = 'pitch',
    carrierOctave = 0,
    detune = 0, // cents, adds two detuned oscillators per note
    formantShift = 0, // in bands (+ = higher / smaller, - = bigger / darker)
    mix = 1,
    width = 0.5,
    noise = 0.5, // noise on unpitched parts (keeps consonants understandable)
    release = 0.03,
    pitch = null, // { t0, hopSec, midi } lead pitch per frame
    pcs = [0, 2, 4, 5, 7, 9, 11],
    droneMidi = 48,
  } = opts;

  const n = inL.length;
  const mod = new Float32Array(n);
  for (let i = 0; i < n; i++) mod[i] = (inL[i] + inR[i]) * 0.5;

  // --- carrier oscillators -------------------------------------------------
  const frames = pitch ? pitch.midi.length : 0;
  const noteAt = (i) => {
    if (!frames) return NaN;
    const fi = Math.round((i / sampleRate - pitch.t0) / pitch.hopSec);
    return fi >= 0 && fi < frames ? pitch.midi[fi] : NaN;
  };
  const chordOffsets = (m) => {
    const r = Math.round(m);
    return [0, diatonicShift(r, 2, pcs) - r, diatonicShift(r, 4, pcs) - r];
  };
  const det = detune > 0 ? [0, detune / 100, -detune / 100] : [0];
  const maxOsc = 3 * det.length;
  const phase = new Float64Array(maxOsc);
  const carrierSig = new Float32Array(n);
  let seed = 12345;
  const white = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  const kV = 1 - Math.exp(-1 / (0.008 * sampleRate));
  let voiced = 0;
  let lastMidi = droneMidi;
  let offsets = [0];
  let lastRounded = null;
  for (let i = 0; i < n; i++) {
    let m = carrier === 'drone' ? droneMidi : noteAt(i);
    const isVoiced = carrier === 'drone' ? 1 : Number.isNaN(m) ? 0 : 1;
    if (Number.isNaN(m)) m = lastMidi; else lastMidi = m;
    voiced += (isVoiced - voiced) * kV;
    if (carrier === 'noise') { carrierSig[i] = white() * 0.6; continue; }
    if (carrier === 'chord' || carrier === 'drone') {
      const r = Math.round(m);
      if (r !== lastRounded) { offsets = carrier === 'drone' ? [0, 7, 12] : chordOffsets(m); lastRounded = r; }
    } else offsets = [0];
    let s = 0, count = 0;
    for (let o = 0; o < offsets.length; o++) {
      for (let d = 0; d < det.length; d++) {
        const f = 440 * 2 ** ((m + offsets[o] + det[d] + 12 * carrierOctave - 69) / 12);
        const dt = Math.min(0.45, f / sampleRate);
        const idx = o * det.length + d;
        let p = phase[idx] + dt;
        if (p >= 1) p -= 1;
        phase[idx] = p;
        s += 2 * p - 1 - polyBlep(p, dt);
        count++;
      }
    }
    carrierSig[i] = (s / Math.sqrt(count)) * voiced + white() * noise * (1 - voiced) * 0.8;
  }

  // --- filter banks --------------------------------------------------------
  const lo = 110;
  const hi = Math.min(8000, sampleRate * 0.45);
  const ratio = (hi / lo) ** (1 / Math.max(1, bands - 1));
  const Q = 1 / (Math.sqrt(ratio) - 1 / Math.sqrt(ratio));
  const coeffs = [];
  for (let k = 0; k < bands; k++) coeffs.push(bandpass(lo * ratio ** k, Q * 1.2, sampleRate));
  const ms = new Float64Array(bands * 4); // modulator biquad states (x1,x2,y1,y2)
  const cs = new Float64Array(bands * 4);
  const env = new Float64Array(bands);
  const atk = 1 - Math.exp(-1 / (0.002 * sampleRate));
  const rel = 1 - Math.exp(-1 / (release * sampleRate));
  const wetL = new Float32Array(n);
  const wetR = new Float32Array(n);
  const sideL = new Float64Array(bands);
  const sideR = new Float64Array(bands);
  for (let k = 0; k < bands; k++) {
    const odd = k % 2 === 1;
    sideL[k] = odd ? 1 - width : 1;
    sideR[k] = odd ? 1 : 1 - width;
  }
  for (let i = 0; i < n; i++) {
    const xm = mod[i], xc = carrierSig[i];
    for (let k = 0; k < bands; k++) {
      const c = coeffs[k];
      const o = k * 4;
      const ym = c.b0 * xm + c.b2 * ms[o + 1] - c.a1 * ms[o + 2] - c.a2 * ms[o + 3];
      ms[o + 1] = ms[o]; ms[o] = xm; ms[o + 3] = ms[o + 2]; ms[o + 2] = ym;
      const a = ym < 0 ? -ym : ym;
      env[k] += (a - env[k]) * (a > env[k] ? atk : rel);
    }
    let l = 0, r = 0;
    for (let k = 0; k < bands; k++) {
      const c = coeffs[k];
      const o = k * 4;
      const yc = c.b0 * xc + c.b2 * cs[o + 1] - c.a1 * cs[o + 2] - c.a2 * cs[o + 3];
      cs[o + 1] = cs[o]; cs[o] = xc; cs[o + 3] = cs[o + 2]; cs[o + 2] = yc;
      let src = k - formantShift;
      src = src < 0 ? 0 : src >= bands ? bands - 1 : src;
      const v = yc * env[src];
      l += v * sideL[k];
      r += v * sideR[k];
    }
    wetL[i] = l;
    wetR[i] = r;
  }

  // Match the vocoded level to the input level.
  let pin = 0, pout = 0;
  for (let i = 0; i < n; i++) { pin += mod[i] * mod[i]; pout += (wetL[i] * wetL[i] + wetR[i] * wetR[i]) / 2; }
  const g = pout > 0 ? Math.sqrt(pin / pout) : 0;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    outL[i] = inL[i] * (1 - mix) + wetL[i] * g * mix;
    outR[i] = inR[i] * (1 - mix) + wetR[i] * g * mix;
  }
  return [outL, outR];
}

function polyBlep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

function bandpass(f, Q, sampleRate) {
  const w0 = (2 * Math.PI * f) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b2: -alpha / a0, a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0 };
}
