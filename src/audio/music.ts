/**
 * Music player and instruments. Owner: Audio.
 *
 * Plays the pieces in `score.ts` with synthesised period instruments:
 *
 * - **Lute** — Karplus-Strong plucked string: a burst of noise circulating in a
 *   delay line one period long, averaged on each pass so the highs die first,
 *   exactly as a real string loses them. Pre-rendered once per pitch.
 * - **Recorder** — near-sine tone with a breathy noise band, a "chiff" on the
 *   attack, and vibrato that only arrives after the note has settled.
 * - **Fiddle** (vielle) — two slightly detuned saws through body resonances.
 * - **Drone** — hurdy-gurdy: root and fifth, dark and steady.
 * - **Tabor, war drum, tambourine** — the percussion of a medieval dance band.
 *
 * Scheduling uses the usual Web Audio lookahead: a timer wakes every 50 ms and
 * books every note that starts before `now + horizon` at an exact audio-clock
 * time. The timer's jitter never reaches the rhythm; only the booking is late.
 *
 * Changing mood never cuts: the same piece shifts intensity by fading its
 * `battle` layer at the next bar line, and a different piece crossfades.
 */

import { compileLoop, frequencyOf, PIECES, type InstrumentId, type Layer, type NoteEvent, type PieceDef } from './score';
import type { SynthEngine } from './synth';

export type Mood = 'silent' | 'menu' | 'calm' | 'battle' | 'boss' | 'lament';

const MOODS: Record<Exclude<Mood, 'silent'>, { piece: string; battle: number; gain: number }> = {
  menu: { piece: 'vigil', battle: 0, gain: 0.67 },
  calm: { piece: 'estampie', battle: 0, gain: 0.49 },
  battle: { piece: 'estampie', battle: 1, gain: 0.46 },
  boss: { piece: 'marrow', battle: 1, gain: 0.41 },
  lament: { piece: 'vigil', battle: 0, gain: 0.4 },
};

/** Per-instrument output trims, set by measurement (see `sounds.ts` header). */
const INSTRUMENT_GAIN: Record<InstrumentId, number> = {
  lute: 0.55,
  recorder: 0.11,
  fiddle: 0.085,
  drone: 0.05,
  tabor: 0.6,
  bigDrum: 0.5,
  tambourine: 0.5,
};

const REVERB_SEND = 0.45;

interface Run {
  piece: PieceDef;
  out: GainNode;
  send: GainNode;
  layers: Record<Layer, GainNode>;
  /** Audio-clock time of beat 0 of loop 0. */
  start: number;
  beatSeconds: number;
  loop: number;
  loopStart: number;
  events: NoteEvent[];
  loopBeats: number;
  cursor: number;
  /** When set, no note starting after this time is booked. */
  endAt: number | null;
}

export class MusicPlayer {
  private readonly runs: Run[] = [];
  private mood: Mood = 'silent';
  private readonly plucks = new Map<number, { buffer: AudioBuffer; rate: number }>();

  constructor(
    private readonly engine: SynthEngine,
    private readonly dest: AudioNode,
    private readonly reverb: AudioNode,
  ) {}

  get current(): Mood {
    return this.mood;
  }

  setMood(mood: Mood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    const ac = this.engine.ac;
    const now = ac.currentTime;
    const active = this.runs.find((r) => r.endAt === null) ?? null;

    if (mood === 'silent') {
      if (active) this.fadeOut(active, now);
      return;
    }

    const spec = MOODS[mood];
    if (active && active.piece.id === spec.piece) {
      // Same piece: change intensity on the next bar line, so the drums come in
      // on a downbeat instead of mid-phrase.
      const bar = active.beatSeconds * active.piece.meter;
      const at = active.start + Math.ceil((now + 0.05 - active.start) / bar) * bar;
      active.layers.battle.gain.setTargetAtTime(spec.battle, at, 0.25);
      active.out.gain.setTargetAtTime(spec.gain, at, 0.6);
      return;
    }

    if (active) this.fadeOut(active, now);
    this.runs.push(this.createRun(PIECES[spec.piece]!, now + (active ? 1.2 : 0.3), spec));
  }

