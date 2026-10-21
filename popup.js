import { defaults, normalizeSettings, effectiveSettings, capabilities } from './settings.js';
const powerButton = document.querySelector('#power-button');
const powerLabel = document.querySelector('#power-label');
const statusLabel = document.querySelector('#status-label');
const statusDetail = document.querySelector('#status-detail');
const notice = document.querySelector('#notice');
const liveDot = document.querySelector('#live-dot');
const intensity = document.querySelector('#intensity');
const intensityValue = document.querySelector('#intensity-value');
const voiceBoost = document.querySelector('#voice-boost');
const spectrum = document.querySelector('#spectrum');
const spectrumContext = spectrum.getContext('2d');

let active = false;
let calibrated = false;
let beforeSpectrum = [];
let afterSpectrum = [];

function drawSpectrum() {
  const width = spectrum.width;
  const height = spectrum.height;
  spectrumContext.clearRect(0, 0, width, height);
  spectrumContext.fillStyle = '#dfe8df';
  spectrumContext.fillRect(0, 0, width, height);
  spectrumContext.strokeStyle = 'rgba(24, 35, 31, .08)';
  spectrumContext.lineWidth = 1;
  for (let row = 1; row < 4; row += 1) {
    spectrumContext.beginPath();
    spectrumContext.moveTo(0, (height / 4) * row);
    spectrumContext.lineTo(width, (height / 4) * row);
    spectrumContext.stroke();
  }

  const drawLine = (values, color, fill) => {
    if (!values.length) return;
    spectrumContext.beginPath();
    values.forEach((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - (value / 255) * (height - 8) - 4;
      if (index === 0) spectrumContext.moveTo(x, y);
      else spectrumContext.lineTo(x, y);
    });
    spectrumContext.strokeStyle = color;
    spectrumContext.lineWidth = 2;
    spectrumContext.stroke();
    if (fill) {
      spectrumContext.lineTo(width, height);
      spectrumContext.lineTo(0, height);
      spectrumContext.globalAlpha = .12;
      spectrumContext.fillStyle = fill;
      spectrumContext.fill();
      spectrumContext.globalAlpha = 1;
    }
  };

  drawLine(beforeSpectrum, '#e98755', '#e98755');
  drawLine(afterSpectrum, '#1e6b4b', '#1e6b4b');
  requestAnimationFrame(drawSpectrum);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROCESSOR_MODE') { processorMode = message.processorMode; renderSettings(); }
  if (message.type === 'AUDIO_METRICS') {
    beforeSpectrum = message.before || [];
    afterSpectrum = message.after || [];
  }
  if (message.type === 'FILTER_STATUS' && message.status === 'ready') {
    calibrated = true;
    statusLabel.textContent = 'FILTERING ACTIVE';
    notice.textContent = 'Orange is the captured signal. Green is what reaches your ears.';
  }
  if (message.type === 'FILTER_STATUS' && message.status === 'neural') {
    calibrated = true;
    statusLabel.textContent = 'NEURAL FILTER ACTIVE';
    notice.textContent = 'GTCRN AI enhancement is processing this tab locally on your Mac.';
  }
  if (message.type === 'FILTER_STATUS' && message.status === 'fallback') {
    calibrated = true;
    statusLabel.textContent = 'FILTERING ACTIVE';
    notice.textContent = 'Compatibility mode is active. Audio is still being filtered locally.';
  }
});

function setActive(nextActive) {
  active = nextActive;
  if (!active) { processorMode = 'none'; renderSettings(); }
  document.body.classList.toggle('is-active', active);
  powerButton.classList.toggle('is-active', active);
  liveDot.classList.toggle('is-active', active);
  powerLabel.textContent = active ? 'Stop filtering' : 'Start filtering';
  statusLabel.textContent = active ? 'FILTERING ACTIVE' : 'READY TO LISTEN';
  statusDetail.textContent = active
    ? 'Background noise is being reduced from this tab.'
    : "Clean up the active tab's audio in real time.";
  notice.textContent = active
    ? calibrated ? 'Orange is the captured signal. Green is what reaches your ears.' : 'Learning the steady noise floor for a moment...'
    : 'Works with audio from the current tab. Start playback before enabling.';
}

