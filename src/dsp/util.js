/** Yield to the event loop so long DSP jobs don't freeze the UI. */
export const tick = () => new Promise((r) => setTimeout(r, 0));

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Mix any number of channels down to a single mono Float32Array. */
export function toMono(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const n = channels[0].length;
  const out = new Float32Array(n);
  const g = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * g;
  return out;
}
