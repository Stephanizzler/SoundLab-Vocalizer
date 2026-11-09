import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch } from '../src/dsp/pitch-detect.js';
import { pitchToMidi, hzToMidi } from '../src/dsp/autotune.js';
import { studioAnalyze, studioRender } from '../src/dsp/studio-engine.js';
import { stoneMask } from '../src/dsp/world.js';

const SR = 44100;
// Voice-like source: glottal-ish harmonic series through two formant resonances.
function vowel(f0, sec, { formants = [700, 1200], sr = SR } = {}) {
  const out = new Float32Array(Math.round(sec * sr));
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const f = typeof f0 === 'function' ? f0(i / sr) : f0;
    ph += (2 * Math.PI * f) / sr;
    let s = 0;
    for (let h = 1; h * f < 6000; h++) {
      const fh = h * f;
      const g = formants.reduce((acc, F) => acc + 1 / (1 + ((fh - F) / 120) ** 2), 0.05);
      s += (g / h ** 0.5) * Math.sin(h * ph);
    }
    out[i] = 0.08 * s;
  }
  return out;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const pitchOf = async (x) => hzToMidi(median([...(await detectPitch(x, SR)).f0].filter((v) => v > 0)));
const rms = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

function spectralCentroid(x, sr) {
  // crude: energy-weighted frequency from a DFT of one 4096 chunk
  const N = 4096, st = Math.floor(x.length / 2) - N / 2;
  let num = 0, den = 0;
  for (let k = 1; k < N / 2; k += 2) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N); re += x[st + n] * w * Math.cos((2 * Math.PI * k * n) / N); im -= x[st + n] * w * Math.sin((2 * Math.PI * k * n) / N); }
    const p = re * re + im * im;
    num += p * (k * sr) / N; den += p;
  }
  return num / den;
}

test('StoneMask refines a rough F0 estimate', () => {
  const x = vowel(203.7, 0.5);
  const pos = Float64Array.from([0.2, 0.25, 0.3]);
  const refined = stoneMask(x, SR, pos, Float64Array.from([195, 210, 200]));
  for (const f of refined) assert.ok(Math.abs(f - 203.7) < 1, `refined ${f}`);
});

test('studio engine: resynthesis keeps pitch, level and timbre', async () => {
  const x = vowel(220, 1.2);
  const pitch = await detectPitch(x, SR);
  const an = studioAnalyze(x, SR, pitch);
  const same = studioRender(an, x, pitch, pitchToMidi(pitch.f0));
  assert.deepEqual(same, x, 'untouched phrases are the original audio');
  // Force resynthesis with a tiny shift to test the vocoder itself.
  const y = studioRender(an, x, pitch, pitchToMidi(pitch.f0).map((m) => m + 0.01));
  assert.equal(y.length, x.length);
  assert.ok(Math.abs((await pitchOf(y)) - hzToMidi(220)) < 0.1);
  const ratio = rms(y, 8000, 45000) / rms(x, 8000, 45000);
  assert.ok(ratio > 0.7 && ratio < 1.4, `level ratio ${ratio.toFixed(2)}`);
  const cx = spectralCentroid(x, SR), cy = spectralCentroid(y, SR);
  assert.ok(Math.abs(cy - cx) / cx < 0.15, `centroid ${cx.toFixed(0)} -> ${cy.toFixed(0)}`);
});

test('studio engine: shifts pitch while keeping formants; formant control moves them', async () => {
  const x = vowel(220, 1.2);
  const pitch = await detectPitch(x, SR);
  const an = studioAnalyze(x, SR, pitch);
  const midi = pitchToMidi(pitch.f0);
  for (const semis of [3, -4]) {
    const y = studioRender(an, x, pitch, midi.map((m) => m + semis));
    const got = await pitchOf(y);
    assert.ok(Math.abs(got - (hzToMidi(220) + semis)) < 0.12, `shift ${semis}: ${got.toFixed(2)}`);
  }
  // Formant control: find the second formant peak (1.2 kHz) in the output's envelope.
  const peakNear = async (y) => {
    const a2 = studioAnalyze(y, SR, await detectPitch(y, SR));
    const env = a2.spectrogram[Math.floor(a2.spectrogram.length / 2)];
    let best = 0, bk = 0;
    for (let k = 0; k < env.length; k++) { const f = (k * SR) / a2.fftSize; if (f > 1000 && f < 2000 && env[k] > best) { best = env[k]; bk = f; } }
    return bk;
  };
  const natural = await peakNear(studioRender(an, x, pitch, midi.map((m) => m + 3)));
  const up = await peakNear(studioRender(an, x, pitch, midi.map((m) => m + 3), { formant: 1.25 }));
  // Harmonics are ~260 Hz apart after the shift, so a formant can only be located to about half that.
  assert.ok(Math.abs(natural - 1200) < 140, `formant stays near 1200 Hz after pitch shift: ${natural.toFixed(0)}`);
  assert.ok(up / natural > 1.12 && up / natural < 1.4, `formant x1.25 moves it up: ${natural.toFixed(0)} -> ${up.toFixed(0)}`);
});

test('studio engine speed on a 10 s take', async () => {
  const x = vowel((t) => 196 * 2 ** (Math.sin(t * 2) * 0.2), 10);
  const pitch = await detectPitch(x, SR);
  let t = performance.now();
  const an = studioAnalyze(x, SR, pitch);
  const tA = performance.now() - t;
  const cache = new Map();
  const tuned = pitchToMidi(pitch.f0).map((m) => Math.round(m));
  t = performance.now();
  studioRender(an, x, pitch, tuned, { cache });
  const tR = performance.now() - t;
  t = performance.now();
  studioRender(an, x, pitch, tuned, { cache });
  const tC = performance.now() - t;
  console.log(`# analysis ${(tA / 1000).toFixed(1)} s, render ${(tR / 1000).toFixed(1)} s, cached re-render ${(tC / 1000).toFixed(2)} s for 10 s of audio`);
  assert.ok(tA < 60000 && tR < 60000);
});