let settings = normalizeSettings();
let processorMode = 'none';
let saveQueue = Promise.resolve();
const controls = { intensity, voiceBoost, listeningMode: document.querySelector('#listening-mode'), ...Object.fromEntries(['speechGain','outputPercent','dryPercent','hissCutoff','noiseWindow','allowBoost'].map(key => [key, document.querySelector('#' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()))])) };
function renderSettings() {
  const effective = effectiveSettings(settings);
  const supported = capabilities(processorMode);
  controls.outputPercent.max = settings.allowBoost ? 800 : 100;
  const ids = { intensity: 'intensity', speechGain: 'speech-gain', outputPercent: 'output-percent', dryPercent: 'dry-percent', hissCutoff: 'hiss-cutoff', noiseWindow: 'noise-window' };
  const units = { intensity: '%', speechGain: ' dB', outputPercent: '%', dryPercent: '%', hissCutoff: ' Hz', noiseWindow: ' s' };
  for (const [key, element] of Object.entries(controls)) {
    if (element.type === 'checkbox') element.checked = effective[key];
    else element.value = effective[key];
    const unsupported = (key in supported && !supported[key]) || (key === 'speechGain' && !effective.voiceBoost);
    element.disabled = unsupported;
    element.title = unsupported ? 'Unavailable in the current processing path; saved for supported paths.' : '';
    if (ids[key]) document.querySelector('#' + ids[key] + '-value').textContent = effective[key] + units[key] + (unsupported ? ' (unavailable)' : '');
  }
}
function saveSettings(patch) {
  settings = normalizeSettings(patch, settings);
  renderSettings();
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const response = await chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: patch });
    if (!response?.ok) throw new Error(response?.error || 'Could not save settings.');
  }).catch(error => { notice.textContent = error.message; });
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const patch = Object.fromEntries(Object.entries(changes).filter(([key]) => key in defaults).map(([key, change]) => [key, change.newValue]));
  settings = normalizeSettings(patch, settings);
  renderSettings();
});

async function toggleFiltering() {
  powerButton.disabled = true;
  notice.textContent = active ? 'Stopping audio filter...' : 'Connecting to the active tab...';
  const messageType = active ? 'STOP_FILTERING' : 'START_FILTERING';

  try {
    await saveQueue;
    const response = await chrome.runtime.sendMessage({ type: messageType });
    if (!response?.ok) {
      throw new Error(response?.error || 'Chrome could not capture this tab.');
    }
    calibrated = false;
    setActive(!active);
  } catch (error) {
    statusLabel.textContent = 'COULD NOT START';
    statusDetail.textContent = 'Choose a regular video tab and try again.';
    notice.textContent = error.message || 'Chrome could not capture this tab.';
  } finally {
    powerButton.disabled = false;
  }
}

async function restoreState() {
  settings = normalizeSettings(await chrome.storage.local.get(defaults));
  renderSettings();

  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  processorMode = state?.processorMode || 'none';
  renderSettings();
  setActive(Boolean(state?.active));
}

powerButton.addEventListener('click', toggleFiltering);
for (const [key, element] of Object.entries(controls)) {
  element.addEventListener(element.type === 'range' ? 'input' : 'change', () => {
    const value = element.type === 'checkbox' ? element.checked : key === 'listeningMode' ? element.value : Number(element.value);
    const patch = { [key]: value };
    if (!['listeningMode','outputPercent','allowBoost'].includes(key)) patch.listeningMode = 'custom';
    saveSettings(patch);
  });
}
restoreState().catch(() => setActive(false));
drawSpectrum();
