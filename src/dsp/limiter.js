/**
 * Look-ahead peak limiter (offline). Guarantees |output| <= ceiling while
 * leaving anything below the ceiling untouched.
 *
 * Gain needed per sample -> minimum over the next `lookahead` samples ->
 * box-averaged over the same length (so the gain ramps down smoothly and is
 * still low enough when the peak arrives) -> exponential release.
 */
export function limit(channels, sampleRate, { ceiling = 0.95, lookaheadMs = 4, releaseMs = 80 } = {}) {
  const n = Math.max(...channels.map((c) => c.length));
  const L = Math.max(1, Math.round((lookaheadMs / 1000) * sampleRate));
  const req = new Float32Array(n + L).fill(1);
  let any = false;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of channels) { const v = Math.abs(c[i] || 0); if (v > p) p = v; }
    if (p > ceiling) { req[i] = ceiling / p; any = true; }
  }
  if (!any) return { channels, reduced: false };
  // hold[j] = min(req[j .. j+L-1]) with a monotonic deque
  const hold = new Float32Array(n);
  const dq = new Int32Array(n + L);
  let head = 0, tail = 0;
  for (let k = 0; k < n + L - 1; k++) {
    while (tail > head && req[dq[tail - 1]] >= req[k]) tail--;
    dq[tail++] = k;
    const j = k - L + 1;
    if (j >= 0 && j < n) {
      while (dq[head] < j) head++;
      hold[j] = req[dq[head]];
    }
  }
  // box average of the hold over the previous L samples
  const rel = 1 - Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  const out = channels.map((c) => new Float32Array(c.length));
  let sum = 0, g = 1;
  for (let i = 0; i < n; i++) {
    sum += hold[i];
    if (i >= L) sum -= hold[i - L];
    const avg = sum / Math.min(i + 1, L) - (i < L ? 0 : 0);
    const target = i < L ? Math.min(avg, hold[i]) : avg;
    g = Math.min(target, g + (1 - g) * rel);
    for (let c = 0; c < channels.length; c++) out[c][i] = (channels[c][i] || 0) * g;
  }
  return { channels: out, reduced: true };
}
