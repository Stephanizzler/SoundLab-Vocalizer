import { removeVocals, isEffectivelyMono } from './dsp/vocal-remover.js';
import { detectKey, NOTE_NAMES } from './dsp/key-detect.js';
import { detectPitch } from './dsp/pitch-detect.js';
import {
  pitchToMidi, computeTargets, applyRetune, scalePitchClasses, noteName, segmentsFrom,
} from './dsp/autotune.js';
import { psola } from './dsp/psola.js';
import { encodeWav } from './dsp/wav.js';
import { toMono } from './dsp/util.js';
import { openMicrophone, createRecorder } from './audio/recorder.js';
import { PitchEditor } from './ui/pitch-editor.js';
import { Overview, peaks } from './ui/overview.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
const S = {
  ctx: null,
  songName: '',
  song: null, // AudioBuffer as imported
  instrumental: null, // AudioBuffer with vocals removed (or stem)
  key: { tonic: 0, mode: 'major' },
  vocalRaw: null, // Float32Array mono
  vocalTuned: null, // Float32Array mono
  pitch: null, // { t0, hopSec, f0, ... }
  midi: null,
  autoTarget: null,
  target: null,
  corrected: null,
  ab: 'tuned',
  latencyTouched: false,
};

function audioCtx() {
  if (!S.ctx) {
    S.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (!S.latencyTouched) {
      const est = Math.round(((S.ctx.outputLatency || 0) + (S.ctx.baseLatency || 0)) * 1000 + 15);
      setSlider('latency', Math.min(400, est));
    }
  }
  if (S.ctx.state === 'suspended') S.ctx.resume();
  return S.ctx;
}

// ---------------------------------------------------------------- status
let busyCount = 0;
function status(text, { progress = null, error = false } = {}) {
  $('statusText').textContent = text;
  $('statusText').title = text;
  $('status').classList.toggle('error', error);
  const p = $('statusProgress');
  p.hidden = progress === null;
  if (progress !== null) p.value = progress;
}
async function busy(label, fn) {
  busyCount++;
  status(label, { progress: 0 });
  try {
    return await fn((p) => status(label, { progress: p }));
  } catch (err) {
    console.error(err);
    status(`${label.replace(/…$/, '')} failed: ${err.message || err}`, { error: true });
    throw err;
  } finally {
    busyCount--;
  }
}
function unlock(...ids) { for (const id of ids) $(id).classList.remove('locked'); }

// ---------------------------------------------------------------- sliders
function setSlider(id, value) {
  const el = $(id);
  el.value = value;
  el.dispatchEvent(new Event('input'));
}
const fmt = {
  removeStrength: (v) => `${Math.round(v * 100)}%`,
  latency: (v) => `${v} ms`,
  retune: (v) => (Number(v) === 0 ? 'robot' : `${v} ms`),
  tolerance: (v) => `±${v}¢`,
  amount: (v) => `${Math.round(v * 100)}%`,
};
for (const [id, f] of Object.entries(fmt)) {
  const el = $(id);
  const out = el.parentElement.querySelector('output');
  const update = () => { if (out) out.textContent = f(el.value); };
  el.addEventListener('input', update);
  update();
}
$('latency').addEventListener('change', () => { S.latencyTouched = true; });

// ---------------------------------------------------------------- key UI
for (const [i, n] of NOTE_NAMES.entries()) $('keyTonic').add(new Option(n, i));
function showKey() {
  $('keyTonic').value = S.key.tonic;
  $('keyMode').value = S.key.mode;
  $('keyResult').textContent = S.key.mode === 'chromatic' ? 'Chromatic' : `${NOTE_NAMES[S.key.tonic]} ${S.key.mode}`;
  editor.setScale(scalePitchClasses(S.key.tonic, S.key.mode));
}
function onKeyChanged() {
  S.key = { tonic: Number($('keyTonic').value), mode: $('keyMode').value };
  showKey();
  if (S.midi) {
    retarget();
    status(`Key set to ${$('keyResult').textContent}. Auto-tune re-applied (Undo restores your edits).`);
  }
}
$('keyTonic').addEventListener('change', onKeyChanged);
$('keyMode').addEventListener('change', onKeyChanged);
$('detectKeyBtn').addEventListener('click', () => runKeyDetection());

