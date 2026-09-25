/**
 * Web Audio building blocks. Owner: Audio.
 *
 * Every sound in the game is built at play time from oscillators, noise and
 * filters — there are no audio files. A `Voice` is one sound: a handful of
 * enveloped sources summed into a gain, panned, and sent dry to a bus and wet to
 * the shared reverb. It tears its own nodes down when its last source ends, so
 * a recipe never has to think about cleanup.
 *
 * Times given to `tone`/`noise` are offsets from the voice's start, which is
 * what lets a recipe read as a score: thump at 0, ring at 0.01, debris at 0.12.
 */

/** A filter on one source, optionally swept across that source's envelope. */
export interface FilterOpts {
  type: BiquadFilterType;
  freq: number;
  /** Frequency the filter glides to, reached when the source falls silent. */
  to?: number;
  q?: number;
}

interface EnvelopeOpts {
  /** Peak gain. */
  gain: number;
  /** Rise to peak, seconds. Linear, so long swells do not snap in at the end. */
  attack?: number;
  /** Time held at peak before the decay starts. */
  hold?: number;
  /** Exponential fall to silence, seconds. */
  dur: number;
  /** Start offset from the voice's start, seconds. */
  at?: number;
  filter?: FilterOpts;
}

export interface ToneOpts extends EnvelopeOpts {
  type?: OscillatorType;
  freq: number;
  /** Pitch the tone glides to; an exponential glide, which the ear hears as even. */
  to?: number;
  /** Glide length. Defaults to the whole envelope. */
  glide?: number;
  /** Cents; for chorusing two copies of one tone. */
  detune?: number;
  /** Pitch wobble: `rate` in Hz, `depth` in cents. */
  vibrato?: { rate: number; depth: number };
}

export interface NoiseOpts extends EnvelopeOpts {
  /** Brown noise: most of its energy is low, which is what wind and rubble are. */
  brown?: boolean;
}

const DEFAULT_ATTACK = 0.004;
/** Silence floor for exponential ramps, which cannot reach zero. */
const FLOOR = 0.0001;

/**
 * Shared state every voice draws on: the context, the noise tables and the
 * live-voice count the mixer uses to refuse sounds when the scene is saturated.
 */
export class SynthEngine {
  readonly white: AudioBuffer;
  readonly brown: AudioBuffer;
  voices = 0;

  constructor(readonly ac: BaseAudioContext) {
    this.white = noiseBuffer(ac, 2, 'white');
    this.brown = noiseBuffer(ac, 4, 'brown');
  }
}

export class Voice {
  private readonly out: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly send: GainNode | null;
  private readonly t0: number;
  private pending = 0;
  private counted = false;

  constructor(
    private readonly engine: SynthEngine,
    dry: AudioNode,
    wet: AudioNode | null,
    gain: number,
    pan: number,
    wetAmount: number,
  ) {
    const ac = engine.ac;
    // A few milliseconds of lead so every scheduled ramp lands in the future;
    // a ramp that starts in the past is applied as a click.
    this.t0 = ac.currentTime + 0.006;
    this.out = ac.createGain();
    this.out.gain.value = gain;
    this.panner = ac.createStereoPanner();
    this.panner.pan.value = Math.max(-1, Math.min(1, pan));
    this.out.connect(this.panner);
    this.panner.connect(dry);
    if (wet && wetAmount > 0) {
      this.send = ac.createGain();
      this.send.gain.value = wetAmount;
      this.panner.connect(this.send);
      this.send.connect(wet);
    } else {
      this.send = null;
    }
  }

