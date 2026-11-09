// Effect defaults, presets and control definitions used by the studio UI.

export const DEFAULT_FX = {
  autotune: { on: false, engine: 'studio', formant: 1 },
  harmonizer: { on: false, mix: 0.8, layers: [] },
  vocoder: { on: false, preset: 'robot', wildness: 45, carrier: 'pitch', carrierOctave: 0, formantBias: 0, bands: 23, detune: 8, formantShift: 0, mix: 0.64, width: 0.5, noise: 0.5 },
  echo: { on: false, preset: 'quarter', sync: '1/4', timeMs: 375, feedback: 0.3, mix: 0.22, pingPong: false, highCut: 5000, lowCut: 200, spread: 0.3 },
  reverb: { on: false, preset: 'studio', decay: 1.1, size: 0.4, preDelayMs: 15, damping: 0.45, width: 0.8, direction: 0, early: 0.5, mix: 0.25 },
};

/** Vocoder "Wildness" macro: one knob from subtle to unhinged. */
export function applyWildness(p, w) {
  const t = w / 100;
  const bias = p.formantBias || 0;
  return {
    ...p,
    wildness: w,
    bands: Math.round(32 - 18 * t),
    detune: Math.round(45 * t * t),
    mix: +(0.3 + 0.7 * t).toFixed(2),
    formantShift: bias + Math.round(t * t * 3 * Math.sign(bias)),
    noise: +(0.35 + 0.4 * t).toFixed(2),
  };
}

export const PRESETS = {
  vocoder: {
    subtle: { label: 'Subtle shimmer', icon: '✧', carrier: 'pitch', carrierOctave: 0, formantBias: 0, wildness: 15 },
    robot: { label: 'Classic robot', icon: '🤖', carrier: 'pitch', carrierOctave: 0, formantBias: 0, wildness: 45 },
    choir: { label: 'Synth choir', icon: '🎹', carrier: 'chord', carrierOctave: 0, formantBias: 0, wildness: 55 },
    whisper: { label: 'Whisper', icon: '🌬', carrier: 'noise', carrierOctave: 0, formantBias: 0, wildness: 50 },
    drone: { label: 'Drone', icon: '〰', carrier: 'drone', carrierOctave: 0, formantBias: 0, wildness: 60 },
    alien: { label: 'Alien', icon: '👽', carrier: 'pitch', carrierOctave: 1, formantBias: 3, wildness: 85 },
    monster: { label: 'Monster', icon: '👹', carrier: 'pitch', carrierOctave: -1, formantBias: -3, wildness: 80 },
  },
  echo: {
    slapback: { label: 'Slapback', icon: '⚡', sync: 'ms', timeMs: 110, feedback: 0.08, mix: 0.3, pingPong: false, highCut: 4500, lowCut: 250 },
    quarter: { label: 'Quarter note', icon: '♩', sync: '1/4', feedback: 0.3, mix: 0.22, pingPong: false, highCut: 5000, lowCut: 200 },
    dotted: { label: 'Dotted 8th', icon: '♪.', sync: '1/8.', feedback: 0.35, mix: 0.22, pingPong: false, highCut: 5000, lowCut: 200 },
    pingpong: { label: 'Ping-pong', icon: '⇄', sync: '1/8', feedback: 0.45, mix: 0.25, pingPong: true, highCut: 6000, lowCut: 250 },
    dub: { label: 'Dub', icon: '🌀', sync: '1/4.', feedback: 0.62, mix: 0.3, pingPong: false, highCut: 2200, lowCut: 300 },
    long: { label: 'Long tail', icon: '∞', sync: '1/2', feedback: 0.5, mix: 0.2, pingPong: true, highCut: 3800, lowCut: 250 },
  },
  reverb: {
    booth: { label: 'Vocal booth', icon: '🎤', decay: 0.35, size: 0.08, preDelayMs: 2, damping: 0.7, early: 0.8, width: 0.4, mix: 0.3 },
    room: { label: 'Small room', icon: '🛋', decay: 0.7, size: 0.25, preDelayMs: 8, damping: 0.55, early: 0.6, width: 0.7, mix: 0.25 },
    studio: { label: 'Studio', icon: '🎙', decay: 1.1, size: 0.4, preDelayMs: 15, damping: 0.45, early: 0.5, width: 0.8, mix: 0.25 },
    plate: { label: 'Plate', icon: '✨', decay: 1.8, size: 0.3, preDelayMs: 10, damping: 0.15, early: 0.1, width: 0.95, mix: 0.3 },
    hall: { label: 'Concert hall', icon: '🏛', decay: 2.6, size: 0.75, preDelayMs: 28, damping: 0.4, early: 0.45, width: 1, mix: 0.3 },
    church: { label: 'Church', icon: '⛪', decay: 4.2, size: 0.9, preDelayMs: 40, damping: 0.55, early: 0.4, width: 1, mix: 0.3 },
    cathedral: { label: 'Cathedral', icon: '✝', decay: 6, size: 1, preDelayMs: 55, damping: 0.6, early: 0.35, width: 1, mix: 0.32 },
    arena: { label: 'Arena', icon: '🏟', decay: 3.5, size: 1, preDelayMs: 75, damping: 0.35, early: 0.3, width: 1, mix: 0.28 },
  },
};

