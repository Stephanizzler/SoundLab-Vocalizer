import { removeVocals, isEffectivelyMono } from './dsp/vocal-remover.js';
import { detectKey, detectTempo, NOTE_NAMES } from './dsp/key-detect.js';
import { detectPitch } from './dsp/pitch-detect.js';
import {
  pitchToMidi, computeTargets, correctPitch, TUNE_STYLES, scalePitchClasses, noteName, segmentsFrom,
} from './dsp/autotune.js';
import { parseMidi, targetsFromMidi } from './dsp/midi.js';
import { recommendHarmony, VOICES, INTERVALS } from './dsp/harmony.js';
import { encodeWav } from './dsp/wav.js';
import { toMono } from './dsp/util.js';
import { openMicrophone, createRecorder } from './audio/recorder.js';
import { PitchEditor } from './ui/pitch-editor.js';
import { Overview, peaks } from './ui/overview.js';
import { DEFAULT_FX, PRESETS, PARAMS, applyWildness } from './engine/presets.js';

const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ================================================================ state
const S = {
  ctx: null,
  screen: 'import',
  songName: '',
  song: null, // AudioBuffer as imported
  sourceKind: null, // 'project' | 'song'
  instrumental: null, // AudioBuffer the singer hears
  backing: null, // mono Float32Array of the instrumental (for analysis)
  key: { tonic: 0, mode: 'major' },
  bpm: 120,
  vocalRaw: null,
  pitch: null,
  midi: null,
  autoTarget: null,
  target: null,
  corrected: null,
  tuneVersion: 0,
  fx: clone(DEFAULT_FX),
  harmRec: null,
  pcsOverride: null, // custom scale from the note toggles
  midiNotes: null, // MIDI melody used as targets
  noteAmount: null, // per-frame overrides from the note inspector (NaN = global)
  noteVibrato: null,
  bus: null, // { L, R } processed vocal from the effects chain
  ab: 'fx',
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
const sampleRate = () => S.ctx?.sampleRate || 44100;

// ================================================================ status
function status(text, { progress = null, error = false } = {}) {
  $('statusText').textContent = text;
  $('statusText').title = text;
  $('status').classList.toggle('error', error);
  const p = $('statusProgress');
  p.hidden = progress === null;
  if (progress !== null) p.value = progress;
}
async function busy(label, fn) {
  status(label, { progress: 0 });
  try {
    return await fn((p) => status(label, { progress: p }));
  } catch (err) {
    console.error(err);
    status(`${label.replace(/…$/, '')} failed: ${err.message || err}`, { error: true });
    throw err;
  }
}

// ================================================================ screens
const STEP_ORDER = ['import', 'record', 'studio'];
function showScreen(name) {
  S.screen = name;
  for (const s of STEP_ORDER) $(`screen-${s}`).hidden = s !== name;
  document.querySelectorAll('.step').forEach((b) => {
    const idx = STEP_ORDER.indexOf(b.dataset.goto);
    b.classList.toggle('active', b.dataset.goto === name);
    b.classList.toggle('done', idx < STEP_ORDER.indexOf(name));
  });
  $('transport').hidden = name !== 'studio';
  if (name !== 'studio') stopPlayback();
  window.scrollTo({ top: 0 });
  if (name === 'studio') { editor.resize(); overview.resize(); }
}
function enableStep(name) { document.querySelector(`.step[data-goto="${name}"]`).disabled = false; }
document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => { if (!b.disabled) showScreen(b.dataset.goto); }));

// ================================================================ sliders with outputs
let syncing = false; // true while the app (not the user) moves a control
function setSlider(id, value) {
  const el = $(id);
  el.value = value;
  syncing = true;
  try { el.dispatchEvent(new Event('input')); } finally { syncing = false; }
}
const pct = (v) => `${Math.round(v * 100)}%`;
const FMT = {
  removeStrength: pct,
  latency: (v) => `${v} ms`,
  retune: (v) => (Number(v) === 0 ? 'robot' : `${v} ms`),
  tolerance: (v) => `±${v}¢`,
  amount: pct,
  humanize: pct,
  keepBends: (v) => (Number(v) === 0 ? 'off' : pct(v)),
  vibrato: pct,
  formant: (v) => (Math.abs(v - 1) < 0.005 ? 'natural' : `${v > 1 ? '+' : ''}${(12 * Math.log2(v)).toFixed(1)} st`),
  niAmount: pct,
  niVibrato: pct,
  harmMix: pct,
  bounceMusic: pct,
  bounceVocal: pct,
};
for (const [id, f] of Object.entries(FMT)) {
  const el = $(id);
  const out = el.parentElement.querySelector('output');
  const update = () => { if (out) out.textContent = f(el.value); };
  el.addEventListener('input', update);
  update();
}
$('latency').addEventListener('change', () => { S.latencyTouched = true; });

// ================================================================ 1. MUSIC
const channelsOf = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
async function decodeFile(file) {
  const data = await file.arrayBuffer();
  return audioCtx().decodeAudioData(data);
}
function makeBuffer(channels) {
  const ctx = audioCtx();
  const len = Math.max(1, ...channels.map((c) => c.length));
  const buf = ctx.createBuffer(channels.length, len, ctx.sampleRate);
  channels.forEach((c, i) => buf.copyToChannel(c, i));
  return buf;
}

