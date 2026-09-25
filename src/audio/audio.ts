/**
 * Audio module. Owner: Audio.
 *
 * Listens to the event bus and turns what happened into sound. It never reads
 * input and never touches simulation state — like every presentation module it
 * only reacts.
 *
 * Signal flow:
 *
 *   voices ─┬─ sfx bus ─────┐
 *           ├─ ui bus ──────┤
 *           └─ reverb send ─┼─ master ─ compressor ─ speakers
 *   ambient ── ambient bus ─┘
 *
 * The compressor is not decoration: a wave dying at once is thirty voices in
 * the same 100 ms, and without it they sum past full scale and crackle.
 *
 * Browsers refuse to start audio before a user gesture, so the graph is built
 * on the first pointer or key press. Until then every play request is a no-op —
 * sounds are feedback for what is happening now, so there is nothing to queue.
 */

import type { EntityId, GameContext, GameModule, TeamId, Vec2 } from '@/core/contracts';
import { UnitKind } from '@/core/contracts';
import type { GameEvents } from '@/core/events';
import { RenderKey } from '@/core/services';
import { playback } from '@/core/playback';
import { SOUNDS, type SoundDef, type SoundId } from './sounds';
import { impulseResponse, rand, SynthEngine, Voice } from './synth';
import { MusicPlayer, type Mood } from './music';

/** Above this many live voices, non-priority sounds are dropped. */
const MAX_VOICES = 42;

/** Which death each creature makes. Anything unlisted uses `death.small`. */
const DEATH_BY_DEF: Record<string, SoundId> = {
  duskrunner: 'death.light',
  prowler: 'death.light',
  spinebolt: 'death.small',
  hexwright: 'death.small',
  necromancer: 'death.small',
  cleaver: 'death.small',
  bastion: 'death.heavy',
  breaker: 'death.heavy',
  skeleton: 'death.bones',
  wraith: 'death.wraith',
  marrowTitan: 'death.titan',
};

/** Heroes whose auto-attack is a spell rather than a weapon. */
const ARCANE_ATTACKERS = new Set(['oracle']);
/** Heroes whose basic attack is a bow: string and shaft, never steel. */
const BOW_ATTACKERS = new Set(['talon']);

export interface AudioLevels {
  master: number;
  sfx: number;
  ambient: number;
  music: number;
}

export interface AudioOptions {
  /** The local player's hero; its attacks and hurts are the ones voiced. */
  playerHeroId: () => EntityId | null;
  /** False on the title and hero-select screens, where the menu theme plays. */
  inMatch: () => boolean;
  /** The local player's team: only its own Core's alarms and fall are voiced. */
  localTeam: () => TeamId;
}

interface Graph {
  ac: AudioContext;
  engine: SynthEngine;
  master: GainNode;
  sfx: GainNode;
  ui: GainNode;
  ambient: GainNode;
  /** Separate from `ambient` so pause ducking and the volume slider do not fight. */
  ambientDuck: GainNode;
  reverb: ConvolverNode;
  /** Lowpass on the music, closed while paused so it plays as if from another room. */
  musicMuffle: BiquadFilterNode;
  music: GainNode;
  player: MusicPlayer;
}

export class AudioModule implements GameModule {
  readonly id = 'audio';
  readonly order = 870;

  private ctx!: GameContext;
  private graph: Graph | null = null;
  private levels: AudioLevels = { master: 0.8, sfx: 1, ambient: 0.6, music: 0.5 };
  private musicTimer = 0;
  /** Audio-clock time the defeat lament may begin, once the explosion has rung out. */
  private lamentAt: number | null = null;
  private paused = false;
  /** Set when the Core falls: the birds stop, the wind drops. */
  private silenced = false;
  private nextBirdAt = 0;
  private readonly lastPlayed = new Map<SoundId, number>();
  private readonly offs: (() => void)[] = [];
  private readonly screen = { x: 0, y: 0 };

  /** QA counters; read through `window.__GAME__.audio.stats`. */
  readonly stats = { played: 0, dropped: 0, last: '' as string };