const pct = (v) => `${Math.round(v * 100)}%`;

export const PARAMS = {
  vocoder: [
    { id: 'carrier', label: 'Synth voice', type: 'select', options: [['pitch', 'Follows my melody'], ['chord', 'Chords in key'], ['drone', 'Drone on the root'], ['noise', 'Whisper (noise)']] },
    { id: 'carrierOctave', label: 'Synth octave', type: 'select', options: [[-1, 'One lower'], [0, 'Same'], [1, 'One higher']], number: true },
    { id: 'bands', label: 'Bands (clarity)', type: 'range', min: 8, max: 40, step: 1, fmt: (v) => `${v}` },
    { id: 'formantShift', label: 'Character (size)', type: 'range', min: -6, max: 6, step: 1, fmt: (v) => (v > 0 ? `+${v} smaller` : v < 0 ? `${v} bigger` : 'neutral') },
    { id: 'detune', label: 'Detune (thickness)', type: 'range', min: 0, max: 60, step: 1, fmt: (v) => `${v}¢` },
    { id: 'noise', label: 'Consonants', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
    { id: 'width', label: 'Stereo width', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
    { id: 'mix', label: 'Mix (dry ↔ vocoded)', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
  ],
  echo: [
    { id: 'sync', label: 'Timing', type: 'select', options: [['1/2', '1/2 note'], ['1/4.', 'Dotted 1/4'], ['1/4', '1/4 note'], ['1/4t', '1/4 triplet'], ['1/8.', 'Dotted 1/8'], ['1/8', '1/8 note'], ['1/8t', '1/8 triplet'], ['1/16', '1/16 note'], ['ms', 'Free (ms)']] },
    { id: 'timeMs', label: 'Time', type: 'range', min: 30, max: 1500, step: 1, fmt: (v) => `${v} ms`, showIf: (p) => p.sync === 'ms' },
    { id: 'feedback', label: 'Repeats (feedback)', type: 'range', min: 0, max: 0.9, step: 0.01, fmt: pct },
    { id: 'mix', label: 'Echo level', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
    { id: 'pingPong', label: 'Ping-pong (bounce L/R)', type: 'toggle' },
    { id: 'highCut', label: 'Tone (high cut)', type: 'range', min: 1000, max: 14000, step: 100, fmt: (v) => `${(v / 1000).toFixed(1)} kHz` },
    { id: 'lowCut', label: 'Low cut', type: 'range', min: 40, max: 1200, step: 10, fmt: (v) => `${v} Hz` },
    { id: 'spread', label: 'Stereo spread', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct, showIf: (p) => !p.pingPong },
  ],
  reverb: [
    { id: 'direction', label: 'Direction', type: 'range', min: -1, max: 1, step: 0.05, fmt: (v) => (Math.abs(v) < 0.05 ? 'Center' : v < 0 ? `Left ${Math.round(-v * 100)}%` : `Right ${Math.round(v * 100)}%`) },
    { id: 'decay', label: 'Length (decay)', type: 'range', min: 0.2, max: 8, step: 0.1, fmt: (v) => `${Number(v).toFixed(1)} s` },
    { id: 'size', label: 'Room size', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.2 ? 'Tiny' : v < 0.45 ? 'Small' : v < 0.7 ? 'Medium' : v < 0.9 ? 'Large' : 'Huge') },
    { id: 'preDelayMs', label: 'Pre-delay', type: 'range', min: 0, max: 150, step: 1, fmt: (v) => `${v} ms` },
    { id: 'damping', label: 'Surfaces (bright ↔ soft)', type: 'range', min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.3 ? 'Bright/stone' : v < 0.6 ? 'Balanced' : 'Soft/fabric') },
    { id: 'early', label: 'Early reflections', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
    { id: 'width', label: 'Stereo width', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
    { id: 'mix', label: 'Reverb level', type: 'range', min: 0, max: 1, step: 0.01, fmt: pct },
  ],
};
