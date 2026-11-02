/**
 * Fully synthesised spatial sound (no audio files to download).
 * Off by default; only started after the visitor presses the SOUND toggle.
 */
class SpatialAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private panner: StereoPannerNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private nodes: AudioScheduledSourceNode[] = [];
  private enabled = false;

  get isEnabled() {
    return this.enabled;
  }

  async enable() {
    if (this.enabled) return;
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = this.ctx ?? new Ctor();
    await this.ctx.resume();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.panner = ctx.createStereoPanner();
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 420;
    this.filter.Q.value = 0.7;

    this.filter.connect(this.panner).connect(this.master).connect(ctx.destination);

    // A soft, detuned drone: the "room tone" of the showroom.
    const freqs = [55, 82.4, 110.2, 164.8];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = i % 2 ? 'triangle' : 'sine';
      osc.frequency.value = f;
      osc.detune.value = (i - 1.5) * 4;
      const g = ctx.createGain();
      g.gain.value = 0.18 / (i + 1);
      osc.connect(g).connect(this.filter!);
      osc.start();
      this.nodes.push(osc);
    });

    // Slow filter breathing
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(this.filter.frequency);
    lfo.start();
    this.nodes.push(lfo);

    this.master.gain.linearRampToValueAtTime(0.32, ctx.currentTime + 1.8);
    this.enabled = true;
  }

  disable() {
    if (!this.enabled || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const nodes = this.nodes;
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setValueAtTime(this.master.gain.value, ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
    window.setTimeout(() => nodes.forEach((n) => n.stop()), 600);
    this.nodes = [];
    this.enabled = false;
  }

  /** -1 (left) … 1 (right) */
  setPan(x: number) {
    if (!this.enabled || !this.panner || !this.ctx) return;
    this.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, x * 0.7)), this.ctx.currentTime, 0.15);
  }

  /** brighten the drone with scroll depth */
  setDepth(t: number) {
    if (!this.enabled || !this.filter || !this.ctx) return;
    this.filter.Q.setTargetAtTime(0.7 + t * 4, this.ctx.currentTime, 0.4);
  }

  /** a short glassy tick for UI feedback */
  tick(pan = 0, pitch = 1) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1600 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(900 * pitch, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    osc.connect(g).connect(p).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}

export const audio = new SpatialAudio();
