/**
 * Stereo echo / delay with feedback, tone filters and ping-pong.
 * Each repeat passes through the filters again, so repeats get darker and
 * thinner like a tape or analog delay.
 */
export function echo([inL, inR], sampleRate, opts = {}) {
  const {
    timeMs = 375,
    feedback = 0.35,
    mix = 0.3,
    pingPong = false,
    highCut = 6000,
    lowCut = 150,
    spread = 0.3, // stereo offset of the right repeat (non ping-pong)
  } = opts;
  const fb = Math.min(0.95, Math.max(0, feedback));
  const dL = Math.max(1, Math.round((timeMs / 1000) * sampleRate));
  const dR = pingPong ? dL : Math.max(1, Math.round(dL * (1 + spread * 0.08)));
  const repeats = fb > 0.001 ? Math.ceil(Math.log(0.001) / Math.log(fb)) : 1;
  const tail = Math.min(Math.round(12 * sampleRate), Math.max(dL, dR) * (repeats + 1));
  const n = inL.length;
  const len = n + tail;
  const outL = new Float32Array(len);
  const outR = new Float32Array(len);
  const bufL = new Float32Array(dL);
  const bufR = new Float32Array(dR);
  let iL = 0, iR = 0;
  const lpK = 1 - Math.exp((-2 * Math.PI * highCut) / sampleRate);
  const hpK = 1 - Math.exp((-2 * Math.PI * lowCut) / sampleRate);
  let lpL = 0, lpR = 0, hpL = 0, hpR = 0;
  for (let i = 0; i < len; i++) {
    const xl = i < n ? inL[i] : 0;
    const xr = i < n ? inR[i] : 0;
    // Read delayed signal and filter it (low-pass then high-pass).
    lpL += (bufL[iL] - lpL) * lpK;
    lpR += (bufR[iR] - lpR) * lpK;
    hpL += (lpL - hpL) * hpK;
    hpR += (lpR - hpR) * hpK;
    const wl = lpL - hpL;
    const wr = lpR - hpR;
    if (pingPong) {
      bufL[iL] = (xl + xr) * 0.5 + wr * fb;
      bufR[iR] = wl * fb;
    } else {
      bufL[iL] = xl + wl * fb;
      bufR[iR] = xr + wr * fb;
    }
    outL[i] = xl + wl * mix;
    outR[i] = xr + wr * mix;
    if (++iL >= dL) iL = 0;
    if (++iR >= dR) iR = 0;
  }
  return [outL, outR];
}

/** Note value -> milliseconds at a tempo. */
export function noteToMs(note, bpm) {
  const q = 60000 / bpm;
  const map = { '1/2': 2, '1/4': 1, '1/4.': 1.5, '1/4t': 2 / 3, '1/8': 0.5, '1/8.': 0.75, '1/8t': 1 / 3, '1/16': 0.25 };
  return q * (map[note] ?? 1);
}
