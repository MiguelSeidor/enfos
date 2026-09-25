/**
 * Engine loop and module orchestration.
 *
 * Two clocks:
 *  - fixedUpdate() runs at SIM_HZ with a constant dt. Deterministic, seeded,
 *    replayable. All gameplay lives here.
 *  - update() runs once per rendered frame with variable dt. Presentation only.
 *
 * Decoupling them is what lets the renderer run at 144 fps while the simulation
 * stays reproducible for QA seeds (GDD §7) and cheap with 1000+ units (§18).
 */

import * as THREE from 'three';
import type {
  GameContext,
  GameModule,
  MatchState,
  ServiceKey,
  ServiceLocator,
  UnitState,
} from './contracts';
import { EventBus, type GameEvents } from './events';
import { createRng, type Rng } from './rng';

/** Bumped whenever snapshot contents change shape; older snapshots are ignored. */
export const SNAPSHOT_VERSION = 1;

export interface SimSnapshot {
  version: number;
  tick: number;
  time: number;
  rng: number;
  match: Pick<MatchState, 'seed' | 'wave' | 'phase' | 'mode' | 'cores' | 'units' | 'heroes' | 'winner'>;
  modules: Record<string, unknown>;
}

export const SIM_HZ = 30;
export const SIM_STEP = 1 / SIM_HZ;
/** Never simulate more than this many steps in one frame; prevents spiral of death. */
const MAX_STEPS_PER_FRAME = 5;

class Services implements ServiceLocator {
  private readonly map = new Map<string, unknown>();

  register<T>(key: ServiceKey<T>, value: T): void {
    this.map.set(key.name, value);
  }

  get<T>(key: ServiceKey<T>): T {
    const value = this.map.get(key.name);
    if (value === undefined) throw new Error(`Service not registered: ${key.name}`);
    return value as T;
  }

  tryGet<T>(key: ServiceKey<T>): T | undefined {
    return this.map.get(key.name) as T | undefined;
  }
}

export interface EngineOptions {
  scene: THREE.Scene;
  camera: THREE.Camera;
  renderer: THREE.WebGLRenderer;
  match: MatchState;
  seed: number;
  /** Called after all modules have stepped; the render module draws here. */
  present: (alpha: number, dt: number) => void;
}

export interface FrameStats {
  fps: number;
  frameMs: number;
  simMs: number;
  presentMs: number;
  steps: number;
  drawCalls: number;
  triangles: number;
  programs: number;
}

export class Engine {
  readonly ctx: GameContext;
  readonly bus = new EventBus<GameEvents>();
  readonly services = new Services();
  readonly stats: FrameStats = {
    fps: 0,
    frameMs: 0,
    simMs: 0,
    presentMs: 0,
    steps: 0,
    drawCalls: 0,
    triangles: 0,
    programs: 0,
  };

  private readonly modules: GameModule[] = [];
  private readonly clock = { time: 0, delta: 0, tick: 0 };
  private readonly rng: Rng;
  private accumulator = 0;
  private lastTime = 0;
  private running = false;
  private rafId = 0;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private paused = false;
  private stepLimit = Infinity;
  /** Debug/QA: run the simulation faster or slower without touching render. */
  timeScale = 1;

  constructor(private readonly opts: EngineOptions) {
    this.rng = createRng(opts.seed);
    this.ctx = {
      scene: opts.scene,
      camera: opts.camera,
      renderer: opts.renderer,
      clock: this.clock,
      rng: this.rng,
      bus: this.bus,
      match: opts.match,
      services: this.services,
    };
  }

  add(module: GameModule): void {
    if (this.modules.some((m) => m.id === module.id)) {
      throw new Error(`Duplicate module id: ${module.id}`);
    }
    this.modules.push(module);
    this.modules.sort((a, b) => a.order - b.order);
  }

  getModule<T extends GameModule>(id: string): T | undefined {
    return this.modules.find((m) => m.id === id) as T | undefined;
  }

