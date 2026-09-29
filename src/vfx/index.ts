/**
 * Visual effects. Owner: VFX. Module order 810.
 *
 * Four systems, five draw calls, everything pooled:
 *
 * | System            | File            | Draw calls |
 * | ----------------- | --------------- | ---------- |
 * | Billboard sprites | `quads.ts`      | 2 (additive + alpha) |
 * | Ground patches    | `ground.ts`     | 2 (additive + alpha) |
 * | Beams             | `beams.ts`      | 1 |
 * | Projectiles       | `projectiles.ts`| 0 — heads and trails ride the sprite batches |
 *
 * What an effect *is* lives in `specs.ts`; this file only knows how to play one.
 *
 * Everything here is presentation. Effects are driven from bus events and the
 * `VfxService`, never from simulation state, so deleting this module changes the
 * outcome of a match by exactly nothing — which is also why it may use
 * `visualRng` freely (GDD §7 determinism rules).
 *
 * Order 810 means terrain (100) is available in `init()`, but the render
 * pipeline (900) and the gameplay modules — which only join the engine after
 * hero selection — are not. Those are resolved lazily on first use.
 *
 * Deliberately *not* here: real lights. A point light per impact would recompile
 * every lit program as the light count changes, which costs more than the effect
 * is worth on the target GPU. The additive ground patch under an impact is the
 * light, and it reads as one because it conforms to the terrain.
 */

import * as THREE from 'three';
import type { DefId, GameContext, GameModule, Vec2 } from '@/core/contracts';
import { DamageType } from '@/core/contracts';
import {
  RenderKey,
  TerrainKey,
  UnitKey,
  VfxKey,
  type RenderService,
  type TerrainService,
  type UnitService,
  type VfxService,
} from '@/core/services';
import { visualRng } from '@/core/rng';
import { playback } from '@/core/playback';
import { GroundBatch, GSHAPE } from './ground';
import { BeamSystem } from './beams';
import { ProjectileSystem } from './projectiles';
import { linearOf, ParticleSystem } from './quads';
import { makeDecalArray, makeHeightField, makeSpriteArray, DECAL, SPRITE } from './sprites';
import type { BurstSpec } from './quads';
import {
  BEAMS,
  curveAt,
  DEFAULT_BEAM,
  EFFECTS,
  PROJECTILES,
  type GroundShapeSpec,
  type ResidueSpec,
  type ShakeSpec,
} from './specs';

/** Pool sizes. Sized for a boss nova landing while forty creeps trade blows. */
const GLOW_PARTICLES = 1400;
const SOFT_PARTICLES = 700;
const GROUND_LIGHT = 96;
const GROUND_DECAL = 64;
const PROJECTILES_MAX = 96;
// Chain lightning draws each jump as several kinked segments, so the pool has to
// cover a full chain in flight at once.
const BEAMS_MAX = 48;

/** Ground patches ride the height field, so the lift only clears depth precision. */
const LIFT_LIGHT = 0.09;
const LIFT_DECAL = 0.04;

/** Effects further than this from the camera are dropped before they cost anything. */
const CULL_DISTANCE = 130;

const FX_SHAPE = 0;
const FX_TELEGRAPH = 1;
const FX_DECAL = 2;

/**
 * Scheduled layers. An effect is no longer one instant — it is a wind-up, a beat
 * and a residue (see the three-beats note in `specs.ts`), and something has to
 * hold the layers that have not happened yet.
 *
 * Sized for a boss nova, two ultimates and a volley of arrows overlapping: the
 * heaviest single effect in the table books fourteen entries.
 */
const PENDING_MAX = 192;

const PEND_SHAPE = 0;
const PEND_BURST = 1;
const PEND_DECAL = 2;
const PEND_SHAKE = 3;

interface Pending {
  active: boolean;
  wait: number;
  kind: number;
  /** Exactly one of these is set, by `kind`. All are module constants, never mutated. */
  shape: GroundShapeSpec | null;
  burst: BurstSpec | null;
  residue: ResidueSpec | null;
  shakeIntensity: number;
  shakeDuration: number;
  x: number;
  z: number;
  scale: number;
}

function blankPending(): Pending {
  return {
    active: false,
    wait: 0,
    kind: PEND_SHAPE,
    shape: null,
    burst: null,
    residue: null,
    shakeIntensity: 0,
    shakeDuration: 0,
    x: 0,
    z: 0,
    scale: 1,
  };
}

interface GroundFx {
  active: boolean;
  kind: number;
  /** Only meaningful for `FX_SHAPE`. */
  spec: GroundShapeSpec | null;
  life: number;
  maxLife: number;
  delay: number;
  x: number;
  z: number;
  scale: number;
  yaw: number;
  spin: number;
  r: number;
  g: number;
  b: number;
  /** Telegraph/decal parameters, precomputed at spawn. */
  shape: number;
  halfX: number;
  halfZ: number;
  alpha: number;
  p0: number;
  soft: boolean;
  layer: number;
  /** Telegraphs flash white the instant their lead time runs out. */
  flash: number;
}

