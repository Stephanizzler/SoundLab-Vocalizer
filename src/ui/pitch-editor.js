import { clamp } from '../dsp/util.js';
import { NOTE_NAMES } from '../dsp/key-detect.js';
import { noteName, pitchClass, segmentsFrom } from '../dsp/autotune.js';

const GUTTER = 56; // piano keys on the left
const RULER = 24; // time ruler on top
const MIN_SPAN_T = 0.25;
const MIN_SPAN_M = 5;
const BLACK = new Set([1, 3, 6, 8, 10]);

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Editable pitch graph ("piano roll" of the vocal).
 *
 *  - grey/green/amber/red line: what was sung (coloured by how far off it is)
 *  - blue blocks: target notes the vocal is tuned to
 *  - white line: resulting tuned pitch
 *
 * Tools: note (click/drag a note block to where it should be), line (place
 * dots joined by straight lines), draw (pencil), bypass (leave the original
 * pitch), restore (back to auto-tune), pan.
 */
export class PitchEditor {
  constructor(canvas, { onEdit, onLiveEdit, onSeek, onHover, onNeedApply, onSelect } = {}) {
    this.onNeedApply = onNeedApply;
    this.onSelect = onSelect;
    this.selected = null;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onEdit = onEdit;
    this.onLiveEdit = onLiveEdit;
    this.onSeek = onSeek;
    this.onHover = onHover;
    this.tool = 'note';
    this.snap = true;
    this.toleranceCents = 25;
    this.pcs = [0, 2, 4, 5, 7, 9, 11];
    this.playhead = 0;
    this.duration = 10;
    this.view = { t0: 0, t1: 10, m0: 48, m1: 72 };
    this.data = null;
    this.undoStack = [];
    this.redoStack = [];
    this.drag = null;
    this.hover = null;
    this.spaceHeld = false;
    this.showBlocks = true;
    this.applied = true; // false = raw take only, before "Auto-tune the track"
    this.reveal = Infinity; // scan position in seconds while auto-tuning animates
    this.chain = null; // active Line-tool anchor chain
    this.viewListeners = [];

    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.pointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.pointerUp(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.onHover?.(null); this.draw(); });
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('dblclick', () => this.endChain());
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === canvas) { this.spaceHeld = true; e.preventDefault(); } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceHeld = false; });
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.draw());
    this.resize();
  }

  // ---------- data ----------
  setData({ t0, hopSec, midi, target, autoTarget, corrected, duration }) {
    this.data = { t0, hopSec, midi, target, autoTarget, corrected };
    this.selected = null;
    this.chain = null;
    this.duration = duration;
    this.undoStack = [];
    this.redoStack = [];
    this.zoomFit();
  }
  setCorrected(corrected) { if (this.data) { this.data.corrected = corrected; this.draw(); } }
  setScale(pcs) { this.pcs = pcs; this.draw(); }
  setTolerance(c) { this.toleranceCents = c; this.draw(); }
  setPlayhead(t) { this.playhead = t; this.draw(); }
  /** Select a note (frame range) for the note inspector; null clears. */
  select(seg) {
    this.selected = seg;
    this.onSelect?.(seg);
    this.draw();
  }
  setApplied(on) { this.applied = on; if (!on) this.endChain(); this.draw(); }
  setReveal(t) { this.reveal = t; this.draw(); }
  setTool(t) {
    if (t !== 'line') this.endChain();
    this.tool = t;
    this.canvas.dataset.tool = t;
  }
  setShowBlocks(on) { this.showBlocks = on; this.draw(); }
  onViewChange(fn) { this.viewListeners.push(fn); }

  /** Finish the current Line-tool chain (Enter, Esc, double-click or tool change). */
  endChain() {
    if (!this.chain) return;
    this.chain = null;
    this.draw();
  }

  replaceTargets(target, autoTarget) {
    this.chain = null;
    this.pushUndo();
    this.data.target = target;
    if (autoTarget) this.data.autoTarget = autoTarget;
    this.draw();
  }

  pushUndo() {
    this.undoStack.push(this.data.target.slice());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    if (!this.data || !this.undoStack.length) return false;
    this.chain = null;
    this.redoStack.push(this.data.target);
    this.data.target = this.undoStack.pop();
    this.onEdit?.(this.data.target);
    return true;
  }
  redo() {
    if (!this.data || !this.redoStack.length) return false;
    this.chain = null;
    this.undoStack.push(this.data.target);
    this.data.target = this.redoStack.pop();
    this.onEdit?.(this.data.target);
    return true;
  }

  // ---------- view ----------
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  zoomFit() {
    const v = this.view;
    v.t0 = 0; v.t1 = Math.max(MIN_SPAN_T, this.duration);
    let lo = Infinity, hi = -Infinity;
    if (this.data) for (const m of this.data.midi) if (!Number.isNaN(m)) { lo = Math.min(lo, m); hi = Math.max(hi, m); }
    if (lo === Infinity) { lo = 55; hi = 72; }
    v.m0 = Math.floor(lo) - 3; v.m1 = Math.ceil(hi) + 3;
    if (v.m1 - v.m0 < 12) { const c = (v.m0 + v.m1) / 2; v.m0 = c - 6; v.m1 = c + 6; }
    this.draw();
  }

  zoomTime(factor, centerT = (this.view.t0 + this.view.t1) / 2) {
    const v = this.view;
    const span = clamp((v.t1 - v.t0) * factor, MIN_SPAN_T, Math.max(MIN_SPAN_T, this.duration));
    const frac = (centerT - v.t0) / (v.t1 - v.t0);
    v.t0 = centerT - frac * span; v.t1 = v.t0 + span;
    this.clampView(); this.draw();
  }

  zoomPitch(factor, centerM = (this.view.m0 + this.view.m1) / 2) {
    const v = this.view;
    const span = clamp((v.m1 - v.m0) * factor, MIN_SPAN_M, 72);
    const frac = (centerM - v.m0) / (v.m1 - v.m0);
    v.m0 = centerM - frac * span; v.m1 = v.m0 + span;
    this.clampView(); this.draw();
  }

  pan(dt, dm) {
    const v = this.view;
    v.t0 += dt; v.t1 += dt; v.m0 += dm; v.m1 += dm;
    this.clampView(); this.draw();
  }

  clampView() {
    const v = this.view;
    const spanT = v.t1 - v.t0;
    if (v.t0 < 0) { v.t0 = 0; v.t1 = spanT; }
    if (v.t1 > Math.max(this.duration, spanT)) { v.t1 = Math.max(this.duration, spanT); v.t0 = v.t1 - spanT; }
    const spanM = v.m1 - v.m0;
    if (v.m0 < 24) { v.m0 = 24; v.m1 = 24 + spanM; }
    if (v.m1 > 108) { v.m1 = 108; v.m0 = 108 - spanM; }
  }

  /** Keep the playhead visible during playback. */
  follow(t) {
    const v = this.view;
    if (t > v.t1 || t < v.t0) { const span = v.t1 - v.t0; v.t0 = t - span * 0.1; v.t1 = v.t0 + span; this.clampView(); }
  }

  tx(t) { return GUTTER + ((t - this.view.t0) / (this.view.t1 - this.view.t0)) * (this.w - GUTTER); }
  xt(x) { return this.view.t0 + ((x - GUTTER) / (this.w - GUTTER)) * (this.view.t1 - this.view.t0); }
  my(m) { return RULER + ((this.view.m1 - m) / (this.view.m1 - this.view.m0)) * (this.h - RULER); }
  ym(y) { return this.view.m1 - ((y - RULER) / (this.h - RULER)) * (this.view.m1 - this.view.m0); }
  frameTime(i) { return this.data.t0 + i * this.data.hopSec; }
  timeFrame(t) {
    const i = Math.round((t - this.data.t0) / this.data.hopSec);
    return clamp(i, 0, this.data.midi.length - 1);
  }

  // ---------- interaction ----------
  localPos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  pointerDown(e) {
    this.canvas.focus({ preventScroll: true });
    const { x, y } = this.localPos(e);
    this.canvas.setPointerCapture(e.pointerId);
    if (y < RULER) { this.drag = { kind: 'seek' }; this.onSeek?.(clamp(this.xt(x), 0, this.duration)); return; }
    if (e.button === 1 || e.button === 2 || this.tool === 'pan' || this.spaceHeld || x < GUTTER) {
      this.drag = { kind: 'pan', x, y, view: { ...this.view } };
      return;
    }
    if (!this.data) return;
    if (!this.applied) { this.onNeedApply?.(); return; }
    const t = this.xt(x), m = this.ym(y);
    const i = this.timeFrame(t);

    if (this.tool === 'line') { this.lineDown(x, y); return; }

    if (this.tool === 'note') {
      const seg = this.segmentAt(i);
      this.select(seg);
      if (!seg) return;
      this.pushUndo();
      // Clicking a "dot" where the note should be moves the block there
      // immediately; keep dragging to move it further.
      this.drag = { kind: 'note', seg };
      this.applyNote(seg, Math.round(m));
      return;
    }
    this.pushUndo();
    this.drag = { kind: 'paint', lastI: i, lastM: m };
    this.paint(i, m, i, m);
  }

  pointerMove(e) {
    const { x, y } = this.localPos(e);
    if (this.data && x >= GUTTER && y >= RULER) {
      const t = this.xt(x), m = this.ym(y);
      const i = this.timeFrame(t);
      this.hover = { x, y, t, m, i };
      const sung = this.data.midi[i];
      this.onHover?.({ t, cursor: m, sung: Number.isNaN(sung) ? null : sung, target: Number.isNaN(this.data.target[i]) ? null : this.data.target[i] });
    }
    const d = this.drag;
    if (!d) { this.draw(); return; }
    if (d.kind === 'seek') { this.onSeek?.(clamp(this.xt(x), 0, this.duration)); return; }
    if (d.kind === 'pan') {
      const dt = ((x - d.x) / (this.w - GUTTER)) * (d.view.t1 - d.view.t0);
      const dm = ((y - d.y) / (this.h - RULER)) * (d.view.m1 - d.view.m0);
      Object.assign(this.view, d.view);
      this.pan(-dt, dm);
      return;
    }
    const t = this.xt(x), m = this.ym(y);
    const i = this.timeFrame(t);
    if (d.kind === 'note') { this.applyNote(d.seg, Math.round(m)); return; }
    if (d.kind === 'anchor') {
      const a = this.chain.anchors[d.k];
      a.t = clamp(t, 0, this.duration);
      a.m = this.snap ? Math.round(m) : m;
      this.applyChain();
      return;
    }
    if (d.kind === 'paint') {
      this.paint(d.lastI, d.lastM, i, m);
      d.lastI = i; d.lastM = m;
    }
  }

  pointerUp(e) {
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    const d = this.drag;
    this.drag = null;
    if (d && (d.kind === 'paint' || d.kind === 'note' || d.kind === 'anchor')) this.onEdit?.(this.data.target);
  }

  wheel(e) {
    e.preventDefault();
    const { x, y } = this.localPos(e);
    const scale = Math.exp((e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) * 0.0015);
    if (e.ctrlKey || e.metaKey) this.zoomTime(scale, this.xt(x));
    else if (e.altKey) this.zoomPitch(scale, this.ym(y));
    else {
      const v = this.view;
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      const dy = e.shiftKey ? 0 : e.deltaY;
      this.pan((dx / (this.w - GUTTER)) * (v.t1 - v.t0), (-dy / (this.h - RULER)) * (v.m1 - v.m0) * 0.5);
    }
  }

  // ---------- Line tool: dots joined by straight pitch lines ----------
  lineDown(x, y) {
    if (!this.chain) this.chain = { base: this.data.target.slice(), anchors: [] };
    this.pushUndo();
    const hit = this.anchorHit(x, y);
    if (hit >= 0) { this.drag = { kind: 'anchor', k: hit }; return; }
    const m = this.ym(y);
    this.chain.anchors.push({ t: this.xt(x), m: this.snap ? Math.round(m) : m });
    this.drag = { kind: 'anchor', k: this.chain.anchors.length - 1 };
    this.applyChain();
  }

  anchorHit(x, y) {
    if (!this.chain) return -1;
    const as = this.chain.anchors;
    for (let k = as.length - 1; k >= 0; k--) {
      if (Math.hypot(this.tx(as[k].t) - x, this.my(as[k].m) - y) <= 9) return k;
    }
    return -1;
  }

  /** Re-apply every segment of the chain on top of the targets it started from. */
  applyChain() {
    const { midi, target } = this.data;
    const { base, anchors } = this.chain;
    target.set(base);
    for (let k = 1; k < anchors.length; k++) {
      let a = anchors[k - 1], b = anchors[k];
      if (a.t > b.t) [a, b] = [b, a];
      const i0 = this.timeFrame(a.t), i1 = this.timeFrame(b.t);
      for (let j = i0; j <= i1; j++) {
        if (Number.isNaN(midi[j])) continue;
        const f = i1 === i0 ? 0 : (j - i0) / (i1 - i0);
        target[j] = a.m + (b.m - a.m) * f;
      }
    }
    this.onLiveEdit?.(target);
    this.draw();
  }

  segmentAt(i) {
    const tg = this.data.target;
    // Allow clicking slightly beside a note.
    let k = -1;
    for (let r = 0; r <= 4 && k < 0; r++) {
      if (i - r >= 0 && !Number.isNaN(tg[i - r])) k = i - r;
      else if (i + r < tg.length && !Number.isNaN(tg[i + r])) k = i + r;
    }
    if (k < 0) return null;
    const note = Math.round(tg[k]);
    let s = k, e = k + 1;
    while (s > 0 && !Number.isNaN(tg[s - 1]) && Math.round(tg[s - 1]) === note) s--;
    while (e < tg.length && !Number.isNaN(tg[e]) && Math.round(tg[e]) === note) e++;
    return { start: s, end: e };
  }

  applyNote(seg, note) {
    const tg = this.data.target;
    for (let j = seg.start; j < seg.end; j++) tg[j] = note;
    this.onLiveEdit?.(tg);
  }

  paint(i0, m0, i1, m1) {
    const { midi, target, autoTarget } = this.data;
    const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
    for (let j = lo; j <= hi; j++) {
      if (Number.isNaN(midi[j])) continue;
      if (this.tool === 'draw') {
        const f = i1 === i0 ? 1 : (j - i0) / (i1 - i0);
        const m = m0 + (m1 - m0) * f;
        target[j] = this.snap ? Math.round(m) : m;
      } else if (this.tool === 'bypass') target[j] = midi[j];
      else if (this.tool === 'restore') target[j] = autoTarget[j];
    }
    this.onLiveEdit?.(target);
  }

  // ---------- drawing ----------
  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  render() {
    const g = this.ctx, w = this.w, h = this.h, v = this.view;
    for (const fn of this.viewListeners) fn(v);
    if (!w || !h) return;
    const col = {
      bg: css('--editor-bg'), row: css('--editor-row'), rowScale: css('--editor-row-scale'),
      grid: css('--editor-grid'), text: css('--text-muted'), key: css('--key-white'), keyBlack: css('--key-black'),
      accent: css('--accent'), good: css('--good'), warn: css('--warn'), bad: css('--bad'),
      tuned: css('--tuned-line'), playhead: css('--playhead'), ruler: css('--surface-2'),
      fix: css('--fix'), raw: css('--raw-line'),
    };
    g.clearRect(0, 0, w, h);
    g.fillStyle = col.bg; g.fillRect(0, 0, w, h);

    const rowH = (h - RULER) / (v.m1 - v.m0);
    g.save();
    g.beginPath(); g.rect(GUTTER, RULER, w - GUTTER, h - RULER); g.clip();
    // Semitone rows (in-key rows highlighted)
    for (let m = Math.floor(v.m0); m <= Math.ceil(v.m1); m++) {
      const yTop = this.my(m + 0.5);
      if (this.pcs.includes(pitchClass(m))) { g.fillStyle = col.rowScale; g.fillRect(GUTTER, yTop, w - GUTTER, rowH); }
      g.fillStyle = pitchClass(m) === 0 ? col.text : col.grid;
      g.globalAlpha = pitchClass(m) === 0 ? 0.35 : 1;
      g.fillRect(GUTTER, Math.round(this.my(m - 0.5)), w - GUTTER, 1);
      g.globalAlpha = 1;
    }
    // Time grid
    const step = niceStep((v.t1 - v.t0) / ((w - GUTTER) / 90));
    g.fillStyle = col.grid;
    for (let t = Math.ceil(v.t0 / step) * step; t <= v.t1; t += step) g.fillRect(Math.round(this.tx(t)), RULER, 1, h - RULER);

    if (this.data) this.renderData(g, col, rowH);
    if (this.chain) this.renderChain(g, col);

    // Playhead
    const px = this.tx(this.playhead);
    g.fillStyle = col.playhead; g.fillRect(Math.round(px) - 1, RULER, 2, h - RULER);
    g.restore();

    // Ruler
    g.fillStyle = col.ruler; g.fillRect(0, 0, w, RULER);
    g.fillStyle = col.text; g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace'; g.textBaseline = 'middle';
    for (let t = Math.ceil(v.t0 / step) * step; t <= v.t1; t += step) {
      const x = this.tx(t);
      if (x < GUTTER) continue;
      g.fillRect(Math.round(x), RULER - 6, 1, 6);
      g.fillText(fmtTime(t, step), x + 4, RULER / 2);
    }
    g.fillStyle = col.playhead;
    g.beginPath(); g.moveTo(px - 6, RULER - 8); g.lineTo(px + 6, RULER - 8); g.lineTo(px, RULER); g.fill();

    // Piano keys
    g.save();
    g.beginPath(); g.rect(0, RULER, GUTTER, h - RULER); g.clip();
    for (let m = Math.floor(v.m0); m <= Math.ceil(v.m1); m++) {
      const y = this.my(m + 0.5);
      const black = BLACK.has(pitchClass(m));
      g.fillStyle = black ? col.keyBlack : col.key;
      g.fillRect(0, y, GUTTER - 1, rowH - 0.5);
      if (rowH >= 9 && (pitchClass(m) === 0 || (rowH >= 14 && this.pcs.includes(pitchClass(m))))) {
        g.fillStyle = black ? '#e8e8ef' : '#22222c';
        g.font = `${Math.min(11, rowH - 2)}px system-ui, sans-serif`;
        g.fillText(noteName(m), 6, y + rowH / 2);
      }
      if (this.pcs.includes(pitchClass(m))) { g.fillStyle = col.accent; g.fillRect(GUTTER - 4, y + 1, 3, rowH - 2); }
    }
    g.restore();
    g.fillStyle = col.grid; g.fillRect(GUTTER - 1, 0, 1, h);

    // Hover crosshair readout
    if (this.hover && !this.drag) {
      const { x, y, m } = this.hover;
      g.strokeStyle = col.text; g.globalAlpha = 0.4; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(GUTTER, y); g.lineTo(w, y); g.moveTo(x, RULER); g.lineTo(x, h); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
      if (this.tool === 'note' || this.tool === 'draw' || this.tool === 'line') {
        const snapped = this.snap || this.tool === 'note' ? Math.round(m) : m;
        g.fillStyle = col.accent;
        g.beginPath(); g.arc(x, this.my(snapped), 4, 0, Math.PI * 2); g.fill();
      }
    }
  }

  renderChain(g, col) {
    const as = this.chain.anchors;
    g.strokeStyle = col.accent; g.lineWidth = 2;
    g.beginPath();
    as.forEach((a, k) => (k ? g.lineTo(this.tx(a.t), this.my(a.m)) : g.moveTo(this.tx(a.t), this.my(a.m))));
    g.stroke();
    if (this.hover && !this.drag && as.length && this.tool === 'line') {
      const last = as[as.length - 1];
      const m = this.snap ? Math.round(this.hover.m) : this.hover.m;
      g.setLineDash([4, 4]); g.globalAlpha = 0.6;
      g.beginPath(); g.moveTo(this.tx(last.t), this.my(last.m)); g.lineTo(this.hover.x, this.my(m)); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
    }
    for (const a of as) {
      g.beginPath(); g.arc(this.tx(a.t), this.my(a.m), 5, 0, Math.PI * 2);
      g.fillStyle = col.bg; g.fill(); g.lineWidth = 2; g.strokeStyle = col.accent; g.stroke();
    }
  }

  renderData(g, col, rowH) {
    const { midi, target, corrected } = this.data;
    const v = this.view;
    const iA = Math.max(0, this.timeFrame(v.t0) - 1);
    const iB = Math.min(midi.length - 1, this.timeFrame(v.t1) + 1);
    const frameW = (this.data.hopSec / (v.t1 - v.t0)) * (this.w - GUTTER);
    const stride = Math.max(1, Math.floor(1 / Math.max(frameW, 1e-6) / 1.5));
    // Everything left of the scan line shows the auto-tune result.
    const scanning = this.applied && this.reveal < this.duration;
    const revealT = this.applied ? this.reveal : -Infinity;
    const revealX = Math.min(this.w, Math.max(GUTTER, this.tx(revealT)));

    g.save();
    g.beginPath(); g.rect(GUTTER, RULER, revealX - GUTTER, this.h - RULER); g.clip();

    // Target note blocks
    const blockH = Math.max(4, rowH * 0.72);
    for (const s of this.showBlocks ? segmentsFrom(target) : []) {
      if (s.end < iA || s.start > iB) continue;
      const x0 = this.tx(this.frameTime(s.start) - this.data.hopSec / 2);
      const x1 = this.tx(this.frameTime(s.end - 1) + this.data.hopSec / 2);
      let sum = 0;
      for (let j = s.start; j < s.end; j++) sum += target[j];
      const y = this.my(sum / (s.end - s.start));
      g.fillStyle = col.accent; g.globalAlpha = 0.14;
      roundRect(g, x0, y - blockH / 2, Math.max(2, x1 - x0), blockH, Math.min(4, blockH / 2)); g.fill();
      g.globalAlpha = 0.4; g.strokeStyle = col.accent; g.lineWidth = 1; g.stroke();
      g.globalAlpha = 1;
      if (x1 - x0 > 34 && blockH > 11) {
        g.fillStyle = col.accent; g.font = '10px system-ui, sans-serif'; g.textBaseline = 'middle';
        g.fillText(noteName(s.note), x0 + 4, y);
      }
    }

    // Selected note (note inspector)
    if (this.selected) {
      const { start, end } = this.selected;
      const x0 = this.tx(this.frameTime(start) - this.data.hopSec / 2);
      const x1 = this.tx(this.frameTime(end - 1) + this.data.hopSec / 2);
      g.fillStyle = col.fix; g.globalAlpha = 0.08; g.fillRect(x0, RULER, x1 - x0, this.h - RULER);
      g.globalAlpha = 0.7; g.strokeStyle = col.fix; g.setLineDash([4, 4]); g.lineWidth = 1;
      g.strokeRect(x0 + 0.5, RULER + 0.5, x1 - x0 - 1, this.h - RULER - 1);
      g.setLineDash([]); g.globalAlpha = 1;
    }

    // Corrections: shade between what was sung and where it was moved to.
    const FIX_MIN = 0.03; // 3 cents
    if (corrected) {
      g.fillStyle = col.fix; g.globalAlpha = 0.22;
      for (let i = iA; i < iB; i += stride) {
        const j = Math.min(iB, i + stride);
        const a = midi[i], b = midi[j], ca = corrected[i], cb = corrected[j];
        if ([a, b, ca, cb].some(Number.isNaN) || Math.abs(a - b) > 1.5) continue;
        if (Math.abs(ca - a) < FIX_MIN && Math.abs(cb - b) < FIX_MIN) continue;
        const xa = this.tx(this.frameTime(i)), xb = this.tx(this.frameTime(j));
        g.beginPath();
        g.moveTo(xa, this.my(a)); g.lineTo(xb, this.my(b)); g.lineTo(xb, this.my(cb)); g.lineTo(xa, this.my(ca));
        g.closePath(); g.fill();
      }
      g.globalAlpha = 1;
    }
    g.restore();

    // Sung pitch: neutral before tuning, coloured by how far off it was after.
    const tol = this.toleranceCents / 100;
    g.lineWidth = 2.5; g.lineCap = 'round';
    for (let i = iA; i < iB; i += stride) {
      const j = Math.min(iB, i + stride);
      const a = midi[i], b = midi[j];
      if (Number.isNaN(a) || Number.isNaN(b) || Math.abs(a - b) > 1.5) continue;
      if (this.frameTime(i) > revealT) g.strokeStyle = col.raw;
      else {
        const t = Number.isNaN(target[i]) ? Math.round(a) : target[i];
        const off = Math.abs(a - t);
        g.strokeStyle = off <= tol ? col.good : off <= tol * 2 ? col.warn : col.bad;
      }
      g.beginPath(); g.moveTo(this.tx(this.frameTime(i)), this.my(a)); g.lineTo(this.tx(this.frameTime(j)), this.my(b)); g.stroke();
    }

    // Corrected pitch, in the fix colour wherever a correction was made.
    if (corrected) {
      g.save();
      g.beginPath(); g.rect(GUTTER, RULER, revealX - GUTTER, this.h - RULER); g.clip();
      g.lineWidth = 2.25; g.lineJoin = 'round'; g.strokeStyle = col.fix;
      for (let i = iA; i < iB; i += stride) {
        const j = Math.min(iB, i + stride);
        const ca = corrected[i], cb = corrected[j];
        if (Number.isNaN(ca) || Number.isNaN(cb) || Math.abs(ca - cb) > 1.5) continue;
        const fixed = Math.abs(ca - midi[i]) >= FIX_MIN || Math.abs(cb - midi[j]) >= FIX_MIN;
        g.globalAlpha = fixed ? 1 : 0.35;
        g.beginPath(); g.moveTo(this.tx(this.frameTime(i)), this.my(ca)); g.lineTo(this.tx(this.frameTime(j)), this.my(cb)); g.stroke();
      }
      g.globalAlpha = 1;
      g.restore();
    }

    // Scan line while auto-tune is "listening".
    if (scanning && revealX > GUTTER) {
      const grad = g.createLinearGradient(revealX - 60, 0, revealX, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, col.fix);
      g.globalAlpha = 0.25; g.fillStyle = grad; g.fillRect(revealX - 60, RULER, 60, this.h - RULER);
      g.globalAlpha = 1; g.fillStyle = col.fix; g.fillRect(revealX - 1, RULER, 2, this.h - RULER);
    }
  }
}

function niceStep(raw) {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
  return steps.find((s) => s >= raw) || 300;
}

function fmtTime(t, step) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return `${m}:${s.toFixed(dec).padStart(dec ? 3 + dec : 2, '0')}`;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export { NOTE_NAMES };
