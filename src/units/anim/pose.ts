/**
 * Pose buffers, blending and IK. Owner: CHARACTERS agent.
 *
 * A pose is a flat Float32Array of 7 floats per bone — local quaternion (xyzw)
 * followed by local position (xyz). Flat buffers mean clips can be blended,
 * baked into a vertex-animation texture, or written straight onto a THREE
 * skeleton without allocating per frame.
 */

import * as THREE from 'three';
import type { Rig } from '../rig/rig';

export const STRIDE = 7;

export type Pose = Float32Array;

export function createPose(rig: Rig): Pose {
  const p = new Float32Array(rig.bones.length * STRIDE);
  resetPose(rig, p);
  return p;
}

export function resetPose(rig: Rig, pose: Pose): void {
  for (let i = 0; i < rig.bones.length; i++) {
    const o = i * STRIDE;
    pose[o] = 0;
    pose[o + 1] = 0;
    pose[o + 2] = 0;
    pose[o + 3] = 1;
    pose[o + 4] = rig.restLocal[i * 3]!;
    pose[o + 5] = rig.restLocal[i * 3 + 1]!;
    pose[o + 6] = rig.restLocal[i * 3 + 2]!;
  }
}

export function copyPose(src: Pose, dst: Pose): void {
  dst.set(src);
}

/** Per-bone slerp + lerp. `t` = 0 keeps `a`, 1 takes `b`. */
export function blendPose(a: Pose, b: Pose, t: number, out: Pose): void {
  const n = a.length / STRIDE;
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE;
    slerpInto(a, b, o, t, out);
    out[o + 4] = a[o + 4]! + (b[o + 4]! - a[o + 4]!) * t;
    out[o + 5] = a[o + 5]! + (b[o + 5]! - a[o + 5]!) * t;
    out[o + 6] = a[o + 6]! + (b[o + 6]! - a[o + 6]!) * t;
  }
}

function slerpInto(a: Pose, b: Pose, o: number, t: number, out: Pose): void {
  let ax = a[o]!;
  let ay = a[o + 1]!;
  let az = a[o + 2]!;
  let aw = a[o + 3]!;
  const bx = b[o]!;
  const by = b[o + 1]!;
  const bz = b[o + 2]!;
  const bw = b[o + 3]!;
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) {
    cos = -cos;
    ax = -ax;
    ay = -ay;
    az = -az;
    aw = -aw;
  }
  let s0: number;
  let s1: number;
  if (cos > 0.9995) {
    s0 = 1 - t;
    s1 = t;
  } else {
    const theta = Math.acos(cos);
    const sin = Math.sin(theta);
    s0 = Math.sin((1 - t) * theta) / sin;
    s1 = Math.sin(t * theta) / sin;
  }
  const x = ax * s0 + bx * s1;
  const y = ay * s0 + by * s1;
  const z = az * s0 + bz * s1;
  const w = aw * s0 + bw * s1;
  const inv = 1 / (Math.hypot(x, y, z, w) || 1);
  out[o] = x * inv;
  out[o + 1] = y * inv;
  out[o + 2] = z * inv;
  out[o + 3] = w * inv;
}