function blankFx(): GroundFx {
  return {
    active: false,
    kind: FX_SHAPE,
    spec: null,
    life: 0,
    maxLife: 1,
    delay: 0,
    x: 0,
    z: 0,
    scale: 1,
    yaw: 0,
    spin: 0,
    r: 1,
    g: 1,
    b: 1,
    shape: 0,
    halfX: 1,
    halfZ: 1,
    alpha: 1,
    p0: 0,
    soft: false,
    layer: 0,
    flash: 0,
  };
}

/** Damage type → hit effect id. The reason a frost hit does not look like an axe. */
const HIT_BY_TYPE: Record<string, string> = {
  [DamageType.Physical]: 'hit.physical',
  [DamageType.Arcane]: 'hit.arcane',
  [DamageType.Frost]: 'hit.frost',
  [DamageType.Holy]: 'hit.holy',
  [DamageType.Shadow]: 'hit.hex',
  [DamageType.Nature]: 'hit.hex',
  [DamageType.Fire]: 'hit.physical',
};

/** Unit definition → the projectile it visibly fires. */
const SHOT_BY_DEF: Record<string, string> = {
  spinebolt: 'shot.spine',
  hexwright: 'shot.hex',
  oracle: 'shot.arcane',
  talon: 'shot.arrow',
  vesper: 'shot.holy',
};

const SHOT_BY_TYPE: Record<string, string> = {
  [DamageType.Physical]: 'shot.spine',
  [DamageType.Arcane]: 'shot.arcane',
  [DamageType.Frost]: 'shot.frost',
  [DamageType.Holy]: 'shot.holy',
  [DamageType.Shadow]: 'shot.hex',
  [DamageType.Nature]: 'shot.hex',
  [DamageType.Fire]: 'shot.holy',
};

/** Beyond this reach a landed hit must have been fired from range. */
const RANGED_HIT_DISTANCE = 4.5;

/**
 * Motes drawn into the centre of a boss telegraph as its lead time runs out.
 * Authored here rather than in `specs.ts` because it belongs to the telegraph
 * mechanism, which is code, not to any one effect.
 */
const BOSS_WARN: BurstSpec = {
  count: 14,
  layer: SPRITE.ember,
  ring: 0.9,
  ringJitter: 0.35,
  y: 0.2,
  yJitter: 1.2,
  converge: true,
  swirl: [1, 2.4],
  rise: [0.4, 1.6],
  size: [0.16, 0.34],
  sizeEnd: 0.5,
  life: [0.42, 0.48],
  color: 0xff6a3c,
  intensity: 0.85,
  intensityEnd: 1.9,
  fadeIn: 0.22,
  decay: 0.7,
};

export class VfxModule implements GameModule {
  readonly id = 'vfx';
  readonly order = 810;

  private readonly root = new THREE.Group();
  private terrain!: TerrainService;
  private ctx!: GameContext;

  private sprites!: THREE.DataArrayTexture;
  private decals!: THREE.DataArrayTexture;
  private height!: ReturnType<typeof makeHeightField>;
  private particles!: ParticleSystem;
  private lightGround!: GroundBatch;
  private decalGround!: GroundBatch;
  private beams!: BeamSystem;
  private shots!: ProjectileSystem;

  private readonly fx: GroundFx[] = [];
  private readonly pending: Pending[] = [];
  private pendingCursor = 0;
  private time = 0;

  /** Lazily resolved: registered at order 900, after this module inits. */
  private render: RenderService | null = null;
  private units: UnitService | null = null;
  private readonly camPos = new THREE.Vector3();

  /** Hit sparks are throttled per frame so a 300-unit brawl cannot flood the pool. */
  private hitsThisFrame = 0;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.root.name = 'vfx';
    this.root.frustumCulled = false;
    this.root.matrixAutoUpdate = false;
    ctx.scene.add(this.root);

    this.terrain = ctx.services.get(TerrainKey);
    this.sprites = makeSpriteArray();
    this.decals = makeDecalArray();
    this.height = makeHeightField(
      (x, z) => this.terrain.heightAt(x, z),
      this.terrain.bounds,
      256,
    );

    this.particles = new ParticleSystem(this.sprites, GLOW_PARTICLES, SOFT_PARTICLES);
    this.particles.addTo(this.root);

    // Two ground batches because additive cannot darken: a scorch mark that does
    // not darken the ground is not a scorch mark.
    this.decalGround = new GroundBatch(
      GROUND_DECAL,
      this.decals,
      this.height,
      THREE.NormalBlending,
      8,
    );
    this.lightGround = new GroundBatch(
      GROUND_LIGHT,
      this.decals,
      this.height,
      THREE.AdditiveBlending,
      9,
    );
    this.root.add(this.decalGround.mesh);
    this.root.add(this.lightGround.mesh);

