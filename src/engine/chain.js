import { psola } from '../dsp/psola.js';
import { renderHarmony } from '../dsp/harmony.js';
import { vocode } from '../dsp/vocoder.js';
import { echo, noteToMs } from '../dsp/echo.js';
import { reverb } from '../dsp/reverb.js';
import { chromaWindow } from '../dsp/key-detect.js';
import { pitchToMidi, scalePitchClasses } from '../dsp/autotune.js';
import { tick } from '../dsp/util.js';

export const STAGES = ['tuned', 'harmonizer', 'vocoder', 'echo', 'reverb'];

async function stage(cache, name, key, onStage, fn) {
  if (cache[name] && cache[name].key === key) return cache[name].value;
  onStage(name);
  await tick();
  const value = fn();
  cache[name] = { key, value };
  return value;
}

/**
 * Vocal chain: Auto-Tune -> Harmonizer -> Vocoder -> Echo -> Reverb.
 * Each stage's output is cached by a key of everything upstream, so changing
 * the reverb only re-renders the reverb.
 *
 * src: { raw, sampleRate, pitch, backing }
 * st:  { fx, corrected, target, tuneVersion, key: {tonic, mode}, bpm }
 * Returns { tuned, L, R } or null when aborted by a newer request.
 */
export async function renderChain(src, st, cache, { onStage = () => {}, aborted = () => false } = {}) {
  const { raw, sampleRate: sr, pitch, backing } = src;
  const { fx } = st;
  if (!cache.midi) cache.midi = pitchToMidi(pitch.f0);
  const midi = cache.midi;
  const mode = st.key.mode === 'chromatic' ? 'major' : st.key.mode;
  const pcs = scalePitchClasses(st.key.tonic, mode);
  const base = fx.autotune.on ? st.corrected : midi;

  let key = `t:${fx.autotune.on}:${st.tuneVersion}`;
  const tuned = await stage(cache, 'tuned', key, onStage, () => (fx.autotune.on ? psola(raw, sr, pitch, st.corrected) : raw));
  if (aborted()) return null;

  key += `|h:${JSON.stringify(fx.harmonizer)}:${st.key.tonic}${mode}`;
  const harm = await stage(cache, 'harmonizer', key, onStage, () => {
    const h = fx.harmonizer;
    if (!h.on || !h.layers.length) return [tuned, tuned];
    const chromaFor = backing
      ? (seg) => chromaWindow(backing, sr, pitch.t0 + seg.start * pitch.hopSec, pitch.t0 + seg.end * pitch.hopSec)
      : null;
    const [hl, hr] = renderHarmony(raw, sr, pitch, base, st.target, h.layers, { pcs, chromaFor });
    const len = Math.max(tuned.length, hl.length);
    const L = new Float32Array(len), R = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const d = i < tuned.length ? tuned[i] : 0;
      L[i] = d + (hl[i] || 0) * h.mix;
      R[i] = d + (hr[i] || 0) * h.mix;
    }
    return [L, R];
  });
  if (aborted()) return null;

  key += `|v:${JSON.stringify(fx.vocoder)}`;
  const voc = await stage(cache, 'vocoder', key, onStage, () => {
    const v = fx.vocoder;
    if (!v.on) return harm;
    return vocode(harm, sr, {
      ...v,
      pitch: { t0: pitch.t0, hopSec: pitch.hopSec, midi: base },
      pcs,
      droneMidi: 48 + st.key.tonic,
    });
  });
  if (aborted()) return null;

  key += `|e:${JSON.stringify(fx.echo)}:${st.bpm}`;
  const ech = await stage(cache, 'echo', key, onStage, () => {
    const e = fx.echo;
    if (!e.on) return voc;
    const timeMs = e.sync === 'ms' ? e.timeMs : noteToMs(e.sync, st.bpm || 120);
    return echo(voc, sr, { ...e, timeMs });
  });
  if (aborted()) return null;

  key += `|r:${JSON.stringify(fx.reverb)}`;
  const rev = await stage(cache, 'reverb', key, onStage, () => (fx.reverb.on ? reverb(ech, sr, fx.reverb) : ech));
  if (aborted()) return null;

  return { tuned, L: rev[0], R: rev[1] };
}
