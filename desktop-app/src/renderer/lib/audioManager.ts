/**
 * ChatterAudioManager — Web Audio API playback with smooth fades.
 *
 * Instead of raw `<audio>` elements, we:
 *   1. Decode ArrayBuffer (from Piper IPC) into AudioBuffer
 *   2. Route through GainNode for volume control + fade-in/fade-out
 *   3. Schedule precisely on the audio card timeline
 *
 * This eliminates clicks/pops and gives smooth interruptions.
 */

class ChatterAudioManager {
  private ctx: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private nextStartTime = 0;

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  /** Smooth fade-out and stop. */
  async stopWithFade(fadeTimeMs = 150) {
    if (!this.ctx || !this.gainNode || !this.currentSource) return;

    const ctx = this.ctx;
    const gain = this.gainNode;
    const source = this.currentSource;
    const fadeTimeSec = fadeTimeMs / 1000;

    try {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeTimeSec);
      source.stop(ctx.currentTime + fadeTimeSec);
    } catch {
      // source may have already stopped
    }

    this.currentSource = null;
    this.gainNode = null;
    this.nextStartTime = 0;

    await new Promise<void>((resolve) => setTimeout(resolve, fadeTimeMs));
  }

  /**
   * Play an audio buffer with fade-in / fade-out.
   * Does NOT stop previous playback — call stopWithFade() first if needed.
   *
   * @param buffer  Raw WAV ArrayBuffer from Piper IPC
   * @param volume  Master volume 0..1
   * @param isChain If true, queue after previous phrase (gapless playback)
   */
  async playBuffer(buffer: ArrayBuffer, volume: number, isChain = false) {
    this.init();
    const ctx = this.ctx!;

    // decodeAudioData "consumes" the buffer — slice to keep a copy
    const audioBuffer = await ctx.decodeAudioData(buffer.slice(0));

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    const gain = ctx.createGain();

    const startTime = isChain ? Math.max(this.nextStartTime, ctx.currentTime) : ctx.currentTime;

    // Fade-in: 40ms ramp from silence
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + 0.04);

    // Fade-out: ramp to 0 strictly 15ms before buffer end (no click)
    const duration = audioBuffer.duration;
    const endTime = startTime + duration;
    gain.gain.setValueAtTime(volume, endTime - 0.06);
    gain.gain.linearRampToValueAtTime(0, endTime - 0.015);

    source.connect(gain);
    gain.connect(ctx.destination);

    this.currentSource = source;
    this.gainNode = gain;
    this.nextStartTime = endTime;

    // Return a Promise that resolves only when audio physically finishes
    return new Promise<void>((resolve) => {
      source.onended = () => {
        resolve();
      };
      source.start(startTime);
    });
  }

  /** Hard stop (no fade). */
  abort() {
    try { this.currentSource?.stop(); } catch { /* ignore */ }
    this.currentSource = null;
    this.gainNode = null;
    this.nextStartTime = 0;
  }
}

export const audioManager = new ChatterAudioManager();