async function importMusic(file, kind) {
  stopPlayback();
  let buf;
  try { buf = await busy(`Loading ${file.name}…`, () => decodeFile(file)); } catch { return; }
  S.songName = file.name.replace(/\.[^.]+$/, '');
  S.song = buf;
  S.sourceKind = kind;
  S.separatedVocal = null;
  $('trackName').textContent = file.name;
  $('importResult').hidden = false;
  const separating = kind === 'song' || kind === 'vocalfx';
  $('removeRow').hidden = !separating;
  $('previewOriginal').hidden = !separating;
  $('previewVocal').hidden = kind !== 'vocalfx';
  $('separateHint').hidden = kind !== 'vocalfx';
  $('removeLabel').textContent = kind === 'vocalfx' ? 'Vocal separation' : 'Vocal removal';
  $('removeBtn').textContent = kind === 'vocalfx' ? 'Redo separation' : 'Redo removal';
  $('previewMusic').textContent = kind === 'vocalfx' ? '▶ Music only' : '▶ Music for singing';
  $('toRecord').textContent = kind === 'vocalfx' ? 'Open the studio →' : 'Next: record your vocal →';
  // For a finished song, full separation and the original balance (music at 100%),
  // so the untouched vocal + music play back exactly like the original.
  const level = kind === 'vocalfx' ? 1 : 0.8;
  setSlider('instGain', level);
  setSlider('bounceMusic', level);
  if (kind === 'vocalfx') setSlider('removeStrength', 1);
  if (separating) {
    const ch = channelsOf(buf);
    if (ch.length < 2 || isEffectivelyMono(ch[0], ch[1])) {
      status(kind === 'vocalfx'
        ? 'This song is mono, so the vocal can\'t be separated from the music. A stereo file works best.'
        : 'This song is mono, so vocal removal won\'t work well. A stereo file or a DAW bounce works best.', { error: true });
    }
    await runVocalRemoval();
  } else {
    S.instrumental = buf;
    await analyzeMusic();
  }
}

async function runVocalRemoval() {
  if (!S.song) return;
  stopPlayback();
  const ch = channelsOf(S.song);
  const [L, R] = ch.length > 1 ? [ch[0], ch[1]] : [ch[0], ch[0]];
  const strength = Number($('removeStrength').value);
  const fx = S.sourceKind === 'vocalfx';
  try {
    const out = await busy(fx ? 'Separating the vocal from the music…' : 'Removing the vocals…', (p) => removeVocals(L, R, S.song.sampleRate, { strength, onProgress: p }));
    if (fx) {
      // The vocal is what was taken out of the centre (as mono). The music is
      // then defined as original minus that vocal, so music + untouched vocal
      // reproduces the original song exactly.
      const vocal = new Float32Array(L.length);
      for (let i = 0; i < L.length; i++) vocal[i] = ((L[i] - out[0][i]) + (R[i] - out[1][i])) * 0.5;
      for (let i = 0; i < L.length; i++) { out[0][i] = L[i] - vocal[i]; out[1][i] = R[i] - vocal[i]; }
      S.separatedVocal = vocal;
    }
    S.instrumental = makeBuffer(out);
  } catch { return; }
  await analyzeMusic();
  if (fx) {
    await loadVocal(S.separatedVocal);
    status('Vocal separated! Pick any tab to add effects. "Dry" plays the original song.');
  }
}

async function analyzeMusic() {
  S.instPeaks = null;
  S.backing = toMono(channelsOf(S.instrumental));
  const sr = sampleRate();
  try {
    const key = await busy('Finding the key…', (p) => detectKey(S.backing, sr, { onProgress: p }));
    S.key = { tonic: key.tonic, mode: key.mode };
    S.bpm = (await busy('Finding the tempo…', () => detectTempo(S.backing, sr))) || 120;
  } catch { /* keep defaults */ }
  $('bpm').value = S.bpm;
  showKey();
  renderTrackChips();
  overviewLayers();
  enableStep('record');
  if (S.sourceKind !== 'vocalfx') status(`Ready: ${keyName()} at ${S.bpm} BPM. Preview it, then record your vocal.`);
}

function keyName() { return S.key.mode === 'chromatic' ? 'Chromatic' : `${NOTE_NAMES[S.key.tonic]} ${S.key.mode}`; }
function renderTrackChips() {
  const chips = [
    { song: 'Vocals removed', vocalfx: 'Vocal separated', project: 'Project bounce' }[S.sourceKind],
    fmtTime(S.instrumental.duration),
    `Key ${keyName()}`,
    `${S.bpm} BPM`,
  ];
  $('trackChips').innerHTML = '';
  chips.forEach((c, i) => {
    const el = document.createElement('span');
    el.className = `chip${i === 2 ? ' accent' : ''}`;
    el.textContent = c;
    $('trackChips').append(el);
  });
  $('recKey').textContent = `${S.songName} · ${keyName()} · ${S.bpm} BPM`;
}

$('songFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importMusic(f, 'song'); });
$('stemFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importMusic(f, 'project'); });
$('removeBtn').addEventListener('click', runVocalRemoval);
$('mixFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importMusic(f, 'vocalfx'); });
$('toRecord').addEventListener('click', () => showScreen(S.sourceKind === 'vocalfx' && S.vocalRaw ? 'studio' : 'record'));
for (const card of document.querySelectorAll('.choice')) {
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('dragover'); });
  card.addEventListener('dragleave', () => card.classList.remove('dragover'));
  card.addEventListener('drop', (e) => {
    e.preventDefault(); card.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) importMusic(f, { songFile: 'song', mixFile: 'vocalfx', stemFile: 'project' }[card.querySelector('input').id]);
  });
}

// ================================================================ playback
const player = { sources: [], startCtx: 0, offset: 0, playing: false, raf: 0, onEnd: null, previewing: null };