export function applyPose(rig: Rig, pose: Pose): void {
  for (let i = 0; i < rig.bones.length; i++) {
    const o = i * STRIDE;
    const bone = rig.bones[i]!;
    bone.quaternion.set(pose[o]!, pose[o + 1]!, pose[o + 2]!, pose[o + 3]!);
    bone.position.set(pose[o + 4]!, pose[o + 5]!, pose[o + 6]!);
  }
  rig.root.updateMatrixWorld(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Poser — the authoring surface every clip writes through
// ─────────────────────────────────────────────────────────────────────────────

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const DOWN = new THREE.Vector3(0, -1, 0);

export class Poser {
  readonly pose: Pose;
  private readonly chain: number[] = [];

  constructor(readonly rig: Rig, pose?: Pose) {
    this.pose = pose ?? createPose(rig);
  }

  reset(): void {
    resetPose(this.rig, this.pose);
  }

  idx(name: string): number {
    const i = this.rig.index[name];
    if (i === undefined) throw new Error(`pose: unknown bone ${name}`);
    return i;
  }

  has(name: string): boolean {
    return this.rig.index[name] !== undefined;
  }

  /** Replaces the bone's local rotation with this XYZ Euler. */
  rot(name: string, x: number, y: number, z: number): void {
    const i = this.rig.index[name];
    if (i === undefined) return;
    _e.set(x, y, z, 'XYZ');
    _q.setFromEuler(_e);
    const o = i * STRIDE;
    this.pose[o] = _q.x;
    this.pose[o + 1] = _q.y;
    this.pose[o + 2] = _q.z;
    this.pose[o + 3] = _q.w;
  }

  /** Post-multiplies an XYZ Euler onto the bone's current local rotation. */
  addRot(name: string, x: number, y: number, z: number): void {
    const i = this.rig.index[name];
    if (i === undefined) return;
    const o = i * STRIDE;
    _q.set(this.pose[o]!, this.pose[o + 1]!, this.pose[o + 2]!, this.pose[o + 3]!);
    _e.set(x, y, z, 'XYZ');
    _q2.setFromEuler(_e);
    _q.multiply(_q2);
    this.pose[o] = _q.x;
    this.pose[o + 1] = _q.y;
    this.pose[o + 2] = _q.z;
    this.pose[o + 3] = _q.w;
  }

  setQuat(name: string, q: THREE.Quaternion): void {
    const i = this.rig.index[name];
    if (i === undefined) return;
    const o = i * STRIDE;
    this.pose[o] = q.x;
    this.pose[o + 1] = q.y;
    this.pose[o + 2] = q.z;
    this.pose[o + 3] = q.w;
  }

  getQuat(name: string, out: THREE.Quaternion): THREE.Quaternion {
    const i = this.rig.index[name];
    if (i === undefined) return out.identity();
    const o = i * STRIDE;
    return out.set(this.pose[o]!, this.pose[o + 1]!, this.pose[o + 2]!, this.pose[o + 3]!);
  }

  /** Offsets the bone from its rest position, in parent space. */
  move(name: string, dx: number, dy: number, dz: number): void {
    const i = this.rig.index[name];
    if (i === undefined) return;
    const o = i * STRIDE;
    this.pose[o + 4] = this.rig.restLocal[i * 3]! + dx;
    this.pose[o + 5] = this.rig.restLocal[i * 3 + 1]! + dy;
    this.pose[o + 6] = this.rig.restLocal[i * 3 + 2]! + dz;
  }

  setPos(name: string, x: number, y: number, z: number): void {
    const i = this.rig.index[name];
    if (i === undefined) return;
    const o = i * STRIDE;
    this.pose[o + 4] = x;
    this.pose[o + 5] = y;
    this.pose[o + 6] = z;
  }

  /** World (character-space) matrix of a bone under the current pose. */
  worldMatrix(boneIndex: number, out: THREE.Matrix4): THREE.Matrix4 {
    this.chain.length = 0;
    let i = boneIndex;
    while (i >= 0) {
      this.chain.push(i);
      i = this.rig.parents[i]!;
    }
    out.identity();
    for (let k = this.chain.length - 1; k >= 0; k--) {
      const b = this.chain[k]!;
      const o = b * STRIDE;
      _q.set(this.pose[o]!, this.pose[o + 1]!, this.pose[o + 2]!, this.pose[o + 3]!);
      _v.set(this.pose[o + 4]!, this.pose[o + 5]!, this.pose[o + 6]!);
      _m.compose(_v, _q, _s);
      out.multiply(_m);
    }
    return out;
  }

  worldPosition(name: string, out: THREE.Vector3): THREE.Vector3 {
    const i = this.rig.index[name];
    if (i === undefined) return out.set(0, 0, 0);
    this.worldMatrix(i, _mWorld);
    return out.setFromMatrixPosition(_mWorld);
  }

  /**
   * Two-bone IK for a limb whose rest direction is -Y.
   * `target` is in character space; `pole` biases which way the joint bends.
   * The chain reaches the target exactly when it is in range, which is what
   * makes foot planting exact instead of approximate.
   */
  ik2(
    upperName: string,
    midName: string,
    endName: string,
    target: THREE.Vector3,
    pole: THREE.Vector3,
  ): void {
    const ui = this.rig.index[upperName];
    const mi = this.rig.index[midName];
    const ei = this.rig.index[endName];
    if (ui === undefined || mi === undefined || ei === undefined) return;

    const rig = this.rig;
    const l1 = Math.hypot(rig.restLocal[mi * 3]!, rig.restLocal[mi * 3 + 1]!, rig.restLocal[mi * 3 + 2]!);
    const l2 = Math.hypot(rig.restLocal[ei * 3]!, rig.restLocal[ei * 3 + 1]!, rig.restLocal[ei * 3 + 2]!);

    // Upper bone's parent frame, so the target can be solved locally.
    const pi = rig.parents[ui]!;
    if (pi >= 0) this.worldMatrix(pi, _mParent);
    else _mParent.identity();
    _mParentInv.copy(_mParent).invert();

    const o = ui * STRIDE;
    _vOrigin.set(this.pose[o + 4]!, this.pose[o + 5]!, this.pose[o + 6]!);

    _vTarget.copy(target).applyMatrix4(_mParentInv).sub(_vOrigin);
    _vPole.copy(pole).transformDirection(_mParentInv);

    let d = _vTarget.length();
    const min = Math.abs(l1 - l2) + 1e-3;
    const max = l1 + l2 - 1e-3;
    if (d < min) d = min;
    if (d > max) d = max;
    if (_vTarget.lengthSq() < 1e-9) _vTarget.set(0, -d, 0);
    else _vTarget.setLength(d);

    const u = _v.copy(_vTarget).normalize();
    // Pole component perpendicular to the limb axis.
    const w = _v2.copy(_vPole).addScaledVector(u, -_vPole.dot(u));
    if (w.lengthSq() < 1e-8) {
      w.set(0, 0, 1).addScaledVector(u, -u.z);
      if (w.lengthSq() < 1e-8) w.set(1, 0, 0);
    }
    w.normalize();

    const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const alpha = Math.acos(cosA);

    const d1 = _v3.copy(u).multiplyScalar(Math.cos(alpha)).addScaledVector(w, Math.sin(alpha));
    _qUpper.setFromUnitVectors(DOWN, d1);
    this.setQuat(upperName, _qUpper);

    // Shin direction from the solved knee to the target.
    _vKnee.copy(d1).multiplyScalar(l1);
    _vShin.copy(_vTarget).sub(_vKnee);
    if (_vShin.lengthSq() < 1e-9) _vShin.copy(d1);
    _vShin.normalize();
    _qMidWorld.setFromUnitVectors(DOWN, _vShin);
    _qMid.copy(_qUpper).invert().multiply(_qMidWorld);
    this.setQuat(midName, _qMid);
  }

  /** Overrides an end effector's orientation given the world rotation wanted. */
  setWorldRotation(name: string, q: THREE.Quaternion): void {
    const i = this.rig.index[name];
    if (i === undefined) return;
    const pi = this.rig.parents[i]!;
    if (pi >= 0) {
      this.worldMatrix(pi, _mParent);
      _qParent.setFromRotationMatrix(_mParent);
      _qTmp.copy(_qParent).invert().multiply(q);
    } else {
      _qTmp.copy(q);
    }
    this.setQuat(name, _qTmp);
  }
}

const _mWorld = new THREE.Matrix4();
const _mParent = new THREE.Matrix4();
const _mParentInv = new THREE.Matrix4();
const _vOrigin = new THREE.Vector3();
const _vTarget = new THREE.Vector3();
const _vPole = new THREE.Vector3();
const _vKnee = new THREE.Vector3();
const _vShin = new THREE.Vector3();
const _qUpper = new THREE.Quaternion();
const _qMid = new THREE.Quaternion();
const _qMidWorld = new THREE.Quaternion();
const _qParent = new THREE.Quaternion();
const _qTmp = new THREE.Quaternion();