    this.beams = new BeamSystem(BEAMS_MAX, this.decals, 13);
    this.root.add(this.beams.mesh);

    this.shots = new ProjectileSystem(PROJECTILES_MAX, this.particles, (id, x, z, scale) =>
      this.play(id, x, z, scale),
    );

    for (let i = 0; i < GROUND_LIGHT + GROUND_DECAL; i++) this.fx.push(blankFx());
    for (let i = 0; i < PENDING_MAX; i++) this.pending.push(blankPending());

    const service: VfxService = {
      spawn: (vfxId, pos, opts) => this.play(vfxId, pos.x, pos.z, opts?.scale ?? 1),
      beam: (vfxId, from, to, duration) => this.spawnBeam(vfxId, from, to, duration),
      telegraph: (shape, pos, size, leadTime, color) =>
        this.spawnTelegraph(shape, pos, size, leadTime, color),
      decal: (id, pos, size, life) => this.spawnDecal(id, pos.x, pos.z, size, life),
      damageNumber: () => {},
      shake: (intensity, duration) => ctx.bus.emit('camera:shake', { intensity, duration }),
      // Appended to VfxService by VFX: gameplay may fire a visible projectile and
      // be told when it lands. See the report for the wiring request.
      projectile: (id, from, to, opts) => this.spawnProjectile(id, from, to, opts),
    } as VfxService;
    ctx.services.register(VfxKey, service);

    // Every landed hit gets feedback without gameplay asking for it: an attack
    // that produces no visual is the single loudest complaint in a combat review.
    ctx.bus.on('unit:damage', (e) => this.onDamage(e));
    ctx.bus.on('unit:death', ({ pos }) => this.play('hit.physical', pos.x, pos.z, 1.4));
    ctx.bus.on('boss:telegraph', ({ pos, leadTime }) => {
      this.spawnTelegraph('circle', pos, 7, leadTime, 0xff5a3c);
      // The circle says *where*. The gather says *now*: it is armed so that its
      // ring closes onto the point over the last third of the lead time, which
      // is the part a player reacts to.
      const warn = Math.min(0.5, leadTime * 0.34);
      const p = this.later(Math.max(0, leadTime - warn), PEND_BURST, pos.x, pos.z, 7);
      p.burst = BOSS_WARN;
    });
    ctx.bus.on('vfx:request', ({ vfxId, pos, scale }) =>
      this.play(vfxId, pos.x, pos.z, scale ?? 1),
    );

