/**
 * Hero and boss rendering. Owner: CHARACTERS agent.
 *
 * Heroes get a real `THREE.SkinnedMesh` with their own skeleton — they are few,
 * they need clip blending, per-bone hit reactions and cloth dynamics, and they
 * are the units the camera actually looks at. Creeps take the instanced VAT path
 * instead (see `render/creepBatch.ts`).
 *
 * Also owns the weapon trail: a screen-facing ribbon built from the recent
 * history of the weapon's tip, which is what makes a swing read as a swing
 * rather than as a shape rotating.
 */

import * as THREE from 'three';
import { Animator } from '../anim/animator';
import type { ClipId } from '../anim/clips';
import type { BuiltCharacter } from '../catalog';
import { cloneRig } from '../rig/rig';

export interface TrailSpec {
  bone: string;
  /** Weapon-local offsets, in the bone's space. */
  base: [number, number, number];
  tip: [number, number, number];
  color: number;
  /** Clips during which the trail is emitted. */
  clips: ClipId[];
}

const TRAIL_SEGMENTS = 14;

export class HeroView {
  readonly group = new THREE.Group();
  readonly animator: Animator;
  readonly mesh: THREE.SkinnedMesh;

  private trail?: {
    mesh: THREE.Mesh;
    positions: Float32Array;
    colors: Float32Array;
    history: Float32Array;
    filled: number;
    spec: TrailSpec;
    boneIndex: number;
    strength: number;
  };

  constructor(built: BuiltCharacter, scale = 1, phase = 0, trailSpec?: TrailSpec) {
    const rig = cloneRig(built.rig);
    this.animator = new Animator(rig, built.def.profile, phase);

    this.mesh = new THREE.SkinnedMesh(built.geometry, built.materials);
    this.mesh.name = built.def.id;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // The rest-pose bounds are too tight once a death animation sprawls; pad so
    // the mesh is not culled mid-clip.
    if (built.geometry.boundingSphere) {
      this.mesh.boundingSphere = built.geometry.boundingSphere.clone();
      this.mesh.boundingSphere.radius *= 1.9;
    }

    this.group.add(rig.root);
    this.group.add(this.mesh);
    this.group.scale.setScalar(scale);
    this.mesh.bind(rig.skeleton, new THREE.Matrix4());

    if (trailSpec) this.buildTrail(trailSpec, rig.index[trailSpec.bone]);
  }

  private buildTrail(spec: TrailSpec, boneIndex: number | undefined): void {
    if (boneIndex === undefined) return;
    const positions = new Float32Array(TRAIL_SEGMENTS * 2 * 3);
    const colors = new Float32Array(TRAIL_SEGMENTS * 2 * 3);
    const indices: number[] = [];
    for (let i = 0; i < TRAIL_SEGMENTS - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 8);

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.group.add(mesh);

    this.trail = {
      mesh,
      positions,
      colors,
      history: new Float32Array(TRAIL_SEGMENTS * 6),
      filled: 0,
      spec,
      boneIndex,
      strength: 0,
    };
  }

  play(clip: ClipId, fade = 0.18): void {
    this.animator.play(clip, fade);
  }

  setSpeed(speed: number): void {
    this.animator.setSpeed(speed);
  }

  update(dt: number): void {
    this.animator.update(dt);
    this.updateTrail(dt);
  }

  private updateTrail(dt: number): void {
    const t = this.trail;
    if (!t) return;

    const active = t.spec.clips.includes(this.animator.clip) && !this.animator.isFinished;
    t.strength = active
      ? Math.min(1, t.strength + dt * 9)
      : Math.max(0, t.strength - dt * 4.5);
    if (t.strength <= 0.001) {
      t.mesh.visible = false;
      t.filled = 0;
      return;
    }
    t.mesh.visible = true;

    const bone = this.animator.rig.bones[t.boneIndex]!;
    _base.set(t.spec.base[0], t.spec.base[1], t.spec.base[2]).applyMatrix4(bone.matrixWorld);
    _tip.set(t.spec.tip[0], t.spec.tip[1], t.spec.tip[2]).applyMatrix4(bone.matrixWorld);

    // Push the newest sample onto the front and shift the history back.
    t.history.copyWithin(6, 0, (TRAIL_SEGMENTS - 1) * 6);
    t.history[0] = _base.x;
    t.history[1] = _base.y;
    t.history[2] = _base.z;
    t.history[3] = _tip.x;
    t.history[4] = _tip.y;
    t.history[5] = _tip.z;
    t.filled = Math.min(TRAIL_SEGMENTS, t.filled + 1);

    _color.setHex(t.spec.color, THREE.SRGBColorSpace);
    for (let i = 0; i < TRAIL_SEGMENTS; i++) {
      const src = Math.min(i, t.filled - 1) * 6;
      const dst = i * 6;
      for (let k = 0; k < 6; k++) t.positions[dst + k] = t.history[src + k]!;
      // Fade to black along the tail; additive blending turns that into alpha.
      const fade = Math.pow(1 - i / (TRAIL_SEGMENTS - 1), 1.7) * t.strength;
      const ci = i * 6;
      t.colors[ci] = _color.r * fade * 0.35;
      t.colors[ci + 1] = _color.g * fade * 0.35;
      t.colors[ci + 2] = _color.b * fade * 0.35;
      t.colors[ci + 3] = _color.r * fade;
      t.colors[ci + 4] = _color.g * fade;
      t.colors[ci + 5] = _color.b * fade;
    }
    (t.mesh.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (t.mesh.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    if (this.trail) {
      this.trail.mesh.geometry.dispose();
      (this.trail.mesh.material as THREE.Material).dispose();
    }
  }
}

const _base = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _color = new THREE.Color();
