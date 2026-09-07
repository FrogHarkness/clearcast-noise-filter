const OFFSCREEN_URL = 'offscreen.html';
const OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(OFFSCREEN_URL);

let creatingOffscreenDocument = null;
let lifecycleQueue = Promise.resolve();

function serializeLifecycle(operation) {
  const result = lifecycleQueue.then(operation, operation);
  lifecycleQueue = result.catch(() => {});
  return result;
}

async function getOffscreenContexts() {
  return chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_DOCUMENT_URL]
  });
}

async function ensureOffscreenDocument() {
  if ((await getOffscreenContexts()).length > 0) return;
  if (creatingOffscreenDocument) return creatingOffscreenDocument;

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Capture, filter, and play the current tab audio in real time.'
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

async function closeOffscreenDocument() {
  if (creatingOffscreenDocument) {
    try {
      await creatingOffscreenDocument;
    } catch (_error) {
      creatingOffscreenDocument = null;
      return;
    }
  }

  if ((await getOffscreenContexts()).length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

async function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

async function resetStoredState() {
  await chrome.storage.local.set({ active: false, tabId: null });
}

async function closeAndResetState() {
  try {
    await closeOffscreenDocument();
  } finally {
    await resetStoredState();
  }
}

async function stopFilteringInternal() {
  try {
    if ((await getOffscreenContexts()).length > 0) {
      await sendToOffscreen({ type: 'STOP_AUDIO' });
    }
  } finally {
    await closeAndResetState();
  }
}

async function startFilteringInternal() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!Number.isInteger(tab?.id)) {
    throw new Error('No active tab was found.');
  }
  if (tab.url && /^(chrome|chrome-extension|edge|edge-extension|about|devtools):/i.test(tab.url)) {
    throw new Error('Chrome cannot capture audio from this protected page. Open a normal website tab and try again.');
  }

  // Clear stale or previous capture state before requesting another one-use ID.
  const storedState = await chrome.storage.local.get(['active', 'tabId']);
  const capturedTabs = await chrome.tabCapture.getCapturedTabs();
  if (storedState.active || capturedTabs.length > 0) {
    await stopFilteringInternal();
  }

  try {
    // Chrome stream IDs expire quickly. The consumer must be ready before we ask
    // Chrome for the ID, particularly on the first run of the extension.
    await ensureOffscreenDocument();
    const settings = await chrome.storage.local.get({ intensity: 68, voiceBoost: true });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const response = await sendToOffscreen({
      type: 'START_AUDIO',
      streamId,
      tabId: tab.id,
      settings
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'The audio processor could not start.');
    }
    await chrome.storage.local.set({ active: true, tabId: tab.id });
  } catch (error) {
    // Consuming a tab stream mutes its normal playback. Always release a partial
    // capture so a failed start immediately restores the site's original audio.
    try {
      await stopFilteringInternal();
    } catch (_cleanupError) {
      await resetStoredState();
    }
    throw error;
  }
}

async function getState() {
  const state = await chrome.storage.local.get(['active', 'tabId']);
  if (!state.active || !Number.isInteger(state.tabId)) {
    return { active: false, tabId: null };
  }

  const capturedTabs = await chrome.tabCapture.getCapturedTabs();
  const captureIsAlive = capturedTabs.some(({ tabId, status }) => (
    tabId === state.tabId && (status === 'active' || status === 'pending')
  ));
  if (captureIsAlive) return state;

  await closeAndResetState();
  return { active: false, tabId: null };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target === 'offscreen') return undefined;

  if (message.type === 'START_FILTERING') {
    serializeLifecycle(startFilteringInternal)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'STOP_FILTERING') {
    serializeLifecycle(stopFilteringInternal)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'GET_STATE') {
    serializeLifecycle(getState)
      .then(sendResponse)
      .catch(() => sendResponse({ active: false, tabId: null }));
    return true;
  }

  if (message.type === 'UPDATE_SETTINGS') {
    sendToOffscreen(message).catch(() => {});
  }

  if (message.type === 'CAPTURE_ENDED') {
    serializeLifecycle(async () => {
      const state = await chrome.storage.local.get(['active', 'tabId']);
      if (state.tabId === message.tabId) {
        await closeAndResetState();
      }
    });
  }

  return undefined;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serializeLifecycle(async () => {
    const state = await chrome.storage.local.get(['active', 'tabId']);
    if (state.active && state.tabId === tabId) {
      await stopFilteringInternal();
    }
  });
});

chrome.tabCapture.onStatusChanged.addListener((info) => {
  if (info.status !== 'stopped' && info.status !== 'error') return;
  serializeLifecycle(async () => {
    const state = await chrome.storage.local.get(['active', 'tabId']);
    if (state.active && state.tabId === info.tabId) {
      await closeAndResetState();
    }
  });
});
