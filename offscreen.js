let audioContext;
let mediaStream;
let source;
let outputGain;
let reducer;
let beforeAnalyser;
let afterAnalyser;
let metricsTimer;
let neuralActivationTimer;
let dryDelay;
let dryGain;
let wetGain;
let voiceEq;
let fallbackHighPass;
let fallbackLowPass;
let fallbackCompressor;
let currentSettings;
let processorMode = 'none';
let neuralReady = false;
let switchingFallback = false;

const defaults = {
  intensity: 68,
  voiceBoost: true
};

function disconnect(node) {
  if (!node) return;
  try {
    node.disconnect();
  } catch (_error) {
    // The node may already be disconnected during a fallback transition.
  }
}

function destroyReducer() {
  if (!reducer) return;
  reducer.onprocessorerror = null;
  reducer.port.onmessage = null;
  // GTCRN uses this message to release its native WASM state. The spectral
  // fallback safely ignores it.
  reducer.port.postMessage('destroy');
  disconnect(reducer);
  reducer = null;
}

function disconnectProcessingGraph() {
  if (neuralActivationTimer) clearTimeout(neuralActivationTimer);
  neuralActivationTimer = null;
  disconnect(source);
  disconnect(beforeAnalyser);
  disconnect(afterAnalyser);
  destroyReducer();
  [dryDelay, dryGain, wetGain, voiceEq, fallbackHighPass,
    fallbackLowPass, fallbackCompressor].forEach(disconnect);
  dryDelay = null;
  dryGain = null;
  wetGain = null;
  voiceEq = null;
  fallbackHighPass = null;
  fallbackLowPass = null;
  fallbackCompressor = null;
  neuralReady = false;
  processorMode = 'none';
}

function applySettings(settings = defaults) {
  currentSettings = {
    intensity: Math.max(0, Math.min(100, Number(settings.intensity ?? defaults.intensity))),
    voiceBoost: settings.voiceBoost ?? defaults.voiceBoost
  };

  if (!audioContext) return;
  const strength = currentSettings.intensity / 100;
  const now = audioContext.currentTime;

  if (processorMode === 'neural' && dryGain && wetGain) {
    // The dry signal is delayed to match GTCRN's five 128-sample buffering
    // blocks, preventing comb filtering while the slider crossfades.
    const effectiveStrength = neuralReady ? strength : 0;
    dryGain.gain.setTargetAtTime(Math.cos(effectiveStrength * Math.PI / 2), now, 0.015);
    wetGain.gain.setTargetAtTime(Math.sin(effectiveStrength * Math.PI / 2), now, 0.015);
    voiceEq.gain.setTargetAtTime(currentSettings.voiceBoost ? 2.5 : 0, now, 0.02);
  }

  if (processorMode === 'spectral' && reducer) {
    reducer.port.postMessage({
      type: 'SETTINGS',
      intensity: currentSettings.intensity,
      voiceBoost: currentSettings.voiceBoost
    });
  }

  if (processorMode === 'dsp' && fallbackHighPass && fallbackLowPass && fallbackCompressor) {
    fallbackHighPass.frequency.setTargetAtTime(55 + strength * 145, now, 0.02);
    fallbackLowPass.frequency.setTargetAtTime(currentSettings.voiceBoost ? 8200 : 16000, now, 0.02);
    fallbackCompressor.threshold.setTargetAtTime(-18 - strength * 18, now, 0.02);
    fallbackCompressor.ratio.setTargetAtTime(2 + strength * 4, now, 0.02);
  }
}

function connectNeuralGraph(wasmBinary) {
  const neuralReducer = new AudioWorkletNode(
    audioContext,
    '@sapphi-red/web-noise-suppressor/gtcrn',
    {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      processorOptions: { maxChannels: 2, wasmBinary }
    }
  );
  const nextDryDelay = audioContext.createDelay(1);
  const nextDryGain = audioContext.createGain();
  const nextWetGain = audioContext.createGain();
  const nextVoiceEq = audioContext.createBiquadFilter();
  nextDryDelay.delayTime.value = 640 / audioContext.sampleRate;
  nextDryGain.gain.value = 1;
  nextWetGain.gain.value = 0;
  nextVoiceEq.type = 'peaking';
  nextVoiceEq.frequency.value = 2400;
  nextVoiceEq.Q.value = 0.8;

  disconnectProcessingGraph();
  reducer = neuralReducer;
  dryDelay = nextDryDelay;
  dryGain = nextDryGain;
  wetGain = nextWetGain;
  voiceEq = nextVoiceEq;
  processorMode = 'neural';

  source.connect(beforeAnalyser);
  beforeAnalyser.connect(dryDelay).connect(dryGain).connect(afterAnalyser);
  beforeAnalyser.connect(reducer).connect(wetGain).connect(afterAnalyser);
  afterAnalyser.connect(voiceEq).connect(outputGain);

  reducer.onprocessorerror = () => {
    switchToSpectralFallback().catch(() => switchToDspFallback());
  };

  // The WASM binary is precompiled before this graph is connected. Keep the
  // aligned dry path live briefly while the worklet creates its model state.
  neuralActivationTimer = setTimeout(() => {
    if (processorMode !== 'neural' || reducer !== neuralReducer) return;
    neuralReady = true;
    applySettings(currentSettings);
    chrome.runtime.sendMessage({ type: 'FILTER_STATUS', status: 'neural' }).catch(() => {});
  }, 150);
  applySettings(currentSettings);
}

