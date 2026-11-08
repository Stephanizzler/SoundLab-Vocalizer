import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fft } from '../src/dsp/fft.js';
import { detectPitch } from '../src/dsp/pitch-detect.js';
import { detectKey } from '../src/dsp/key-detect.js';
import { removeVocals } from '../src/dsp/vocal-remover.js';
import { psola } from '../src/dsp/psola.js';
import { encodeWav } from '../src/dsp/wav.js';
import {
  hzToMidi, midiToHz, pitchToMidi, computeTargets, applyRetune,
  scalePitchClasses, nearestScaleNote, segmentsFrom,
} from '../src/dsp/autotune.js';

const SR = 44100;

function tone(freqs, seconds, sr = SR, amp = 0.3) {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (const f of freqs) s += Math.sin((2 * Math.PI * f * i) / sr);
    out[i] = (amp * s) / freqs.length;
  }
  return out;
}

/** Harmonic-rich voice-like tone. */
function voice(f, seconds, sr = SR) {
  const out = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let h = 1; h <= 8; h++) s += Math.sin((2 * Math.PI * f * h * i) / sr) / h;
    out[i] = 0.25 * s;
  }
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const voicedMedian = (p) => median([...p.f0].filter((v) => v > 0));

function bandEnergy(x, sr, freq) {
  // Goertzel
  const k = (2 * Math.PI * freq) / sr;
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) { const s = x[i] + 2 * Math.cos(k) * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - 2 * Math.cos(k) * s1 * s2;
}

test('fft round-trips', () => {
  const re = Float64Array.from({ length: 64 }, (_, i) => Math.sin(i) + i * 0.1);
  const orig = re.slice();
  const im = new Float64Array(64);
  fft(re, im); fft(re, im, true);
  for (let i = 0; i < 64; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
});

test('detectPitch finds sine and voice-like pitches', async () => {
  for (const f of [110, 220, 330, 523.25]) {
    const p = await detectPitch(voice(f, 1), SR);
    const est = voicedMedian(p);
    assert.ok(Math.abs(hzToMidi(est) - hzToMidi(f)) < 0.1, `${f}Hz -> ${est}`);
  }
  const p = await detectPitch(new Float32Array(SR), SR);
  assert.equal([...p.f0].filter((v) => v > 0).length, 0, 'silence is unvoiced');
});

test('detectKey: G major progression', async () => {
  const chords = [
    ['G3', 'B3', 'D4'], ['C4', 'E4', 'G4'], ['D4', 'F#4', 'A4'], ['G3', 'B3', 'D4'],
    ['E3', 'G3', 'B3'], ['C4', 'E4', 'G4'], ['D4', 'F#4', 'A4'], ['G3', 'B3', 'D4'],
  ];
  const names = { C: 0, 'C#': 1, D: 2, E: 4, F: 5, 'F#': 6, G: 7, A: 9, B: 11 };
  const hz = (n) => midiToHz(names[n.slice(0, -1)] + 12 * (Number(n.slice(-1)) + 1));
  const parts = chords.map((c) => tone(c.map(hz), 1));
  const x = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { x.set(p, o); o += p.length; }
  const key = await detectKey(x, SR);
  assert.equal(key.name, 'G major');
});

test('removeVocals removes centered content and keeps side content', async () => {
  const center = tone([440], 2);
  const side = tone([300], 2);
  const L = center.map((v, i) => v + side[i]);
  const R = center.slice();
  const [oL] = await removeVocals(L, R, SR, { strength: 1 });
  const mid = (a) => a.subarray(SR / 2, SR + SR / 2);
  const centerDrop = 10 * Math.log10(bandEnergy(mid(oL), SR, 440) / bandEnergy(mid(L), SR, 440));
  const sideDrop = 10 * Math.log10(bandEnergy(mid(oL), SR, 300) / bandEnergy(mid(L), SR, 300));
  assert.ok(centerDrop < -20, `center only dropped ${centerDrop.toFixed(1)} dB`);
  assert.ok(sideDrop > -3, `side dropped ${sideDrop.toFixed(1)} dB`);
});

test('autotune targets snap to scale and retune glides', () => {
  const pcs = scalePitchClasses(0, 'major'); // C major
  assert.equal(nearestScaleNote(61.4, pcs), 62); // C#+40c -> D
  assert.equal(nearestScaleNote(60.4, pcs), 60);
  const midi = Float32Array.from([60.3, 60.35, 60.4, NaN, 64.6, 64.7]);
  const target = computeTargets(midi, pcs);
  assert.deepEqual([...target].map((v) => (Number.isNaN(v) ? null : v)), [60, 60, 60, null, 65, 65]);
  const hard = applyRetune(midi, target, 0.01, 0);
  assert.ok(Math.abs(hard[0] - 60) < 1e-6 && Math.abs(hard[5] - 65) < 1e-6);
  const soft = applyRetune(midi, target, 0.01, 100);
  assert.ok(soft[0] > 60.2, 'slow retune starts near the sung pitch');
  assert.deepEqual(segmentsFrom(target).map((s) => s.note), [60, 65]);
});

test('psola shifts pitch and passes through at ratio 1', async () => {
  const x = voice(220, 1.5);
  const p = await detectPitch(x, SR);
  const midi = pitchToMidi(p.f0);
  const same = psola(x, SR, p, midi);
  let err = 0, ref = 0;
  for (let i = 1000; i < x.length - 1000; i++) { err += (same[i] - x[i]) ** 2; ref += x[i] ** 2; }
  assert.ok(err / ref < 1e-3, `passthrough error ${err / ref}`);

  for (const semis of [2, -3]) {
    const shifted = psola(x, SR, p, midi.map((m) => m + semis));
    const est = voicedMedian(await detectPitch(shifted, SR));
    assert.ok(Math.abs(hzToMidi(est) - (hzToMidi(220) + semis)) < 0.15, `shift ${semis}: ${est}Hz`);
  }
});

test('encodeWav writes a valid header', () => {
  const buf = encodeWav([new Float32Array([0, 0.5, -0.5])], 48000);
  const v = new DataView(buf);
  assert.equal(buf.byteLength, 44 + 6);
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getInt16(46, true), 16383);
});

test('vibrato on a sharp note does not flip the target note', () => {
  const pcs = scalePitchClasses(9, 'minor'); // A minor: B and C both in key
  const hop = 0.01;
  // B4 (71) sung +45 cents with ±15 cent 5.5 Hz vibrato
  const midi = Float32Array.from({ length: 80 }, (_, i) => 71.45 + 0.15 * Math.sin(2 * Math.PI * 5.5 * i * hop));
  const t = computeTargets(midi, pcs, { smoothFrames: 20 });
  assert.ok([...t].every((v) => v === 71), `targets: ${[...new Set(t)]}`);
});