  /**
   * Adds a module to an already-running engine and initialises it immediately.
   *
   * Used for subsystems that cannot exist until the player has made a choice —
   * gameplay needs a hero before it can spawn one. Such a module may only depend
   * on services that already exist, since the boot-order guarantee no longer
   * applies to it.
   */
  async addAndInit(module: GameModule): Promise<void> {
    this.add(module);
    await module.init(this.ctx);
  }

  async initAll(onProgress?: (done: number, total: number, id: string) => void): Promise<void> {
    const total = this.modules.length;
    for (let i = 0; i < total; i++) {
      const module = this.modules[i]!;
      await module.init(this.ctx);
      onProgress?.(i + 1, total, module.id);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /**
   * Puts the simulation back at tick 0 with a fresh seed.
   *
   * The engine runs from boot — behind the title screen, through hero select —
   * so by the time a match starts each machine has counted a different number
   * of ticks and drawn nothing from the RNG in a different state. Online, every
   * machine must start the match from the same tick and the same RNG, so the
   * match resets both before its modules initialise.
   */
  resetSimulation(seed: number): void {
    this.clock.tick = 0;
    this.clock.time = 0;
    this.accumulator = 0;
    this.rng.restore((seed | 0) === 0 ? 0x9e3779b9 : seed | 0);
    this.opts.match.seed = seed;
    this.opts.match.tick = 0;
    this.opts.match.time = 0;
  }

  /**
   * The last tick the simulation may reach. Online, a tick can only be
   * simulated once every player's commands for it are known; the network
   * session raises this as turns arrive. Infinity for solo play.
   */
  setStepLimit(tick: number): void {
    this.stepLimit = tick;
  }

  /** Called after every simulated tick, with that tick. For checksums. */
  onStep: ((tick: number) => void) | null = null;

  get isPaused(): boolean {
    return this.paused;
  }

  /** Headless stepping for balance simulations and regression tests. */
  stepHeadless(steps: number): void {
    for (let i = 0; i < steps; i++) {
      this.simulateStep();
    }
  }

  /**
   * Simulates every tick up to the step limit right away, returning how many.
   * A hidden tab gets no animation frames at all, so the network session calls
   * this from a timer to keep an online match from piling up unplayed turns.
   */
  drainToLimit(maxSteps = 900): number {
    let steps = 0;
    while (this.clock.tick < this.stepLimit && steps < maxSteps) {
      this.simulateStep();
      steps++;
    }
    return steps;
  }

  /** The current simulation tick. */
  get tick(): number {
    return this.clock.tick;
  }

  /**
   * A deep copy of the whole simulation: clock, RNG, match state and every
   * module's `saveState`. Built as one object and cloned in one pass, so an
   * object referenced from two places — a hero in both unit tables, a timed
   * modifier both on its unit and in the ability module's expiry list — is
   * still one object in the copy.
   */
  snapshot(): SimSnapshot {
    const match = this.opts.match;
    // Render handles are presentation (and hold GPU objects that cannot be
    // cloned); detach them for the duration of the copy.
    const handles: [UnitState, unknown][] = [];
    for (const unit of match.units.values()) {
      if (unit.renderRef === undefined) continue;
      handles.push([unit, unit.renderRef]);
      unit.renderRef = undefined;
    }
    try {
      const modules: Record<string, unknown> = {};
      for (const module of this.modules) {
        if (module.saveState) modules[module.id] = module.saveState();
      }
      return structuredClone({
        version: SNAPSHOT_VERSION,
        tick: this.clock.tick,
        time: this.clock.time,
        rng: this.rng.state(),
        match: {
          seed: match.seed,
          wave: match.wave,
          phase: match.phase,
          mode: match.mode,
          cores: match.cores,
          units: match.units,
          heroes: match.heroes,
          winner: match.winner,
        },
        modules,
      });
    } finally {
      for (const [unit, handle] of handles) unit.renderRef = handle;
    }
  }

  /**
   * Replaces the running simulation with a snapshot. The snapshot is adopted,
   * not copied: pass a fresh one (from `snapshot()` or from storage).
   */
  restore(snapshot: SimSnapshot): void {
    for (const module of this.modules) module.beforeRestore?.();

    this.clock.tick = snapshot.tick;
    this.clock.time = snapshot.time;
    this.accumulator = 0;
    this.rng.restore(snapshot.rng);
    const match = this.opts.match;
    const m = snapshot.match;
    match.seed = m.seed;
    match.tick = snapshot.tick;
    match.time = snapshot.time;
    match.wave = m.wave;
    match.phase = m.phase;
    match.mode = m.mode;
    match.cores = m.cores;
    match.winner = m.winner;
    // Refilled rather than reassigned: modules and presentation hold these Maps.
    match.units.clear();
    for (const [id, unit] of m.units) match.units.set(id, unit);
    match.heroes.clear();
    for (const [id, hero] of m.heroes) match.heroes.set(id, hero);

    for (const module of this.modules) {
      if (module.loadState && snapshot.modules[module.id] !== undefined) {
        module.loadState(snapshot.modules[module.id]);
      }
    }
  }

  private frame(now: number): void {
    const frameStart = now;
    this.opts.renderer.info.reset();
    // Clamp to 250 ms so a stalled tab does not fast-forward the match.
    let dt = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;

    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }

    if (this.paused) dt = 0;

    // Online pacing. `behind` is how many ticks are already confirmed and
    // waiting. A small backlog is normal network jitter; a large one means this
    // machine fell behind (a slow frame, a hidden tab) and has to catch up, so
    // it runs slightly fast, and much faster when far behind.
    //
    // Only online: solo play has no limit, and `Infinity - tick` read as being
    // infinitely far behind — which ran every solo match at four times speed.
    const behind = Number.isFinite(this.stepLimit) ? this.stepLimit - this.clock.tick : 0;
    const catchUp = behind > 30 ? 4 : behind > 6 ? 1.25 : 1;
    const maxSteps = behind > 30 ? MAX_STEPS_PER_FRAME * 4 : MAX_STEPS_PER_FRAME;
    this.accumulator += dt * this.timeScale * catchUp;

    const simStart = performance.now();
    let steps = 0;
    while (
      this.accumulator >= SIM_STEP &&
      steps < maxSteps &&
      this.clock.tick < this.stepLimit
    ) {
      this.simulateStep();
      this.accumulator -= SIM_STEP;
      steps++;
    }
    if (steps === maxSteps) this.accumulator = 0;
    // Waiting on the network: do not bank the waited time, or the next turn
    // would be played back as a burst to "catch up" on time that was never owed.
    if (this.clock.tick >= this.stepLimit) this.accumulator = Math.min(this.accumulator, SIM_STEP);
    this.stats.simMs = performance.now() - simStart;
    this.stats.steps = steps;

    this.clock.delta = dt;

    for (let i = 0; i < this.modules.length; i++) {
      this.modules[i]!.update?.(dt, this.ctx);
    }

    const presentStart = performance.now();
    this.opts.present(this.accumulator / SIM_STEP, dt);
    this.stats.presentMs = performance.now() - presentStart;

    const info = this.opts.renderer.info;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.programs = info.programs?.length ?? 0;
    this.stats.frameMs = performance.now() - frameStart;
  }

  private simulateStep(): void {
    this.clock.tick++;
    this.clock.time += SIM_STEP;
    this.opts.match.tick = this.clock.tick;
    this.opts.match.time = this.clock.time;
    for (let i = 0; i < this.modules.length; i++) {
      this.modules[i]!.fixedUpdate?.(SIM_STEP, this.ctx);
    }
    this.onStep?.(this.clock.tick);
  }

  dispose(): void {
    this.stop();
    for (const module of this.modules) module.dispose?.();
    this.modules.length = 0;
    this.bus.clear();
  }
}

/** Empty match state; systems populate it during init. */
export function createMatchState(seed: number, mode: '1v1' | '2v2' | '3v3'): MatchState {
  return {
    seed,
    tick: 0,
    time: 0,
    wave: 0,
    phase: 'preparation',
    mode,
    cores: [],
    units: new Map(),
    heroes: new Map(),
    winner: null,
  };
}
