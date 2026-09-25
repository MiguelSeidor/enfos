/**
 * Pooled projectiles. Owner: VFX.
 *
 * A projectile here is *presentation only*: a head, a trail and an impact. It
 * carries no damage and hits nothing — gameplay has already resolved the shot by
 * the time one of these is fired. That split is deliberate: a visual that owned
 * damage would have to run in `fixedUpdate` at 30 Hz and would jitter at display
 * rate, and a visual that can miss would desync from the simulation.
 *
 * Costs zero extra draw calls. The head is pushed straight into the additive
 * sprite batch each frame and the trail is ordinary pooled particles, so forty
 * arrows in flight are still the same two draws as one.
 *
 * The flight path is a straight line with a ballistic lift rather than true
 * physics. A bolt that visibly arcs over the creep in front of its target is what
 * makes ranged combat readable from an RTS camera; solving for a real launch
 * angle would buy nothing a reviewer could see.
 */

import { BLEND_GLOW, BLEND_SOFT, linearOf, type ParticleSystem } from './quads';
import type { ProjectileSpec } from './specs';
import { SPRITE } from './sprites';
import { visualRng } from '@/core/rng';

interface Shot {
  active: boolean;
  spec: ProjectileSpec | null;
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  /** Progress along the path, 0..1. */
  u: number;
  /** 1 / flight time. */
  rate: number;
  /** Distance accumulator for even trail spacing. */
  trail: number;
  length: number;
  rot: number;
  /** Current position, kept so the trail and the impact agree. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  color: [number, number, number];
  trailColor: [number, number, number];
}

function blankShot(): Shot {
  return {
    active: false,
    spec: null,
    x0: 0,
    y0: 0,
    z0: 0,
    x1: 0,
    y1: 0,
    z1: 0,
    u: 0,
    rate: 1,
    trail: 0,
    length: 1,
    rot: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    color: [1, 1, 1],
    trailColor: [1, 1, 1],
  };
}

export type ImpactHandler = (vfxId: string, x: number, z: number, scale: number) => void;

export class ProjectileSystem {
  private readonly shots: Shot[] = [];
  private cursor = 0;

  constructor(
    capacity: number,
    private readonly particles: ParticleSystem,
    private readonly onImpact: ImpactHandler,
  ) {
    for (let i = 0; i < capacity; i++) this.shots.push(blankShot());
  }

  fire(
    spec: ProjectileSpec,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    speed: number,
  ): void {
    const shot = this.acquire();
    const dx = x1 - x0;
    const dz = z1 - z0;
    const dy = y1 - y0;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 0.05) {
      // Point-blank: skip the flight entirely and land it now, rather than
      // spawning a projectile that would live for one frame at zero length.
      this.onImpact(spec.impact, x1, z1, 1.3);
      return;
    }

    shot.active = true;
    shot.spec = spec;
    shot.x0 = x0;
    shot.y0 = y0;
    shot.z0 = z0;
    shot.x1 = x1;
    shot.y1 = y1;
    shot.z1 = z1;
    shot.u = 0;
    shot.length = length;
    shot.rate = Math.max(0.2, speed) / length;
    shot.trail = 0;
    shot.rot = visualRng.next() * Math.PI * 2;
    shot.x = x0;
    shot.y = y0;
    shot.z = z0;
    shot.vx = 0;
    shot.vy = 0;
    shot.vz = 0;
    shot.color = linearOf(spec.color);
    shot.trailColor = linearOf(spec.colorTrail);
  }

  private acquire(): Shot {
    const n = this.shots.length;
    for (let k = 0; k < n; k++) {
      const shot = this.shots[(this.cursor + k) % n];
      if (!shot.active) {
        this.cursor = (this.cursor + k + 1) % n;
        return shot;
      }
    }
    // Saturated: recycle at the cursor, which is the oldest region of the ring.
    const shot = this.shots[this.cursor];
    this.cursor = (this.cursor + 1) % n;
    return shot;
  }

  /**
   * Advances every live shot, writes its head into the additive batch and lays
   * down trail particles at a fixed *spatial* interval — not a fixed time
   * interval, so a fast bolt and a slow orb leave the same continuous ribbon
   * instead of the fast one leaving a dotted line.
   */
  update(dt: number): void {
    // Trail density backs off once a lot is in the air. Forty ranged creeps all
    // firing would otherwise spend the whole particle pool on trails and leave
    // nothing for the impacts, which are the part the player actually reads.
    let live = 0;
    for (const shot of this.shots) if (shot.active) live++;
    const spacing = live > 40 ? 3 : live > 20 ? 2 : 1;

    for (const shot of this.shots) {
      if (!shot.active) continue;
      const spec = shot.spec!;

      const prevX = shot.x;
      const prevY = shot.y;
      const prevZ = shot.z;

      shot.u += shot.rate * dt;
      const landed = shot.u >= 1;
      const u = landed ? 1 : shot.u;

      // Ballistic lift, peaking at mid-flight and scaled by the range so a
      // short shot does not lob like a mortar.
      const lift = spec.arc * Math.min(2.4, shot.length * 0.09) * 4 * u * (1 - u);
      shot.x = shot.x0 + (shot.x1 - shot.x0) * u;
      shot.y = shot.y0 + (shot.y1 - shot.y0) * u + lift;
      shot.z = shot.z0 + (shot.z1 - shot.z0) * u;

      const inv = dt > 1e-5 ? 1 / dt : 0;
      shot.vx = (shot.x - prevX) * inv;
      shot.vy = (shot.y - prevY) * inv;
      shot.vz = (shot.z - prevZ) * inv;
      shot.rot += (spec.spin ?? 0) * dt;

      // Trail: step along the segment covered this frame.
      const step = Math.hypot(shot.x - prevX, shot.y - prevY, shot.z - prevZ);
      shot.trail += step;
      const soft = spec.trailLayer === SPRITE.smoke;
      const trailStep = spec.trailStep * spacing;
      while (shot.trail >= trailStep && step > 1e-4) {
        shot.trail -= trailStep;
        const back = shot.trail / step;
        const j = spec.trailJitter;
        this.particles.emit(
          soft ? BLEND_SOFT : BLEND_GLOW,
          spec.trailLayer,
          shot.x + (prevX - shot.x) * back + (visualRng.next() - 0.5) * j,
          shot.y + (prevY - shot.y) * back + (visualRng.next() - 0.5) * j,
          shot.z + (prevZ - shot.z) * back + (visualRng.next() - 0.5) * j,
          (visualRng.next() - 0.5) * 0.6,
          (visualRng.next() - 0.2) * 0.5,
          (visualRng.next() - 0.5) * 0.6,
          visualRng.range(spec.trailLife[0], spec.trailLife[1]),
          visualRng.range(spec.trailSize[0], spec.trailSize[1]),
          spec.trailSize[0] * (soft ? 2.2 : 0.25),
          shot.trailColor,
          soft ? 0.38 : spec.intensity * 0.5,
          soft ? 0.14 : 0,
          soft ? 1.6 : 2.4,
          0,
          0,
          soft ? 0.4 : 1,
        );
      }

      if (landed) {
        shot.active = false;
        this.onImpact(spec.impact, shot.x1, shot.z1, 1.4);
        continue;
      }

      // Head. Fades in over the first metre so it does not pop out of the caster.
      const emerge = Math.min(1, (shot.u * shot.length) / 0.8);
      this.particles.glow.push(
        shot.x,
        shot.y,
        shot.z,
        spec.size,
        shot.rot,
        shot.color[0] * spec.intensity,
        shot.color[1] * spec.intensity,
        shot.color[2] * spec.intensity,
        emerge,
        spec.layer,
        shot.vx,
        shot.vy,
        shot.vz,
        spec.stretch,
      );
    }
  }

  get live(): number {
    let n = 0;
    for (const shot of this.shots) if (shot.active) n++;
    return n;
  }

  clear(): void {
    for (const shot of this.shots) shot.active = false;
  }
}
