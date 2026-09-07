# ClearCast Noise Filter

A Chrome MV3 extension that uses local neural speech enhancement to reduce background noise from audio playing in the active tab.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this folder.
4. Open a video site, start playback, then open ClearCast from the extensions toolbar.
5. Select **Start filtering** and adjust the filter strength or voice focus.

## Notes

- The primary filter is GTCRN, a gated convolutional-recurrent neural network running locally in WebAssembly at 48 kHz. Audio is not uploaded.
- The strength slider blends a latency-aligned original signal with the neural result. Voice focus adds a gentle speech-presence lift.
- If the neural model cannot start, ClearCast automatically falls back to the stereo spectral reducer and then to a browser-native DSP filter.
- ClearCast captures the tab's final audio output rather than modifying a page's player, so it works with YouTube and other normal web video/audio players, including players inside frames.
- The popup spectrum shows the captured signal in orange and the filtered output in green.
- Leave playback running briefly after starting so ClearCast can learn the steady noise floor.
- Chrome does not allow capture on some privileged pages, including `chrome://` pages and the Chrome Web Store.
- The filter keeps the captured audio audible by routing the processed signal back to the tab's output.
- If startup fails after capture begins, ClearCast releases the stream and restores the website's original audio automatically.

## Neural model and licenses

- GTCRN model: Xiaobin Rong et al., MIT licensed.
- Browser WebAssembly integration: `@sapphi-red/web-noise-suppressor`, MIT licensed. See `GTCRN-WEB-NOISE-SUPPRESSOR-LICENSE.txt`.

## Updating after a code change

1. Open `chrome://extensions`.
2. Select **Reload** on the ClearCast card.
3. Reload the video tab once, start playback, and then select **Start filtering**.
