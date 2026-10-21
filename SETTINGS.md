# Settings implementation and verification

Base reviewed: main 93302334c8f5c1bf21b6498684eec6b028b719a4.
No advanced controls were implemented in that revision. Existing model loading,
pass-through initialization, and neural → spectral → DSP fallback are retained.

Popup sends partial changes to the service worker. The worker serializes these
with start/stop, normalizes and persists complete settings, then waits for an
offscreen acknowledgement. Startup reads all persisted keys. Popup listens to
storage changes and queries the current processor when reopened. Listening mode
is a preset, not an engine selector: engines still follow automatic fallback.

| Control | GTCRN | Spectral | DSP |
| --- | --- | --- | --- |
| Strength | Aligned wet/dry blend | Spectral suppression | High-pass 55–200 Hz and compression threshold −18 to −36 dB, ratio 2–6 |
| Voice focus | Enable common speech EQ | EQ plus existing protected speech band | Enable common speech EQ |
| Speech clarity | 2.4 kHz peaking EQ, Q 0.8, 0–9 dB when Voice focus enabled | Same | Same |
| Output | Common 0–8 gain, 50 ms smoothing, final linked peak limiter | Same | Same |
| Dry | Wet fraction = strength × (1 − dry/100); dry = 1 − wet | Disabled | Disabled |
| Cutoff | Common low-pass 4–20 kHz (bounded below Nyquist) | Same | Same plus DSP low-pass |
| Noise window | Disabled | Noise estimate exponential time constant 3–15 s; 30× slower during detected speech | Disabled |

GTCRN exposes no model strength or noise learning parameter. Its strength is a
blend, not a change to inference. Noise window is an adaptation time constant,
not a promise to delay playback or average exactly N seconds. Unsupported values
are retained for a later supported path, and marked unavailable in the UI.

Natural: strength 40, Voice focus off, clarity 0, dry 30%, cutoff 20 kHz,
window 3 s. Clear dialogue: 85, on, 4 dB, 5%, 10 kHz, 5 s. Output and boost
permission are independent of presets. Custom values survive preset selection;
manually editing a tuning parameter returns to Custom and its saved values.
Legacy installations default to Custom to retain their strength/Voice focus.

Above-unity gain requires an explicit checkbox; revoking it clamps the saved
value to 100%. The permission persists. Presets never increase output. The final
worklet limits linked-channel digital sample peaks to 0.95 with immediate attack
and 100 ms release, after gain and EQ, including startup pass-through. Nonfinite
samples become silence. Gain is smoothed; neural blend coefficients sum to one.
This is not a calibrated hearing protection system: device volume, SPL, duration,
and intersample peaks remain outside its guarantee. At high gain, limiting can
pump and distort; begin with low device volume. There is no automatic makeup gain.

## Automated checks

Run `npm test` (Node 20+; no dependencies). Tests exercise actual popup, worker,
offscreen and worklet code with simulated Chrome/DOM/AudioNodes. They verify
restoration and numeric displays, input events and storage notifications,
serialized partial writes and startup persistence, preset/custom restoration,
capability updates, neural/spectral/DSP transitions, finite bounds and boost
permission, noise adaptation, and stereo transient limiting. They do not execute
Chrome tabCapture, real AudioParam scheduling, GTCRN WASM inference or listening.

## Required real Chrome acceptance (not yet performed)

1. Load unpacked on Chrome 116+; play a quiet test source at low device volume.
   Change every supported parameter during playback, close/reopen popup, stop/
   restart capture and restart Chrome. Confirm values, labels and effective audio.
2. Switch Natural → Clear dialogue → Custom and edit while presets are active.
   Check gain does not rise from selecting a preset. Test rapid slider moves and
   immediately press Start; verify final settings after reopening.
3. Force GTCRN load failure, then Spectral load failure in a test copy. Confirm
   automatic transitions update disabled controls and preserve settings, without
   duplicate routing, silent playback, or stale messages after Stop.
4. On Spectral, compare stationary noise adaptation at 3 and 15 seconds without
   resetting the stream. Verify speech, stereo phase and transients with real audio.
5. With low device volume, test 0%, 100% and explicitly unlocked 800% using quiet
   signals and full-scale impulses. Measure rendered peaks, release, distortion,
   channel linking, parameter smoothing and startup/stop clicks. Validate perceived
   latency, alignment and limiter CPU load; do not infer safe SPL from sample peaks.
6. Check suspend/resume, background worker restart, protected tab rejection,
   capture ended/tab closed, missing WASM/worklet, and model runtime failure.
