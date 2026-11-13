class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.targetRate = Number(config.targetRate || 16000);
    this.chunkSize = Number(config.chunkSize || 2048);
    this.ratio = sampleRate / this.targetRate;
    this.readPosition = 0;
    this.pending = [];
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }

    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    // Streaming linear resampling: microphone sample rate -> 16 kHz.
    // The fractional read position is kept across process() blocks to avoid drift.
    while (this.readPosition < input.length) {
      const left = Math.min(Math.floor(this.readPosition), input.length - 1);
      const right = Math.min(left + 1, input.length - 1);
      const fraction = this.readPosition - left;
      const sample = input[left] * (1 - fraction) + input[right] * fraction;
      this.pending.push(Math.max(-1, Math.min(1, sample)));
      this.readPosition += this.ratio;
    }
    this.readPosition -= input.length;

    while (this.pending.length >= this.chunkSize) {
      const chunk = this.pending.splice(0, this.chunkSize);
      const pcm = new Int16Array(this.chunkSize);
      for (let i = 0; i < chunk.length; i += 1) {
        const value = chunk[i];
        pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
