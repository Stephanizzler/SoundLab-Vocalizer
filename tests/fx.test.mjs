import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch } from '../src/dsp/pitch-detect.js';
import { detectTempo, chromaWindow } from '../src/dsp/key-detect.js';
import { psola } from '../src/dsp/psola.js';
import { diatonicShift, planOffsets, renderHarmony, recommendHarmony } from '../src/dsp/harmony.js';
import { vocode } from '../src/dsp/vocoder.js';
import { echo, noteToMs } from '../src/dsp/echo.js';
import { reverb, makeImpulse, convolveStereo } from '../src/dsp/reverb.js';
import { hzToMidi, midiToHz, pitchToMidi, computeTargets, scalePitchClasses } from '../src/dsp/autotune.js';
import { renderChain } from '../src/engine/chain.js';
import { DEFAULT_FX, PRESETS, applyWildness } from '../src/engine/presets.js';

const SR = 44100;
const voice = (f, sec, sr = SR) => {
  const out = new Float32Array(Math.round(sec * sr));
  for (let i = 0; i < out.length; i++) { let s = 0; for (let h = 1; h <= 8; h++) s += Math.sin((2 * Math.PI * f * h * i) / sr) / h; out[i] = 0.25 * s; }
  return out;
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const voicedMedianMidi = async (x) => hzToMidi(median([...(await detectPitch(x, SR)).f0].filter((v) => v > 0)));
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
const cMajor = scalePitchClasses(0, 'major');

test('diatonic intervals stay in key', () => {
  assert.equal(diatonicShift(60, 2, cMajor), 64); // C -> E (major 3rd)
  assert.equal(diatonicShift(62, 2, cMajor), 65); // D -> F (minor 3rd)
  assert.equal(diatonicShift(64, -2, cMajor), 60); // E -> C
  assert.equal(diatonicShift(71, 1, cMajor), 72); // B -> C (octave wrap)
  assert.equal(diatonicShift(60, -1, cMajor), 59);
  assert.equal(diatonicShift(61, 2, cMajor), 64, 'out-of-key note snaps first');
});

test('smart harmony picks the chord tone of the backing', () => {
  const target = new Float32Array(10).fill(64); // lead sings E
  // Backing is an A minor chord (A C E): smart-above should pick A (4th) over G (3rd).
  const chroma = new Float64Array(12); chroma[9] = 1; chroma[0] = 0.8; chroma[4] = 0.9;
  const offs = planOffsets(target, 'smart-above', cMajor, () => chroma);
  assert.equal(offs[0], 5);
  // Over C major (C E G) it picks G (diatonic 3rd above E).
  const c2 = new Float64Array(12); c2[0] = 1; c2[4] = 0.9; c2[7] = 0.9;
  assert.equal(planOffsets(target, 'smart-above', cMajor, () => c2)[0], 3);
});

test('harmony voice is rendered at the harmony pitch', async () => {
  const x = voice(220, 1.2); // A3
  const pitch = await detectPitch(x, SR);
  const base = pitchToMidi(pitch.f0);
  const target = computeTargets(base, cMajor);
  const [L, R] = renderHarmony(x, SR, pitch, base, target, [{ interval: 'third-above', voice: 'natural', level: 1, pan: 0, humanize: 0 }], { pcs: cMajor });
  const mono = L.map((v, i) => (v + R[i]) / 2);
  const m = await voicedMedianMidi(mono);
  assert.ok(Math.abs(m - 60) < 0.25, `A3 + diatonic 3rd should be C4, got ${m.toFixed(2)}`);
});

test('formant shift keeps the pitch', async () => {
  const x = voice(220, 1);
  const pitch = await detectPitch(x, SR);
  const midi = pitchToMidi(pitch.f0);
  for (const formant of [0.8, 1.2]) {
    const y = psola(x, SR, pitch, midi, { formant });
    assert.ok(Math.abs((await voicedMedianMidi(y)) - hzToMidi(220)) < 0.2, `formant ${formant}`);
  }
});

test('recommendation adapts to the melody range', () => {
  const high = new Float32Array(50).fill(74);
  const low = new Float32Array(50).fill(50);
  assert.ok(recommendHarmony(high).layers.every((l) => l.interval.includes('below')));
  assert.ok(recommendHarmony(low).layers.every((l) => l.interval.includes('above')));
  assert.equal(recommendHarmony(new Float32Array(50).fill(62), { hasBacking: false }).layers[0].interval, 'third-above');
});

test('vocoder follows the melody pitch and keeps level', async () => {
  const x = voice(220, 1);
  const pitch = await detectPitch(x, SR);
  const midi = pitchToMidi(pitch.f0).map(() => 64); // synth plays E4 regardless
  const [L, R] = vocode([x, x], SR, { carrier: 'pitch', mix: 1, pitch: { t0: pitch.t0, hopSec: pitch.hopSec, midi } });
  const m = await voicedMedianMidi(L.map((v, i) => (v + R[i]) / 2));
  assert.ok(Math.abs(m - 64) < 0.3, `vocoder pitch ${m}`);
  const ratio = rms(L, 4410, 40000) / rms(x, 4410, 40000);
  assert.ok(ratio > 0.5 && ratio < 2, `level ratio ${ratio}`);
});

test('echo repeats at the set time and decays', () => {
  const x = new Float32Array(SR); x[0] = 1;
  const [L] = echo([x, x], SR, { timeMs: 250, feedback: 0.5, mix: 1, highCut: 20000, lowCut: 5 });
  const at = (ms) => Math.max(...Array.from(L.subarray(Math.round((ms / 1000) * SR) - 50, Math.round((ms / 1000) * SR) + 50), Math.abs));
  assert.ok(at(250) > 0.3, `first repeat ${at(250)}`);
  assert.ok(at(500) < at(250) && at(500) > 0.05, 'second repeat quieter');
  assert.ok(at(125) < 0.01, 'nothing between repeats');
  assert.equal(noteToMs('1/8.', 120), 375);
});

test('ping-pong alternates sides', () => {
  const x = new Float32Array(SR); x[0] = 1;
  const [L, R] = echo([x, x], SR, { timeMs: 200, feedback: 0.6, mix: 1, pingPong: true, highCut: 20000, lowCut: 5 });
  const s = Math.round(0.2 * SR);
  const peak = (a, i) => Math.max(...Array.from(a.subarray(i - 40, i + 40), Math.abs));
  assert.ok(peak(L, s) > peak(R, s) * 3, 'first repeat left');
  assert.ok(peak(R, 2 * s) > peak(L, 2 * s) * 3, 'second repeat right');
});

test('reverb: convolution matches direct, tail length follows decay, direction pans', () => {
  const x = Float32Array.from({ length: 3000 }, (_, i) => Math.sin(i * 0.37) * Math.exp(-i / 800));
  const hL = Float32Array.from({ length: 500 }, (_, i) => Math.cos(i * 0.1) * Math.exp(-i / 100));
  const hR = Float32Array.from({ length: 500 }, (_, i) => Math.sin(i * 0.2) * Math.exp(-i / 150));
  const [cL, cR] = convolveStereo(x, hL, hR);
  for (const n of [0, 700, 2900, 3400]) {
    let dl = 0, dr = 0;
    for (let k = 0; k < 500; k++) if (n - k >= 0 && n - k < x.length) { dl += x[n - k] * hL[k]; dr += x[n - k] * hR[k]; }
    assert.ok(Math.abs(dl - cL[n]) < 1e-6 && Math.abs(dr - cR[n]) < 1e-6, `sample ${n}`);
  }
  const [shortL] = makeImpulse(SR, { decay: 0.5, preDelayMs: 0 });
  const [longL] = makeImpulse(SR, { decay: 4, preDelayMs: 0 });
  assert.ok(longL.length > shortL.length * 4);
  const tailEnergy = (h) => rms(h, Math.round(0.4 * SR), Math.round(0.45 * SR));
  assert.ok(tailEnergy(longL) > tailEnergy(shortL) * 5);
  const [lL, lR] = makeImpulse(SR, { direction: -1, decay: 1 });
  assert.ok(rms(lL) > rms(lR) * 3, 'direction left -> left channel louder');
  const imp = new Float32Array(SR / 2); imp[0] = 1;
  const [oL] = reverb([imp, imp], SR, { decay: 1, mix: 1 });
  assert.ok(oL.length > imp.length && rms(oL, SR * 0.6, SR * 0.7) > 0);
});

test('tempo detection on a click track', async () => {
  for (const bpm of [92, 128]) {
    const x = new Float32Array(SR * 20);
    const period = (60 / bpm) * SR;
    for (let b = 0; b * period < x.length - 2000; b++) {
      const s = Math.round(b * period);
      for (let i = 0; i < 1500; i++) x[s + i] += Math.sin(i * 0.3) * Math.exp(-i / 300) * (b % 4 === 0 ? 1 : 0.6);
    }
    const est = await detectTempo(x, SR);
    assert.ok(Math.abs(est - bpm) <= 2, `${bpm} -> ${est}`);
  }
});

test('chroma window sees the chord', () => {
  const x = new Float32Array(SR);
  for (const m of [57, 60, 64]) for (let i = 0; i < x.length; i++) x[i] += Math.sin((2 * Math.PI * midiToHz(m) * i) / SR);
  const c = chromaWindow(x, SR, 0.2, 0.8);
  const top = [...c].map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((p) => p[1]).sort((a, b) => a - b);
  assert.deepEqual(top, [0, 4, 9]);
});

test('full chain renders with every effect on and caches stages', async () => {
  const x = voice(220, 1.5);
  const pitch = await detectPitch(x, SR);
  const midi = pitchToMidi(pitch.f0);
  const target = computeTargets(midi, cMajor);
  const fx = structuredClone(DEFAULT_FX);
  for (const k of Object.keys(fx)) fx[k].on = true;
  fx.harmonizer.layers = recommendHarmony(midi).layers;
  Object.assign(fx.vocoder, applyWildness({ ...fx.vocoder, ...PRESETS.vocoder.choir }, 60));
  const st = { fx, corrected: target, target, tuneVersion: 1, key: { tonic: 0, mode: 'major' }, bpm: 100 };
  const cache = {};
  const stages = [];
  const r = await renderChain({ raw: x, sampleRate: SR, pitch, backing: null }, st, cache, { onStage: (s) => { if (s !== 'analyzing') stages.push(s); } });
  assert.deepEqual(stages, ['tuned', 'harmonizer', 'vocoder', 'echo', 'reverb']);
  assert.ok(r.L.length > x.length && r.L.every(Number.isFinite) && rms(r.L) > 0.01);
  stages.length = 0;
  st.fx.reverb.mix = 0.5;
  await renderChain({ raw: x, sampleRate: SR, pitch, backing: null }, st, cache, { onStage: (s) => stages.push(s) });
  assert.deepEqual(stages, ['reverb'], 'only the changed stage re-renders');
});

test('limiter stops peaks at the ceiling and leaves quiet audio alone', async () => {
  const { limit } = await import('../src/dsp/limiter.js');
  const sr = 44100;
  const quiet = Float32Array.from({ length: sr / 2 }, (_, i) => 0.5 * Math.sin(i * 0.05));
  const q = limit([quiet], sr);
  assert.equal(q.reduced, false);
  assert.equal(q.channels[0], quiet);
  // Quiet tone with loud bursts (like WORLD's peaky output).
  const loud = Float32Array.from({ length: sr }, (_, i) => Math.sin(i * 0.05) * (i % 11025 < 2000 ? 3 : 0.5));
  const r = limit([loud, loud.map((v) => -v)], sr, { ceiling: 0.95 });
  let peak = 0;
  for (const c of r.channels) for (const v of c) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 0.95 + 1e-6, `peak ${peak}`);
  // Away from the bursts (after release) the level is restored.
  let p2 = 0;
  for (let i = 8000; i < 10500; i++) p2 = Math.max(p2, Math.abs(r.channels[0][i]));
  assert.ok(p2 > 0.45, `level after release ${p2}`);
});