    // QA hook: `?vfxdemo=1` runs the effect catalogue on a loop near the hero so
    // a screenshot can catch short-lived effects. Off by default; it changes
    // nothing in the simulation either way.
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __VFX__?: unknown; location?: Location };
      if (w.location && new URLSearchParams(w.location.search).get('vfxdemo') === '1') {
        this.demo = true;
      }
      w.__VFX__ = {
        play: (id: string, x: number, z: number, scale: number) => this.play(id, x, z, scale),
        telegraph: (shape: string, x: number, z: number, size: number, lead: number, color: number) =>
          this.spawnTelegraph(shape, { x, z }, size, lead, color),
        beam: (id: string, from: Vec2, to: Vec2, duration: number) =>
          this.spawnBeam(id, from, to, duration),
        shot: (id: string, from: Vec2, to: Vec2) => this.spawnProjectile(id, from, to),
        setDemo: (on: boolean) => {
          this.demo = on;
        },
        counts: () => this.counts(),
        heightAt: (x: number, z: number) => this.terrain.heightAt(x, z),
      };
    }
  }

  // ── Playback ───────────────────────────────────────────────────────────────

  /**
   * Fires a full effect: ground shapes, particle bursts, residue and shake.
   *
   * Each layer carries an optional `at`, in seconds, and anything with one is
   * booked rather than played. That is the whole anticipation mechanism — the
   * same call site now produces a wind-up, a beat and a residue in sequence
   * instead of everything landing on one frame.
   *
   * Culling is decided once, here, against the effect's origin. A layer that was
   * worth playing at t=0 is worth finishing.
   */
  private play(vfxId: DefId, x: number, z: number, scale: number): void {
    // Replaying missed turns: effects for events long past would only flood the pools.
    if (playback.fastForward) return;
    const spec = EFFECTS[vfxId];
    if (!spec) return;
    if (this.culled(x, z)) return;

    const s = Math.max(0.4, scale);
    const groundY = this.terrain.heightAt(x, z);

    if (spec.ground) {
      for (const shape of spec.ground) {
        if (shape.at) this.later(shape.at, PEND_SHAPE, x, z, s).shape = shape;
        else this.armShape(shape, x, z, s);
      }
    }
    if (spec.bursts) {
      for (const burst of spec.bursts) {
        if (burst.at) this.later(burst.at, PEND_BURST, x, z, s).burst = burst;
        else this.particles.burst(burst, x, groundY, z, s, visualRng.next() * Math.PI * 2);
      }
    }
    if (spec.residue) {
      const list = Array.isArray(spec.residue) ? spec.residue : [spec.residue];
      for (const res of list) {
        if (res.at) this.later(res.at, PEND_DECAL, x, z, s).residue = res;
        else this.armDecal(res.layer, x, z, s * res.size, res.life, res.alpha, res.color);
      }
    }
    if (spec.shake) {
      if (Array.isArray(spec.shake) && typeof spec.shake[0] === 'number') {
        const [intensity, duration] = spec.shake as [number, number];
        this.ctx.bus.emit('camera:shake', { intensity, duration });
      } else {
        for (const sh of spec.shake as ShakeSpec[]) {
          if (sh.at) {
            const p = this.later(sh.at, PEND_SHAKE, x, z, s);
            p.shakeIntensity = sh.intensity;
            p.shakeDuration = sh.duration;
          } else {
            this.ctx.bus.emit('camera:shake', {
              intensity: sh.intensity,
              duration: sh.duration,
            });
          }
        }
      }
    }
  }

  /**
   * Books one layer for `wait` seconds from now.
   *
   * Recycles the entry nearest to firing when the pool is full rather than
   * dropping the newest: a booked layer that never arrives leaves an effect with
   * a wind-up and no payoff, which reads far worse than a missing residue.
   */
  private later(wait: number, kind: number, x: number, z: number, scale: number): Pending {
    let slot: Pending | null = null;
    for (let k = 0; k < PENDING_MAX; k++) {
      const p = this.pending[(this.pendingCursor + k) % PENDING_MAX]!;
      if (!p.active) {
        this.pendingCursor = (this.pendingCursor + k + 1) % PENDING_MAX;
        slot = p;
        break;
      }
    }
    if (!slot) {
      slot = this.pending[this.pendingCursor]!;
      this.pendingCursor = (this.pendingCursor + 1) % PENDING_MAX;
    }
    slot.active = true;
    slot.wait = wait;
    slot.kind = kind;
    slot.shape = null;
    slot.burst = null;
    slot.residue = null;
    slot.shakeIntensity = 0;
    slot.shakeDuration = 0;
    slot.x = x;
    slot.z = z;
    slot.scale = scale;
    return slot;
  }

  private stepPending(dt: number): void {
    for (const p of this.pending) {
      if (!p.active) continue;
      p.wait -= dt;
      if (p.wait > 0) continue;
      p.active = false;
      switch (p.kind) {
        case PEND_SHAPE:
          this.armShape(p.shape!, p.x, p.z, p.scale);
          break;
        case PEND_BURST:
          this.particles.burst(
            p.burst!,
            p.x,
            this.terrain.heightAt(p.x, p.z),
            p.z,
            p.scale,
            visualRng.next() * Math.PI * 2,
          );
          break;
        case PEND_DECAL: {
          const res = p.residue!;
          this.armDecal(res.layer, p.x, p.z, p.scale * res.size, res.life, res.alpha, res.color);
          break;
        }
        default:
          this.ctx.bus.emit('camera:shake', {
            intensity: p.shakeIntensity,
            duration: p.shakeDuration,
          });
          break;
      }
    }
  }

  private armShape(spec: GroundShapeSpec, x: number, z: number, scale: number): void {
    const fx = this.acquire(spec.soft === true);
    if (!fx) return;
    const half = typeof spec.size === 'function' ? spec.size(0) : spec.size ?? 1;
    const [r, g, b] = linearOf(spec.color);
    const i = spec.intensity ?? 1;
    fx.active = true;
    fx.kind = FX_SHAPE;
    fx.spec = spec;
    fx.life = spec.life;
    fx.maxLife = spec.life;
    fx.delay = spec.delay ?? 0;
    fx.x = x;
    fx.z = z;
    fx.scale = scale;
    fx.halfX = scale * half;
    fx.halfZ = scale * half;
    fx.yaw = spec.yaw ?? visualRng.next() * Math.PI * 2;
    fx.spin = spec.spin ?? 0;
    fx.r = r * i;
    fx.g = g * i;
    fx.b = b * i;
    fx.shape = spec.shape;
    fx.soft = spec.soft === true;
    fx.layer = spec.decalLayer ?? DECAL.grain;
    fx.flash = 0;
  }

  private armDecal(
    layer: number,
    x: number,
    z: number,
    size: number,
    life: number,
    alpha: number,
    color: number,
  ): void {
    const fx = this.acquire(true);
    if (!fx) return;
    const [r, g, b] = linearOf(color);
    fx.active = true;
    fx.kind = FX_DECAL;
    fx.spec = null;
    fx.life = life;
    fx.maxLife = life;
    fx.delay = 0;
    fx.x = x;
    fx.z = z;
    fx.scale = size;
    fx.halfX = size;
    fx.halfZ = size;
    fx.yaw = visualRng.next() * Math.PI * 2;
    fx.spin = 0;
    fx.r = r;
    fx.g = g;
    fx.b = b;
    fx.shape = GSHAPE.decal;
    fx.alpha = alpha;
    fx.p0 = 0.35;
    fx.soft = true;
    fx.layer = layer;
    fx.flash = 0;
  }

  /**
   * Telegraphs. `shape` is `circle | ring | cone | line | cross`, optionally
   * `cone:70` for a 70° total angle and `@1.57` for a world yaw in radians —
   * e.g. `'cone:70@1.57'`. The signature in `services.ts` has no direction
   * parameter, and encoding it in the shape string beats changing a contract
   * another eleven agents are building against.
   */
  private spawnTelegraph(
    shape: string,
    pos: Vec2,
    size: number,
    leadTime: number,
    color: number,
  ): void {
    // Telegraphs are alpha-blended, not additive. Additive over bright ground
    // washes a red danger zone to yellow-white and takes the surface texture
    // with it; alpha tints the ground and leaves it readable underneath, which
    // is what lets a player judge whether they are standing in the shape.
    const fx = this.acquire(true);
    if (!fx) return;

    let name = shape;
    let yaw = visualRng.next() * Math.PI * 2;
    const at = name.indexOf('@');
    if (at >= 0) {
      yaw = Number(name.slice(at + 1)) || 0;
      name = name.slice(0, at);
    }
    let param = 0;
    const colon = name.indexOf(':');
    if (colon >= 0) {
      param = Number(name.slice(colon + 1)) || 0;
      name = name.slice(0, colon);
    }

    const [r, g, b] = linearOf(color);
    fx.active = true;
    fx.kind = FX_TELEGRAPH;
    fx.spec = null;
    fx.life = Math.max(0.12, leadTime);
    fx.maxLife = fx.life;
    fx.delay = 0;
    fx.x = pos.x;
    fx.z = pos.z;
    fx.scale = size;
    fx.halfX = size;
    fx.halfZ = size;
    fx.yaw = yaw;
    fx.spin = 0;
    fx.r = r;
    fx.g = g;
    fx.b = b;
    fx.alpha = 1;
    fx.soft = true;
    fx.layer = DECAL.grain;
    fx.flash = 0;

    switch (name) {
      case 'cone': {
        fx.shape = GSHAPE.cone;
        // A cone is authored by its total angle in degrees; the shader wants a half angle.
        fx.p0 = ((param > 0 ? param : 70) * Math.PI) / 360;
        break;
      }
      case 'line': {
        fx.shape = GSHAPE.line;
        fx.halfX = param > 0 ? param * 0.5 : Math.max(0.6, size * 0.16);
        fx.p0 = 0;
        break;
      }
      case 'ring': {
        fx.shape = GSHAPE.ring;
        fx.p0 = 0;
        break;
      }
      case 'cross': {
        fx.shape = GSHAPE.cross;
        fx.p0 = param > 0 ? param : 0.16;
        break;
      }
      default: {
        fx.shape = GSHAPE.disc;
        fx.p0 = 0;
        break;
      }
    }
  }

  private spawnDecal(id: DefId, x: number, z: number, size: number, life: number): void {
    if (playback.fastForward) return;
    const layer =
      id === 'frost' || id === 'decal.frost'
        ? DECAL.frost
        : id === 'sigil' || id === 'decal.sigil'
          ? DECAL.sigil
          : DECAL.scorch;
    const color = layer === DECAL.frost ? 0xcdeeff : layer === DECAL.sigil ? 0xff9ce8 : 0xffffff;
    this.armDecal(layer, x, z, Math.max(0.3, size), Math.max(0.2, life), 0.85, color);
  }

  private spawnBeam(vfxId: DefId, from: Vec2, to: Vec2, duration: number): void {
    if (playback.fastForward) return;
    const spec = BEAMS[vfxId] ?? BEAMS[DEFAULT_BEAM]!;
    const x0 = from.x;
    const y0 = this.terrain.heightAt(from.x, from.z) + spec.height;
    const z0 = from.z;
    const x1 = to.x;
    const y1 = this.terrain.heightAt(to.x, to.z) + spec.height;
    const z1 = to.z;
    const life = Math.max(0.08, duration);

    const segments = spec.jagged ?? 1;
    if (segments <= 1) {
      this.beams.fire(spec, x0, y0, z0, x1, y1, z1, life);
      return;
    }
    // Lightning: the straight line broken into kinked segments. Offsets are
    // sideways and vertical, scaled by length so a short jump is not a scribble,
    // and pinned to zero at both ends so the bolt still meets its targets.
    const length = Math.hypot(x1 - x0, z1 - z0) || 1;
    const sideX = -(z1 - z0) / length;
    const sideZ = (x1 - x0) / length;
    const amp = Math.min(1.4, length * (spec.jitter ?? 0.08));
    let px = x0;
    let py = y0;
    let pz = z0;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const edge = i === segments ? 0 : 1;
      const side = (visualRng.next() * 2 - 1) * amp * edge;
      const lift = (visualRng.next() * 2 - 1) * amp * 0.5 * edge;
      const nx = x0 + (x1 - x0) * t + sideX * side;
      const ny = y0 + (y1 - y0) * t + lift;
      const nz = z0 + (z1 - z0) * t + sideZ * side;
      this.beams.fire(spec, px, py, pz, nx, ny, nz, life);
      px = nx;
      py = ny;
      pz = nz;
    }
  }

  private spawnProjectile(
    id: DefId,
    from: Vec2,
    to: Vec2,
    opts?: { speed?: number; height?: number; fromHeight?: number; toHeight?: number },
  ): void {
    // A replay fast-forwards minutes of match in a moment; shots fired then
    // would all arrive at once, long after the moment they belonged to.
    if (playback.fastForward) return;
    const spec = PROJECTILES[id] ?? PROJECTILES['shot.arcane']!;
    const h = opts?.height ?? 1.15;
    this.shots.fire(
      spec,
      from.x,
      this.terrain.heightAt(from.x, from.z) + (opts?.fromHeight ?? h),
      from.z,
      to.x,
      this.terrain.heightAt(to.x, to.z) + (opts?.toHeight ?? h),
      to.z,
      opts?.speed ?? spec.speed,
    );
  }

  // ── Event feedback ─────────────────────────────────────────────────────────

  private onDamage(e: {
    sourceId: number | null;
    type: DamageType;
    crit: boolean;
    pos: Vec2;
    abilityId: string | null;
  }): void {
    if (playback.fastForward || this.culled(e.pos.x, e.pos.z)) return;

    // A ranged attacker deals its damage the instant it swings, with nothing in
    // flight. Rather than let arrows be invisible, the shot is reconstructed
    // here from the geometry of the hit: source far from target means something
    // crossed the gap. See the report — gameplay calling `projectile()` at fire
    // time and applying damage on arrival is the correct fix.
    const source = e.sourceId === null ? null : this.unitService()?.get(e.sourceId);
    // Spell damage brings its own visuals (a meteor, a lightning arc). Treating
    // it as a ranged swing drew an arcane bolt from the caster to every unit a
    // meteor landed on.
    if (source && source.alive && e.abilityId === null) {
      const dx = e.pos.x - source.pos.x;
      const dz = e.pos.z - source.pos.z;
      if (dx * dx + dz * dz > RANGED_HIT_DISTANCE * RANGED_HIT_DISTANCE) {
        const shot = SHOT_BY_DEF[source.defId] ?? SHOT_BY_TYPE[e.type] ?? 'shot.spine';
        this.spawnProjectile(shot, source.pos, e.pos);
        return; // The impact effect fires when the projectile lands.
      }
    }

    if (e.crit) {
      this.play('hit.crit', e.pos.x, e.pos.z, 1.8);
      return;
    }
    if (this.hitsThisFrame >= 18) return;
    this.hitsThisFrame++;
    this.play(HIT_BY_TYPE[e.type] ?? 'hit.physical', e.pos.x, e.pos.z, 1.2);
  }

  private unitService(): UnitService | null {
    // Gameplay modules join the engine after hero selection, long after this
    // module's init, so this cannot be resolved eagerly.
    if (!this.units) this.units = this.ctx.services.tryGet(UnitKey) ?? null;
    return this.units;
  }

  private culled(x: number, z: number): boolean {
    if (!this.render) {
      this.render = this.ctx.services.tryGet(RenderKey) ?? null;
      if (!this.render) return false;
    }
    this.render.camera.getWorldPosition(this.camPos);
    const dx = x - this.camPos.x;
    const dz = z - this.camPos.z;
    return dx * dx + dz * dz > CULL_DISTANCE * CULL_DISTANCE;
  }

  // ── Pool ───────────────────────────────────────────────────────────────────

  private acquire(soft: boolean): GroundFx | null {
    let free: GroundFx | null = null;
    let oldest: GroundFx | null = null;
    let used = 0;
    const cap = soft ? GROUND_DECAL : GROUND_LIGHT;
    for (const fx of this.fx) {
      if (!fx.active) {
        if (!free) free = fx;
        continue;
      }
      if (fx.soft !== soft) continue;
      used++;
      // Residue is long-lived by design; the oldest of it is the one to reuse.
      if (!oldest || fx.life / fx.maxLife < oldest.life / oldest.maxLife) oldest = fx;
    }
    if (used < cap && free) return free;
    return oldest;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  update(dt: number): void {
    this.time += dt;
    this.hitsThisFrame = 0;
    this.lightGround.setTime(this.time);
    this.decalGround.setTime(this.time);
    this.beams.setTime(this.time);

    this.particles.begin();
    this.lightGround.begin();
    this.decalGround.begin();

    if (this.demo) this.runDemo(dt);

    // Booked layers first, so anything that comes due this frame is drawn on it
    // rather than one frame late — at a 0.1 s wind-up, one frame is a sixth of
    // the anticipation.
    if (playback.fastForward) this.clearPending();
    else this.stepPending(dt);

    this.shots.update(dt);
    this.beams.update(dt, this.particles);
    this.stepGround(dt);
    this.particles.simulate(dt);

    this.particles.end();
    this.lightGround.end();
    this.decalGround.end();
    this.beams.end();
  }

  private stepGround(dt: number): void {
    for (const fx of this.fx) {
      if (!fx.active) continue;
      fx.life -= dt;
      if (fx.life <= 0) {
        fx.active = false;
        // A telegraph that simply vanishes reads as a bug; it detonates instead.
        if (fx.kind === FX_TELEGRAPH && fx.flash === 0) this.armTelegraphFlash(fx);
        continue;
      }
      fx.yaw += fx.spin * dt;
      const t = 1 - fx.life / fx.maxLife;
      const batch = fx.soft ? this.decalGround : this.lightGround;

      if (fx.kind === FX_SHAPE) {
        const spec = fx.spec!;
        // `delay` is expressed as a fraction of the shape's own life, which is
        // how one authored effect gets a leading and a trailing ring.
        const local = fx.delay > 0 ? (t - fx.delay) / (1 - fx.delay) : t;
        if (local <= 0) continue;
        const alpha = curveAt(spec.alpha, local, 1);
        if (alpha <= 0.002) continue;
        const size = typeof spec.size === 'function' ? spec.size(local) : null;
        const half = size === null ? fx.halfX : fx.scale * size;
        batch.push(
          fx.x,
          fx.soft ? LIFT_DECAL : LIFT_LIGHT,
          fx.z,
          half,
          half,
          fx.yaw,
          fx.r,
          fx.g,
          fx.b,
          alpha,
          fx.shape,
          curveAt(spec.p0, local),
          curveAt(spec.p1, local),
          curveAt(spec.p2, local),
          fx.layer,
        );
        continue;
      }

      if (fx.kind === FX_DECAL) {
        // Residue fades in fast and lingers, then dissolves over its last third
        // instead of blinking out.
        const fadeIn = Math.min(1, t / 0.06);
        const fadeOut = t > 0.66 ? 1 - (t - 0.66) / 0.34 : 1;
        batch.push(
          fx.x,
          LIFT_DECAL,
          fx.z,
          fx.halfX,
          fx.halfZ,
          fx.yaw,
          fx.r,
          fx.g,
          fx.b,
          fx.alpha * fadeIn * fadeOut,
          GSHAPE.decal,
          fx.p0,
          0,
          0,
          fx.layer,
        );
        continue;
      }

      // Telegraph: the outline is constant so the danger zone is never ambiguous,
      // and the fill sweeps to zero-hour so the player can read *when*, not just
      // *where*. Both are the point of a telegraph.
      const flash = fx.flash > 0;
      const sweep = flash ? 1 : t;
      // The fill is a *tint*, never a coat of paint. A telegraph that reaches
      // full opacity hides the units standing in it, which is the opposite of
      // its job; only the outline is allowed to be solid.
      const fill = flash ? 0.2 : 0.16 + 0.24 * t;
      const alpha = flash ? fx.life / fx.maxLife : Math.min(1, t / 0.1) * (0.5 + 0.35 * t);

      // Every shape reads these three parameters differently (see `GSHAPE`).
      // Pushing (sweep, sweep, fill) for all of them was the bug behind the
      // blown-out ground blobs: for a ring it set the band half-width equal to
      // the radius — a filled disc — and hid all but a narrow wedge of it, and
      // for a circle it drove the *fill opacity* to 1.0, painting the terrain
      // out entirely. Only cone/line/cross ever matched that layout.
      let p0 = sweep;
      let p1 = sweep;
      let p2 = fill;
      switch (fx.shape) {
        case GSHAPE.ring:
          // p0 radius, p1 band half-width, p2 angular reveal.
          p1 = Math.min(0.05, sweep * 0.4);
          p2 = 1;
          break;
        case GSHAPE.disc:
          // p0 fill opacity, p1 radial sweep.
          p0 = fill;
          p2 = 0;
          break;
        case GSHAPE.cone:
        case GSHAPE.cross:
          // p0 is the authored half angle / half width; the sweep drives p1.
          p0 = fx.p0;
          break;
        default:
          // Line: p1 length sweep, p2 fill. p0 is unused.
          break;
      }

      batch.push(
        fx.x,
        LIFT_LIGHT,
        fx.z,
        fx.halfX,
        fx.halfZ,
        fx.yaw,
        fx.r,
        fx.g,
        fx.b,
        alpha,
        fx.shape,
        p0,
        p1,
        p2,
        fx.layer,
      );
    }
  }

  /** A replay jumps minutes in a moment; every booked beat would land at once. */
  private clearPending(): void {
    for (const p of this.pending) {
      p.active = false;
      p.shape = null;
      p.burst = null;
      p.residue = null;
    }
  }

  private armTelegraphFlash(from: GroundFx): void {
    const fx = this.acquire(false);
    if (!fx) return;
    fx.active = true;
    fx.kind = FX_TELEGRAPH;
    fx.spec = null;
    fx.life = 0.16;
    fx.maxLife = 0.16;
    fx.delay = 0;
    fx.x = from.x;
    fx.z = from.z;
    fx.scale = from.scale;
    fx.halfX = from.halfX;
    fx.halfZ = from.halfZ;
    fx.yaw = from.yaw;
    fx.spin = 0;
    // The flash is the one additive frame of a telegraph: zero hour, and the
    // only moment it is allowed over the bloom threshold. It reads through the
    // *outline* snapping bright, not through a filled disc — an additive fill
    // at this size is a light source the width of the danger zone, which is
    // precisely the white blob that swallowed the buildings around it.
    fx.r = from.r * 1.25;
    fx.g = from.g * 1.25;
    fx.b = from.b * 1.25;
    fx.shape = from.shape;
    fx.p0 = from.p0;
    fx.alpha = 1;
    fx.soft = false;
    fx.layer = from.layer;
    fx.flash = 1;
  }

  // ── QA demo loop ───────────────────────────────────────────────────────────

  private demo = false;
  private demoTimer = 0;
  private demoIndex = 0;

  /**
   * Cycles the catalogue around the player's hero. Presentation only, enabled by
   * `?vfxdemo=1`, and never on in a normal session: it exists so a screenshot
   * can catch a 0.4 s impact.
   */
  private runDemo(dt: number): void {
    this.demoTimer -= dt;
    if (this.demoTimer > 0) return;
    this.demoTimer = 0.55;

    const units = this.unitService();
    let cx = 0;
    let cz = 0;
    for (const hero of this.ctx.match.heroes.values()) {
      cx = hero.pos.x;
      cz = hero.pos.z;
      break;
    }
    const i = this.demoIndex++;
    const ang = i * 1.1;
    const x = cx + Math.cos(ang) * 9;
    const z = cz + Math.sin(ang) * 9;
    void units;

    switch (i % 8) {
      case 0:
        this.play('impact.slam', x, z, 5.2);
        break;
      case 1:
        this.play('aura.frost', cx, cz, 9);
        break;
      case 2:
        this.spawnProjectile('shot.arcane', { x: cx - 16, z: cz - 12 }, { x, z });
        this.spawnProjectile('shot.hex', { x: cx + 15, z: cz - 14 }, { x: cx, z: cz + 4 });
        break;
      case 3:
        this.play('bolt.arcane', x, z, 2.4);
        break;
      case 4:
        this.spawnBeam('beam.arcane', { x: cx, z: cz }, { x: cx + 14, z: cz + 9 }, 0.8);
        this.spawnBeam('beam.holy', { x: cx, z: cz }, { x: cx - 13, z: cz + 11 }, 0.8);
        break;
      case 5:
        this.spawnTelegraph('circle', { x: cx + 8, z: cz - 8 }, 6, 1.6, 0xff5a3c);
        this.spawnTelegraph(`cone:70@${(ang % 6.28).toFixed(2)}`, { x: cx, z: cz }, 13, 1.8, 0xff8a3c);
        this.spawnTelegraph('line@0.6', { x: cx - 10, z: cz + 6 }, 12, 1.6, 0xffd23c);
        break;
      case 6:
        this.play('aura.shout', cx, cz, 8);
        this.play('aura.guard', cx + 4, cz + 3, 3);
        break;
      default:
        this.play('impact.nova', cx, cz, 13);
        break;
    }
  }

  counts(): { glow: number; soft: number; light: number; decal: number; beams: number } {
    return {
      glow: this.particles.glow.drawn,
      soft: this.particles.soft.drawn,
      light: this.lightGround.drawn,
      decal: this.decalGround.drawn,
      beams: this.beams.drawn,
    };
  }

  dispose(): void {
    this.particles.dispose();
    this.lightGround.dispose();
    this.decalGround.dispose();
    this.beams.dispose();
    this.sprites.dispose();
    this.decals.dispose();
    this.height.dispose();
    this.root.removeFromParent();
  }
}

export function createVfxModules(): GameModule[] {
  return [new VfxModule()];
}
