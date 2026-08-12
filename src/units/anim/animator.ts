/**
 * Per-character animator. Owner: CHARACTERS agent.
 *
 * Drives one rig: evaluates the active clip, cross-fades from whatever pose was
 * on screen when the new clip started, then layers spring dynamics on the cape
 * and tail so cloth lags the body instead of moving welded to it.
 *
 * Locomotion clips are time-scaled by actual ground speed, so stride length and
 * ground speed always agree — that is the real fix for foot skating, with the
 * IK-planted foot targets in `clips.ts` doing the rest.
 */

import * as THREE from 'three';
import { applyPose, blendPose, copyPose, createPose, Poser, type Pose } from './pose';
import { buildClips, type AnimProfile, type Clip, type ClipId } from './clips';
import { capeBone, tailBone, type Rig } from '../rig/rig';

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

interface SpringState {
  x: number;
  vx: number;
  z: number;
  vz: number;
}

export class Animator {
  private readonly clips: Record<ClipId, Clip>;
  private readonly poser: Poser;
  private readonly outPose: Pose;
  private readonly fromPose: Pose;

  private current: ClipId = 'idle';
  private clipTime = 0;
  private fade = 0;
  private fadeDuration = 0;
  private finished = false;

  /** Ground speed in world units/second; scales the locomotion cycle. */
  private speed = 0;
  private readonly springs: SpringState[] = [];
  private readonly springBones: string[] = [];
  private swayPhase = 0;

  constructor(
    readonly rig: Rig,
    readonly profile: AnimProfile,
    /** Per-instance phase offset so a crowd never breathes in lockstep. */
    private readonly phaseOffset = 0,
  ) {
    this.clips = buildClips(profile);
    this.poser = new Poser(rig);
    this.outPose = createPose(rig);
    this.fromPose = createPose(rig);
    this.clipTime = phaseOffset * this.clips.idle.duration;

    for (let i = 0; i < profile.capeSegments; i++) this.springBones.push(capeBone(i));
    for (let i = 0; i < profile.tailSegments; i++) this.springBones.push(tailBone(i));
    for (let i = 0; i < 3; i++) {
      if (rig.index[`skirt${i}`] !== undefined) this.springBones.push(`skirt${i}`);
    }
    for (let i = 0; i < this.springBones.length; i++) this.springs.push({ x: 0, vx: 0, z: 0, vz: 0 });
  }

  get clip(): ClipId {
    return this.current;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  play(clip: ClipId, fadeSeconds = 0.18): void {
    if (clip === this.current && this.clips[clip].loop) return;
    copyPose(this.outPose, this.fromPose);
    this.current = clip;
    this.clipTime = 0;
    this.fade = 0;
    this.fadeDuration = Math.max(0, fadeSeconds);
    this.finished = false;
  }

  /** Restarts the current clip without a fade; used for repeated attacks. */
  retrigger(): void {
    this.clipTime = 0;
    this.finished = false;
  }

  update(dt: number): void {
    const clip = this.clips[this.current];

    // Locomotion advances with ground speed so the stride matches the distance
    // actually covered. Everything else runs on wall time.
    let scale = 1;
    if (this.current === 'walk') scale = this.speed / Math.max(0.05, this.profile.walkSpeed);
    else if (this.current === 'run') scale = this.speed / Math.max(0.05, this.profile.runSpeed);
    if (this.current === 'walk' || this.current === 'run') scale = clampScale(scale);

    this.clipTime += dt * scale;
    if (clip.loop) {
      if (this.clipTime > clip.duration) this.clipTime %= clip.duration;
    } else if (this.clipTime >= clip.duration) {
      this.clipTime = clip.duration;
      this.finished = true;
    }

    this.poser.reset();
    clip.evaluate(this.poser, this.clipTime + this.phaseOffset * 0.37, this.profile);

    if (this.fadeDuration > 0 && this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / this.fadeDuration);
      const t = this.fade * this.fade * (3 - 2 * this.fade);
      blendPose(this.fromPose, this.poser.pose, t, this.outPose);
    } else {
      copyPose(this.poser.pose, this.outPose);
    }

    this.applySecondary(dt);
    applyPose(this.rig, this.outPose);
  }

  /**
   * Spring dynamics on the cloth chains. Each segment chases the one above it
   * with progressively less stiffness, so the tip trails by a visible lag and
   * overshoots when the body stops.
   */
  private applySecondary(dt: number): void {
    if (this.springBones.length === 0) return;
    const step = Math.min(dt, 1 / 45);
    this.swayPhase += step * 1.3;

    // Drive: forward motion pushes cloth back, and a low wind term keeps it
    // alive when the character is standing still.
    const drag = Math.min(1.4, this.speed * 0.16);
    const wind = Math.sin(this.swayPhase + this.phaseOffset * 6.2) * 0.05;
    const windZ = Math.cos(this.swayPhase * 0.77 + this.phaseOffset * 4.1) * 0.04;

    for (let i = 0; i < this.springBones.length; i++) {
      const s = this.springs[i]!;
      const depth = i / this.springBones.length;
      const stiffness = 46 - depth * 24;
      const damping = 9 - depth * 3.4;
      const targetX = drag * (0.22 + depth * 0.5) + wind * (0.4 + depth);
      const targetZ = windZ * (0.3 + depth * 1.2);

      s.vx += (stiffness * (targetX - s.x) - damping * s.vx) * step;
      s.x += s.vx * step;
      s.vz += (stiffness * (targetZ - s.z) - damping * s.vz) * step;
      s.z += s.vz * step;

      const name = this.springBones[i]!;
      const idx = this.rig.index[name];
      if (idx === undefined) continue;
      const o = idx * 7;
      _q.set(this.outPose[o]!, this.outPose[o + 1]!, this.outPose[o + 2]!, this.outPose[o + 3]!);
      _e.set(s.x, 0, s.z, 'XYZ');
      _q.multiply(_qFrom.setFromEuler(_e));
      this.outPose[o] = _q.x;
      this.outPose[o + 1] = _q.y;
      this.outPose[o + 2] = _q.z;
      this.outPose[o + 3] = _q.w;
    }
  }

  /** World-space position of a bone under the current pose, in character space. */
  bonePosition(name: string, out: THREE.Vector3): THREE.Vector3 {
    const i = this.rig.index[name];
    if (i === undefined) return out.set(0, 0, 0);
    return out.setFromMatrixPosition(this.rig.bones[i]!.matrixWorld);
  }
}

const _qFrom = new THREE.Quaternion();

function clampScale(v: number): number {
  if (!Number.isFinite(v) || v <= 0.05) return 0.05;
  return v > 3 ? 3 : v;
}
