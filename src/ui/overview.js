const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Max-abs envelope of a signal, `buckets` values long. */
export function peaks(samples, buckets = 2000) {
  const out = new Float32Array(buckets);
  const step = samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const end = Math.min(samples.length, Math.floor((b + 1) * step));
    for (let i = Math.floor(b * step); i < end; i++) { const a = Math.abs(samples[i]); if (a > m) m = a; }
    out[b] = m;
  }
  return out;
}

/**
 * Waveform strip under the pitch graph: shows the whole take, the part that
 * is zoomed into the editor (drag it to move around), and the playhead.
 */
export class Overview {
  constructor(canvas, editor) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.editor = editor;
    this.layers = []; // { peaks, duration, color, alpha }
    this.drag = null;
    editor.onViewChange(() => this.draw());
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', () => { this.drag = null; });
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    this.resize();
  }

  setLayers(layers) { this.layers = layers.filter((l) => l.peaks); this.draw(); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  get duration() { return Math.max(0.001, this.editor.duration); }
  tx(t) { return (t / this.duration) * this.w; }
  xt(x) { return (x / this.w) * this.duration; }

  down(e) {
    const x = e.offsetX;
    const v = this.editor.view;
    this.canvas.setPointerCapture(e.pointerId);
    const span = v.t1 - v.t0;
    if (x >= this.tx(v.t0) && x <= this.tx(v.t1)) this.drag = { grab: this.xt(x) - v.t0 };
    else { this.drag = { grab: span / 2 }; this.moveTo(this.xt(x) - span / 2); }
  }
  move(e) { if (this.drag) this.moveTo(this.xt(e.offsetX) - this.drag.grab); }
  moveTo(t0) {
    const v = this.editor.view;
    this.editor.pan(t0 - v.t0, 0);
  }

  draw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.render(); });
  }

  render() {
    const g = this.ctx, w = this.w, h = this.h;
    if (!w || !h) return;
    g.clearRect(0, 0, w, h);
    g.fillStyle = css('--editor-bg'); g.fillRect(0, 0, w, h);
    const mid = h / 2;
    for (const l of this.layers) {
      g.fillStyle = css(l.color); g.globalAlpha = l.alpha ?? 1;
      const n = l.peaks.length;
      let max = 1e-6;
      for (const p of l.peaks) if (p > max) max = p;
      for (let x = 0; x < w; x++) {
        const t = this.xt(x + 0.5);
        if (t > l.duration) break;
        const p = l.peaks[Math.min(n - 1, Math.floor((t / l.duration) * n))] / max;
        const hh = Math.max(0.5, p * (mid - 3));
        g.fillRect(x, mid - hh, 1, hh * 2);
      }
      g.globalAlpha = 1;
    }
    // Visible window
    const v = this.editor.view;
    const x0 = this.tx(v.t0), x1 = this.tx(v.t1);
    g.fillStyle = css('--accent'); g.globalAlpha = 0.14; g.fillRect(x0, 0, x1 - x0, h);
    g.globalAlpha = 1; g.strokeStyle = css('--accent'); g.lineWidth = 1.5;
    g.strokeRect(x0 + 0.75, 0.75, Math.max(2, x1 - x0 - 1.5), h - 1.5);
    // Playhead
    g.fillStyle = css('--playhead');
    g.fillRect(Math.round(this.tx(this.editor.playhead)) - 1, 0, 2, h);
  }
}