  /** Books every note that starts before `until`. Called by the owner's timer. */
  schedule(until: number): void {
    const now = this.engine.ac.currentTime;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const run = this.runs[i]!;
      if (run.endAt !== null && now > run.endAt + 4) {
        run.out.disconnect();
        run.send.disconnect();
        this.runs.splice(i, 1);
        continue;
      }
      this.book(run, until);
    }
  }

  private fadeOut(run: Run, now: number): void {
    run.out.gain.cancelScheduledValues(now);
    run.out.gain.setValueAtTime(run.out.gain.value, now);
    run.out.gain.setTargetAtTime(0, now, 0.7);
    run.endAt = now + 2.5;
  }

  private createRun(piece: PieceDef, start: number, spec: { battle: number; gain: number }): Run {
    const ac = this.engine.ac;
    const out = ac.createGain();
    out.gain.setValueAtTime(0, ac.currentTime);
    out.gain.setTargetAtTime(spec.gain, start, 0.8);
    out.connect(this.dest);
    const send = ac.createGain();
    send.gain.value = REVERB_SEND;
    out.connect(send);
    send.connect(this.reverb);

    const base = ac.createGain();
    base.connect(out);
    const battle = ac.createGain();
    battle.gain.value = spec.battle;
    battle.connect(out);

    const first = compileLoop(piece, 0);
    return {
      piece,
      out,
      send,
      layers: { base, battle },
      start,
      beatSeconds: 60 / piece.bpm,
      loop: 0,
      loopStart: start,
      events: first.events,
      loopBeats: first.beats,
      cursor: 0,
      endAt: null,
    };
  }

  private book(run: Run, until: number): void {
    for (;;) {
      if (run.cursor >= run.events.length) {
        run.loop++;
        run.loopStart += run.loopBeats * run.beatSeconds;
        const next = compileLoop(run.piece, run.loop);
        run.events = next.events;
        run.loopBeats = next.beats;
        run.cursor = 0;
      }
      const e = run.events[run.cursor]!;
      const t = run.loopStart + e.beat * run.beatSeconds;
      if (t >= until) return;
      if (run.endAt !== null && t > run.endAt) return;
      run.cursor++;
      // A note already in the past (tab was asleep) is skipped rather than
      // played late: a late note is heard as a stumble, a missing one is not.
      if (t < this.engine.ac.currentTime - 0.02) continue;
      this.play(e, t, e.dur * run.beatSeconds, run.layers[e.layer]);
    }
  }

  // ── Instruments ────────────────────────────────────────────────────────────

  private play(e: NoteEvent, t: number, seconds: number, dest: AudioNode): void {
    const gain = e.vel * INSTRUMENT_GAIN[e.inst];
    switch (e.inst) {
      case 'lute':
        return this.lute(e.midi, t, gain, dest);
      case 'recorder':
        return this.recorder(frequencyOf(e.midi), t, seconds, gain, dest);
      case 'fiddle':
        return this.fiddle(frequencyOf(e.midi), t, seconds, gain, dest);
      case 'drone':
        return this.drone(frequencyOf(e.midi), t, seconds, gain, dest);
      case 'tabor':
        return this.tabor(t, gain, dest);
      case 'bigDrum':
        return this.bigDrum(t, gain, dest);
      case 'tambourine':
        return this.tambourine(t, gain, dest);
    }
  }

  private lute(midi: number, t: number, gain: number, dest: AudioNode): void {
    const ac = this.engine.ac;
    const pluck = this.pluck(midi);
    const src = ac.createBufferSource();
    src.buffer = pluck.buffer;
    src.playbackRate.value = pluck.rate;
    // The body: a hollow wooden box that booms low and sings around 2.5 kHz.
    const body = ac.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 210;
    body.Q.value = 1.1;
    body.gain.value = 5;
    const amp = ac.createGain();
    amp.gain.value = gain;
    src.connect(body).connect(amp).connect(dest);
    src.start(t);
    src.onended = () => {
      src.disconnect();
      body.disconnect();
      amp.disconnect();
    };
  }

  private recorder(freq: number, t: number, seconds: number, gain: number, dest: AudioNode): void {
    const ac = this.engine.ac;
    const end = t + Math.max(0.08, seconds - 0.02);
    const amp = ac.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(gain, t + 0.04);
    amp.gain.setValueAtTime(gain * 0.92, end);
    amp.gain.exponentialRampToValueAtTime(0.0001, end + 0.1);
    amp.connect(dest);

    const vib = ac.createOscillator();
    vib.frequency.value = 5.2;
    const vibDepth = ac.createGain();
    // Vibrato grows in once the note has settled; on short notes it never does.
    vibDepth.gain.setValueAtTime(0, t);
    vibDepth.gain.linearRampToValueAtTime(seconds > 0.4 ? 14 : 0, t + Math.min(0.4, seconds));
    vib.connect(vibDepth);

    const nodes: AudioNode[] = [amp, vib, vibDepth];
    const partial = (type: OscillatorType, mult: number, level: number): OscillatorNode => {
      const osc = ac.createOscillator();
      osc.type = type;
      osc.frequency.value = freq * mult;
      vibDepth.connect(osc.detune);
      const g = ac.createGain();
      g.gain.value = level;
      osc.connect(g).connect(amp);
      osc.start(t);
      osc.stop(end + 0.15);
      nodes.push(osc, g);
      return osc;
    };
    const main = partial('sine', 1, 1);
    partial('triangle', 1, 0.16);
    partial('sine', 2, 0.05);
    partial('sine', 3, 0.035);

    // Breath riding on the tone, and the chiff of air hitting the labium.
    const breath = this.noiseSource(t, end + 0.15);
    const band = ac.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq * 2;
    band.Q.value = 1.4;
    const breathGain = ac.createGain();
    breathGain.gain.value = 0.06;
    breath.connect(band).connect(breathGain).connect(amp);
    const chiff = ac.createGain();
    chiff.gain.setValueAtTime(0.5, t);
    chiff.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    const chiffHp = ac.createBiquadFilter();
    chiffHp.type = 'highpass';
    chiffHp.frequency.value = 2500;
    breath.connect(chiffHp).connect(chiff).connect(amp);
    nodes.push(breath, band, breathGain, chiff, chiffHp);

    vib.start(t);
    vib.stop(end + 0.15);
    main.onended = () => {
      for (const n of nodes) n.disconnect();
    };
  }

  private fiddle(freq: number, t: number, seconds: number, gain: number, dest: AudioNode): void {
    const ac = this.engine.ac;
    const end = t + Math.max(0.1, seconds - 0.03);
    const amp = ac.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(gain, t + 0.07);
    amp.gain.setValueAtTime(gain, end);
    amp.gain.exponentialRampToValueAtTime(0.0001, end + 0.14);

    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2800;
    const wood = ac.createBiquadFilter();
    wood.type = 'peaking';
    wood.frequency.value = 480;
    wood.Q.value = 1.3;
    wood.gain.value = 6;
    const nasal = ac.createBiquadFilter();
    nasal.type = 'peaking';
    nasal.frequency.value = 1500;
    nasal.Q.value = 1.8;
    nasal.gain.value = 4;
    lp.connect(wood).connect(nasal).connect(amp).connect(dest);

    const vib = ac.createOscillator();
    vib.frequency.value = 5.6;
    const vibDepth = ac.createGain();
    vibDepth.gain.setValueAtTime(0, t);
    vibDepth.gain.linearRampToValueAtTime(seconds > 0.35 ? 16 : 3, t + Math.min(0.35, seconds));
    vib.connect(vibDepth);

    const nodes: AudioNode[] = [amp, lp, wood, nasal, vib, vibDepth];
    let first: OscillatorNode | null = null;
    for (const detune of [-5, 6]) {
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      vibDepth.connect(osc.detune);
      osc.connect(lp);
      osc.start(t);
      osc.stop(end + 0.2);
      nodes.push(osc);
      first ??= osc;
    }
    // Rosin: a thin scrape of noise under the bow.
    const bow = this.noiseSource(t, end + 0.2);
    const bowBand = ac.createBiquadFilter();
    bowBand.type = 'bandpass';
    bowBand.frequency.value = 3200;
    bowBand.Q.value = 0.9;
    const bowGain = ac.createGain();
    bowGain.gain.value = 0.02;
    bow.connect(bowBand).connect(bowGain).connect(amp);
    nodes.push(bow, bowBand, bowGain);

    vib.start(t);
    vib.stop(end + 0.2);
    first!.onended = () => {
      for (const n of nodes) n.disconnect();
    };
  }

  private drone(freq: number, t: number, seconds: number, gain: number, dest: AudioNode): void {
    const ac = this.engine.ac;
    // Overlaps the next section's drone by a little, so the seam is not heard.
    const end = t + seconds + 0.4;
    const amp = ac.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(gain, t + 0.6);
    amp.gain.setValueAtTime(gain, end - 0.6);
    amp.gain.linearRampToValueAtTime(0, end);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    lp.Q.value = 0.8;
    lp.connect(amp).connect(dest);

    const nodes: AudioNode[] = [amp, lp];
    let first: OscillatorNode | null = null;
    for (const [mult, level, detune] of [
      [1, 1, 0],
      [1, 0.8, 7],
      [1.5, 0.6, -4],
      [0.5, 0.7, 0],
    ] as const) {
      const osc = ac.createOscillator();
      osc.type = mult === 0.5 ? 'triangle' : 'sawtooth';
      osc.frequency.value = freq * mult;
      osc.detune.value = detune;
      const g = ac.createGain();
      g.gain.value = level;
      osc.connect(g).connect(lp);
      osc.start(t);
      osc.stop(end + 0.05);
      nodes.push(osc, g);
      first ??= osc;
    }
    first!.onended = () => {
      for (const n of nodes) n.disconnect();
    };
  }

  private tabor(t: number, gain: number, dest: AudioNode): void {
    const ac = this.engine.ac;
    const amp = ac.createGain();
    amp.gain.value = gain;
    amp.connect(dest);
    const osc = ac.createOscillator();
    osc.frequency.setValueAtTime(190, t);
    osc.frequency.exponentialRampToValueAtTime(75, t + 0.09);
    const body = ac.createGain();
    body.gain.setValueAtTime(0.9, t);
    body.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(body).connect(amp);
    // The snare gut stretched across a tabor's head: a short rattle.
    const snare = this.noiseSource(t, t + 0.15);
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    const skin = ac.createGain();
    skin.gain.setValueAtTime(0.35, t);
    skin.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    snare.connect(bp).connect(skin).connect(amp);
    osc.start(t);
    osc.stop(t + 0.25);
    osc.onended = () => {
      for (const n of [osc, body, snare, bp, skin, amp]) n.disconnect();
    };
  }

  private bigDrum(t: number, gain: number, dest: AudioNode): void {
    const ac = this.engine.ac;
    const amp = ac.createGain();
    amp.gain.value = gain;
    amp.connect(dest);
    const osc = ac.createOscillator();
    osc.frequency.setValueAtTime(95, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.25);
    const body = ac.createGain();
    body.gain.setValueAtTime(1, t);
    body.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    osc.connect(body).connect(amp);
    const thud = this.noiseSource(t, t + 0.3, true);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    const skin = ac.createGain();
    skin.gain.setValueAtTime(0.6, t);
    skin.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    thud.connect(lp).connect(skin).connect(amp);
    osc.start(t);
    osc.stop(t + 0.75);
    osc.onended = () => {
      for (const n of [osc, body, thud, lp, skin, amp]) n.disconnect();
    };
  }

  private tambourine(t: number, gain: number, dest: AudioNode): void {
    const ac = this.engine.ac;
    const src = this.noiseSource(t, t + 0.2);
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    const ring = ac.createBiquadFilter();
    ring.type = 'peaking';
    ring.frequency.value = 8200;
    ring.Q.value = 4;
    ring.gain.value = 9;
    const amp = ac.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(gain, t + 0.005);
    amp.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(hp).connect(ring).connect(amp).connect(dest);
    src.onended = () => {
      for (const n of [src, hp, ring, amp]) n.disconnect();
    };
  }

  private noiseSource(t: number, end: number, brown = false): AudioBufferSourceNode {
    const ac = this.engine.ac;
    const src = ac.createBufferSource();
    const buffer = brown ? this.engine.brown : this.engine.white;
    src.buffer = buffer;
    src.loop = true;
    src.start(t, Math.random() * buffer.duration);
    src.stop(end);
    return src;
  }

  /** Karplus-Strong string for one MIDI pitch, rendered on first use. */
  private pluck(midi: number): { buffer: AudioBuffer; rate: number } {
    const cached = this.plucks.get(midi);
    if (cached) return cached;

    const ac = this.engine.ac;
    const sr = ac.sampleRate;
    const freq = frequencyOf(midi);
    // Low strings ring for seconds, high ones are gone in about one.
    const seconds = Math.max(1.1, Math.min(3, 3.4 - freq / 250));
    const length = Math.floor(sr * seconds);
    // The two-tap average adds half a sample of delay, so the loop is tuned to
    // p − 0.5 samples and the leftover error is corrected with playback rate.
    const period = Math.max(2, Math.round(sr / freq + 0.5));
    const actual = sr / (period - 0.5);

    const line = new Float32Array(period);
    // Excitation: noise softened by a one-pole lowpass (a thumb, not a pick),
    // then combed at 1/6 of the string, which is where a lute is plucked.
    let lp = 0;
    const excite = new Float32Array(period);
    for (let i = 0; i < period; i++) {
      lp += (Math.random() * 2 - 1 - lp) * 0.5;
      excite[i] = lp;
    }
    const pluckAt = Math.max(1, Math.round(period / 6));
    let mean = 0;
    for (let i = 0; i < period; i++) {
      line[i] = excite[i]! - 0.85 * excite[(i + pluckAt) % period]!;
      mean += line[i]!;
    }
    mean /= period;
    for (let i = 0; i < period; i++) line[i]! -= mean;

    const t60 = seconds * 0.75;
    const loss = Math.pow(10, -3 / (t60 * actual));
    const buffer = ac.createBuffer(1, length, sr);
    const out = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0, idx = 0; i < length; i++) {
      const next = (idx + 1) % period;
      const y = line[idx]!;
      out[i] = y;
      if (Math.abs(y) > peak) peak = Math.abs(y);
      line[idx] = loss * 0.5 * (y + line[next]!);
      idx = next;
    }
    const norm = peak > 0 ? 0.9 / peak : 1;
    const fade = Math.floor(sr * 0.05);
    for (let i = 0; i < length; i++) {
      const tail = length - i < fade ? (length - i) / fade : 1;
      out[i]! *= norm * tail;
    }

    const result = { buffer, rate: freq / actual };
    this.plucks.set(midi, result);
    return result;
  }
}
