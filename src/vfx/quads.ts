/**
 * Billboard particle renderer and pool. Owner: VFX.
 *
 * One `InstancedBufferGeometry` per blend mode, rebuilt on the CPU every frame
 * and uploaded as five tightly packed attribute arrays. Two draw calls cover
 * every spark, ember, shard, dust puff and projectile head in the game, which is
 * the only way 40 ranged creeps and a boss nova can share a 700-call budget.
 *
 * Two blend modes, not one:
 *
 * - **glow** (additive) — anything that emits light. Colours are allowed above
 *   1.0 so the bloom threshold at 1.05 picks out cores and leaves the rest alone.
 * - **soft** (alpha) — dust and smoke. Additive smoke reads as glowing gas; a
 *   physical slam needs particles that *darken* the ground behind them.
 *
 * Particles are a fixed pre-allocated array with an O(1) free list, so a burst
 * never allocates (GDD §18). Exhaustion recycles the oldest particle rather than
 * dropping the newest — a late burst is the one the player is looking at.
 */

import * as THREE from 'three';
import { visualRng } from '@/core/rng';
import { SPRITE_COUNT } from './sprites';

export const BLEND_GLOW = 0;
export const BLEND_SOFT = 1;

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec3 iColor;
attribute vec4 iParams;   // x size, y rotation, z alpha, w velocity stretch
attribute float iLayer;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vLayer;

void main() {
  vUv = uv;
  vColor = iColor;
  vAlpha = iParams.z;
  vLayer = iLayer;

  // Rows of the view matrix are the camera basis in world space.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camFwd   = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);

  float c = cos(iParams.y);
  float s = sin(iParams.y);
  vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c);

  vec3 right = camRight;
  vec3 up = camUp;

  // Velocity stretch. A tracer that stays a round dot reads as a floating bead;
  // elongating it along its own motion is what makes it read as speed.
  float stretch = iParams.w;
  float vl = length(iVel);
  if (stretch > 0.001 && vl > 0.0001) {
    vec3 dir = iVel / vl;
    vec3 side = cross(dir, camFwd);
    float sl = length(side);
    // Near-parallel to the view axis the side vector collapses; fall back to a
    // plain billboard rather than producing a degenerate sliver.
    if (sl > 0.15) {
      right = side / sl;
      up = dir * (1.0 + stretch);
      p = position.xy;
    }
  }

  vec3 world = iPos + (right * p.x + up * p.y) * iParams.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uAtlas;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vLayer;

