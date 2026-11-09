// Background renderer for the vocal effects chain (keeps the UI responsive).
import { renderChain, ensureStudioAnalysis } from './chain.js';

let src = null;
let cache = {};
let latest = 0;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'load') {
    src = m.src;
    cache = {};
    return;
  }
  if (m.type !== 'render' || !src) return;
  latest = m.id;
  try {
    const r = await renderChain(src, m.settings, cache, {
      onStage: (stage, p) => self.postMessage({ type: 'progress', id: m.id, stage, p }),
      aborted: () => latest !== m.id,
    });
    if (!r) return;
    // Warm up the Studio engine in the background so Auto-Tune is quick later.
    if (m.settings.fx.autotune.engine === 'studio' && !cache.studio) {
      setTimeout(() => {
        if (cache.studio || !src) return;
        ensureStudioAnalysis(src, cache, (stage, p) => self.postMessage({ type: 'analysis', p }));
        self.postMessage({ type: 'analysis', p: 1 });
      }, 0);
    }
    const tuned = r.tuned.slice();
    const L = r.L.slice();
    const R = r.R.slice();
    self.postMessage({ type: 'done', id: m.id, tuned, L, R }, [tuned.buffer, L.buffer, R.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: err.message || String(err) });
  }
};
