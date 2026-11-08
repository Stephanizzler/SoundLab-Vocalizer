# SoundLab Vocalizer

Sing over any song and get a polished, in-tune vocal, all in your browser.

1. **Import the music.** Load a song (MP3/WAV/M4A/FLAC…) and SoundLab removes the lead vocal, or import an instrumental bounced from your DAW.
2. **Key detection.** The song's key is detected automatically, and you can override it.
3. **Record.** With headphones on, the instrumental plays while you sing. The take is captured sample-accurately, with latency compensation. You can also import an existing vocal take.
4. **Auto-tune and edit.** Your vocal is pitch-tracked against the song's key and tuned. An editable pitch graph shows exactly where you were off:
   - green / amber / red line: what you sang, colored by how far off the note was
   - purple blocks: the target notes
   - dark/white line: the tuned result
5. **Export** the tuned vocal (to drop back into your DAW) or the full mix as WAV.

## Editing the pitch graph

| Tool | Key | What it does |
| --- | --- | --- |
| ◆ Note | `N` | Click where a note *should* be and the note block jumps there. Drag to move it up or down. |
| ✎ Draw | `D` | Paint the pitch by hand (snaps to semitones unless *Snap to notes* is off). |
| ⌀ Bypass | `B` | Leave the painted region untouched (no correction, which is good for slides and breaths). |
| ↺ Restore | `R` | Paint the automatic correction back in. |
| ✋ Pan | `H` | Drag to move around (also middle/right-drag or Space+drag). |

Zoom: Ctrl/⌘ + scroll (time), Alt + scroll (pitch), `+` / `-` / `0` (fit). Scroll pans.
Undo/redo: Ctrl/⌘+Z, Ctrl/⌘+Shift+Z.

**Retune speed** controls how fast the correction snaps: 0 ms gives the hard "robot" effect, and 30–80 ms sounds natural. **Amount** blends between your original and the full correction.

## Run it

```bash
npm start        # http://localhost:5173
npm test         # DSP unit tests (Node 18+)
```

No dependencies or build step. It's plain ES modules, so any static file server works. Microphone access requires `localhost` or HTTPS.

## How it works

| Stage | Technique | File |
| --- | --- | --- |
| Vocal removal | STFT center-channel extraction: attenuates bins whose L/R are correlated (centered) in the 120 Hz–9 kHz vocal band, keeping bass and side-panned parts | `src/dsp/vocal-remover.js` |
| Key detection | Chromagram + Krumhansl–Kessler key profiles | `src/dsp/key-detect.js` |
| Pitch tracking | YIN on a decimated signal, 10 ms hop, octave-error cleanup | `src/dsp/pitch-detect.js` |
| Target notes | Nearest in-key note on vibrato-smoothed pitch, with hysteresis | `src/dsp/autotune.js` |
| Retuning | One-pole glide toward the target (retune speed) | `src/dsp/autotune.js` |
| Pitch shifting | TD-PSOLA, which preserves timing and roughly preserves formants | `src/dsp/psola.js` |
| Recording | AudioWorklet that starts capture on the exact frame the backing track starts | `src/audio/recorder.js` |
| Editor | Canvas piano-roll with note/draw/bypass/restore tools | `src/ui/pitch-editor.js` |

## Limitations and next steps

- **DAW project files** (`.als`, `.logicx`, `.flp`, `.ptx`, …) are proprietary and can't be opened in a browser. Export or bounce an instrumental (and optionally the vocal) as WAV instead. Next step: import multiple stems, or MIDI/AAF/OMF.
- **Vocal removal** uses the classic center-channel method. It works best on studio stereo mixes with a centered lead vocal, and leaves some reverb tails and centered instruments partially reduced. An ML source separator (Demucs/Spleeter, for example, run server-side or via ONNX/WebGPU) would give much cleaner results.
- The pitch tracker is monophonic, built for a single lead vocal.
- Next ideas: note splitting/merging in the editor, timing (not just pitch) editing, formant control, saving and loading sessions, and a mobile layout for the editor.
