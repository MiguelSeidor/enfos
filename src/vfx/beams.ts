/**
 * Beams. Owner: VFX.
 *
 * One instanced draw for every beam on screen. Each instance is a quad stretched
 * between two world points and rolled around its own axis to face the camera, so
 * a beam is legible from any yaw without ever being a flat card that turns edge
 * on and disappears.
 *
 * The shape is a tapered core inside a wide soft glow, not a uniform tube. Three
 * things carry the read:
 *
 * - **Taper** — wide at the caster, narrow at the target. That is what gives a
 *   beam a direction; a constant-width bar reads as a bridge between two things
 *   rather than something being fired *at* one of them.
 * - **Scroll** — turbulence sampled along the beam and scrolled toward the
 *   target at a speed the eye can follow, so the beam reads as flowing energy
 *   instead of a static gradient.
 * - **Ends** — both tips fade over their last few percent, which hides the hard
 *   quad boundary and lets the muzzle and impact sparks own those points.
 *
 * Blending is additive with the core above the bloom threshold and the glow
 * below it: only the thin centre line blooms, which is the difference between a
 * laser and a smear across the frame (rubric §7).
 */

import * as THREE from 'three';
import { BLEND_GLOW, linearOf, type ParticleSystem } from './quads';
import { DECAL } from './sprites';
import { SPRITE } from './sprites';
import type { BeamSpec } from './specs';
import { visualRng } from '@/core/rng';

const VERT = /* glsl */ `
attribute vec3 iFrom;
attribute vec3 iTo;
attribute vec3 iColor;
attribute vec3 iCore;
attribute vec4 iParams;   // envelope half width, half width at source, at target, alpha
attribute vec2 iExtra;    // scroll speed, intensity

varying vec2 vLocal;      // x across (-1..1), y along (0..1)
varying vec3 vColor;
varying vec3 vCore;
varying vec4 vParams;
varying vec2 vExtra;

void main() {
  float along = position.y + 0.5;
  vLocal = vec2(position.x * 2.0, along);
  vColor = iColor;
  vCore = iCore;
  vParams = iParams;
  vExtra = iExtra;

  vec3 mid = mix(iFrom, iTo, along);
  vec3 axis = iTo - iFrom;
  float len = length(axis);
  vec3 dir = len > 0.0001 ? axis / len : vec3(0.0, 1.0, 0.0);

  // Roll the quad around the beam axis until its face points at the camera.
  vec3 view = normalize(cameraPosition - mid);
  vec3 side = cross(dir, view);
  float sl = length(side);
  // Looking straight down the beam the side vector collapses; any perpendicular
  // will do at that point, because the beam is a dot on screen anyway.
  side = sl > 0.001 ? side / sl : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));

  vec3 world = mid + side * (position.x * 2.0) * iParams.x;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uDecals;
uniform float uTime;
uniform float uGrainLayer;

varying vec2 vLocal;
varying vec3 vColor;
varying vec3 vCore;
varying vec4 vParams;
varying vec2 vExtra;

void main() {
  float across = vLocal.x;
  float along = vLocal.y;

  // Half width at this point along the beam, in the quad's own -1..1 space.
  float w = mix(vParams.y, vParams.z, along) / max(0.0001, vParams.x);
  float d = abs(across) / max(0.02, w);

  // The core is deliberately narrow: it is the only part of a beam allowed over
  // the bloom threshold, and a wide one turns into a white bar with no colour.
  float core = exp(-d * d * 9.0);
  float glow = exp(-d * d * 0.5) * 0.45;

  // Turbulence scrolled toward the target. Sampling in beam space rather than
  // screen space is what keeps the flow reading as travel along the beam.
  float n = texture(uDecals, vec3(fract(vec2(along * 2.2 - uTime * vExtra.x, across * 0.35 + 0.5)), uGrainLayer)).r;
  float flow = 0.72 + 0.5 * n;

  float ends = smoothstep(0.0, 0.05, along) * smoothstep(1.0, 0.9, along);
  float a = (core * flow + glow) * ends * vParams.w;
  if (a < 0.004) discard;

  vec3 col = mix(vColor, vCore, core) * vExtra.y;
  gl_FragColor = vec4(col, a);
}
`;

