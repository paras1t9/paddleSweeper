// src/client/audio.ts
//
// All sound is synthesized live with the Web Audio API — no audio files to
// load or host. A single module-level singleton (`audioManager`) is shared
// across every scene, so the music keeps playing seamlessly through scene
// transitions instead of restarting each time a Scene is recreated.

class AudioManager {
  private ctx: AudioContext | null = null;
  private master: DynamicsCompressorNode | null = null;
  private musicGain: GainNode | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private started = false;

  private readonly NORMAL_VOLUME = 0.65;
  private readonly DUCKED_VOLUME = 0.42;

  // Must be called from inside a real user gesture handler (click/tap) —
  // browsers refuse to start audio otherwise. Safe to call more than once;
  // only does anything the first time.
  async ensureStarted(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.ctx = new AudioContextCtor();
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    // A shared limiter on the output — lets everything run louder without
    // the louder moments (a sunk-ship boom landing on top of the music
    // pulse) clipping or crackling.
    this.master = this.ctx.createDynamicsCompressor();
    this.master.threshold.value = -10;
    this.master.knee.value = 18;
    this.master.ratio.value = 5;
    this.master.attack.value = 0.003;
    this.master.release.value = 0.25;
    this.master.connect(this.ctx.destination);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = this.NORMAL_VOLUME;
    this.musicGain.connect(this.master);

    const loopBuffer = await this.renderMusicLoop(this.ctx);
    const source = this.ctx.createBufferSource();
    source.buffer = loopBuffer;
    source.loop = true;
    source.connect(this.musicGain);
    source.start();
    this.musicSource = source;
  }

  // Called when the puzzle screen loads — lower the music so it sits behind
  // gameplay instead of competing with it.
  duck(): void {
    if (!this.ctx || !this.musicGain) return;
    this.musicGain.gain.linearRampToValueAtTime(
      this.DUCKED_VOLUME,
      this.ctx.currentTime + 0.8
    );
  }

  // Called at GameOver — bring the music back up now that the round's done.
  restore(): void {
    if (!this.ctx || !this.musicGain) return;
    this.musicGain.gain.linearRampToValueAtTime(
      this.NORMAL_VOLUME,
      this.ctx.currentTime + 1.2
    );
  }

  // ---- One-shot SFX ----

  playMiss(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const master = this.master ?? ctx.destination;
    const t = ctx.currentTime;

    // Splash — filtered noise sweeping down in tone, like a bomb hitting
    // open water instead of a hull
    const noise = this.makeNoiseBurst(ctx, 0.22);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(1500, t);
    noiseFilter.frequency.exponentialRampToValueAtTime(450, t + 0.2);
    noiseFilter.Q.value = 1.1;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.45, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    noise.connect(noiseFilter).connect(noiseGain).connect(master);
    noise.start(t);

    // Low plunk underneath, for weight
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.18);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.32, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    osc.connect(oscGain).connect(master);
    osc.start(t);
    osc.stop(t + 0.22);
  }

  playHit(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const master = this.master ?? ctx.destination;
    const t = ctx.currentTime;

    // Punchy low thump
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.55, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(oscGain).connect(master);
    osc.start(t);
    osc.stop(t + 0.15);

    // Short noise crack on top, for impact
    const noise = this.makeNoiseBurst(ctx, 0.05);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'highpass';
    noiseFilter.frequency.value = 800;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.32;
    noise.connect(noiseFilter).connect(noiseGain).connect(master);
    noise.start(t);
  }

  playSunk(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const master = this.master ?? ctx.destination;
    const t = ctx.currentTime;

    // Deep descending boom
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(35, t + 0.55);
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 400;
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.7, t);
    oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.connect(lowpass).connect(oscGain).connect(master);
    osc.start(t);
    osc.stop(t + 0.65);

    // Explosion noise layer
    const noise = this.makeNoiseBurst(ctx, 0.4);
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'lowpass';
    noiseFilter.frequency.value = 1200;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.48, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    noise.connect(noiseFilter).connect(noiseGain).connect(master);
    noise.start(t);
  }

  playHint(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const master = this.master ?? ctx.destination;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.45, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + 0.5);
  }

  // ---- Internal helpers ----

  private makeNoiseBurst(
    ctx: AudioContext,
    duration: number
  ): AudioBufferSourceNode {
    const size = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, size, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < size; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / size);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    return source;
  }

  // Renders one loop of "aggravating battle" music into a buffer using an
  // OfflineAudioContext: a dissonant low sawtooth pulse (driving 8th-note
  // rhythm, alternating a minor-second-apart pair of low notes for tension),
  // metallic filtered-noise clangs on the off-beats, and a very low
  // continuous drone underneath for weight. Baked once, then looped forever
  // by the caller via AudioBufferSourceNode.loop = true.
  private async renderMusicLoop(liveCtx: AudioContext): Promise<AudioBuffer> {
    const duration = 3.2; // 8 steps at 0.4s = one loop cycle
    const sampleRate = liveCtx.sampleRate;
    const offline = new OfflineAudioContext(
      2,
      Math.ceil(duration * sampleRate),
      sampleRate
    );

    // Low drone underneath everything
    const drone = offline.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = 41;
    const droneGain = offline.createGain();
    droneGain.gain.value = 0.18;
    drone.connect(droneGain).connect(offline.destination);
    drone.start(0);
    drone.stop(duration);

    // Driving dissonant pulse — 8 steps, two low notes a minor second apart
    const stepDur = duration / 8;
    const pulseFreqs = [55, 55, 58.27, 55, 55, 55, 61.74, 58.27];
    for (let i = 0; i < 8; i++) {
      const t = i * stepDur;
      const osc = offline.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = pulseFreqs[i] ?? 55;
      const filter = offline.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 320;
      const gain = offline.createGain();
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.55, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 0.85);
      osc.connect(filter).connect(gain).connect(offline.destination);
      osc.start(t);
      osc.stop(t + stepDur);
    }

    // Metallic clang on the off-beats — filtered noise burst
    for (let i = 1; i < 8; i += 2) {
      const t = i * stepDur + stepDur * 0.5;
      const size = Math.floor(sampleRate * 0.08);
      const buffer = offline.createBuffer(1, size, sampleRate);
      const data = buffer.getChannelData(0);
      for (let j = 0; j < size; j++) {
        data[j] = (Math.random() * 2 - 1) * (1 - j / size);
      }
      const noise = offline.createBufferSource();
      noise.buffer = buffer;
      const bandpass = offline.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 3000;
      bandpass.Q.value = 8;
      const gain = offline.createGain();
      gain.gain.value = 0.32;
      noise.connect(bandpass).connect(gain).connect(offline.destination);
      noise.start(t);
    }

    return offline.startRendering();
  }
}

export const audioManager = new AudioManager();
