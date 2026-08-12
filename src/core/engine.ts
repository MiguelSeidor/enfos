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
} from './contracts';
import { EventBus, type GameEvents } from './events';
import { createRng, type Rng } from './rng';

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

  get isPaused(): boolean {
    return this.paused;
  }

  /** Headless stepping for balance simulations and regression tests. */
  stepHeadless(steps: number): void {
    for (let i = 0; i < steps; i++) {
      this.simulateStep();
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
    this.accumulator += dt * this.timeScale;

    const simStart = performance.now();
    let steps = 0;
    while (this.accumulator >= SIM_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.simulateStep();
      this.accumulator -= SIM_STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
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