async function runKeyDetection() {
  const src = S.instrumental ? toMono(channelsOf(S.instrumental)) : S.vocalRaw;
  if (!src) return;
  const sr = audioCtx().sampleRate;
  const key = await busy('Detecting key…', (p) => detectKey(src, sr, { onProgress: p }));
  S.key = { tonic: key.tonic, mode: key.mode };
  showKey();
  if (S.midi) retarget();
  const sure = key.confidence > 0.05 ? '' : ' (low confidence, double-check it)';
  status(`Detected key: ${key.name}${sure}.`);
}

// ---------------------------------------------------------------- import
const channelsOf = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));

async function decodeFile(file) {
  const ctx = audioCtx();
  const data = await file.arrayBuffer();
  return ctx.decodeAudioData(data);
}

function makeBuffer(channels) {
  const ctx = audioCtx();
  const len = Math.max(...channels.map((c) => c.length));
  const buf = ctx.createBuffer(channels.length, Math.max(1, len), ctx.sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  return buf;
}

async function importSong(file, isStem) {
  stopPlayback();
  const buf = await busy(`Loading ${file.name}…`, () => decodeFile(file));
  S.songName = file.name.replace(/\.[^.]+$/, '');
  S.song = buf;
  const dur = fmtTime(buf.duration);
  if (isStem) {
    S.instrumental = buf;
    $('removeRow').hidden = true;
    $('songInfo').textContent = `Instrumental: ${file.name} · ${dur}`;
    $('previewInstrumental').hidden = false;
    $('previewOriginal').hidden = true;
  } else {
    S.instrumental = null;
    $('removeRow').hidden = false;
    $('previewOriginal').hidden = false;
    $('previewInstrumental').hidden = true;
    const mono = buf.numberOfChannels < 2 || isEffectivelyMono(buf.getChannelData(0), buf.getChannelData(1));
    $('songInfo').textContent = `Song: ${file.name} · ${dur}` +
      (mono ? ' · ⚠ This file is mono. Vocal removal needs a stereo mix, so you may want a DAW instrumental instead.' : '');
  }
  $('previewRow').hidden = false;
  if (isStem) await afterInstrumentalReady();
  else status('Song loaded. Click "Remove vocals".');
}

async function runVocalRemoval() {
  if (!S.song) return;
  stopPlayback();
  const ch = channelsOf(S.song);
  const [L, R] = ch.length > 1 ? [ch[0], ch[1]] : [ch[0], ch[0]];
  const strength = Number($('removeStrength').value);
  const out = await busy('Removing vocals…', (p) => removeVocals(L, R, S.song.sampleRate, { strength, onProgress: p }));
  S.instrumental = makeBuffer(out);
  $('previewInstrumental').hidden = false;
  await afterInstrumentalReady();
}

async function afterInstrumentalReady() {
  S.instPeaks = peaks(S.instrumental.getChannelData(0));
  updateOverview();
  unlock('stepKey', 'stepRecord', 'stepTune', 'stepExport');
  editor.duration = Math.max(editor.duration, S.instrumental.duration);
  if (!S.vocalRaw) { editor.duration = S.instrumental.duration; editor.zoomFit(); }
  updateTime(0);
  await runKeyDetection();
  status(`${$('keyResult').textContent}. Put on headphones and hit Record.`);
}

$('songFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importSong(f, false); e.target.value = ''; });
$('stemFile').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importSong(f, true); e.target.value = ''; });
$('removeBtn').addEventListener('click', runVocalRemoval);
for (const drop of document.querySelectorAll('.drop')) {
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) importSong(f, drop.querySelector('input').id === 'stemFile');
  });
}

// ---------------------------------------------------------------- playback
const player = { sources: [], startCtx: 0, offset: 0, playing: false, raf: 0, onEnd: null, previewing: null };

function stopPlayback() {
  for (const s of player.sources) { s.onended = null; try { s.stop(); } catch { /* not started */ } }
  player.sources = [];
  if (player.playing) player.offset = currentTime();
  player.playing = false;
  cancelAnimationFrame(player.raf);
  $('playBtn').textContent = '▶ Play';
  document.querySelectorAll('[data-preview]').forEach((b) => { b.textContent = b.textContent.replace('■', '▶'); });
}

function currentTime() {
  if (!player.playing) return player.offset;
  return player.offset + (S.ctx.currentTime - player.startCtx);
}