  tone(o: ToneOpts): this {
    const ac = this.engine.ac;
    const t = this.t0 + (o.at ?? 0);
    const attack = o.attack ?? DEFAULT_ATTACK;
    const end = t + attack + (o.hold ?? 0) + o.dur;

    const osc = ac.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.to !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t + (o.glide ?? end - t));
    }
    if (o.detune) osc.detune.value = o.detune;

    const nodes: AudioNode[] = [osc];
    if (o.vibrato) {
      const lfo = ac.createOscillator();
      lfo.frequency.value = o.vibrato.rate;
      const depth = ac.createGain();
      depth.gain.value = o.vibrato.depth;
      lfo.connect(depth);
      depth.connect(osc.detune);
      lfo.start(t);
      lfo.stop(end + 0.05);
      nodes.push(lfo, depth);
    }

    this.chain(osc, nodes, o, t, end);
    osc.start(t);
    osc.stop(end + 0.05);
    return this;
  }

  noise(o: NoiseOpts): this {
    const ac = this.engine.ac;
    const t = this.t0 + (o.at ?? 0);
    const end = t + (o.attack ?? DEFAULT_ATTACK) + (o.hold ?? 0) + o.dur;

    const src = ac.createBufferSource();
    const buffer = o.brown ? this.engine.brown : this.engine.white;
    src.buffer = buffer;
    src.loop = true;
    this.chain(src, [src], o, t, end);
    // A random read offset, so two bursts in a row do not share a waveform —
    // identical noise played twice is heard as a sample, not as a new event.
    src.start(t, Math.random() * buffer.duration);
    src.stop(end + 0.05);
    return this;
  }

  /** Filter (optional) → envelope → voice output, plus lifetime tracking. */
  private chain(
    src: AudioScheduledSourceNode,
    nodes: AudioNode[],
    o: EnvelopeOpts,
    t: number,
    end: number,
  ): void {
    const ac = this.engine.ac;
    let head: AudioNode = src;
    if (o.filter) {
      const f = ac.createBiquadFilter();
      f.type = o.filter.type;
      f.Q.value = o.filter.q ?? 0.7;
      f.frequency.setValueAtTime(o.filter.freq, t);
      if (o.filter.to !== undefined) {
        f.frequency.exponentialRampToValueAtTime(Math.max(10, o.filter.to), end);
      }
      head.connect(f);
      head = f;
      nodes.push(f);
    }

    const amp = ac.createGain();
    const attack = o.attack ?? DEFAULT_ATTACK;
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(o.gain, t + attack);
    if (o.hold) amp.gain.setValueAtTime(o.gain, t + attack + o.hold);
    amp.gain.exponentialRampToValueAtTime(FLOOR, end);
    head.connect(amp);
    amp.connect(this.out);
    nodes.push(amp);

    if (!this.counted) {
      this.counted = true;
      this.engine.voices++;
    }
    this.pending++;
    src.onended = () => {
      for (const n of nodes) n.disconnect();
      if (--this.pending === 0) this.release();
    };
  }

  private release(): void {
    this.out.disconnect();
    this.panner.disconnect();
    this.send?.disconnect();
    this.engine.voices--;
  }
}

/**
 * A struck bell: inharmonic partials, each decaying at its own rate. The ratios
 * are the classic church-bell set (hum, prime, tierce, quint, nominal) — the
 * minor third among them is what makes a bell sound like a bell and not a
 * chime.
 */
export function bell(v: Voice, freq: number, at: number, gain: number, decay: number): void {
  const partials: [ratio: number, amp: number, life: number][] = [
    [0.5, 0.35, 1.0],
    [1.0, 0.8, 0.8],
    [1.19, 0.45, 0.55],
    [1.5, 0.3, 0.45],
    [2.0, 0.5, 0.35],
    [2.51, 0.18, 0.25],
    [3.0, 0.12, 0.18],
  ];
  for (const [ratio, amp, life] of partials) {
    v.tone({ freq: freq * ratio, gain: gain * amp, attack: 0.002, dur: decay * life, at });
  }
}

/** Random value in [min, max). Presentation only — never used by the simulation. */
export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** A frequency jittered by ±`cents`, so repeated sounds are never identical. */
export function vary(freq: number, cents = 60): number {
  return freq * Math.pow(2, rand(-cents, cents) / 1200);
}

function noiseBuffer(ac: BaseAudioContext, seconds: number, colour: 'white' | 'brown'): AudioBuffer {
  const length = Math.floor(ac.sampleRate * seconds);
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    if (colour === 'white') {
      data[i] = white;
    } else {
      // Leaky integrator: integrated white noise, pulled back towards zero so
      // it cannot drift into DC. The gain restores roughly unit loudness.
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  }
  return buffer;
}

/**
 * A synthetic room: decaying stereo noise that darkens as it fades, the way
 * real reverb loses its highs to air and walls. Independent noise per channel
 * is what makes it wide.
 */
export function impulseResponse(ac: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const length = Math.floor(ac.sampleRate * seconds);
  const buffer = ac.createBuffer(2, length, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const white = Math.random() * 2 - 1;
      lp += (white - lp) * (0.65 - 0.5 * t);
      data[i] = lp * Math.pow(1 - t, decay);
    }
  }
  return buffer;
}