interface Beam {
  active: boolean;
  spec: BeamSpec | null;
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  life: number;
  maxLife: number;
  sparkDebt: number;
  color: [number, number, number];
  core: [number, number, number];
  spark: [number, number, number];
}

function blankBeam(): Beam {
  return {
    active: false,
    spec: null,
    x0: 0,
    y0: 0,
    z0: 0,
    x1: 0,
    y1: 0,
    z1: 0,
    life: 0,
    maxLife: 1,
    sparkDebt: 0,
    color: [1, 1, 1],
    core: [1, 1, 1],
    spark: [1, 1, 1],
  };
}

export class BeamSystem {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly from: Float32Array;
  private readonly to: Float32Array;
  private readonly color: Float32Array;
  private readonly core: Float32Array;
  private readonly params: Float32Array;
  private readonly extra: Float32Array;
  private readonly attributes: THREE.InstancedBufferAttribute[];
  private readonly beams: Beam[] = [];
  private cursor = 0;
  private drawnCount = 0;

  constructor(capacity: number, decals: THREE.DataArrayTexture, renderOrder: number) {
    const base = new THREE.PlaneGeometry(1, 1, 1, 12);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.getAttribute('position'));
    base.dispose();

    this.from = new Float32Array(capacity * 3);
    this.to = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);
    this.core = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    this.extra = new Float32Array(capacity * 2);

    const aFrom = new THREE.InstancedBufferAttribute(this.from, 3);
    const aTo = new THREE.InstancedBufferAttribute(this.to, 3);
    const aColor = new THREE.InstancedBufferAttribute(this.color, 3);
    const aCore = new THREE.InstancedBufferAttribute(this.core, 3);
    const aParams = new THREE.InstancedBufferAttribute(this.params, 4);
    const aExtra = new THREE.InstancedBufferAttribute(this.extra, 2);
    this.attributes = [aFrom, aTo, aColor, aCore, aParams, aExtra];
    for (const a of this.attributes) a.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('iFrom', aFrom);
    geometry.setAttribute('iTo', aTo);
    geometry.setAttribute('iColor', aColor);
    geometry.setAttribute('iCore', aCore);
    geometry.setAttribute('iParams', aParams);
    geometry.setAttribute('iExtra', aExtra);
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geometry;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uDecals: { value: decals },
        uTime: { value: 0 },
        uGrainLayer: { value: DECAL.grain },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;

    for (let i = 0; i < capacity; i++) this.beams.push(blankBeam());
  }

  get capacity(): number {
    return this.beams.length;
  }

  setTime(t: number): void {
    this.material.uniforms.uTime.value = t;
  }

  fire(
    spec: BeamSpec,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    duration: number,
  ): void {
    const beam = this.acquire();
    beam.active = true;
    beam.spec = spec;
    beam.x0 = x0;
    beam.y0 = y0;
    beam.z0 = z0;
    beam.x1 = x1;
    beam.y1 = y1;
    beam.z1 = z1;
    beam.life = duration;
    beam.maxLife = duration;
    beam.sparkDebt = 0;
    beam.color = linearOf(spec.color);
    beam.core = linearOf(spec.coreColor);
    beam.spark = linearOf(spec.sparkColor);
  }

  private acquire(): Beam {
    const n = this.beams.length;
    for (let k = 0; k < n; k++) {
      const beam = this.beams[(this.cursor + k) % n];
      if (!beam.active) {
        this.cursor = (this.cursor + k + 1) % n;
        return beam;
      }
    }
    const beam = this.beams[this.cursor];
    this.cursor = (this.cursor + 1) % n;
    return beam;
  }

  /**
   * Advances every live beam and writes its instance. Muzzle and impact sparks
   * are spawned here rather than by the caller so a beam is one call at the call
   * site and still has both ends alive.
   */
  update(dt: number, particles: ParticleSystem): void {
    this.drawnCount = 0;
    for (const beam of this.beams) {
      if (!beam.active) continue;
      beam.life -= dt;
      if (beam.life <= 0) {
        beam.active = false;
        continue;
      }
      const spec = beam.spec!;
      const t = 1 - beam.life / beam.maxLife;

      // Snap on, hold, then collapse. A symmetric fade makes a beam read as a
      // glow that happens to be long; the fast attack is what sells the fire.
      const envelope = t < 0.08 ? t / 0.08 : t > 0.72 ? 1 - (t - 0.72) / 0.28 : 1;
      // The core also thins as it dies, so the last frames are a filament.
      const thin = 0.35 + 0.65 * envelope;

      const i = this.drawnCount;
      if (i >= this.beams.length) break;
      const i3 = i * 3;
      const i4 = i * 4;
      const i2 = i * 2;
      this.from[i3] = beam.x0;
      this.from[i3 + 1] = beam.y0;
      this.from[i3 + 2] = beam.z0;
      this.to[i3] = beam.x1;
      this.to[i3 + 1] = beam.y1;
      this.to[i3 + 2] = beam.z1;
      this.color[i3] = beam.color[0];
      this.color[i3 + 1] = beam.color[1];
      this.color[i3 + 2] = beam.color[2];
      this.core[i3] = beam.core[0];
      this.core[i3 + 1] = beam.core[1];
      this.core[i3 + 2] = beam.core[2];
      // The envelope is generous: the soft glow needs room, and the quad is only
      // as expensive as the pixels the fragment shader keeps.
      this.params[i4] = Math.max(spec.widthFrom, spec.widthTo) * 4.5;
      this.params[i4 + 1] = spec.widthFrom * thin;
      this.params[i4 + 2] = spec.widthTo * thin;
      this.params[i4 + 3] = envelope;
      this.extra[i2] = spec.scroll;
      this.extra[i2 + 1] = spec.intensity;
      this.drawnCount = i + 1;

      // Endpoint sparks, rate-based so a long beam is not denser than a short one.
      beam.sparkDebt += spec.sparkRate * dt * envelope;
      while (beam.sparkDebt >= 1) {
        beam.sparkDebt -= 1;
        const atTarget = visualRng.next() < 0.65;
        const x = atTarget ? beam.x1 : beam.x0;
        const y = atTarget ? beam.y1 : beam.y0;
        const z = atTarget ? beam.z1 : beam.z0;
        const spread = atTarget ? 3.6 : 2.2;
        particles.emit(
          BLEND_GLOW,
          visualRng.next() < 0.4 ? SPRITE.shard : SPRITE.spark,
          x + (visualRng.next() - 0.5) * 0.3,
          y + (visualRng.next() - 0.5) * 0.3,
          z + (visualRng.next() - 0.5) * 0.3,
          (visualRng.next() - 0.5) * spread,
          visualRng.next() * spread * 0.8,
          (visualRng.next() - 0.5) * spread,
          visualRng.range(0.18, 0.42),
          visualRng.range(0.14, 0.32),
          0.04,
          beam.spark,
          spec.intensity,
          0,
          2.6,
          -3,
          0.5,
        );
      }
    }
  }

  end(): void {
    this.geometry.instanceCount = this.drawnCount;
    if (this.drawnCount === 0) return;
    for (const a of this.attributes) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.drawnCount * a.itemSize);
      a.needsUpdate = true;
    }
  }

  get drawn(): number {
    return this.drawnCount;
  }

  clear(): void {
    for (const beam of this.beams) beam.active = false;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