void main() {
  vec4 t = texture(uAtlas, vec3(vUv, vLayer));
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * t.rgb, a);
}
`;

/** One instanced draw of camera-facing quads. */
export class QuadBatch {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly color: Float32Array;
  private readonly params: Float32Array;
  private readonly layer: Float32Array;
  private readonly attributes: THREE.InstancedBufferAttribute[];
  private cursor = 0;

  constructor(
    readonly capacity: number,
    atlas: THREE.DataArrayTexture,
    blending: THREE.Blending,
    renderOrder: number,
  ) {
    const base = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.getAttribute('position'));
    geometry.setAttribute('uv', base.getAttribute('uv'));
    base.dispose();

    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    this.layer = new Float32Array(capacity);

    const aPos = new THREE.InstancedBufferAttribute(this.pos, 3);
    const aVel = new THREE.InstancedBufferAttribute(this.vel, 3);
    const aColor = new THREE.InstancedBufferAttribute(this.color, 3);
    const aParams = new THREE.InstancedBufferAttribute(this.params, 4);
    const aLayer = new THREE.InstancedBufferAttribute(this.layer, 1);
    this.attributes = [aPos, aVel, aColor, aParams, aLayer];
    for (const a of this.attributes) a.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('iPos', aPos);
    geometry.setAttribute('iVel', aVel);
    geometry.setAttribute('iColor', aColor);
    geometry.setAttribute('iParams', aParams);
    geometry.setAttribute('iLayer', aLayer);
    geometry.instanceCount = 0;
    // The bounding sphere is meaningless for a buffer rewritten every frame;
    // culling is disabled on the mesh instead.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geometry;

    const material = new THREE.ShaderMaterial({
      uniforms: { uAtlas: { value: atlas } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
  }

  begin(): void {
    this.cursor = 0;
  }

  /** Appends one quad for this frame. Silently drops past capacity. */
  push(
    x: number,
    y: number,
    z: number,
    size: number,
    rot: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
    spriteLayer: number,
    vx: number,
    vy: number,
    vz: number,
    stretch: number,
  ): void {
    const i = this.cursor;
    if (i >= this.capacity) return;
    const i3 = i * 3;
    const i4 = i * 4;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.color[i3] = r;
    this.color[i3 + 1] = g;
    this.color[i3 + 2] = b;
    this.params[i4] = size;
    this.params[i4 + 1] = rot;
    this.params[i4 + 2] = alpha;
    this.params[i4 + 3] = stretch;
    this.layer[i] = spriteLayer < SPRITE_COUNT ? spriteLayer : 0;
    this.cursor = i + 1;
  }

  end(): void {
    this.geometry.instanceCount = this.cursor;
    if (this.cursor === 0) return;
    for (const a of this.attributes) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.cursor * a.itemSize);
      a.needsUpdate = true;
    }
  }

  get drawn(): number {
    return this.cursor;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// Particle pool
// ---------------------------------------------------------------------------

interface Particle {
  active: boolean;
  blend: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  drag: number;
  life: number;
  maxLife: number;
  size0: number;
  size1: number;
  r0: number;
  g0: number;
  b0: number;
  r1: number;
  g1: number;
  b1: number;
  alpha: number;
  fadeIn: number;
  rot: number;
  spin: number;
  layer: number;
  stretch: number;
  /** Particles stop at this height instead of sinking into the terrain. */
  floor: number;
}

function blankParticle(): Particle {
  return {
    active: false,
    blend: BLEND_GLOW,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    gravity: 0,
    drag: 0,
    life: 0,
    maxLife: 1,
    size0: 1,
    size1: 1,
    r0: 1,
    g0: 1,
    b0: 1,
    r1: 1,
    g1: 1,
    b1: 1,
    alpha: 1,
    fadeIn: 0.1,
    rot: 0,
    spin: 0,
    layer: 0,
    stretch: 0,
    floor: -Infinity,
  };
}

/** Everything a burst needs to know. Authored in `specs.ts`. */
export interface BurstSpec {
  count: number;
  layer: number;
  blend?: number;
  /** Spawn radius as a fraction of the effect scale. 0 = point source. */
  ring?: number;
  ringJitter?: number;
  /** Spawn height above the ground, in world units. */
  y?: number;
  yJitter?: number;
  /** Radial speed range. */
  speed?: [number, number];
  /** Vertical speed range. */
  rise?: [number, number];
  /** Tangential speed range — the difference between a burst and a vortex. */
  swirl?: [number, number];
  size: [number, number];
  /** Size multiplier at end of life. */
  sizeEnd?: number;
  life: [number, number];
  color: number;
  colorEnd?: number;
  /** Colour multiplier; above ~1.05 the effect crosses the bloom threshold. */
  intensity?: number;
  intensityEnd?: number;
  gravity?: number;
  drag?: number;
  spin?: [number, number];
  stretch?: number;
  fadeIn?: number;
  alpha?: number;
  /** 0 = spread over the full circle, 1 = tight cone along the facing. */
  focus?: number;
}

const linearCache = new Map<number, [number, number, number]>();
const tmpColor = new THREE.Color();

/**
 * Hex colours are authored as sRGB the way an artist reads them; the scene
 * renders in linear HDR. Converting once and caching keeps the burst path free
 * of per-particle colour maths.
 */
export function linearOf(hex: number): [number, number, number] {
  let c = linearCache.get(hex);
  if (!c) {
    tmpColor.setHex(hex, THREE.SRGBColorSpace);
    c = [tmpColor.r, tmpColor.g, tmpColor.b];
    linearCache.set(hex, c);
  }
  return c;
}

export class ParticleSystem {
  readonly glow: QuadBatch;
  readonly soft: QuadBatch;
  private readonly particles: Particle[] = [];
  private next = 0;

  constructor(atlas: THREE.DataArrayTexture, glowCapacity: number, softCapacity: number) {
    this.glow = new QuadBatch(glowCapacity, atlas, THREE.AdditiveBlending, 12);
    this.soft = new QuadBatch(softCapacity, atlas, THREE.NormalBlending, 11);
    const total = glowCapacity + softCapacity;
    for (let i = 0; i < total; i++) this.particles.push(blankParticle());
  }

  addTo(parent: THREE.Object3D): void {
    parent.add(this.soft.mesh);
    parent.add(this.glow.mesh);
  }

  batch(blend: number): QuadBatch {
    return blend === BLEND_SOFT ? this.soft : this.glow;
  }

  private acquire(): Particle {
    const n = this.particles.length;
    for (let k = 0; k < n; k++) {
      const p = this.particles[(this.next + k) % n];
      if (!p.active) {
        this.next = (this.next + k + 1) % n;
        return p;
      }
    }
    // Fully saturated: recycle where the cursor happens to be. That is the
    // oldest region of the ring, so the newest burst still shows.
    const p = this.particles[this.next];
    this.next = (this.next + 1) % n;
    return p;
  }

  /**
   * Fires one burst. `facing` is the yaw the cone points along when
   * `spec.focus > 0`; `scale` is the effect radius in world units.
   */
  burst(
    spec: BurstSpec,
    x: number,
    groundY: number,
    z: number,
    scale: number,
    facing: number,
    budget = 1,
  ): void {
    const rng = visualRng;
    const count = Math.max(1, Math.round(spec.count * budget));
    const blend = spec.blend ?? BLEND_GLOW;
    const c0 = linearOf(spec.color);
    const c1 = linearOf(spec.colorEnd ?? spec.color);
    const i0 = spec.intensity ?? 1;
    const i1 = spec.intensityEnd ?? 0;
    const ring = spec.ring ?? 0;
    const ringJitter = spec.ringJitter ?? 0;
    const focus = spec.focus ?? 0;

    for (let i = 0; i < count; i++) {
      const p = this.acquire();
      // Even angular spread with a jitter beats pure random: a burst of eight
      // random angles clumps, and a clumped burst reads as a mistake.
      const spread = Math.PI * (1 - focus * 0.94);
      const even = (i + rng.next() * 0.7) / count;
      const ang = facing + (even * 2 - 1) * spread;
      const sa = Math.sin(ang);
      const ca = Math.cos(ang);

      const r = scale * (ring + (rng.next() - 0.5) * ringJitter);
      p.active = true;
      p.blend = blend;
      p.x = x + sa * r;
      p.z = z + ca * r;
      p.y = groundY + (spec.y ?? 0) + rng.next() * (spec.yJitter ?? 0);

      const sp = spec.speed ? rng.range(spec.speed[0], spec.speed[1]) : 0;
      const sw = spec.swirl ? rng.range(spec.swirl[0], spec.swirl[1]) : 0;
      p.vx = sa * sp + ca * sw;
      p.vz = ca * sp - sa * sw;
      p.vy = spec.rise ? rng.range(spec.rise[0], spec.rise[1]) : 0;

      p.gravity = spec.gravity ?? 0;
      p.drag = spec.drag ?? 0;
      p.maxLife = rng.range(spec.life[0], spec.life[1]);
      p.life = p.maxLife;
      p.size0 = rng.range(spec.size[0], spec.size[1]);
      p.size1 = p.size0 * (spec.sizeEnd ?? 1);
      p.r0 = c0[0] * i0;
      p.g0 = c0[1] * i0;
      p.b0 = c0[2] * i0;
      p.r1 = c1[0] * i1;
      p.g1 = c1[1] * i1;
      p.b1 = c1[2] * i1;
      p.alpha = spec.alpha ?? 1;
      p.fadeIn = spec.fadeIn ?? 0.12;
      p.rot = rng.next() * Math.PI * 2;
      p.spin = spec.spin ? rng.range(spec.spin[0], spec.spin[1]) : 0;
      p.layer = spec.layer;
      p.stretch = spec.stretch ?? 0;
      p.floor = groundY + 0.05;
    }
  }

  /** Single particle, for trails and one-off accents. */
  emit(
    blend: number,
    layer: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size0: number,
    size1: number,
    color: [number, number, number],
    intensity: number,
    intensityEnd: number,
    drag: number,
    gravity: number,
    stretch: number,
    alpha = 1,
  ): void {
    const p = this.acquire();
    p.active = true;
    p.blend = blend;
    p.x = x;
    p.y = y;
    p.z = z;
    p.vx = vx;
    p.vy = vy;
    p.vz = vz;
    p.gravity = gravity;
    p.drag = drag;
    p.life = life;
    p.maxLife = life;
    p.size0 = size0;
    p.size1 = size1;
    p.r0 = color[0] * intensity;
    p.g0 = color[1] * intensity;
    p.b0 = color[2] * intensity;
    p.r1 = color[0] * intensityEnd;
    p.g1 = color[1] * intensityEnd;
    p.b1 = color[2] * intensityEnd;
    p.alpha = alpha;
    p.fadeIn = 0.08;
    p.rot = visualRng.next() * Math.PI * 2;
    p.spin = 0;
    p.layer = layer;
    p.stretch = stretch;
    p.floor = -Infinity;
  }

  begin(): void {
    this.glow.begin();
    this.soft.begin();
  }

  /** Integrates every live particle and writes it into its batch. */
  simulate(dt: number): void {
    for (const p of this.particles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }

      const damping = p.drag > 0 ? Math.exp(-p.drag * dt) : 1;
      p.vx *= damping;
      p.vz *= damping;
      p.vy = p.vy * damping + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < p.floor) {
        p.y = p.floor;
        p.vy = 0;
        // Grounded debris slides to a halt instead of skating forever.
        p.vx *= 0.72;
        p.vz *= 0.72;
      }
      p.rot += p.spin * dt;

      const t = 1 - p.life / p.maxLife;
      const fade =
        t < p.fadeIn ? t / Math.max(1e-4, p.fadeIn) : 1 - (t - p.fadeIn) / Math.max(1e-4, 1 - p.fadeIn);
      const a = p.alpha * fade * fade;
      const size = p.size0 + (p.size1 - p.size0) * t;
      const r = p.r0 + (p.r1 - p.r0) * t;
      const g = p.g0 + (p.g1 - p.g0) * t;
      const b = p.b0 + (p.b1 - p.b0) * t;
      this.batch(p.blend).push(
        p.x,
        p.y,
        p.z,
        size,
        p.rot,
        r,
        g,
        b,
        a,
        p.layer,
        p.vx,
        p.vy,
        p.vz,
        p.stretch,
      );
    }
  }

  end(): void {
    this.glow.end();
    this.soft.end();
  }

  get live(): number {
    let n = 0;
    for (const p of this.particles) if (p.active) n++;
    return n;
  }

  clear(): void {
    for (const p of this.particles) p.active = false;
  }

  dispose(): void {
    this.glow.dispose();
    this.soft.dispose();
  }
}
