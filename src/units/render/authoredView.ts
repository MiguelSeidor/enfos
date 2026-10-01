/**
 * Authored characters rendered as ordinary skinned meshes. Owner: CHARACTERS.
 *
 * This is deliberately the boring path: a cloned `SkinnedMesh`, an
 * `AnimationMixer`, and the artist's own clips. three does the skinning.
 *
 * It exists because the clever path did not work. Creeps normally render
 * through `CreepBatch`, which bakes poses into a vertex animation texture so a
 * whole wave costs a handful of draw calls. That bake is this project's own
 * code, and between 2026-09-29 and 2026-10-01 it failed four times in a row in
 * ways that produce no error and no warning: a texture wider than the GPU
 * accepts, a character scaled twice and left two centimetres tall, a geometry
 * with no draw groups that silently emitted no draw call at all, and root
 * motion baked into the clips so the mesh walked away from its own instance
 * transform. The skeleton was measured to be correct throughout -- all 136
 * bones animate, all 416 tracks of the walk clip resolve -- so the fault lay
 * entirely between a correct skeleton and the screen.
 *
 * Instancing is an optimisation. An optimisation that cannot be made to draw
 * the character is worth less than the slow version that can, so authored
 * creatures take this path and the procedural ones keep the batch. The cost is
 * one draw call and one skeleton update per creature; whether that holds at a
 * full wave is a measurement nobody has taken yet, and if it does not, the
 * answer is to fix the bake against something that already renders rather than
 * to debug it in the dark again.
 */

import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { ClipId } from '../anim/clips';
import type { AuthoredCharacter } from '../build/authoredCharacter';

/** Clips that repeat. Everything else runs once and holds its last frame. */
const LOOPING: ReadonlySet<ClipId> = new Set<ClipId>(['idle', 'walk', 'run']);

export class AuthoredView {
  readonly group = new THREE.Group();
  /** Mirrors `HeroView.animator` so `unitView` can treat both the same way. */
  readonly animator: { isFinished: boolean };

  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<ClipId, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private currentId: ClipId = 'idle';
  private remaining = 0;
  private readonly rootBone: THREE.Bone | null;
  private readonly rootRest = new THREE.Vector3();

  constructor(source: AuthoredCharacter, scale = 1, phase = 0) {
    // `SkeletonUtils.clone` is required rather than `Object3D.clone`: it rebuilds
    // the bone references so the copy drives its own skeleton. A plain clone
    // leaves every copy pointing at the original's bones, and the whole wave
    // animates as one creature.
    const root: THREE.Object3D = cloneSkinned(source.root);
    this.group.add(root);
    this.group.scale.setScalar(scale);

    let mesh: THREE.SkinnedMesh | null = null;
    root.traverse((o: THREE.Object3D) => {
      const s = o as THREE.SkinnedMesh;
      if (!s.isSkinnedMesh) return;
      if (!mesh) mesh = s;
      s.castShadow = true;
      s.receiveShadow = true;
      // Cull, but against a sphere with a lot of slack. The bind pose is a
      // standing figure and a death sprawls well outside it, so a tight sphere
      // would pop creeps out of view mid-clip. Three and a half times the rest
      // radius costs nothing and leaves no clip able to reach the edge, while
      // still skipping the draw and the skinning for everything off screen,
      // which is most of a wave most of the time.
      if (!s.geometry.boundingSphere) s.geometry.computeBoundingSphere();
      s.boundingSphere = s.geometry.boundingSphere!.clone();
      s.boundingSphere.radius *= 3.5;
    });

    this.mixer = new THREE.AnimationMixer(root);
    for (const [id, clip] of source.clips) {
      const action = this.mixer.clipAction(clip);
      const loops = LOOPING.has(id);
      action.setLoop(loops ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = !loops;
      this.actions.set(id, action);
    }

    // The root bone carries the clip's travel: the walk advances a stride, the
    // attack lunges. The simulation owns position, so pin the root horizontally
    // and let the animation play in place. Vertical is left alone, because a
    // death is supposed to drop.
    const bones = (mesh as THREE.SkinnedMesh | null)?.skeleton.bones ?? [];
    const boneSet = new Set<THREE.Object3D>(bones);
    this.rootBone = bones.find((b) => !b.parent || !boneSet.has(b.parent)) ?? bones[0] ?? null;
    if (this.rootBone) this.rootRest.copy(this.rootBone.position);

    this.animator = { isFinished: true };
    this.play('idle', 0);
    // De-phase the pack so a wave does not breathe in lockstep.
    this.mixer.update(phase * 1.7);
  }

  play(clip: ClipId, fade = 0.18): void {
    const next = this.actions.get(clip) ?? this.actions.get('idle');
    if (!next) return;
    const looping = LOOPING.has(clip);

    // A loop already running is left alone; retriggering it would snap the
    // cycle back to its first frame on every call.
    if (next === this.current && looping) return;

    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    if (this.current === next) {
      // Retriggering a one-shot that is already the current action. It must NOT
      // cross-fade, because cross-fading an action with itself schedules a fade
      // out and a fade in on the same weight: the weight collapses to zero and
      // the character vanishes for the length of the fade. That is the blink
      // seen on every attack after the first, when a second attack command
      // arrives while the first is still the current clip.
      next.play();
    } else if (this.current && fade > 0) {
      this.current.crossFadeTo(next, fade, false);
      next.play();
    } else {
      if (this.current) this.current.stop();
      next.play();
    }

    this.current = next;
    this.currentId = clip;
    this.remaining = looping ? Infinity : next.getClip().duration;
    this.animator.isFinished = looping;
  }

  /**
   * Plays locomotion at the pace the unit is actually travelling, so the feet
   * stay with the ground instead of skating over it.
   *
   * The references are the speed each clip was authored for, derived from its
   * own stride: on the orc the walk's feet separate by at most 0.78 m over a
   * 2.42 s cycle of two steps, which is 0.64 m/s, and the run reaches 1.60 m
   * for 1.32 m/s. These are close to universal for humanoid clips because they
   * come from anatomy rather than from this file, but a creature with a very
   * different gait will need its own numbers.
   *
   * The ceiling is deliberately high. A creep moving at 3.5 m/s needs its run
   * driven at well over double speed, and a clamp that refuses is a clamp that
   * chooses gliding.
   */
  setSpeed(speed: number): void {
    if (!this.current) return;
    if (this.currentId !== 'walk' && this.currentId !== 'run') {
      this.current.timeScale = 1;
      return;
    }
    const authoredPace = this.currentId === 'walk' ? 0.64 : 1.32;
    this.current.timeScale = THREE.MathUtils.clamp(speed / authoredPace, 0.6, 3.2);
  }

  update(dt: number): void {
    this.mixer.update(dt);
    if (this.remaining !== Infinity) {
      this.remaining -= dt;
      if (this.remaining <= 0) this.animator.isFinished = true;
    }
    if (this.rootBone) {
      this.rootBone.position.x = this.rootRest.x;
      this.rootBone.position.z = this.rootRest.z;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot() as THREE.Object3D);
    this.group.removeFromParent();
    // Geometry and materials belong to the shared source character and are
    // referenced by every other clone, so they are not disposed here.
  }
}