  constructor(private readonly opts: AudioOptions) {}

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // Capture phase, so a handler that stops propagation cannot keep the
    // context locked. Left installed: a browser may suspend the context again
    // (tab switch, device change) and the next gesture should bring it back.
    window.addEventListener('pointerdown', this.unlock, true);
    window.addEventListener('keydown', this.unlock, true);
    this.listen();
  }

  update(): void {
    const g = this.graph;
    if (!g || g.ac.state !== 'running') return;
    const now = g.ac.currentTime;
    g.player.setMood(this.moodNow(now));

    if (this.paused || this.silenced) return;
    if (now >= this.nextBirdAt) {
      // Scheduled before playing, so a refused play does not retry every frame.
      this.nextBirdAt = now + rand(7, 19);
      this.play('ambient.bird', undefined, rand(0.5, 1), rand(-0.8, 0.8));
    }
  }

  /** Which music fits what is on screen right now. */
  private moodNow(now: number): Mood {
    if (!this.opts.inMatch()) return 'menu';
    switch (this.ctx.match.phase) {
      case 'wave':
        return 'battle';
      case 'boss':
        return 'boss';
      case 'defeat':
        // Silence first, so the explosion is heard alone; then the lament.
        return this.lamentAt !== null && now >= this.lamentAt ? 'lament' : 'silent';
      case 'victory':
        // A team won. For the winners that is the menu theme; for the losers
        // it is the same silence-then-lament as a solo defeat.
        if (this.ctx.match.winner === this.opts.localTeam()) return 'menu';
        return this.lamentAt !== null && now >= this.lamentAt ? 'lament' : 'silent';
      default:
        return 'calm';
    }
  }

  dispose(): void {
    window.clearInterval(this.musicTimer);
    window.removeEventListener('pointerdown', this.unlock, true);
    window.removeEventListener('keydown', this.unlock, true);
    for (const off of this.offs) off();
    void this.graph?.ac.close();
    this.graph = null;
  }

  /** Slider values 0..1, squared so the slider's midpoint sounds like half. */
  setLevels(levels: AudioLevels): void {
    this.levels = { ...levels };
    const g = this.graph;
    if (!g) return;
    const now = g.ac.currentTime;
    g.master.gain.setTargetAtTime(levels.master * levels.master, now, 0.04);
    g.sfx.gain.setTargetAtTime(levels.sfx * levels.sfx, now, 0.04);
    g.ui.gain.setTargetAtTime(levels.sfx * levels.sfx, now, 0.04);
    g.ambient.gain.setTargetAtTime(levels.ambient * levels.ambient, now, 0.04);
    g.music.gain.setTargetAtTime(levels.music * levels.music, now, 0.04);
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.play(paused ? 'ui.pause' : 'ui.resume');
    const g = this.graph;
    // The world keeps breathing under the pause plate, just further away.
    if (g && !this.silenced) g.ambientDuck.gain.setTargetAtTime(paused ? 0.4 : 1, g.ac.currentTime, 0.15);
    // The music plays on through a pause, muffled, as if the band were in the
    // next room — silence would make the pause feel like a crash.
    if (g) g.musicMuffle.frequency.setTargetAtTime(paused ? 650 : 20000, g.ac.currentTime, 0.2);
  }

  /** Current music mood. For QA. */
  get mood(): Mood {
    return this.graph?.player.current ?? 'silent';
  }

  /** Whether the context exists and is running. For QA. */
  get state(): string {
    return this.graph?.ac.state ?? 'locked';
  }

  get voices(): number {
    return this.graph?.engine.voices ?? 0;
  }

  /**
   * Plays a sound. `pos` places it in the world (panned, and quieter the
   * further it is from what the camera sees); omit it for interface sounds.
   */
  play(id: SoundId, pos?: Vec2, volume = 1, panOverride?: number): boolean {
    const g = this.graph;
    // Replaying missed turns: those sounds belong to minutes ago.
    if (!g || g.ac.state !== 'running' || playback.fastForward) return false;
    const def: SoundDef = SOUNDS[id];
    const now = g.ac.currentTime;

    const last = this.lastPlayed.get(id);
    if (last !== undefined && now - last < def.gap) return false;
    if (!def.priority && g.engine.voices >= MAX_VOICES) {
      this.stats.dropped++;
      return false;
    }

    let gain = def.gain * volume;
    let pan = panOverride ?? 0;
    if (pos && def.bus === 'sfx') {
      const s = this.spatial(pos);
      const heard = Math.max(s.gain, def.floor ?? 0);
      if (heard < 0.03) return false;
      gain *= heard;
      pan = s.pan;
    }

    this.lastPlayed.set(id, now);
    this.stats.played++;
    this.stats.last = id;
    const bus = def.bus === 'ui' ? g.ui : def.bus === 'ambient' ? g.ambient : g.sfx;
    def.play(new Voice(g.engine, bus, g.reverb, gain, pan, def.wet));
    return true;
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  private readonly unlock = (): void => {
    if (!this.graph) this.build();
    const g = this.graph;
    if (g && g.ac.state === 'suspended') void g.ac.resume();
  };

  private build(): void {
    let ac: AudioContext;
    try {
      ac = new AudioContext({ latencyHint: 'interactive' });
    } catch {
      // No audio device, or audio disabled by policy: the game runs silent.
      return;
    }

    const compressor = ac.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 8;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    compressor.connect(ac.destination);

    const master = ac.createGain();
    master.connect(compressor);

    const sfx = ac.createGain();
    sfx.connect(master);
    const ui = ac.createGain();
    ui.connect(master);

    const ambientDuck = ac.createGain();
    // Fades in rather than starting at full: a wall of wind on the first click
    // reads as a glitch.
    ambientDuck.gain.setValueAtTime(0, ac.currentTime);
    ambientDuck.gain.linearRampToValueAtTime(1, ac.currentTime + 3);
    ambientDuck.connect(master);
    const ambient = ac.createGain();
    ambient.connect(ambientDuck);

    const reverb = ac.createConvolver();
    reverb.buffer = impulseResponse(ac, 2.4, 3.2);
    const reverbReturn = ac.createGain();
    reverbReturn.gain.value = 0.32;
    reverb.connect(reverbReturn);
    reverbReturn.connect(master);

    // Music has its own, longer hall, and it sits behind the music slider — a
    // shared reverb would leave the band's echo audible with the music off.
    const music = ac.createGain();
    music.connect(master);
    const musicMuffle = ac.createBiquadFilter();
    musicMuffle.type = 'lowpass';
    musicMuffle.frequency.value = 20000;
    musicMuffle.Q.value = 0.5;
    musicMuffle.connect(music);
    const hall = ac.createConvolver();
    hall.buffer = impulseResponse(ac, 3.4, 2.6);
    hall.connect(musicMuffle);

    const engine = new SynthEngine(ac);
    const player = new MusicPlayer(engine, musicMuffle, hall);
    this.graph = { ac, engine, master, sfx, ui, ambient, ambientDuck, reverb, music, musicMuffle, player };
    this.setLevels(this.levels);
    // The lookahead scheduler. A hidden tab's timers are throttled to about once
    // a second, so the horizon stretches to cover the gap.
    this.musicTimer = window.setInterval(() => {
      const horizon = document.hidden ? 1.6 : 0.35;
      player.schedule(ac.currentTime + horizon);
    }, 50);
    this.buildWind(this.graph);
    this.nextBirdAt = ac.currentTime + rand(3, 8);
  }

  /**
   * Wind: two independent gust layers, one per side, each a low rumble plus a
   * band of hiss whose centre drifts, plus a faint rustle of leaves. One LFO per
   * layer drives all three, so a gust swells the rumble, the hiss and the leaves
   * together — which is what makes it read as wind moving through trees rather
   * than three unrelated noises.
   */
  private buildWind(g: Graph): void {
    const { ac, engine } = g;
    const layer = (pan: number, rate: number): void => {
      const gustLfo = ac.createOscillator();
      gustLfo.frequency.value = rate;
      const gustDepth = ac.createGain();
      gustDepth.gain.value = 0.32;
      gustLfo.connect(gustDepth);
      const gust = ac.createGain();
      gust.gain.value = 0.45;
      gustDepth.connect(gust.gain);

      const rumble = ac.createBufferSource();
      rumble.buffer = engine.brown;
      rumble.loop = true;
      const rumbleLp = ac.createBiquadFilter();
      rumbleLp.type = 'lowpass';
      rumbleLp.frequency.value = 360;
      const rumbleGain = ac.createGain();
      rumbleGain.gain.value = 0.5;
      rumble.connect(rumbleLp).connect(rumbleGain).connect(gust);

      const hiss = ac.createBufferSource();
      hiss.buffer = engine.white;
      hiss.loop = true;
      const band = ac.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 620;
      band.Q.value = 1.3;
      const sweepLfo = ac.createOscillator();
      sweepLfo.frequency.value = rate * 0.71;
      const sweepDepth = ac.createGain();
      sweepDepth.gain.value = 240;
      sweepLfo.connect(sweepDepth).connect(band.frequency);
      const hissGain = ac.createGain();
      hissGain.gain.value = 0.05;
      hiss.connect(band).connect(hissGain).connect(gust);

      const leaves = ac.createBufferSource();
      leaves.buffer = engine.white;
      leaves.loop = true;
      const leavesHp = ac.createBiquadFilter();
      leavesHp.type = 'highpass';
      leavesHp.frequency.value = 3800;
      const leavesGain = ac.createGain();
      leavesGain.gain.value = 0.012;
      leaves.connect(leavesHp).connect(leavesGain).connect(gust);

      const panner = ac.createStereoPanner();
      panner.pan.value = pan;
      gust.connect(panner).connect(g.ambient);

      const t = ac.currentTime;
      gustLfo.start(t);
      sweepLfo.start(t);
      rumble.start(t, Math.random() * engine.brown.duration);
      hiss.start(t, Math.random() * engine.white.duration);
      leaves.start(t, Math.random() * engine.white.duration);
    };
    // Rates that are not multiples of each other, so the two sides never fall
    // into step and the gusts do not become a rhythm.
    layer(-0.6, 0.043);
    layer(0.6, 0.067);
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  private listen(): void {
    const bus = this.ctx.bus;
    const on = <K extends keyof GameEvents>(key: K, fn: (e: GameEvents[K]) => void): void => {
      this.offs.push(bus.on(key, fn));
    };

    on('unit:damage', (e) => {
      const hero = this.opts.playerHeroId();
      if (hero === null) return;
      if (e.sourceId === hero) {
        // Ability damage is voiced by the cast itself; a hit per target on top
        // of a shockwave would bury it.
        if (e.abilityId !== null) return;
        const def = this.defOf(hero);
        const id: SoundId = ARCANE_ATTACKERS.has(def)
          ? e.crit ? 'attack.arcaneCrit' : 'attack.arcane'
          : BOW_ATTACKERS.has(def)
            ? e.crit ? 'attack.bowCrit' : 'attack.bow'
            : e.crit ? 'attack.bladeCrit' : 'attack.blade';
        this.play(id, e.pos);
      } else if (e.targetId === hero) {
        this.play('hero.hurt', e.pos);
      }
    });

    on('unit:miss', (e) => {
      if (e.sourceId !== null && e.sourceId === this.opts.playerHeroId()) {
        this.play('attack.miss', e.pos);
      }
    });

    on('unit:death', (e) => {
      const unit = this.ctx.match.units.get(e.id);
      if (!unit) return;
      if (unit.kind === UnitKind.Hero) {
        if (unit.id === this.opts.playerHeroId()) this.play('hero.death');
        return;
      }
      this.play(DEATH_BY_DEF[unit.defId] ?? 'death.small', e.pos);
    });

    on('unit:bounty', (e) => this.play('bounty.coins', e.pos));

    on('hero:abilityCast', (e) => {
      if (e.id !== this.opts.playerHeroId()) return;
      const id = `ability.${e.abilityId}`;
      const pos = this.ctx.match.units.get(e.id)?.pos;
      if (id in SOUNDS) this.play(id as SoundId, pos);
    });

    on('hero:levelUp', (e) => {
      if (e.id === this.opts.playerHeroId()) this.play('hero.levelUp');
    });
    on('hero:itemBought', (e) => {
      if (e.id === this.opts.playerHeroId()) this.play('shop.purchase');
    });
    on('hero:itemUsed', (e) => {
      if (e.id === this.opts.playerHeroId()) this.play('hero.potion');
    });
    on('hero:revive', (e) => {
      if (e.id === this.opts.playerHeroId()) this.play('hero.revive');
    });

    on('wave:announce', (e) => this.play(e.isBoss || e.sudden ? 'wave.bossHorn' : 'wave.horn'));
    on('wave:clear', (e) => {
      // Each team hears its own side being cleared, not the rival's.
      if (e.team === this.opts.localTeam()) this.play('wave.clear');
    });
    on('boss:phase', (e) => this.play('boss.phase', this.ctx.match.units.get(e.id)?.pos));

    on('core:leak', (e) => {
      if (e.team !== this.opts.localTeam()) return;
      this.play('core.crack');
      // The bell has a long gap of its own, so a column leaking in one after
      // another rings the alarm once rather than into a carillon.
      this.play('core.alarm');
    });

    on('core:destroyed', (e) => {
      if (e.team !== this.opts.localTeam()) return;
      this.play('core.explosion');
      this.silenced = true;
      const g = this.graph;
      if (g) {
        g.ambientDuck.gain.setTargetAtTime(0.25, g.ac.currentTime, 1.5);
        this.lamentAt = g.ac.currentTime + 6;
      }
    });

    on('sabotage:launched', (e) => {
      if (e.toTeam === this.opts.localTeam()) this.play('sabotage.hit');
      else if (e.fromTeam === this.opts.localTeam()) this.play('sabotage.cast');
    });

    on('match:end', (e) => {
      if (e.winner !== null && e.winner === this.opts.localTeam()) this.play('match.victory');
    });

    // The generic request channel, for systems that want a sound by name.
    on('sfx:request', (e) => {
      if (e.sfxId in SOUNDS) this.play(e.sfxId as SoundId, e.pos, e.volume ?? 1);
    });
  }

  private defOf(id: EntityId): string {
    return this.ctx.match.units.get(id)?.defId ?? '';
  }

  /**
   * How loud and where a world position is, judged from the screen: anything
   * on screen is full volume, and it fades over one more screen-width beyond
   * the edge. Panned by horizontal screen position. Zooming out lowers
   * everything a little — the camera is further from the fight.
   */
  private spatial(pos: Vec2): { gain: number; pan: number } {
    const render = this.ctx.services.tryGet(RenderKey);
    if (!render) return { gain: 1, pan: 0 };
    if (!render.project(pos, 1, this.screen)) return { gain: 0, pan: 0 };

    const nx = (this.screen.x / window.innerWidth) * 2 - 1;
    const ny = (this.screen.y / window.innerHeight) * 2 - 1;
    const edge = Math.max(Math.abs(nx), Math.abs(ny));
    const onScreen = edge <= 1 ? 1 : Math.max(0, 1 - (edge - 1) * 0.9);

    const cam = render.camera.position;
    const dx = cam.x - pos.x;
    const dz = cam.z - pos.z;
    const distance = Math.sqrt(dx * dx + cam.y * cam.y + dz * dz);
    const zoom = Math.min(1, Math.max(0.4, 34 / distance));

    return { gain: onScreen * zoom, pan: Math.max(-0.8, Math.min(0.8, nx * 0.8)) };
  }
}