/** Start buffers together at `when` (ctx time) from `offset` seconds. */
function startBuffers(tracks, offset, when) {
  const ctx = audioCtx();
  stopPlayback();
  player.previewing = null;
  let longest = 0;
  for (const { buffer, gain } of tracks) {
    if (!buffer) continue;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(ctx.destination);
    if (offset < buffer.duration) src.start(when, offset);
    player.sources.push(src);
    longest = Math.max(longest, buffer.duration);
  }
  player.offset = offset;
  player.startCtx = when;
  player.playing = true;
  player.duration = longest;
  const last = player.sources.reduce((a, s) => (!a || s.buffer.duration > a.buffer.duration ? s : a), null);
  if (last) last.onended = () => { const cb = player.onEnd; stopPlayback(); player.offset = 0; updateTime(0); cb?.(); };
  const loop = () => {
    const t = currentTime();
    updateTime(t);
    player.raf = requestAnimationFrame(loop);
  };
  loop();
}

function updateTime(t) {
  const total = Math.max(S.instrumental?.duration || 0, (S.vocalRaw?.length || 0) / (S.ctx?.sampleRate || 44100));
  $('timeDisplay').textContent = `${fmtTime(t, 1)} / ${fmtTime(total, 1)}`;
  if (player.playing) editor.follow(t);
  editor.setPlayhead(t);
}

let vocalBufferCache = { key: null, buf: null };
function vocalBuffer() {
  const data = S.ab === 'tuned' && S.vocalTuned ? S.vocalTuned : S.vocalRaw;
  if (!data) return null;
  if (vocalBufferCache.key !== data) vocalBufferCache = { key: data, buf: makeBuffer([data]) };
  return vocalBufferCache.buf;
}

function playMix(from = player.offset) {
  player.onEnd = null;
  const ctx = audioCtx();
  startBuffers([
    { buffer: S.instrumental, gain: Number($('instGain').value) },
    { buffer: vocalBuffer(), gain: Number($('vocGain').value) },
  ], from, ctx.currentTime + 0.05);
  $('playBtn').textContent = '❚❚ Pause';
}

$('playBtn').addEventListener('click', () => (player.playing ? stopPlayback() : playMix()));
$('stopBtn').addEventListener('click', () => { stopPlayback(); player.offset = 0; updateTime(0); });
for (const b of document.querySelectorAll('[data-preview]')) {
  b.addEventListener('click', () => {
    const wasThis = player.playing && player.previewing === b.dataset.preview;
    stopPlayback();
    if (wasThis) return;
    const buffer = b.dataset.preview === 'original' ? S.song : S.instrumental;
    player.onEnd = null;
    startBuffers([{ buffer, gain: 1 }], 0, audioCtx().currentTime + 0.05);
    player.previewing = b.dataset.preview;
    b.textContent = b.textContent.replace('▶', '■');
  });
}
for (const b of document.querySelectorAll('[data-ab]')) {
  b.addEventListener('click', () => {
    S.ab = b.dataset.ab;
    document.querySelectorAll('[data-ab]').forEach((x) => x.classList.toggle('active', x === b));
    if (player.playing && !player.previewing) playMix(currentTime());
  });
}
for (const id of ['instGain', 'vocGain']) {
  $(id).addEventListener('change', () => { if (player.playing && !player.previewing) playMix(currentTime()); });
}

// ---------------------------------------------------------------- recording
let rec = null;
let recTimer = 0;

$('recordBtn').addEventListener('click', async () => {
  if (rec) return;
  const ctx = audioCtx();
  await ctx.resume();
  let stream;
  try {
    stream = await openMicrophone();
  } catch (err) {
    status(`Microphone unavailable: ${err.message}. Allow mic access in your browser and try again.`, { error: true });
    return;
  }
  stopPlayback();
  const meter = $('meterFill');
  rec = await createRecorder(ctx, stream, { onLevel: (p) => { meter.style.width = `${Math.min(100, p * 100)}%`; } });
  const startAt = ctx.currentTime + 0.25;
  rec.start(Math.round(startAt * ctx.sampleRate));
  player.onEnd = () => finishRecording();
  if (S.instrumental) startBuffers([{ buffer: S.instrumental, gain: Number($('instGain').value) }], 0, startAt);
  $('recordBtn').classList.add('recording');
  $('recordBtn').textContent = '● Recording…';
  $('stopRecBtn').disabled = false;
  status('Recording… sing along! Press Stop when done.');
  const t0 = performance.now();
  recTimer = setInterval(() => { $('recTime').textContent = fmtTime((performance.now() - t0) / 1000); }, 200);
});
$('stopRecBtn').addEventListener('click', () => finishRecording());