async function switchToSpectralFallback() {
  if (switchingFallback || !source || !audioContext || processorMode === 'spectral') return;
  switchingFallback = true;
  try {
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('noise-reducer-worklet.js'));
    if (!source || !audioContext) return;

    const spectralReducer = new AudioWorkletNode(audioContext, 'spectral-noise-reducer', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'speakers'
    });
    disconnectProcessingGraph();
    reducer = spectralReducer;
    processorMode = 'spectral';
    source.connect(beforeAnalyser).connect(reducer).connect(afterAnalyser).connect(outputGain);
    reducer.onprocessorerror = () => switchToDspFallback();
    reducer.port.onmessage = (event) => {
      if (event.data.type === 'CALIBRATED') {
        chrome.runtime.sendMessage({ type: 'FILTER_STATUS', status: 'fallback' }).catch(() => {});
      }
    };
    applySettings(currentSettings);
  } finally {
    switchingFallback = false;
  }
}

function switchToDspFallback() {
  if (!source || !audioContext || processorMode === 'dsp') return;
  const highPass = audioContext.createBiquadFilter();
  const lowPass = audioContext.createBiquadFilter();
  const compressor = audioContext.createDynamicsCompressor();
  highPass.type = 'highpass';
  lowPass.type = 'lowpass';

  disconnectProcessingGraph();
  fallbackHighPass = highPass;
  fallbackLowPass = lowPass;
  fallbackCompressor = compressor;
  processorMode = 'dsp';
  source.connect(beforeAnalyser).connect(highPass).connect(lowPass).connect(compressor).connect(afterAnalyser).connect(outputGain);
  applySettings(currentSettings);
  chrome.runtime.sendMessage({ type: 'FILTER_STATUS', status: 'fallback' }).catch(() => {});
}

function sendMetrics() {
  if (!beforeAnalyser || !afterAnalyser) return;
  const before = new Uint8Array(beforeAnalyser.frequencyBinCount);
  const after = new Uint8Array(afterAnalyser.frequencyBinCount);
  beforeAnalyser.getByteFrequencyData(before);
  afterAnalyser.getByteFrequencyData(after);
  chrome.runtime.sendMessage({
    type: 'AUDIO_METRICS',
    before: Array.from(before.filter((_value, index) => index % 8 === 0)),
    after: Array.from(after.filter((_value, index) => index % 8 === 0))
  }).catch(() => {});
}

async function loadNeuralModel() {
  const response = await fetch(chrome.runtime.getURL('gtcrn.wasm'));
  if (!response.ok) throw new Error(`Could not load the neural model (${response.status}).`);
  const wasmBinary = await response.arrayBuffer();
  // Fail before disconnecting the audible pass-through if WASM is blocked,
  // corrupt, or unsupported on the current Chrome build.
  await WebAssembly.compile(wasmBinary.slice(0));
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('gtcrn-worklet.js'));
  return wasmBinary;
}

async function startAudio(streamId, tabId, settings) {
  await stopAudio();

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    const audioTrack = mediaStream.getAudioTracks()[0];
    if (!audioTrack) {
      throw new Error('This tab has no capturable audio track. Start playback and try again.');
    }
    audioTrack.addEventListener('ended', () => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_ENDED', tabId }).catch(() => {});
    }, { once: true });

    currentSettings = { ...defaults, ...settings };
    // GTCRN has a native 48 kHz streaming path. Chrome resamples the device
    // output when necessary while keeping model inference deterministic.
    audioContext = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    source = audioContext.createMediaStreamSource(mediaStream);
    outputGain = audioContext.createGain();
    outputGain.gain.value = 1;
    beforeAnalyser = audioContext.createAnalyser();
    afterAnalyser = audioContext.createAnalyser();
    beforeAnalyser.fftSize = 1024;
    afterAnalyser.fftSize = 1024;

    // Chrome suppresses normal tab output during capture. Restore playback
    // before loading any model so a slow or failed initialization cannot mute it.
    source.connect(outputGain).connect(audioContext.destination);
    if (audioContext.state === 'suspended') await audioContext.resume();

    try {
      connectNeuralGraph(await loadNeuralModel());
    } catch (_neuralError) {
      try {
        await switchToSpectralFallback();
      } catch (_spectralError) {
        switchToDspFallback();
      }
    }
    metricsTimer = setInterval(sendMetrics, 100);
  } catch (error) {
    await stopAudio();
    throw error;
  }
}

async function stopAudio() {
  const oldContext = audioContext;
  const oldStream = mediaStream;
  if (metricsTimer) clearInterval(metricsTimer);
  metricsTimer = null;
  disconnectProcessingGraph();
  [source, beforeAnalyser, afterAnalyser, outputGain].forEach(disconnect);

  audioContext = null;
  mediaStream = null;
  source = null;
  outputGain = null;
  beforeAnalyser = null;
  afterAnalyser = null;
  switchingFallback = false;

  if (oldStream) oldStream.getTracks().forEach((track) => track.stop());
  if (oldContext && oldContext.state !== 'closed') {
    try {
      await oldContext.close();
    } catch (_error) {
      // Stopping the MediaStream above is enough to restore original tab audio.
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return undefined;

  if (message.type === 'START_AUDIO') {
    startAudio(message.streamId, message.tabId, message.settings)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'STOP_AUDIO') {
    stopAudio()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'UPDATE_SETTINGS') applySettings(message.settings);
  return undefined;
});
