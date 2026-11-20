const Audio = globalThis.AudioContext ?? globalThis.webkitAudioContext;
const bass = [55, 55, 65.41, 55, 82.41, 73.42, 65.41, 49];

export class PursuitAudio {
  constructor() {
    this.muted = false;
    this.cues = { beat: 0, pickup: 0, crash: 0, use: 0 };
    this.error = Audio ? "" : "Audio unavailable in this browser.";
  }

  async unlock() {
    if (!Audio || this.muted) return;
    try {
      if (!this.context) this.build();
      await this.context.resume();
      this.error = "";
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      this.error = `Audio unavailable: ${error.message}`;
    }
  }

  build() {
    const ctx = this.context = new Audio();
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const limit = ctx.createDynamicsCompressor();
    this.master.connect(limit).connect(ctx.destination);
    this.voices = [this.loop("triangle", 72), this.loop("sine", 490)];
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noise.getChannelData(0);
    let word = 54981;
    for (let i = 0; i < data.length; i++) {
      word = (Math.imul(word, 1664525) + 1013904223) >>> 0;
      data[i] = word / 2147483648 - 1;
    }
    this.noise = noise;
    const tire = ctx.createBufferSource();
    tire.buffer = noise;
    tire.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1220;
    band.Q.value = 3.2;
    this.tire = ctx.createGain();
    this.tire.gain.value = 0;
    tire.connect(band).connect(this.tire).connect(this.master);
    tire.start();
  }

  loop(type, hz) {
    const ctx = this.context;
    const voice = ctx.createOscillator(), gain = ctx.createGain();
    voice.type = type;
    voice.frequency.value = hz;
    gain.gain.value = 0;
    voice.connect(gain).connect(this.master);
    voice.start();
    return { voice, gain };
  }

  tone(type, time, hz, endHz, span, volume) {
    const ctx = this.context;
    const osc = ctx.createOscillator(), envelope = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, time);
    osc.frequency.exponentialRampToValueAtTime(endHz, time + span);
    envelope.gain.setValueAtTime(.0001, time);
    envelope.gain.exponentialRampToValueAtTime(volume, time + .009);
    envelope.gain.exponentialRampToValueAtTime(.0001, time + span);
    osc.connect(envelope).connect(this.master);
    osc.start(time);
    osc.stop(time + span + .02);
  }

  noiseHit(time, hz, span, volume) {
    const ctx = this.context;
    const hit = ctx.createBufferSource(), tone = ctx.createBiquadFilter(), envelope = ctx.createGain();
    hit.buffer = this.noise;
    tone.type = "lowpass";
    tone.frequency.value = hz;
    envelope.gain.setValueAtTime(volume, time);
    envelope.gain.exponentialRampToValueAtTime(.0001, time + span);
    hit.connect(tone).connect(envelope).connect(this.master);
    hit.start(time);
    hit.stop(time + span);
  }

  get audible() { return this.context?.state === "running" && !this.muted; }

  update(world, rolling) {
    if (!this.context) return;
    const t = this.context.currentTime;
    const active = this.audible && rolling;
    this.master.gain.setTargetAtTime(active ? .43 : 0, t, .025);
    if (!active) {
      if (this.next !== null) {
        this.next = null;
        this.beat = 0;
      }
      return;
    }
    const { pursuit: run, player: p, tick } = world;
    const normal = run.phase === "running";
    let nearest = 45;
    for (const unit of run.patrols) nearest = Math.min(nearest, Math.hypot(unit.x - p.x, unit.z - p.z));
    const [motor, siren] = this.voices;
    motor.voice.frequency.setTargetAtTime(56 + p.speed * 3.7, t, .09);
    motor.gain.gain.setTargetAtTime(normal ? .066 : 0, t, .085);
    siren.voice.frequency.setTargetAtTime(510 + 197 * Math.sin(tick * .049), t, .06);
    siren.gain.gain.setTargetAtTime(normal ? (1 - nearest / 45) * .028 : 0, t, .09);
    this.tire.gain.setTargetAtTime(normal ? Math.min(.09, Math.abs(p.arcadeSlip ?? 0) * .38) : 0, t, .05);
    if (!normal) return;
    this.next = Math.max(this.next ?? t, t);
    while (this.next < t + .09) {
      const step = (this.beat ?? 0) % 16;
      this.beat = step + 1;
      this.cues.beat++;
      const n = bass[step % bass.length];
      this.tone("triangle", this.next, n, n * .99, .117, step % 4 === 0 ? .19 : .082);
      if (step % 4 === 0) this.tone("sine", this.next, 102, 43, .18, .37);
      if (step % 4 === 2) this.noiseHit(this.next, 3900, .065, .088);
      this.next += 15 / (125 + run.wantedLevel * 6);
    }
  }

  play(event) {
    if (!this.audible) return;
    const t = this.context.currentTime + .005;
    if (event.type === "pickup") {
      this.cues.pickup++;
      for (let i = 0; i < 3; i++)
        this.tone("sine", t + i * .058, [391.99, 523.25, 783.99][i], [397, 529, 792][i], .19, .23);
    } else if (event.type === "impact" || event.type === "wreck") {
      if (event.type === "wreck" && this.lastCrash !== undefined && t - this.lastCrash < .11) return;
      this.lastCrash = t;
      this.cues.crash++;
      this.noiseHit(t, 900, event.type === "impact" ? .51 : .28, event.type === "impact" ? .62 : .28);
      this.tone("triangle", t, 125, 35, .29, .28);
    } else if (event.type === "use" || event.type === "burst") {
      this.cues.use++;
      this.tone("triangle", t, 320, 110, .17, .18);
    }
  }

  quiet() {
    if (this.context) this.master.gain.setTargetAtTime(0, this.context.currentTime, .02);
    this.next = null;
    this.beat = 0;
  }
}