function stopPlayback() {
  for (const s of player.sources) { s.onended = null; try { s.stop(); } catch { /* not started */ } }
  player.sources = [];
  if (player.playing) player.offset = currentTime();
  player.playing = false;
  player.previewing = null;
  cancelAnimationFrame(player.raf);
  $('playBtn').textContent = '▶';
  document.querySelectorAll('[data-preview]').forEach((b) => { b.textContent = b.textContent.replace('■', '▶'); });
}
function currentTime() {
  if (!player.playing) return player.offset;
  return player.offset + Math.max(0, S.ctx.currentTime - player.startCtx);
}
function startBuffers(tracks, offset, when) {
  const ctx = audioCtx();
  stopPlayback();
  for (const { buffer, gain } of tracks) {
    if (!buffer) continue;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(ctx.destination);
    if (offset < buffer.duration) src.start(when, offset);
    player.sources.push(src);
  }
  player.offset = offset;
  player.startCtx = when;
  player.playing = true;
  const last = player.sources.reduce((a, s) => (!a || s.buffer.duration > a.buffer.duration ? s : a), null);
  if (last) last.onended = () => { const cb = player.onEnd; stopPlayback(); player.offset = 0; updateTime(0); cb?.(); };
  const loop = () => { updateTime(currentTime()); player.raf = requestAnimationFrame(loop); };
  loop();
}
function totalDuration() {
  return Math.max(S.instrumental?.duration || 0, (S.vocalRaw?.length || 0) / sampleRate());
}
function updateTime(t) {
  $('timeDisplay').textContent = `${fmtTime(t, 1)} / ${fmtTime(totalDuration(), 1)}`;
  if (player.playing && !player.previewing) editor.follow(t);
  editor.setPlayhead(t);
}

const bufCache = new WeakMap();
function bufferFor(...channels) {
  const key = channels[0];
  if (!bufCache.has(key)) bufCache.set(key, makeBuffer(channels));
  return bufCache.get(key);
}
function vocalBuffer() {
  if (!S.vocalRaw) return null;
  if (S.ab === 'fx' && S.bus) return bufferFor(S.bus.L, S.bus.R);
  return bufferFor(S.vocalRaw);
}
function playMix(from = player.offset) {
  player.onEnd = null;
  startBuffers([
    { buffer: S.instrumental, gain: Number($('instGain').value) },
    { buffer: vocalBuffer(), gain: Number($('vocGain').value) },
  ], from, audioCtx().currentTime + 0.05);
  $('playBtn').textContent = '❚❚';
}
const restartIfPlaying = () => { if (player.playing && !player.previewing) playMix(currentTime()); };

$('playBtn').addEventListener('click', () => (player.playing ? stopPlayback() : playMix()));
$('stopBtn').addEventListener('click', () => { stopPlayback(); player.offset = 0; updateTime(0); });
for (const b of document.querySelectorAll('[data-preview]')) {
  b.addEventListener('click', () => {
    const wasThis = player.playing && player.previewing === b.dataset.preview;
    stopPlayback();
    if (wasThis) return;
    const buffer = b.dataset.preview === 'original' ? S.song
      : b.dataset.preview === 'vocal' ? (S.separatedVocal && bufferFor(S.separatedVocal))
        : S.instrumental;
    if (!buffer) return;
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
    restartIfPlaying();
  });
}
for (const id of ['instGain', 'vocGain']) $(id).addEventListener('change', restartIfPlaying);

// ================================================================ 2. RECORD
let rec = null;
let recTimer = 0;
const recPeaks = [];

$('hpReady').addEventListener('click', () => {
  $('hpPrompt').hidden = true;
  $('recorder').hidden = false;
  drawRecWave();
});

function drawRecWave() {
  const c = $('recWave');
  const r = c.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  const mid = r.height / 2;
  g.fillStyle = 'rgba(255,255,255,.06)';
  g.fillRect(0, mid, r.width, 1);
  const bar = 3;
  const n = Math.floor(r.width / bar);
  const grad = g.createLinearGradient(0, 0, r.width, 0);
  grad.addColorStop(0, '#8b5cf6'); grad.addColorStop(1, '#ec4899');
  g.fillStyle = grad;
  const start = Math.max(0, recPeaks.length - n);
  for (let i = start; i < recPeaks.length; i++) {
    const h = Math.max(1, Math.min(1, recPeaks[i] * 1.6) * (mid - 4));
    g.fillRect((i - start) * bar, mid - h, bar - 1, h * 2);
  }
}

$('recordBtn').addEventListener('click', async () => {
  if (rec) { finishRecording(); return; }
  if (!S.instrumental) { status('Load your music first.', { error: true }); return; }
  const ctx = audioCtx();
  await ctx.resume();
  let stream;
  try {
    stream = await openMicrophone();
  } catch (err) {
    status(`Microphone unavailable: ${err.message}. Allow mic access and try again.`, { error: true });
    return;
  }
  stopPlayback();
  recPeaks.length = 0;
  let lastDraw = 0;
  rec = await createRecorder(ctx, stream, {
    onLevel: (p) => {
      $('meterFill').style.width = `${Math.min(100, p * 100)}%`;
      if (rec?.started) recPeaks.push(p);
      const now = performance.now();
      if (now - lastDraw > 40) { drawRecWave(); lastDraw = now; }
    },
  });
  const startAt = ctx.currentTime + 0.25;
  rec.start(Math.round(startAt * ctx.sampleRate));
  rec.started = true;
  player.onEnd = () => finishRecording();
  startBuffers([{ buffer: S.instrumental, gain: Number($('instGain').value) }], 0, startAt);
  $('recordBtn').classList.add('recording');
  $('recordBtn').setAttribute('aria-label', 'Stop recording');
  $('stopRecBtn').disabled = false;
  $('recHint').textContent = 'Recording… sing along! Press stop when you\'re done.';
  status('Recording…');
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
  $('recordBtn').setAttribute('aria-label', 'Start recording');
  $('stopRecBtn').disabled = true;
  $('meterFill').style.width = '0';
  $('recHint').textContent = 'Press record to try another take.';
  const drop = Math.round((Number($('latency').value) / 1000) * S.ctx.sampleRate);
  const take = raw.slice(Math.min(drop, raw.length));
  if (take.length < S.ctx.sampleRate * 0.5) { status('That take was too short. Try again.', { error: true }); return; }
  await loadVocal(take);
}

$('vocalFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let buf;
  try { buf = await busy(`Loading ${f.name}…`, () => decodeFile(f)); } catch { return; }
  await loadVocal(toMono(channelsOf(buf)));
});