async function finishRecording() {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearInterval(recTimer);
  player.onEnd = null;
  stopPlayback();
  player.offset = 0;
  const raw = await r.stop();
  $('recordBtn').classList.remove('recording');
  $('recordBtn').textContent = '● Record';
  $('stopRecBtn').disabled = true;
  $('meterFill').style.width = '0';
  // Latency compensation: what was sung at song time t arrives `latency` later.
  const drop = Math.round((Number($('latency').value) / 1000) * S.ctx.sampleRate);
  const take = raw.slice(Math.min(drop, raw.length));
  if (take.length < S.ctx.sampleRate * 0.5) { status('That take was too short. Try again.', { error: true }); return; }
  await loadVocal(take);
}

$('vocalFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const buf = await busy(`Loading ${f.name}…`, () => decodeFile(f));
  unlock('stepKey', 'stepRecord', 'stepTune', 'stepExport');
  await loadVocal(toMono(channelsOf(buf)));
  if (!S.instrumental) await runKeyDetection();
});

// ---------------------------------------------------------------- tuning
async function loadVocal(samples) {
  S.vocalRaw = samples;
  S.vocalTuned = null;
  S.vocalPeaks = peaks(samples);
  const sr = S.ctx.sampleRate;
  S.pitch = await busy('Analyzing your pitch…', (p) => detectPitch(samples, sr, { onProgress: p }));
  S.midi = pitchToMidi(S.pitch.f0);
  S.autoTarget = autoTargets();
  S.target = S.autoTarget.slice();
  recomputeCorrected();
  $('editorEmpty').hidden = true;
  editor.setData({
    t0: S.pitch.t0, hopSec: S.pitch.hopSec, midi: S.midi, target: S.target, autoTarget: S.autoTarget,
    corrected: S.corrected, duration: Math.max(samples.length / sr, S.instrumental?.duration || 0),
  });
  updateOverview();
  await render();
  const off = countOffKey();
  const total = segmentsFrom(S.autoTarget).length;
  status(`Tuned! ${off} of ${total} notes were off-key (red/amber). Press Play to hear it, or edit the graph.`);
}

/** Number of sung notes whose typical (median) pitch is outside tolerance. */
function countOffKey() {
  const tol = Number($('tolerance').value) / 100;
  let off = 0;
  for (const seg of segmentsFrom(S.autoTarget)) {
    const dev = [];
    for (let i = seg.start; i < seg.end; i++) dev.push(Math.abs(S.midi[i] - seg.note));
    dev.sort((a, b) => a - b);
    if (dev[dev.length >> 1] > tol) off++;
  }
  return off;
}

function autoTargets() {
  const smoothFrames = Math.round(0.2 / S.pitch.hopSec); // ~one vibrato cycle
  return computeTargets(S.midi, scalePitchClasses(S.key.tonic, S.key.mode), { smoothFrames });
}

function recomputeCorrected() {
  if (!S.midi) return;
  S.corrected = applyRetune(S.midi, S.target, S.pitch.hopSec, Number($('retune').value), Number($('amount').value));
  editor.setCorrected(S.corrected);
}

function retarget() {
  const auto = autoTargets();
  S.autoTarget = auto;
  S.target = auto.slice();
  editor.replaceTargets(S.target, S.autoTarget);
  recomputeCorrected();
  scheduleRender();
}

let renderTimer = 0;
let renderSeq = 0;
function scheduleRender(delay = 250) {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, delay);
}
async function render() {
  if (!S.vocalRaw) return;
  const seq = ++renderSeq;
  status('Rendering tuned vocal…', { progress: null });
  await new Promise((r) => setTimeout(r, 0));
  const out = psola(S.vocalRaw, S.ctx.sampleRate, S.pitch, S.corrected);
  if (seq !== renderSeq) return;
  S.vocalTuned = out;
  status('Tuned vocal ready.');
  if (player.playing && !player.previewing && S.ab === 'tuned') playMix(currentTime());
}

