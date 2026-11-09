# SoundLab Vocalizer

Sing over any song and turn your take into a finished, studio-polished vocal, all in your browser.

## How it works

**1. Music.** Choose how to start:
- **My project:** upload a bounce of your DAW project, exported without the vocal.
- **An artist's song:** upload any song and the lead vocal is removed automatically.

The key and tempo are detected for you.

**2. Record.** Plug in your headphones, hit the big record button and sing along while the music plays. Your take lines up exactly with the music. If it still sounds late, use *Advanced → Latency fix*. You can also import an existing vocal take.

**3. Studio.** Each processor has its own tab with an on/off switch. They run in this order:

| Tab | What it does |
| --- | --- |
| **Auto-Tune** | Press **Auto-tune the track**. A scan line sweeps across the pitch graph and draws every correction in **cyan**, shaded between what you sang and where it was moved. Then shape it with styles (Natural, Pop polish, Hard tune) and controls for retune speed, humanize, keep bends, vibrato, amount and formant. Click a note for its own correction and vibrato, toggle scale notes, or load a **MIDI melody** as the targets. Fine-tune by hand with the tools below. |
| **Harmonizer** | 1–4 harmony layers made from your own voice. Each layer has its own **interval** (3rd/4th/5th/6th above or below, octaves, double, or ✨ *Smart*), **voice** (Natural, Female, Male, Deep bass, Bright, Choir), level, pan and feel. **Use recommended harmony** looks at where your melody sits and listens to the chord under each note to pick harmony notes that fit. |
| **Vocoder** | Talking-synth presets (Subtle shimmer, Classic robot, Synth choir, Whisper, Drone, Alien, Monster), a **How wild?** macro from subtle to unhinged, and fine controls (synth voice, octave, bands, character, detune, consonants, width, mix). |
| **Echo** | Slapback, quarter, dotted 8th, ping-pong, dub and long-tail presets, synced to the song tempo. Controls for repeats, level, tone, low cut and stereo spread. |
| **Reverb** | Vocal booth, Small room, Studio, Plate, Concert hall, Church, Cathedral and Arena presets. Controls for **direction** (left / center / right), length, room size, pre-delay, surfaces (bright ↔ soft), early reflections, width and level, with a live room diagram. |
| **Bounce** | Shows the effect chain, lets you set music and vocal levels, then renders **one stereo WAV** of your processed vocal plus the music. You can also export the processed vocal on its own. |

The play bar at the bottom works on every tab. *With effects / Dry* switches between the full chain and your raw take.

### Pitch editor tools (Auto-Tune tab)

| Tool | Key | What it does |
| --- | --- | --- |
| ◆ Note | `N` | Click where a note *should* be and it jumps there. Drag to move it. |
| ⟋ Line | `L` | Click to place dots joined by straight pitch lines. Drag a dot to move it. Enter, Esc or double-click finishes the line. |
| ✎ Draw | `D` | Paint the pitch by hand. |
| ⌀ Bypass | `B` | Leave a part untouched (slides, breaths). |
| ↺ Restore | `R` | Paint the automatic correction back in. |
| ✋ Pan | `H` | Move around. You can also drag the waveform strip under the graph. |

Ctrl/⌘+scroll zooms time, Alt+scroll zooms pitch, `+` `-` `0` zoom from the keyboard, and Ctrl/⌘+Z undoes.

## Run it

```bash
npm start        # http://localhost:5173
npm test         # DSP unit tests (Node 18+)
```

There are no dependencies and no build step. Any static HTTPS host works, for example GitHub Pages. The microphone needs `localhost` or HTTPS.

## Under the hood

| Stage | Technique | File |
| --- | --- | --- |
| Vocal removal | STFT center-channel extraction (bass and side-panned parts kept) | `src/dsp/vocal-remover.js` |
| Key / tempo / chords | Krumhansl–Kessler key profiles; onset autocorrelation; per-note chroma | `src/dsp/key-detect.js` |
| Pitch tracking | YIN, 10 ms hop | `src/dsp/pitch-detect.js` |
| Auto-Tune | In-key or MIDI targets; pitch split into smooth line + vibrato; retune / humanize / keep-bends correction on the smooth line, vibrato re-applied | `src/dsp/autotune.js`, `src/dsp/midi.js` |
| Studio engine | Port of the WORLD vocoder (StoneMask, CheapTrick, D4C, synthesis): resynthesises changed phrases from the spectral envelope, keeps the original audio elsewhere | `src/dsp/world.js`, `src/dsp/studio-engine.js` |
| Classic engine | TD-PSOLA (instant) | `src/dsp/psola.js` |
| Harmonizer | Diatonic and chord-aware intervals, PSOLA with formant shifting for voice character | `src/dsp/harmony.js` |
| Vocoder | Band-pass filter-bank channel vocoder with a polyBLEP synth carrier that follows your melody | `src/dsp/vocoder.js` |
| Echo | Stereo feedback delay with filters in the loop, ping-pong | `src/dsp/echo.js` |
| Reverb | Generated stereo room impulse (early reflections + damped tail) with FFT convolution | `src/dsp/reverb.js` |
| Effects chain | Runs in a Web Worker and caches each stage, so changing the reverb only re-renders the reverb | `src/engine/` |

## Limitations

- DAW project files (`.als`, `.logicx`, `.flp`, …) can't be opened in a browser, so export a bounce instead.
- Vocal removal uses the classic center-channel method. A machine-learning separator would be cleaner.
- Tempo detection needs a clear beat, and you can type the BPM on the Echo tab.

## Credits

The Studio engine is a JavaScript port of the core of [WORLD](https://github.com/mmorise/World) by M. Morise (modified BSD license; the notice is kept in `src/dsp/world.js`).
