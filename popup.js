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

function saveSettings() {
  const settings = {
    intensity: Number(intensity.value),
    voiceBoost: voiceBoost.checked
  };
  chrome.storage.local.set(settings);
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });
}

async function toggleFiltering() {
  powerButton.disabled = true;
  notice.textContent = active ? 'Stopping audio filter...' : 'Connecting to the active tab...';
  const messageType = active ? 'STOP_FILTERING' : 'START_FILTERING';

  try {
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
  const settings = await chrome.storage.local.get({ intensity: 68, voiceBoost: true });
  intensity.value = settings.intensity;
  intensityValue.textContent = `${settings.intensity}%`;
  voiceBoost.checked = settings.voiceBoost;

  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  setActive(Boolean(state?.active));
}

powerButton.addEventListener('click', toggleFiltering);
intensity.addEventListener('input', () => {
  intensityValue.textContent = `${intensity.value}%`;
  saveSettings();
});
voiceBoost.addEventListener('change', saveSettings);
restoreState().catch(() => setActive(false));
drawSpectrum();
