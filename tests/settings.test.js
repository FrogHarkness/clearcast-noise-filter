import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { defaults, normalizeSettings, effectiveSettings, capabilities } from '../settings.js';
const source = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
function context(extra = {}) { return vm.createContext({ defaults, normalizeSettings, effectiveSettings, capabilities, console, ...extra }); }
test('bounds, invalid values, legacy migration, and explicit boost permission', () => {
  assert.equal(normalizeSettings({ outputPercent: 800 }).outputPercent, 100);
  assert.equal(normalizeSettings({ outputPercent: 900, allowBoost: true }).outputPercent, 800);
  assert.equal(normalizeSettings({ allowBoost: false }, normalizeSettings({ outputPercent: 800, allowBoost: true })).outputPercent, 100);
  for (const value of [NaN, Infinity, null, '8', {}, undefined]) assert.equal(normalizeSettings({ intensity: value }).intensity, 68);
  assert.equal(normalizeSettings({ dryPercent: -1 }).dryPercent, 0);
  assert.equal(normalizeSettings({ hissCutoff: 99999 }).hissCutoff, 20000);
  assert.equal(normalizeSettings({ noiseWindow: 0 }).noiseWindow, 3);
  assert.equal(normalizeSettings({ speechGain: 999 }).speechGain, 9);
  assert.equal(normalizeSettings({ intensity: 20, voiceBoost: false }).listeningMode, 'custom');
});
test('presets preserve custom values and never raise output gain', () => {
  const s = normalizeSettings({ speechGain: 7, intensity: 13, outputPercent: 80, listeningMode: 'dialogue' });
  assert.equal(effectiveSettings(s).speechGain, 4);
  assert.equal(effectiveSettings(s).outputPercent, 80);
  assert.equal(effectiveSettings({ ...s, listeningMode: 'custom' }).speechGain, 7);
  assert.equal(effectiveSettings({ ...s, listeningMode: 'natural' }).intensity, 40);
  assert.equal(capabilities('dsp').noiseWindow, false);
});
function audioHarness() {
  const messages = [], nodes = [];
  const param = () => ({ value: 0, setTargetAtTime(value) { this.value = value; } });
  const node = () => { const n = { gain: param(), frequency: param(), Q: param(), delayTime: param(), threshold: param(), ratio: param(), connections: [], connect(other) { this.connections.push(other); return other; }, disconnect() { this.connections = []; }, port: { postMessage(m) { messages.push(m); } } }; nodes.push(n); return n; };
  const audio = { currentTime: 0, sampleRate: 48000, createDelay: node, createGain: node, createBiquadFilter: node, createDynamicsCompressor: node, audioWorklet: { async addModule() {} } };
  const c = context({ chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async () => {}, getURL: s => s } }, AudioWorkletNode: function() { return node(); }, setTimeout() { return 1; }, clearTimeout() {} });
  vm.runInContext(source('offscreen.js'), c);
  c.audio = audio; c.node = node;
  vm.runInContext('audioContext = audio; source = node(); beforeAnalyser = node(); afterAnalyser = node(); outputGain = node(); commonEq = node(); commonLowPass = node(); currentSettings = normalizeSettings();', c);
  return { c, messages, nodes };
}
test('live settings survive neural → spectral → DSP and unsupported parameters are not sent to GTCRN', async () => {
  const { c, messages } = audioHarness();
  vm.runInContext('connectNeuralGraph(new ArrayBuffer(0)); neuralReady = true; applySettings({ intensity: 100, dryPercent: 20, speechGain: 6, outputPercent: 800, allowBoost: true, hissCutoff: 7000, noiseWindow: 12 });', c);
  assert.equal(vm.runInContext('wetGain.gain.value', c), 0.8);
  assert.ok(Math.abs(vm.runInContext('dryGain.gain.value', c) - 0.2) < 1e-10);
  assert.equal(vm.runInContext('outputGain.gain.value', c), 8);
  assert.equal(vm.runInContext('commonEq.gain.value', c), 6);
  assert.equal(messages.filter(m => m?.type === 'SETTINGS').length, 0);
  await vm.runInContext('switchToSpectralFallback()', c);
  assert.equal(messages.at(-1).noiseWindow, 12);
  assert.equal(messages.at(-1).intensity, 100);
  vm.runInContext('switchToDspFallback(); applySettings({ hissCutoff: 5000 });', c);
  assert.equal(vm.runInContext('fallbackLowPass.frequency.value', c), 5000);
  assert.equal(vm.runInContext('currentSettings.noiseWindow', c), 12);
  assert.equal(vm.runInContext('outputGain.gain.value', c), 8);
  vm.runInContext("applySettings({ listeningMode: 'natural' });", c);
  assert.equal(vm.runInContext('commonEq.gain.value', c), 0);
});
test('worker serializes partial writes, persists settings, and restores all fields on start', async () => {
  let listener; const saved = {}; const forwarded = [];
  const c = context({ chrome: {
    runtime: { getURL: s => s, onMessage: { addListener(fn) { listener = fn; } }, getContexts: async () => [{}], sendMessage: async m => { forwarded.push(m); return { ok: true }; } },
    storage: { local: { async get(keys) { return Array.isArray(keys) ? Object.fromEntries(keys.map(k => [k,saved[k]])) : { ...keys, ...saved }; }, async set(patch) { Object.assign(saved,patch); } } },
    tabs: { query: async () => [{ id: 1, url: 'https://example.com' }], onRemoved: { addListener() {} } },
    tabCapture: { getCapturedTabs: async () => [], getMediaStreamId: async () => 'stream', onStatusChanged: { addListener() {} } }, offscreen: { closeDocument: async () => {} }
  } });
  vm.runInContext(source('service-worker.js'),c);
  const send = m => new Promise(resolve => listener(m, {}, resolve));
  await Promise.all([send({ type: 'UPDATE_SETTINGS', settings: { speechGain: 5 } }), send({ type: 'UPDATE_SETTINGS', settings: { noiseWindow: 11, listeningMode: 'dialogue' } })]);
  assert.equal(saved.speechGain,5); assert.equal(saved.noiseWindow,11);
  await send({ type: 'START_FILTERING' });
  const started = forwarded.find(m => m.type === 'START_AUDIO');
  assert.equal(started.settings.speechGain,5); assert.equal(started.settings.listeningMode,'dialogue');
  assert.equal(started.settings.noiseWindow,11);
});
test('popup restores every display, handles inputs, follows storage and processor changes', async () => {
  const elements = new Map(); const handlers = {}; let storageHandler, runtimeHandler;
  function element(id) { if (!elements.has(id)) elements.set(id, { type: id === '#voice-boost' || id === '#allow-boost' ? 'checkbox' : id === '#listening-mode' ? 'select-one' : 'range', classList: { toggle() {} }, addEventListener(event, fn) { handlers[id + event] = fn; }, getContext() { return new Proxy({}, { get: () => () => {} }); } }); return elements.get(id); }
  const requests = [];
  const c = context({ document: { querySelector: element, body: { classList: { toggle() {} } } }, requestAnimationFrame() {}, chrome: {
    storage: { local: { get: async () => ({ ...defaults, speechGain: 5, noiseWindow: 8 }) }, onChanged: { addListener(fn) { storageHandler = fn; } } },
    runtime: { onMessage: { addListener(fn) { runtimeHandler = fn; } }, async sendMessage(m) { requests.push(m); return m.type === 'GET_STATE' ? { active: true, processorMode: 'spectral' } : { ok: true }; } }
  } });
  vm.runInContext(source('popup.js'),c); await new Promise(setImmediate);
  assert.equal(element('#speech-gain-value').textContent,'5 dB');
  assert.equal(element('#noise-window').disabled,false);
  assert.equal(element('#dry-percent').disabled,true);
  element('#speech-gain').value = '7'; handlers['#speech-gaininput'](); await new Promise(setImmediate);
  assert.equal(requests.at(-1).settings.speechGain,7);
  element('#listening-mode').value = 'dialogue'; handlers['#listening-modechange'](); await new Promise(setImmediate);
  assert.equal(element('#speech-gain-value').textContent,'4 dB');
  storageHandler({ listeningMode: { newValue: 'custom' }, speechGain: { newValue: 8 } },'local');
  assert.equal(element('#speech-gain-value').textContent,'8 dB');
  runtimeHandler({ type: 'PROCESSOR_MODE', processorMode: 'neural' });
  assert.equal(element('#dry-percent').disabled,false); assert.equal(element('#noise-window').disabled,true);
});
test('spectral noise window changes actual adaptation without resetting profile', () => {
  let Processor; const c = context({ sampleRate: 48000, AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {} }; } }, registerProcessor(_,p) { Processor=p; } });
  vm.runInContext(source('noise-reducer-worklet.js'),c);
  const run = seconds => { const p=new Processor(); p.port.onmessage({ data: { type:'SETTINGS',intensity:68,voiceBoost:true,noiseWindow:seconds } }); const state=p.createChannelState(); state.noise.fill(1); state.noiseReady=true; p.reduceFrame(state); return state.noise[1]; };
  assert.ok(run(15)>run(3));
});
test('limiter bounds 8x transients, links stereo, mutes nonfinite samples, and releases', () => {
  let Processor; const c = context({ sampleRate:48000, AudioWorkletProcessor:class {}, registerProcessor(_,p) { Processor=p; } });
  vm.runInContext(source('output-limiter-worklet.js'),c); const p=new Processor();
  const left=Float32Array.from([8,-8,NaN,Infinity,0.1]), right=Float32Array.from([4,-4,0,0,0.05]); const out=[new Float32Array(5),new Float32Array(5)];
  p.process([[left,right]],[out]);
  assert.ok([...out[0],...out[1]].every(x => Number.isFinite(x) && Math.abs(x)<=0.950001));
  assert.equal(out[0][0],2*out[1][0]); assert.equal(out[0][2],0);
  const previous=p.gain; p.process([[new Float32Array(128)]],[[new Float32Array(128)]]); assert.ok(p.gain>previous);
});