const editor = new PitchEditor($('editor'), {
  onLiveEdit: (target) => { S.target = target; recomputeCorrected(); },
  onEdit: (target) => { S.target = target; recomputeCorrected(); scheduleRender(); },
  onSeek: (t) => {
    player.offset = t;
    if (player.playing && !player.previewing) playMix(t); else updateTime(t);
  },
  onHover: (h) => {
    if (!h) { $('readout').textContent = ''; return; }
    const parts = [fmtTime(h.t, 2)];
    if (h.sung !== null) {
      const ref = h.target ?? Math.round(h.sung);
      const cents = Math.round((h.sung - ref) * 100);
      parts.push(`sung ${noteName(h.sung)} ${cents >= 0 ? '+' : ''}${cents}¢`);
      if (h.target !== null) parts.push(`→ ${noteName(h.target)}`);
    } else parts.push(`cursor ${noteName(h.cursor)}`);
    $('readout').textContent = parts.join('  ·  ');
  },
});
showKey();
const overview = new Overview($('overview'), editor);
function updateOverview() {
  const sr = S.ctx?.sampleRate || 44100;
  overview.setLayers([
    S.instrumental && { peaks: S.instPeaks, duration: S.instrumental.duration, color: '--text-muted', alpha: 0.35 },
    S.vocalRaw && { peaks: S.vocalPeaks, duration: S.vocalRaw.length / sr, color: '--accent', alpha: 0.55 },
  ].filter(Boolean));
}

for (const id of ['retune', 'amount']) {
  $(id).addEventListener('input', () => { recomputeCorrected(); scheduleRender(400); });
}
$('tolerance').addEventListener('input', () => editor.setTolerance(Number($('tolerance').value)));
editor.setTolerance(Number($('tolerance').value));
$('reautoBtn').addEventListener('click', () => { if (S.midi) { retarget(); status('Back to automatic tuning (Undo restores your edits).'); } });

// Tools
function selectTool(tool) {
  editor.setTool(tool);
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => selectTool(b.dataset.tool)));
selectTool('note');
$('snap').addEventListener('change', (e) => { editor.snap = e.target.checked; });
$('showBlocks').addEventListener('change', (e) => editor.setShowBlocks(e.target.checked));
$('undoBtn').addEventListener('click', () => editor.undo());
$('redoBtn').addEventListener('click', () => editor.redo());
$('zoomIn').addEventListener('click', () => editor.zoomTime(0.5));
$('zoomOut').addEventListener('click', () => editor.zoomTime(2));
$('zoomFit').addEventListener('click', () => editor.zoomFit());

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); editor.redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === 'escape' || k === 'enter') { editor.endChain(); return; }
  const tools = { n: 'note', l: 'line', d: 'draw', b: 'bypass', r: 'restore', h: 'pan' };
  if (tools[k]) selectTool(tools[k]);
  else if (k === '+' || k === '=') editor.zoomTime(0.5);
  else if (k === '-') editor.zoomTime(2);
  else if (k === '0') editor.zoomFit();
  else if (e.code === 'Space' && e.target !== $('editor') && S.instrumental) { e.preventDefault(); if (player.playing) stopPlayback(); else playMix(); }
});

// ---------------------------------------------------------------- export
function download(buf, name) {
  const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const baseName = () => S.songName || 'soundlab';

$('exportVocal').addEventListener('click', () => {
  const v = S.vocalTuned || S.vocalRaw;
  if (!v) { status('Record a vocal first.', { error: true }); return; }
  download(encodeWav([v], S.ctx.sampleRate), `${baseName()} - tuned vocal.wav`);
});
$('exportMix').addEventListener('click', () => {
  const v = S.vocalTuned || S.vocalRaw;
  if (!v || !S.instrumental) { status('You need both music and a vocal to export a mix.', { error: true }); return; }
  const gi = Number($('instGain').value), gv = Number($('vocGain').value);
  const inst = channelsOf(S.instrumental);
  const len = Math.max(inst[0].length, v.length);
  const L = new Float32Array(len), R = new Float32Array(len);
  const iL = inst[0], iR = inst[1] || inst[0];
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const vs = (v[i] || 0) * gv;
    L[i] = (iL[i] || 0) * gi + vs;
    R[i] = (iR[i] || 0) * gi + vs;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  if (peak > 0.99) { const g = 0.99 / peak; for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; } }
  download(encodeWav([L, R], S.ctx.sampleRate), `${baseName()} - SoundLab mix.wav`);
});

// ---------------------------------------------------------------- helpers
function fmtTime(t, dec = 0) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0')}`;
}

// Expose for debugging in the console.
window.soundlab = { state: S, editor, overview };
