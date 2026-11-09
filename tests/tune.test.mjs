import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctPitch, smoothPitch, TUNE_STYLES } from '../src/dsp/autotune.js';
import { parseMidi, targetsFromMidi } from '../src/dsp/midi.js';

const HOP = 0.01;
// A held note: 40 cents sharp of A4 with ±30 cent 5.5 Hz vibrato, 2 s long.
const sung = Float32Array.from({ length: 200 }, (_, i) => 69.4 + 0.3 * Math.sin(2 * Math.PI * 5.5 * i * HOP));
const target = new Float32Array(200).fill(69);
const range = (a) => { let lo = Infinity, hi = -Infinity; for (const v of a) { lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

test('smoothPitch removes vibrato but keeps the centre', () => {
  const s = smoothPitch(sung, target, HOP).slice(30, 170);
  assert.ok(range(s) < 0.12, `residual vibrato ${range(s)}`);
  assert.ok(Math.abs(mean(s) - 69.4) < 0.02);
});

test('hard tune is flat and exactly on the note', () => {
  const out = correctPitch(sung, target, HOP, TUNE_STYLES.hard);
  for (const v of out) assert.ok(Math.abs(v - 69) < 0.08, `got ${v}`);
});

test('vibrato control keeps, removes or deepens vibrato around the target', () => {
  const opts = { retuneMs: 0, humanize: 0 };
  const keep = correctPitch(sung, target, HOP, { ...opts, vibrato: 1 }).slice(30, 170);
  const none = correctPitch(sung, target, HOP, { ...opts, vibrato: 0 }).slice(30, 170);
  const more = correctPitch(sung, target, HOP, { ...opts, vibrato: 2 }).slice(30, 170);
  assert.ok(Math.abs(mean(keep) - 69) < 0.03, 'centred on the target');
  assert.ok(range(keep) > 0.45 && range(keep) < 0.7, `kept vibrato ${range(keep)}`);
  assert.ok(range(none) < 0.15);
  assert.ok(range(more) > range(keep) * 1.7);
});

test('keep bends leaves big deliberate deviations alone', () => {
  // A slow scoop: 1.5 semitones below the target, rising onto it.
  const scoop = Float32Array.from({ length: 100 }, (_, i) => 67.5 + Math.min(1.5, i * 0.03));
  const tg = new Float32Array(100).fill(69);
  const off = correctPitch(scoop, tg, HOP, { retuneMs: 0, keepBends: 0, vibrato: 1 });
  const on = correctPitch(scoop, tg, HOP, { retuneMs: 0, keepBends: 1, vibrato: 1 });
  assert.ok(Math.abs(off[5] - 69) < 0.1, 'without keep-bends the scoop is flattened');
  assert.ok(Math.abs(on[5] - scoop[5]) < 0.15, `with keep-bends the scoop stays (${on[5]} vs ${scoop[5]})`);
  assert.ok(Math.abs(on[99] - 69) < 0.1, 'and the landing note is still tuned');
});

test('humanize corrects sustained parts more slowly than the attack', () => {
  // Pitch drifts flat late in a long note.
  const drift = Float32Array.from({ length: 150 }, (_, i) => (i < 100 ? 69 : 69 - 0.5));
  const tg = new Float32Array(150).fill(69);
  const tight = correctPitch(drift, tg, HOP, { retuneMs: 10, humanize: 0, vibrato: 1 });
  const human = correctPitch(drift, tg, HOP, { retuneMs: 10, humanize: 1, vibrato: 1 });
  assert.ok(Math.abs(tight[115] - 69) < Math.abs(human[115] - 69), 'humanized lets the late drift through more');
});

test('per-note overrides apply only to that note', () => {
  const noteAmount = new Float32Array(200).fill(NaN);
  noteAmount.fill(0, 0, 100);
  const out = correctPitch(sung, target, HOP, { retuneMs: 0, vibrato: 0, noteAmount });
  assert.ok(Math.abs(out[50] - 69.4) < 0.1, 'first half untouched');
  assert.ok(Math.abs(out[150] - 69) < 0.1, 'second half corrected');
});

function smf(events, tempoUspq = 500000, division = 480) {
  // events: [deltaTicks, bytes[]]
  const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
  const body = [0, 0xff, 0x51, 3, (tempoUspq >> 16) & 255, (tempoUspq >> 8) & 255, tempoUspq & 255];
  for (const [d, bytes] of events) body.push(...vlq(d), ...bytes);
  body.push(0, 0xff, 0x2f, 0);
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, division >> 8, division & 255, 0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body]).buffer;
}

test('MIDI melody becomes targets in the singer\'s octave', () => {
  // 120 BPM: a quarter note = 0.5 s. C5 for a beat, then (running status) E5 for a beat.
  const buf = smf([[0, [0x90, 72, 100]], [480, [0x80, 72, 0]], [0, [0x90, 76, 90]], [480, [76, 0]]]);
  const notes = parseMidi(buf);
  assert.deepEqual(notes.map((n) => [n.midi, +n.start.toFixed(3), +n.end.toFixed(3)]), [[72, 0, 0.5], [76, 0.5, 1]]);
  const sungLow = new Float32Array(100).fill(60.3); // singing an octave lower
  sungLow[90] = NaN;
  const t = targetsFromMidi(notes, sungLow, 0, HOP, new Float32Array(100).fill(55));
  assert.equal(t[10], 60, 'C5 moved down to the sung octave');
  assert.equal(t[70], 64);
  assert.equal(t[90], 55, 'unvoiced frames keep fallback');
});
