// Linked-channel, zero-lookahead peak limiter: immediate attenuation, 100 ms
// release. This bounds digital samples, not device SPL or intersample peaks.
class OutputLimiter extends AudioWorkletProcessor {
  constructor() { super(); this.gain = 1; this.release = 1 - Math.exp(-1 / (sampleRate * 0.1)); }
  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    for (let i = 0; i < (output[0]?.length || 0); i++) {
      let peak = 0;
      for (let c = 0; c < output.length; c++) {
        const x = input[c]?.[i] ?? input[0]?.[i] ?? 0;
        if (Number.isFinite(x)) peak = Math.max(peak, Math.abs(x));
      }
      const target = peak > 0.95 ? 0.95 / peak : 1;
      this.gain = Math.min(target, this.gain + (1 - this.gain) * this.release);
      for (let c = 0; c < output.length; c++) {
        const x = input[c]?.[i] ?? input[0]?.[i] ?? 0;
        output[c][i] = Number.isFinite(x) ? Math.max(-0.95, Math.min(0.95, x * this.gain)) : 0;
      }
    }
    return true;
  }
}
registerProcessor('clearcast-output-limiter', OutputLimiter);