// ================================================================ vocal analysis
async function loadVocal(samples) {
  S.vocalRaw = samples;
  S.bus = null;
  const sr = sampleRate();
  try {
    S.pitch = await busy('Listening to your vocal…', (p) => detectPitch(samples, sr, { onProgress: p }));
  } catch { return; }
  S.midi = pitchToMidi(S.pitch.f0);
  S.noteAmount = new Float32Array(S.midi.length).fill(NaN);
  S.noteVibrato = new Float32Array(S.midi.length).fill(NaN);
  S.autoTarget = autoTargets();
  S.target = S.autoTarget.slice();
  S.fx.autotune.on = false;
  recomputeCorrected(false);
  editor.setData({
    t0: S.pitch.t0, hopSec: S.pitch.hopSec, midi: S.midi, target: S.target, autoTarget: S.autoTarget,
    corrected: S.corrected, duration: Math.max(samples.length / sr, S.instrumental?.duration || 0),
  });
  editor.setApplied(false);
  $('editorEmpty').hidden = true;
  $('tuneStats').hidden = true;
  $('applyTune').textContent = '✨ Auto-tune the track';
  overviewLayers();

  S.harmRec = recommendHarmony(S.midi, { hasBacking: !!S.backing });
  $('harmReason').textContent = S.harmRec.reason;
  if (!S.fx.harmonizer.layers.length) S.fx.harmonizer.layers = clone(S.harmRec.layers);
  buildLayers();

  worker.postMessage({
    type: 'load',
    src: { raw: samples, sampleRate: sr, pitch: { t0: S.pitch.t0, hopSec: S.pitch.hopSec, f0: S.pitch.f0 }, backing: S.backing },
  });
  syncAllFx();
  requestRender(0);
  enableStep('studio');
  showScreen('studio');
  player.offset = 0;
  updateTime(0);
  selectTab('autotune');
  status('Got it! Press "Auto-tune the track" to tune your vocal.');
}

function scalePcs() { return S.pcsOverride || scalePitchClasses(S.key.tonic, S.key.mode); }
function autoTargets() {
  const smoothFrames = Math.round(0.2 / S.pitch.hopSec);
  const auto = computeTargets(S.midi, scalePcs(), { smoothFrames });
  return S.midiNotes ? targetsFromMidi(S.midiNotes, S.midi, S.pitch.t0, S.pitch.hopSec, auto) : auto;
}
function tuneOpts() {
  return {
    retuneMs: Number($('retune').value),
    amount: Number($('amount').value),
    humanize: Number($('humanize').value),
    keepBends: Number($('keepBends').value),
    vibrato: Number($('vibrato').value),
    noteAmount: S.noteAmount,
    noteVibrato: S.noteVibrato,
  };
}
function recomputeCorrected(render = true) {
  if (!S.midi) return;
  S.corrected = correctPitch(S.midi, S.target, S.pitch.hopSec, tuneOpts());
  S.tuneVersion++;
  editor.setCorrected(S.corrected);
  if (render && S.fx.autotune.on) requestRender();
}
function retarget() {
  S.autoTarget = autoTargets();
  S.target = S.autoTarget.slice();
  editor.replaceTargets(S.target, S.autoTarget);
  recomputeCorrected();
}

// ================================================================ effects worker
const worker = new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' });
let renderId = 0;
let renderTimer = 0;
let pendingRender = false;
let renderQueued = false; // a request is waiting for its debounce timer
const renderWaiters = [];
const STAGE_LABEL = { tuned: 'auto-tune', harmonizer: 'harmonies', vocoder: 'vocoder', echo: 'echo', reverb: 'reverb', analyzing: 'voice analysis' };

function requestRender(delay = 300) {
  if (!S.vocalRaw) return;
  clearTimeout(renderTimer);
  setRenderChip('Waiting…', false);
  pendingRender = true;
  renderQueued = true;
  renderTimer = setTimeout(() => {
    renderQueued = false;
    renderId++;
    worker.postMessage({
      type: 'render',
      id: renderId,
      settings: {
        fx: S.fx, corrected: S.corrected, target: S.target, tuneVersion: S.tuneVersion,
        key: S.key, bpm: S.bpm,
      },
    });
  }, delay);
}
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'analysis') {
    if (!pendingRender) setRenderChip(m.p < 1 ? `Preparing Studio engine ${Math.round(m.p * 100)}%…` : 'Up to date', m.p >= 1);
    return;
  }
  if (m.id !== renderId) return;
  if (m.type === 'progress') {
    const pctText = m.stage === 'analyzing' && m.p != null ? ` ${Math.round(m.p * 100)}%` : '';
    setRenderChip(`Rendering ${STAGE_LABEL[m.stage] || m.stage}${pctText}…`, false);
  }
  else if (m.type === 'error') { setRenderChip('Render failed', true); status(`Effects failed: ${m.message}`, { error: true }); }
  else if (m.type === 'done') {
    S.bus = { L: m.L, R: m.R };
    if (!renderQueued) {
      // Only the latest request counts as "up to date".
      pendingRender = false;
      setRenderChip('Up to date', true);
      while (renderWaiters.length) renderWaiters.shift()();
    }
    if (S.ab === 'fx') restartIfPlaying();
  }
};
worker.onerror = (e) => { setRenderChip('Render failed', true); status(`Effects engine error: ${e.message}`, { error: true }); };
function whenRendered() {
  if (!pendingRender && S.bus) return Promise.resolve();
  return new Promise((r) => renderWaiters.push(r));
}
function setRenderChip(text, ready) {
  const chip = $('renderChip');
  chip.hidden = false;
  chip.classList.toggle('ready', ready);
  chip.querySelector('span').textContent = text;
}

// ================================================================ studio tabs
function selectTab(name) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  if (name === 'autotune') { editor.resize(); overview.resize(); }
  if (name === 'bounce') renderChainSummary();
}
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

