/**
 * AudioWorklet processor that captures raw PCM audio from the microphone
 * and sends it to the main thread as Int16 ArrayBuffers.
 */
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    // Send chunks of ~4096 samples at a time for efficiency
    this._chunkSize = 4096;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0]; // mono

      // Append to buffer
      const newBuffer = new Float32Array(this._buffer.length + channelData.length);
      newBuffer.set(this._buffer);
      newBuffer.set(channelData, this._buffer.length);
      this._buffer = newBuffer;

      // Send chunks when we have enough data
      while (this._buffer.length >= this._chunkSize) {
        const chunk = this._buffer.slice(0, this._chunkSize);
        this._buffer = this._buffer.slice(this._chunkSize);

        // Convert Float32 [-1, 1] to Int16 [-32768, 32767]
        const int16Data = new Int16Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          const s = Math.max(-1, Math.min(1, chunk[i]));
          int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        this.port.postMessage(
          { type: "audio", data: int16Data.buffer },
          [int16Data.buffer]
        );
      }
    }
    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
