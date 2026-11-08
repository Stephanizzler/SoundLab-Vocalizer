// Sample-accurate microphone recorder built on an AudioWorklet.
// Capture begins at an exact AudioContext frame so the take lines up
// with the backing track that is scheduled to start at that same frame.

const WORKLET = `
class SoundLabRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.startFrame = Infinity;
    this.stopped = false;
    this.buf = new Float32Array(8192);
    this.fill = 0;
    this.peak = 0;
    this.blocks = 0;
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'start') this.startFrame = e.data.frame;
      if (e.data.cmd === 'stop') { this.flush(); this.stopped = true; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (this.fill === 0) return;
    const data = this.buf.slice(0, this.fill);
    this.port.postMessage({ data }, [data.buffer]);
    this.fill = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || this.stopped) return !this.stopped;
    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > this.peak) this.peak = a; }
    if (++this.blocks % 8 === 0) { this.port.postMessage({ peak: this.peak }); this.peak = 0; }
    const end = currentFrame + ch.length;
    if (end > this.startFrame) {
      for (let i = Math.max(0, this.startFrame - currentFrame); i < ch.length; i++) {
        this.buf[this.fill++] = ch[i];
        if (this.fill === this.buf.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('soundlab-recorder', SoundLabRecorder);
`;

const loaded = new WeakSet();

export async function openMicrophone() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
}

export async function createRecorder(ctx, stream, { onLevel } = {}) {
  if (!loaded.has(ctx)) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    loaded.add(ctx);
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'soundlab-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the node pulled by the graph without monitoring the mic
  src.connect(node).connect(mute).connect(ctx.destination);

  const chunks = [];
  let resolveStop;
  node.port.onmessage = (e) => {
    if (e.data.data) chunks.push(e.data.data);
    if (e.data.peak !== undefined) onLevel?.(e.data.peak);
    if (e.data.done) resolveStop?.();
  };

  return {
    start(frame) { node.port.postMessage({ cmd: 'start', frame }); },
    async stop() {
      const done = new Promise((r) => { resolveStop = r; });
      node.port.postMessage({ cmd: 'stop' });
      await done;
      src.disconnect(); node.disconnect(); mute.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Float32Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
  };
}