function setOn(name, on) {
  S.fx[name].on = on;
  syncFx(name);
  requestRender();
}
for (const name of ['autotune', 'harmonizer', 'vocoder', 'echo', 'reverb']) {
  $(`on-${name}`).addEventListener('change', (e) => {
    if (name === 'autotune') {
      if (e.target.checked && !editor.applied) { applyTune(); return; }
      editor.setApplied(e.target.checked);
    }
    setOn(name, e.target.checked);
  });
}
function syncTabDots() {
  for (const name of Object.keys(S.fx)) {
    document.querySelector(`[data-tab="${name}"] .dot`)?.classList.toggle('on', !!S.fx[name].on);
    const sw = $(`on-${name}`);
    if (sw) sw.checked = !!S.fx[name].on;
  }
}

// ================================================================ AUTO-TUNE tab
for (const [i, n] of NOTE_NAMES.entries()) $('keyTonic').add(new Option(n, i));
function showKey() {
  $('keyTonic').value = S.key.tonic;
  $('keyMode').value = S.key.mode;
  editor.setScale(scalePcs());
  renderScaleNotes();
}
function renderScaleNotes() {
  const wrap = $('scaleNotes');
  const pcs = scalePcs();
  wrap.innerHTML = '';
  for (let k = 0; k < 12; k++) {
    const pc = (S.key.tonic + k) % 12;
    const b = document.createElement('button');
    b.textContent = NOTE_NAMES[pc];
    b.className = `${pcs.includes(pc) ? 'on' : ''} ${NOTE_NAMES[pc].includes('#') ? 'black' : ''}`;
    b.title = pcs.includes(pc) ? `Remove ${NOTE_NAMES[pc]} from the scale` : `Add ${NOTE_NAMES[pc]} to the scale`;
    b.addEventListener('click', () => {
      const cur = new Set(scalePcs());
      if (cur.has(pc)) { if (cur.size > 1) cur.delete(pc); } else cur.add(pc);
      S.pcsOverride = [...cur].sort((x, y) => x - y);
      showKey();
      if (S.midi) { retarget(); status(`Scale notes: ${S.pcsOverride.map((p) => NOTE_NAMES[p]).join(' ')}`); }
    });
    wrap.append(b);
  }
}
function onKeyChanged() {
  S.key = { tonic: Number($('keyTonic').value), mode: $('keyMode').value };
  S.pcsOverride = null;
  showKey();
  renderTrackChips();
  if (S.midi) {
    retarget();
    requestRender();
    status(`Key set to ${keyName()}. Auto-tune re-applied (Undo restores your edits).`);
  }
}
$('keyTonic').addEventListener('change', onKeyChanged);
$('keyMode').addEventListener('change', onKeyChanged);

let scanRaf = 0;
function applyTune() {
  if (!S.midi) return;
  cancelAnimationFrame(scanRaf);
  if (editor.applied) retarget(); // re-scan = back to automatic
  S.fx.autotune.on = true;
  syncTabDots();
  editor.setApplied(true);
  editor.zoomFit();
  requestRender(0);
  // Scan animation: the graph fills in left to right as the take is "listened to".
  const dur = editor.duration;
  const animMs = Math.min(6000, Math.max(2200, dur * 180));
  const t0 = performance.now();
  $('applyTune').disabled = true;
  status('Auto-tuning: scanning your vocal…');
  const step = (now) => {
    const p = Math.min(1, (now - t0) / animMs);
    editor.setReveal(p * dur);
    if (p < 1) { scanRaf = requestAnimationFrame(step); return; }
    editor.setReveal(Infinity);
    $('applyTune').disabled = false;
    $('applyTune').textContent = '↻ Re-scan';
    showTuneStats();
  };
  scanRaf = requestAnimationFrame(step);
}
$('applyTune').addEventListener('click', applyTune);

function showTuneStats() {
  const tol = Number($('tolerance').value) / 100;
  const segs = segmentsFrom(S.autoTarget);
  let off = 0, sumCents = 0, nCorr = 0;
  for (const seg of segs) {
    const dev = [];
    for (let i = seg.start; i < seg.end; i++) dev.push(Math.abs(S.midi[i] - seg.note));
    dev.sort((a, b) => a - b);
    if (dev[dev.length >> 1] > tol) off++;
  }
  for (let i = 0; i < S.midi.length; i++) {
    if (Number.isNaN(S.midi[i]) || Number.isNaN(S.corrected[i])) continue;
    const c = Math.abs(S.corrected[i] - S.midi[i]);
    if (c > 0.03) { sumCents += c * 100; nCorr++; }
  }
  const avg = nCorr ? Math.round(sumCents / nCorr) : 0;
  $('tuneStats').hidden = false;
  $('tuneStats').textContent = off
    ? `Fixed ${off} of ${segs.length} notes that were off-key (average correction ${avg}¢). The corrections are drawn in cyan. Click or drag on the graph to fine-tune.`
    : `Nice! All ${segs.length} notes were close; small corrections averaging ${avg}¢ were applied.`;
  status('Auto-tune applied. Press play to hear it.');
}

// Correction style + parameters
function setStyle(name) {
  const st = TUNE_STYLES[name];
  for (const [id, key] of [['retune', 'retuneMs'], ['humanize', 'humanize'], ['keepBends', 'keepBends'], ['vibrato', 'vibrato'], ['amount', 'amount']]) setSlider(id, st[key]);
  markStyle(name);
  recomputeCorrected();
}
function markStyle(name) {
  document.querySelectorAll('[data-style]').forEach((b) => b.classList.toggle('active', b.dataset.style === name));
  $('styleCustom').hidden = !!name;
}
document.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => setStyle(b.dataset.style)));
function markEngine() {
  document.querySelectorAll('[data-engine]').forEach((b) => b.classList.toggle('active', b.dataset.engine === S.fx.autotune.engine));
}
document.querySelectorAll('[data-engine]').forEach((b) => b.addEventListener('click', () => {
  S.fx.autotune.engine = b.dataset.engine;
  markEngine();
  requestRender(0);
  status(b.dataset.engine === 'studio' ? 'Studio engine: cleanest sound, renders in the background.' : 'Classic engine: instant renders.');
}));
markEngine();
$('formant').addEventListener('input', () => { S.fx.autotune.formant = Number($('formant').value); });
$('formant').addEventListener('change', () => requestRender());
markStyle('pop');
for (const id of ['retune', 'amount', 'humanize', 'keepBends', 'vibrato']) {
  $(id).addEventListener('input', () => { if (!syncing) markStyle(null); recomputeCorrected(); });
}

