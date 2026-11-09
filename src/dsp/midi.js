/**
 * Minimal Standard MIDI File reader: returns note events in seconds,
 * honouring the tempo map (Set Tempo meta events).
 */
export function parseMidi(buffer) {
  const v = new DataView(buffer);
  let p = 0;
  const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(p + i)); p += n; return s; };
  const u32 = () => { const x = v.getUint32(p); p += 4; return x; };
  const u16 = () => { const x = v.getUint16(p); p += 2; return x; };
  const vlq = () => { let x = 0, b; do { b = v.getUint8(p++); x = (x << 7) | (b & 0x7f); } while (b & 0x80); return x; };
  if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
  const hlen = u32();
  u16(); // format
  const ntrks = u16();
  const division = u16();
  p += hlen - 6;
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
  const tempos = [{ tick: 0, uspq: 500000 }];
  const raw = []; // { tick, on, note, vel, ch, track }
  for (let t = 0; t < ntrks && p < v.byteLength; t++) {
    if (str(4) !== 'MTrk') throw new Error('Bad MIDI track');
    const len = u32();
    const end = p + len;
    let tick = 0, status = 0;
    while (p < end) {
      tick += vlq();
      let b = v.getUint8(p);
      if (b & 0x80) { status = b; p++; } // else running status
      b = status;
      if (b === 0xff) {
        const type = v.getUint8(p++);
        const len = vlq();
        if (type === 0x51 && len === 3) tempos.push({ tick, uspq: (v.getUint8(p) << 16) | (v.getUint8(p + 1) << 8) | v.getUint8(p + 2) });
        p += len;
      } else if (b === 0xf0 || b === 0xf7) {
        p += vlq();
      } else {
        const kind = b & 0xf0;
        const d1 = v.getUint8(p++);
        const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : v.getUint8(p++);
        if (kind === 0x90 || kind === 0x80) raw.push({ tick, on: kind === 0x90 && d2 > 0, note: d1, vel: d2, ch: b & 15, track: t });
      }
    }
    p = end;
  }
  tempos.sort((a, b) => a.tick - b.tick);
  const toSec = (tick) => {
    let sec = 0, last = 0, uspq = tempos[0].uspq;
    for (const tp of tempos) {
      if (tp.tick >= tick) break;
      sec += ((tp.tick - last) * uspq) / division / 1e6;
      last = tp.tick; uspq = tp.uspq;
    }
    return sec + ((tick - last) * uspq) / division / 1e6;
  };
  raw.sort((a, b) => a.tick - b.tick || (a.on ? 1 : 0) - (b.on ? 1 : 0));
  const open = new Map();
  const notes = [];
  for (const e of raw) {
    const k = `${e.track}:${e.ch}:${e.note}`;
    if (e.on) { if (!open.has(k)) open.set(k, e); continue; }
    const s = open.get(k);
    if (!s) continue;
    open.delete(k);
    notes.push({ start: toSec(s.tick), end: toSec(e.tick), midi: e.note });
  }
  return notes.sort((a, b) => a.start - b.start);
}

/**
 * Per-frame targets from MIDI notes. Each MIDI note is moved to the octave
 * nearest the sung pitch; frames with no MIDI note keep `fallback`.
 */
export function targetsFromMidi(notes, midi, t0, hopSec, fallback) {
  const out = fallback.slice();
  let k = 0;
  for (let i = 0; i < midi.length; i++) {
    if (Number.isNaN(midi[i])) continue;
    const t = t0 + i * hopSec;
    while (k < notes.length && notes[k].end < t - 5) k++;
    let best = null, bd = Infinity;
    for (let j = k; j < notes.length && notes[j].start <= t; j++) {
      const nt = notes[j];
      if (t < nt.start || t >= nt.end) continue;
      const shifted = nt.midi + 12 * Math.round((midi[i] - nt.midi) / 12);
      const d = Math.abs(shifted - midi[i]);
      if (d < bd) { bd = d; best = shifted; }
    }
    if (best !== null) out[i] = best;
  }
  return out;
}
