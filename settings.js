export const defaults = Object.freeze({ intensity: 68, voiceBoost: true, listeningMode: 'custom', speechGain: 2.5, outputPercent: 100, dryPercent: 15, hissCutoff: 20000, noiseWindow: 3, allowBoost: false });
const ranges = { intensity: [0,100], speechGain: [0,9], outputPercent: [0,800], dryPercent: [0,50], hissCutoff: [4000,20000], noiseWindow: [3,15] };
export function normalizeSettings(input = {}, previous = defaults) {
  const result = { ...defaults, ...previous };
  for (const [key, [min,max]] of Object.entries(ranges)) {
    if (Object.hasOwn(input, key)) {
      const value = input[key];
      result[key] = typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max,value)) : defaults[key];
    }
  }
  for (const key of ['voiceBoost','allowBoost']) if (Object.hasOwn(input,key)) result[key] = input[key] === true;
  if (Object.hasOwn(input,'listeningMode')) result.listeningMode = ['natural','dialogue','custom'].includes(input.listeningMode) ? input.listeningMode : 'custom';
  // A boost cannot silently return after permission is revoked.
  if (!result.allowBoost) result.outputPercent = Math.min(100,result.outputPercent);
  return result;
}
export function effectiveSettings(input) {
  const s = normalizeSettings(input);
  const presets = { natural: { intensity: 40, voiceBoost: false, speechGain: 0, dryPercent: 30, hissCutoff: 20000, noiseWindow: 3 }, dialogue: { intensity: 85, voiceBoost: true, speechGain: 4, dryPercent: 5, hissCutoff: 10000, noiseWindow: 5 } };
  return { ...s, ...presets[s.listeningMode] };
}
export function capabilities(mode) { return { dryPercent: mode === 'neural', noiseWindow: mode === 'spectral' }; }
