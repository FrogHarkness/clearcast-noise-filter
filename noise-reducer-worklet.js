class SpectralNoiseReducer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 1024;
    this.hop = this.size / 2;
    this.channels = [];
    this.intensity = 0.68;
    this.voiceBoost = true;
    this.calibrated = false;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'SETTINGS') {
        this.intensity = Math.max(0, Math.min(1, Number(data.intensity) / 100));
        this.voiceBoost = Boolean(data.voiceBoost);
      }
    };
  }

  createChannelState() {
    return {
      input: new Float32Array(this.size),
      inputCount: 0,
      real: new Float32Array(this.size),
      imag: new Float32Array(this.size),
      noise: new Float32Array(this.size / 2),
      noiseReady: false,
      overlap: new Float32Array(this.hop),
      queue: new Float32Array(this.size * 4),
      queueRead: 0,
      queueWrite: 0,
      queueLength: 0
    };
  }

  process(inputs, outputs) {
    const inputChannels = inputs[0] || [];
    const outputChannels = outputs[0] || [];

    for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex += 1) {
      const output = outputChannels[channelIndex];
      const input = inputChannels[channelIndex] || inputChannels[0];
      if (!input) {
        output.fill(0);
        continue;
      }

      if (!this.channels[channelIndex]) {
        this.channels[channelIndex] = this.createChannelState();
      }
      const state = this.channels[channelIndex];

      for (let sampleIndex = 0; sampleIndex < output.length; sampleIndex += 1) {
        state.input[state.inputCount] = input[sampleIndex] || 0;
        state.inputCount += 1;
        if (state.inputCount === this.size) {
          this.reduceFrame(state);
          state.input.copyWithin(0, this.hop);
          state.inputCount = this.size - this.hop;
        }
        output[sampleIndex] = this.dequeue(state);
      }
    }

    return true;
  }

  enqueue(state, value) {
    if (state.queueLength === state.queue.length) {
      state.queueRead = (state.queueRead + 1) % state.queue.length;
      state.queueLength -= 1;
    }
    state.queue[state.queueWrite] = value;
    state.queueWrite = (state.queueWrite + 1) % state.queue.length;
    state.queueLength += 1;
  }

  dequeue(state) {
    if (state.queueLength === 0) return 0;
    const value = state.queue[state.queueRead];
    state.queueRead = (state.queueRead + 1) % state.queue.length;
    state.queueLength -= 1;
    return value;
  }

  reduceFrame(state) {
    const { real, imag } = state;
    imag.fill(0);
    for (let index = 0; index < this.size; index += 1) {
      // A square-root Hann pair gives smooth 50% overlap-add reconstruction.
      const window = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * index) / this.size));
      real[index] = state.input[index] * window;
    }
    this.fft(real, imag);

    for (let bin = 0; bin < this.size / 2; bin += 1) {
      const magnitude = Math.hypot(real[bin], imag[bin]);
      if (!state.noiseReady) state.noise[bin] = magnitude;

      const frequency = (bin * sampleRate) / this.size;
      const protectedBandEnd = this.voiceBoost ? 7200 : 4200;
      const isVoiceBand = frequency >= 80 && frequency <= protectedBandEnd;
      const noiseRatio = state.noise[bin] / Math.max(magnitude, 0.00001);
      const reduction = Math.max(0.06, 1 - this.intensity * Math.min(0.94, noiseRatio * 0.92));
      const gain = isVoiceBand ? Math.max(reduction, 0.2) : reduction;

      real[bin] *= gain;
      imag[bin] *= gain;
      if (bin > 0) {
        real[this.size - bin] *= gain;
        imag[this.size - bin] *= gain;
      }

      const speechPresent = magnitude > state.noise[bin] * 1.8;
      state.noise[bin] = speechPresent
        ? state.noise[bin] * 0.9995 + magnitude * 0.0005
        : state.noise[bin] * 0.985 + magnitude * 0.015;
    }
    state.noiseReady = true;
    this.fft(real, imag, true);

    for (let index = 0; index < this.hop; index += 1) {
      const firstWindow = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * index) / this.size));
      const secondIndex = index + this.hop;
      const secondWindow = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * secondIndex) / this.size));
      this.enqueue(state, real[index] * firstWindow + state.overlap[index]);
      state.overlap[index] = real[secondIndex] * secondWindow;
    }

    if (!this.calibrated) {
      this.calibrated = true;
      this.port.postMessage({ type: 'CALIBRATED' });
    }
  }

  fft(real, imag, inverse = false) {
    const length = real.length;
    for (let index = 1, reversed = 0; index < length; index += 1) {
      let bit = length >> 1;
      for (; reversed & bit; bit >>= 1) reversed ^= bit;
      reversed ^= bit;
      if (index < reversed) {
        [real[index], real[reversed]] = [real[reversed], real[index]];
        [imag[index], imag[reversed]] = [imag[reversed], imag[index]];
      }
    }

    for (let blockLength = 2; blockLength <= length; blockLength <<= 1) {
      const angle = (inverse ? 2 : -2) * Math.PI / blockLength;
      for (let start = 0; start < length; start += blockLength) {
        for (let offset = 0; offset < blockLength / 2; offset += 1) {
          const cosine = Math.cos(angle * offset);
          const sine = Math.sin(angle * offset);
          const even = start + offset;
          const odd = even + blockLength / 2;
          const oddReal = real[odd] * cosine - imag[odd] * sine;
          const oddImag = real[odd] * sine + imag[odd] * cosine;
          real[odd] = real[even] - oddReal;
          imag[odd] = imag[even] - oddImag;
          real[even] += oddReal;
          imag[even] += oddImag;
        }
      }
    }

    if (inverse) {
      for (let index = 0; index < length; index += 1) {
        real[index] /= length;
        imag[index] /= length;
      }
    }
  }
}

registerProcessor('spectral-noise-reducer', SpectralNoiseReducer);