// MIDI melody -> target notes
$('midiFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f || !S.midi) { if (f) status('Record a vocal first.', { error: true }); return; }
  try {
    const notes = parseMidi(await f.arrayBuffer());
    if (!notes.length) throw new Error('no notes found');
    S.midiNotes = notes;
  } catch (err) {
    status(`Couldn't read that MIDI file: ${err.message}`, { error: true });
    return;
  }
  if (editor.applied) retarget(); else applyTune();
  status(`Using ${S.midiNotes.length} notes from ${f.name} as targets. "Reset to auto" goes back to the key.`);
});

// Note inspector: per-note correction and vibrato
let inspected = null;
function inspect(seg) {
  inspected = seg;
  $('noteInspector').hidden = !seg;
  if (!seg) return;
  const note = Math.round(S.target[seg.start]);
  $('niTitle').textContent = `${noteName(note)} · ${fmtTime(S.pitch.t0 + seg.start * S.pitch.hopSec, 2)}–${fmtTime(S.pitch.t0 + seg.end * S.pitch.hopSec, 2)}`;
  const a = S.noteAmount[seg.start], v = S.noteVibrato[seg.start];
  setSlider('niAmount', Number.isNaN(a) ? Number($('amount').value) : a);
  setSlider('niVibrato', Number.isNaN(v) ? Number($('vibrato').value) : v);
}
for (const [id, key] of [['niAmount', 'noteAmount'], ['niVibrato', 'noteVibrato']]) {
  $(id).addEventListener('input', () => {
    if (!inspected || syncing) return;
    S[key].fill(Number($(id).value), inspected.start, inspected.end);
    recomputeCorrected();
  });
}
$('niReset').addEventListener('click', () => {
  if (!inspected) return;
  S.noteAmount.fill(NaN, inspected.start, inspected.end);
  S.noteVibrato.fill(NaN, inspected.start, inspected.end);
  inspect(inspected);
  recomputeCorrected();
});
$('niClose').addEventListener('click', () => editor.select(null));
$('tolerance').addEventListener('input', () => editor.setTolerance(Number($('tolerance').value)));
$('reautoBtn').addEventListener('click', () => {
  if (!S.midi) return;
  S.midiNotes = null;
  S.pcsOverride = null;
  S.noteAmount.fill(NaN); S.noteVibrato.fill(NaN);
  editor.select(null);
  showKey();
  retarget();
  status('Back to automatic tuning in the song key (Undo restores your edits).');
});

const editor = new PitchEditor($('editor'), {
  onLiveEdit: (target) => {
    S.target = target;
    S.corrected = correctPitch(S.midi, S.target, S.pitch.hopSec, tuneOpts());
    editor.setCorrected(S.corrected);
  },
  onEdit: (target) => { S.target = target; recomputeCorrected(); },
  onSeek: (t) => {
    player.offset = t;
    if (player.playing && !player.previewing) playMix(t); else updateTime(t);
  },
  onNeedApply: () => status('Press "Auto-tune the track" first, then you can edit the corrections.'),
  onSelect: (seg) => inspect(seg),
  onHover: (h) => {
    if (!h) { $('readout').textContent = ''; return; }
    const parts = [fmtTime(h.t, 2)];
    if (h.sung !== null) {
      const ref = h.target ?? Math.round(h.sung);
      const cents = Math.round((h.sung - ref) * 100);
      parts.push(`sung ${noteName(h.sung)} ${cents >= 0 ? '+' : ''}${cents}¢`);
      if (h.target !== null && editor.applied) parts.push(`→ ${noteName(h.target)}`);
    } else parts.push(noteName(h.cursor));
    $('readout').textContent = parts.join(' · ');
  },
});
editor.setTolerance(Number($('tolerance').value));
const overview = new Overview($('overview'), editor);
function overviewLayers() {
  const sr = sampleRate();
  if (S.instrumental && !S.instPeaks) S.instPeaks = peaks(S.backing || S.instrumental.getChannelData(0));
  if (S.vocalRaw) S.vocalPeaks = peaks(S.vocalRaw);
  overview.setLayers([
    S.instrumental && { peaks: S.instPeaks, duration: S.instrumental.duration, color: '--text-muted', alpha: 0.3 },
    S.vocalRaw && { peaks: S.vocalPeaks, duration: S.vocalRaw.length / sr, color: '--accent', alpha: 0.6 },
  ].filter(Boolean));
}

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

// ================================================================ HARMONIZER tab
const LAYER_COLORS = ['#22d3ee', '#f472b6', '#a3e635', '#fbbf24'];
const EXTRA_LAYERS = [
  { interval: 'smart-above', voice: 'natural', level: 0.6, pan: -0.45, humanize: 0.4 },
  { interval: 'smart-below', voice: 'natural', level: 0.5, pan: 0.45, humanize: 0.45 },
  { interval: 'octave-below', voice: 'male', level: 0.35, pan: 0, humanize: 0.3 },
  { interval: 'fifth-above', voice: 'female', level: 0.35, pan: 0.75, humanize: 0.5 },
];

function buildLayers() {
  const h = S.fx.harmonizer;
  const wrap = $('harmLayers');
  wrap.innerHTML = '';
  document.querySelectorAll('#harmCount button').forEach((b) => b.classList.toggle('active', Number(b.dataset.count) === h.layers.length));
  h.layers.forEach((layer, i) => {
    const card = document.createElement('div');
    card.className = 'layer';
    card.innerHTML = `<h4><i style="background:${LAYER_COLORS[i]}"></i>Harmony ${i + 1}</h4>`;
    const sel = (label, key, options) => {
      const l = document.createElement('label');
      l.innerHTML = `<span>${label}</span>`;
      const s = document.createElement('select');
      for (const [v, t] of options) s.add(new Option(t, v));
      s.value = layer[key];
      s.addEventListener('change', () => { layer[key] = s.value; harmChanged(); });
      l.append(s, document.createElement('span'));
      card.append(l);
    };
    const range = (label, key, min, max, step, fmt) => {
      const l = document.createElement('label');
      l.innerHTML = `<span>${label}</span>`;
      const r = Object.assign(document.createElement('input'), { type: 'range', min, max, step, value: layer[key] });
      const o = document.createElement('output');
      o.textContent = fmt(layer[key]);
      r.addEventListener('input', () => { layer[key] = Number(r.value); o.textContent = fmt(layer[key]); });
      r.addEventListener('change', harmChanged);
      l.append(r, o);
      card.append(l);
    };
    sel('Interval', 'interval', Object.entries(INTERVALS).map(([k, v]) => [k, v.label]));
    sel('Voice', 'voice', Object.entries(VOICES).map(([k, v]) => [k, v.label]));
    range('Level', 'level', 0, 1, 0.01, pct);
    range('Pan', 'pan', -1, 1, 0.05, (v) => (Math.abs(v) < 0.05 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`));
    range('Feel', 'humanize', 0, 1, 0.05, (v) => (v < 0.25 ? 'Tight' : v < 0.65 ? 'Natural' : 'Loose'));
    wrap.append(card);
  });
}
function harmChanged() {
  S.fx.harmonizer.on = true;
  syncFx('harmonizer');
  requestRender();
}
document.querySelectorAll('#harmCount button').forEach((b) => b.addEventListener('click', () => {
  const n = Number(b.dataset.count);
  const layers = S.fx.harmonizer.layers;
  while (layers.length > n) layers.pop();
  while (layers.length < n) layers.push(clone(EXTRA_LAYERS[layers.length]));
  buildLayers();
  harmChanged();
}));
$('harmMix').addEventListener('input', () => { S.fx.harmonizer.mix = Number($('harmMix').value); });
$('harmMix').addEventListener('change', () => requestRender());
$('harmRecommendBtn').addEventListener('click', () => {
  if (!S.harmRec) { status('Record a vocal first.', { error: true }); return; }
  S.fx.harmonizer.layers = clone(S.harmRec.layers);
  buildLayers();
  harmChanged();
  status('Recommended harmony added. Press play to hear it.');
});

// ================================================================ VOCODER / ECHO / REVERB tabs
const paramRefs = {};
function buildFxPanel(name) {
  const presetsEl = $(`presets-${name}`);
  for (const [id, p] of Object.entries(PRESETS[name])) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.preset = id;
    b.innerHTML = `<b>${p.icon}</b><span>${p.label}</span>`;
    b.addEventListener('click', () => applyPreset(name, id));
    presetsEl.append(b);
  }
  const paramsEl = $(`params-${name}`);
  paramRefs[name] = [];
  for (const def of PARAMS[name]) {
    const row = document.createElement('label');
    row.className = 'param';
    row.innerHTML = `<span>${def.label}</span>`;
    let input;
    const out = document.createElement('output');
    if (def.type === 'select') {
      input = document.createElement('select');
      for (const [v, t] of def.options) input.add(new Option(t, v));
      input.addEventListener('change', () => setParam(name, def.id, def.number ? Number(input.value) : input.value));
    } else if (def.type === 'toggle') {
      input = Object.assign(document.createElement('input'), { type: 'checkbox' });
      input.addEventListener('change', () => setParam(name, def.id, input.checked));
    } else {
      input = Object.assign(document.createElement('input'), { type: 'range', min: def.min, max: def.max, step: def.step });
      input.addEventListener('input', () => { S.fx[name][def.id] = Number(input.value); out.textContent = def.fmt(Number(input.value)); markCustom(name); syncRoom(); });
      input.addEventListener('change', () => setParam(name, def.id, Number(input.value)));
    }
    row.append(input, out);
    paramsEl.append(row);
    paramRefs[name].push({ def, row, input, out });
  }
}
function applyPreset(name, id) {
  const { label, icon, ...values } = PRESETS[name][id];
  void label; void icon;
  let fx = { ...S.fx[name], ...values, preset: id, on: true };
  if (name === 'vocoder') fx = applyWildness(fx, values.wildness);
  S.fx[name] = fx;
  syncFx(name);
  requestRender(100);
}
function setParam(name, id, value) {
  S.fx[name][id] = value;
  markCustom(name);
  S.fx[name].on = true;
  syncFx(name);
  requestRender();
}
function markCustom(name) {
  S.fx[name].preset = 'custom';
  document.querySelectorAll(`#presets-${name} .preset`).forEach((b) => b.classList.remove('active'));
}
function syncFx(name) {
  const fx = S.fx[name];
  if (name === 'harmonizer') { $('harmMix').value = fx.mix; $('harmMix').dispatchEvent(new Event('input')); }
  document.querySelectorAll(`#presets-${name} .preset`).forEach((b) => b.classList.toggle('active', b.dataset.preset === fx.preset));
  for (const { def, row, input, out } of paramRefs[name] || []) {
    if (def.type === 'toggle') input.checked = !!fx[def.id];
    else input.value = fx[def.id];
    if (def.fmt) out.textContent = def.fmt(Number(fx[def.id]));
    row.hidden = def.showIf ? !def.showIf(fx) : false;
  }
  if (name === 'vocoder') { $('wildness').value = fx.wildness; $('wildnessOut').textContent = `${fx.wildness}%`; }
  if (name === 'reverb') syncRoom();
  syncTabDots();
}
function syncAllFx() { for (const n of Object.keys(S.fx)) syncFx(n); }

$('wildness').addEventListener('input', () => {
  const w = Number($('wildness').value);
  S.fx.vocoder = applyWildness(S.fx.vocoder, w);
  $('wildnessOut').textContent = `${w}%`;
});
$('wildness').addEventListener('change', () => { S.fx.vocoder.on = true; syncFx('vocoder'); requestRender(); });
$('bpm').addEventListener('change', () => {
  S.bpm = Math.min(240, Math.max(40, Number($('bpm').value) || 120));
  $('bpm').value = S.bpm;
  renderTrackChips();
  if (S.fx.echo.on) requestRender();
});

/** Top-down room picture: size of the room and where the sound comes from. */
function syncRoom() {
  const r = S.fx.reverb;
  const w = 70 + r.size * 130, h = 50 + r.size * 90;
  const rect = $('roomRect');
  rect.setAttribute('x', 110 - w / 2); rect.setAttribute('y', 145 - h);
  rect.setAttribute('width', w); rect.setAttribute('height', h);
  const ang = (r.direction * Math.PI) / 2.4;
  const dist = h * 0.62;
  const sx = 110 + Math.sin(ang) * dist, sy = 132 - Math.cos(ang) * dist;
  $('roomSource').setAttribute('cx', sx); $('roomSource').setAttribute('cy', sy);
  const waves = $('roomWaves');
  waves.innerHTML = '';
  const rings = 1 + Math.round(r.decay);
  for (let k = 1; k <= Math.min(5, rings); k++) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    p.setAttribute('cx', sx); p.setAttribute('cy', sy); p.setAttribute('r', 8 + k * 9);
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'var(--fix)'); p.setAttribute('stroke-width', '1.2');
    p.setAttribute('opacity', String((0.7 - k * 0.12) * (1 - r.damping * 0.4)));
    waves.append(p);
  }
}

// ================================================================ BOUNCE tab
function renderChainSummary() {
  const wrap = $('chainSummary');
  wrap.innerHTML = '';
  const names = { autotune: 'Auto-Tune', harmonizer: 'Harmonizer', vocoder: 'Vocoder', echo: 'Echo', reverb: 'Reverb' };
  const add = (text, cls) => { const el = document.createElement('span'); el.className = cls; el.textContent = text; wrap.append(el); };
  add('🎤 Your vocal', 'chip accent');
  for (const [k, label] of Object.entries(names)) {
    add('→', 'arrow');
    const fx = S.fx[k];
    let detail = '';
    if (k === 'harmonizer' && fx.on) detail = ` (${fx.layers.length} layer${fx.layers.length > 1 ? 's' : ''})`;
    else if (fx.on && fx.preset && PRESETS[k]?.[fx.preset]) detail = ` (${PRESETS[k][fx.preset].label})`;
    add(label + detail, `chip ${fx.on ? '' : 'off'}`);
  }
  add('+', 'arrow');
  add('🎵 Music', 'chip accent');
}

$('bounceBtn').addEventListener('click', async () => {
  if (!S.vocalRaw || !S.instrumental) { status('You need music and a vocal to bounce.', { error: true }); return; }
  stopPlayback();
  $('bounceBtn').disabled = true;
  status('Bouncing: finishing effects…', { progress: 0.2 });
  await whenRendered();
  status('Bouncing: mixing…', { progress: 0.7 });
  await new Promise((r) => setTimeout(r, 30));
  const gm = Number($('bounceMusic').value), gv = Number($('bounceVocal').value);
  const inst = channelsOf(S.instrumental);
  const iL = inst[0], iR = inst[1] || inst[0];
  const { L: vL, R: vR } = S.bus;
  const len = Math.max(iL.length, vL.length);
  const L = new Float32Array(len), R = new Float32Array(len);
  let peak = 0;
  for (let i = 0; i < len; i++) {
    L[i] = (iL[i] || 0) * gm + (vL[i] || 0) * gv;
    R[i] = (iR[i] || 0) * gm + (vR[i] || 0) * gv;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const ceiling = 0.89; // -1 dBFS
  if (peak > ceiling) { const g = ceiling / peak; for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; } }
  const sr = sampleRate();
  const mixUrl = URL.createObjectURL(new Blob([encodeWav([L, R], sr)], { type: 'audio/wav' }));
  const vocUrl = URL.createObjectURL(new Blob([encodeWav([vL, vR], sr)], { type: 'audio/wav' }));
  const base = S.songName || 'SoundLab';
  $('bounceAudio').src = mixUrl;
  Object.assign($('dlMix'), { href: mixUrl, download: `${base} - SoundLab mix.wav` });
  Object.assign($('dlVocal'), { href: vocUrl, download: `${base} - SoundLab vocal.wav` });
  $('bounceResult').hidden = false;
  $('bounceBtn').disabled = false;
  status(`Bounced! ${fmtTime(len / sr)} stereo track ready to play or download.`);
});

// ================================================================ keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (S.screen !== 'studio') return;
  const k = e.key.toLowerCase();
  const onTune = !$('tab-autotune').hidden;
  if (onTune && (e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); return; }
  if (onTune && (e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); editor.redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space' && e.target !== $('editor')) { e.preventDefault(); if (player.playing) stopPlayback(); else playMix(); return; }
  if (!onTune) return;
  if (k === 'escape' || k === 'enter') { editor.endChain(); return; }
  const tools = { n: 'note', l: 'line', d: 'draw', b: 'bypass', r: 'restore', h: 'pan' };
  if (tools[k]) selectTool(tools[k]);
  else if (k === '+' || k === '=') editor.zoomTime(0.5);
  else if (k === '-') editor.zoomTime(2);
  else if (k === '0') editor.zoomFit();
});

// ================================================================ init
function fmtTime(t, dec = 0) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0')}`;
}

for (const n of ['vocoder', 'echo', 'reverb']) buildFxPanel(n);
showKey();
syncAllFx();
buildLayers();
showScreen('import');

// Expose for debugging in the console.
window.soundlab = { state: S, editor, overview, whenRendered };
