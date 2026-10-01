/**
 * Skeleton construction and procedural skinning. Owner: CHARACTERS agent.
 *
 * Rigs are generated from a `Proportions` block rather than authored, so a tank
 * and an assassin share one code path but produce genuinely different skeletons
 * (leg count is the same; bone lengths, stance width and stoop are not).
 *
 * Skin weights come from bone-segment proximity with a Gaussian falloff, but the
 * candidate set is *declared per part*. That single restriction is what removes
 * the two classic procedural-skinning failures: weight bleeding across the body
 * (a pauldron dragged by the opposite thigh) and candy-wrapper twisting, since a
 * rigid armour piece is only ever allowed to follow the bone it sits on.
 */

import * as THREE from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// Bone names
// ─────────────────────────────────────────────────────────────────────────────

export const B = {
  root: 'root',
  pelvis: 'pelvis',
  spine: 'spine',
  chest: 'chest',
  neck: 'neck',
  head: 'head',
  headTop: 'headTop',
  shoulderL: 'shoulder.L',
  elbowL: 'elbow.L',
  wristL: 'wrist.L',
  handL: 'hand.L',
  shoulderR: 'shoulder.R',
  elbowR: 'elbow.R',
  wristR: 'wrist.R',
  handR: 'hand.R',
  hipL: 'hip.L',
  kneeL: 'knee.L',
  ankleL: 'ankle.L',
  toeL: 'toe.L',
  hipR: 'hip.R',
  kneeR: 'knee.R',
  ankleR: 'ankle.R',
  toeR: 'toe.R',
} as const;

export const capeBone = (i: number): string => `cape${i}`;
export const tailBone = (i: number): string => `tail${i}`;
export const orbitBone = (i: number): string => `orbit${i}`;

export type Side = 'L' | 'R';
export const armChain = (s: Side): [string, string, string, string] => [
  `shoulder.${s}`,
  `elbow.${s}`,
  `wrist.${s}`,
  `hand.${s}`,
];
export const legChain = (s: Side): [string, string, string, string] => [
  `hip.${s}`,
  `knee.${s}`,
  `ankle.${s}`,
  `toe.${s}`,
];

// ─────────────────────────────────────────────────────────────────────────────
// Proportions
// ─────────────────────────────────────────────────────────────────────────────

export interface Proportions {
  /** Eye-height of the finished character in world units, before `scale`. */
  height: number;
  /** 'robe' hides legs entirely and drives a skirt chain instead. */
  legType: 'plantigrade' | 'digitigrade' | 'robe';
  /** Hip height as a fraction of total height. Low = squat and heavy. */
  legFraction: number;
  /** Half-distance between the hip joints. */
  hipHalfWidth: number;
  /** Half-distance between the shoulder joints. Drives the silhouette's top. */
  shoulderHalfWidth: number;
  /** Vertical span pelvis → chest. */
  torsoFraction: number;
  neckLength: number;
  /** Radius of the skull. Deliberately oversized; realism fails at RTS zoom. */
  headSize: number;
  /** Arm length as a fraction of height. */
  armFraction: number;
  /** Forward lean of the spine, radians. Hunched creeps read instantly. */
  stoop: number;
  /** Height the character floats above the ground. */
  hover: number;
  capeSegments: number;
  tailSegments: number;
  orbitCount: number;
  /** Digitigrade only: how far back the hock sits. */
  hockOffset: number;
  /** Length of the foot, ankle → toe. */
  footLength: number;
}

export const DEFAULT_PROPORTIONS: Proportions = {
  height: 2.0,
  legType: 'plantigrade',
  legFraction: 0.46,
  hipHalfWidth: 0.17,
  shoulderHalfWidth: 0.32,
  torsoFraction: 0.3,
  neckLength: 0.07,
  headSize: 0.24,
  armFraction: 0.42,
  stoop: 0.05,
  hover: 0,
  capeSegments: 0,
  tailSegments: 0,
  orbitCount: 0,
  hockOffset: 0,
  footLength: 0.22,
};

// ─────────────────────────────────────────────────────────────────────────────
// Rig
// ─────────────────────────────────────────────────────────────────────────────

export interface Rig {
  bones: THREE.Bone[];
  names: string[];
  index: Record<string, number>;
  parents: Int32Array;
  children: number[][];
  /** Rest position of each bone in its parent's space. */
  restLocal: Float32Array;
  /** Rest position of each bone in character space. */
  restWorld: Float32Array;
  /** Segment end used for skin-weight distance (child centroid or a stub). */
  segEnd: Float32Array;
  skeleton: THREE.Skeleton;
  root: THREE.Bone;
  proportions: Proportions;
}

interface BoneDef {
  name: string;
  parent: string | null;
  x: number;
  y: number;
  z: number;
}

export function buildRig(p: Proportions): Rig {
  const defs: BoneDef[] = [];
  const add = (name: string, parent: string | null, x: number, y: number, z: number): void => {
    defs.push({ name, parent, x, y, z });
  };

  const hipY = p.height * p.legFraction + p.hover;
  const torso = p.height * p.torsoFraction;

  add(B.root, null, 0, 0, 0);
  add(B.pelvis, B.root, 0, hipY, 0);
  add(B.spine, B.pelvis, 0, torso * 0.42, p.stoop * torso * 0.18);
  add(B.chest, B.spine, 0, torso * 0.58, p.stoop * torso * 0.3);
  add(B.neck, B.chest, 0, p.neckLength, -p.stoop * p.neckLength * 0.4);
  add(B.head, B.neck, 0, p.headSize * 0.55, 0);
  add(B.headTop, B.head, 0, p.headSize * 1.05, 0);

  const armLen = p.height * p.armFraction;
  const upper = armLen * 0.46;
  const fore = armLen * 0.4;
  for (const s of ['L', 'R'] as const) {
    const sign = s === 'L' ? 1 : -1;
    add(`shoulder.${s}`, B.chest, sign * p.shoulderHalfWidth, p.neckLength * 0.35, 0);
    add(`elbow.${s}`, `shoulder.${s}`, 0, -upper, 0);
    add(`wrist.${s}`, `elbow.${s}`, 0, -fore, 0);
    add(`hand.${s}`, `wrist.${s}`, 0, -armLen * 0.14, 0);
  }

  if (p.legType !== 'robe') {
    const legLen = hipY - p.hover;
    const digit = p.legType === 'digitigrade';
    // Digitigrade: short thigh, long shin sweeping back to a raised hock, then a
    // long metatarsal forward to the toe. Same 2-bone IK solver drives both.
    const thigh = legLen * (digit ? 0.42 : 0.5);
    const shin = legLen * (digit ? 0.44 : 0.44);
    for (const s of ['L', 'R'] as const) {
      const sign = s === 'L' ? 1 : -1;
      add(`hip.${s}`, B.pelvis, sign * p.hipHalfWidth, -p.height * 0.02, 0);
      add(`knee.${s}`, `hip.${s}`, 0, -thigh, digit ? p.hockOffset * 0.5 : 0);
      add(`ankle.${s}`, `knee.${s}`, 0, -shin, digit ? -p.hockOffset : 0);
      add(`toe.${s}`, `ankle.${s}`, 0, digit ? -legLen * 0.14 : -legLen * 0.06, p.footLength);
    }
  } else {
    // Robed casters: a skirt chain replaces the legs so the silhouette is one
    // continuous cone. Nothing under the hem ever has to be drawn.
    for (let i = 0; i < 3; i++) {
      add(`skirt${i}`, i === 0 ? B.pelvis : `skirt${i - 1}`, 0, -(hipY - p.hover) / 3, 0);
    }
  }

  for (let i = 0; i < p.capeSegments; i++) {
    const seg = (p.height * 0.62) / Math.max(1, p.capeSegments);
    add(capeBone(i), i === 0 ? B.chest : capeBone(i - 1), 0, i === 0 ? 0 : -seg, i === 0 ? -0.06 : -seg * 0.12);
  }
  for (let i = 0; i < p.tailSegments; i++) {
    const seg = (p.height * 0.34) / Math.max(1, p.tailSegments);
    add(tailBone(i), i === 0 ? B.pelvis : tailBone(i - 1), 0, i === 0 ? 0.02 : -seg * 0.25, -seg);
  }
  for (let i = 0; i < p.orbitCount; i++) {
    add(orbitBone(i), B.chest, 0, 0, 0);
  }

  // Instantiate.
  const bones: THREE.Bone[] = [];
  const names: string[] = [];
  const index: Record<string, number> = {};
  const parents = new Int32Array(defs.length);
  const restLocal = new Float32Array(defs.length * 3);

  for (let i = 0; i < defs.length; i++) {
    const d = defs[i]!;
    const bone = new THREE.Bone();
    bone.name = d.name;
    bone.position.set(d.x, d.y, d.z);
    bones.push(bone);
    names.push(d.name);
    index[d.name] = i;
    restLocal[i * 3] = d.x;
    restLocal[i * 3 + 1] = d.y;
    restLocal[i * 3 + 2] = d.z;
  }
  const children: number[][] = defs.map(() => []);
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i]!;
    if (d.parent === null) {
      parents[i] = -1;
    } else {
      const pi = index[d.parent];
      if (pi === undefined) throw new Error(`rig: unknown parent ${d.parent}`);
      parents[i] = pi;
      children[pi]!.push(i);
      bones[pi]!.add(bones[i]!);
    }
  }

  // Rest positions in character space.
  const restWorld = new Float32Array(defs.length * 3);
  for (let i = 0; i < defs.length; i++) {
    const pi = parents[i]!;
    const px = pi < 0 ? 0 : restWorld[pi * 3]!;
    const py = pi < 0 ? 0 : restWorld[pi * 3 + 1]!;
    const pz = pi < 0 ? 0 : restWorld[pi * 3 + 2]!;
    restWorld[i * 3] = px + restLocal[i * 3]!;
    restWorld[i * 3 + 1] = py + restLocal[i * 3 + 1]!;
    restWorld[i * 3 + 2] = pz + restLocal[i * 3 + 2]!;
  }

  // Skin-weight segments: bone origin → centroid of its children, or a short
  // stub continuing the parent direction for leaf bones.
  const segEnd = new Float32Array(defs.length * 3);
  for (let i = 0; i < defs.length; i++) {
    const kids = children[i]!;
    if (kids.length > 0) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const k of kids) {
        sx += restWorld[k * 3]!;
        sy += restWorld[k * 3 + 1]!;
        sz += restWorld[k * 3 + 2]!;
      }
      segEnd[i * 3] = sx / kids.length;
      segEnd[i * 3 + 1] = sy / kids.length;
      segEnd[i * 3 + 2] = sz / kids.length;
    } else {
      const pi = parents[i]!;
      let dx = 0;
      let dy = 1;
      let dz = 0;
      if (pi >= 0) {
        dx = restWorld[i * 3]! - restWorld[pi * 3]!;
        dy = restWorld[i * 3 + 1]! - restWorld[pi * 3 + 1]!;
        dz = restWorld[i * 3 + 2]! - restWorld[pi * 3 + 2]!;
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len;
        dy /= len;
        dz /= len;
      }
      const stub = p.height * 0.07;
      segEnd[i * 3] = restWorld[i * 3]! + dx * stub;
      segEnd[i * 3 + 1] = restWorld[i * 3 + 1]! + dy * stub;
      segEnd[i * 3 + 2] = restWorld[i * 3 + 2]! + dz * stub;
    }
  }

  const root = bones[0]!;
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  return {
    bones,
    names,
    index,
    parents,
    children,
    restLocal,
    restWorld,
    segEnd,
    skeleton,
    root,
    proportions: p,
  };
}

/** Clones the rig's bone hierarchy so each instance animates independently. */
export function cloneRig(rig: Rig): Rig {
  const bones: THREE.Bone[] = rig.names.map((name, i) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(rig.restLocal[i * 3]!, rig.restLocal[i * 3 + 1]!, rig.restLocal[i * 3 + 2]!);
    return bone;
  });
  for (let i = 0; i < bones.length; i++) {
    const pi = rig.parents[i]!;
    if (pi >= 0) bones[pi]!.add(bones[i]!);
  }
  const root = bones[0]!;
  root.updateMatrixWorld(true);
  return { ...rig, bones, skeleton: new THREE.Skeleton(bones), root };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skinning
// ─────────────────────────────────────────────────────────────────────────────

export interface Bind {
  /** Candidate bones, most important first. Nothing outside this list can pull. */
  bones: string[];
  /** Weight 1.0 to bones[0]; used for armour that must not deform. */
  rigid?: boolean;
  /** Gaussian sigma of the proximity falloff, in world units. */
  falloff?: number;
  /** Extra multiplier on bones[0] so a part stays anchored to its own joint. */
  bias?: number;
}

const MAX_INFLUENCES = 4;

/**
 * Generates skin indices and weights for one part's vertices.
 * Returns interleaved arrays sized `count * 4`.
 */
export function computeSkinWeights(
  rig: Rig,
  positions: ArrayLike<number>,
  count: number,
  bind: Bind,
): { index: Uint16Array; weight: Float32Array } {
  const outIndex = new Uint16Array(count * MAX_INFLUENCES);
  const outWeight = new Float32Array(count * MAX_INFLUENCES);

  const ids: number[] = [];
  for (const name of bind.bones) {
    const i = rig.index[name];
    if (i === undefined) throw new Error(`skin: unknown bone ${name}`);
    ids.push(i);
  }
  if (ids.length === 0) throw new Error('skin: empty bind');

  if (bind.rigid || ids.length === 1) {
    const b = ids[0]!;
    for (let v = 0; v < count; v++) {
      outIndex[v * MAX_INFLUENCES] = b;
      outWeight[v * MAX_INFLUENCES] = 1;
    }
    return { index: outIndex, weight: outWeight };
  }

  const sigma = bind.falloff ?? 0.2;
  const inv2s2 = 1 / (2 * sigma * sigma);
  const bias = bind.bias ?? 1.6;
  const scratch: { id: number; w: number }[] = ids.map((id) => ({ id, w: 0 }));

  for (let v = 0; v < count; v++) {
    const px = positions[v * 3]!;
    const py = positions[v * 3 + 1]!;
    const pz = positions[v * 3 + 2]!;
    let total = 0;
    for (let k = 0; k < ids.length; k++) {
      const b = ids[k]!;
      const d = distanceToSegment(
        px,
        py,
        pz,
        rig.restWorld[b * 3]!,
        rig.restWorld[b * 3 + 1]!,
        rig.restWorld[b * 3 + 2]!,
        rig.segEnd[b * 3]!,
        rig.segEnd[b * 3 + 1]!,
        rig.segEnd[b * 3 + 2]!,
      );
      let w = Math.exp(-d * d * inv2s2);
      if (k === 0) w *= bias;
      w += k === 0 ? 1e-4 : 0;
      // The id is rewritten every time, not just the weight. `scratch` is
      // reused across vertices and gets sorted below, so by the second vertex
      // `scratch[k]` no longer holds `ids[k]`: writing only the weight pairs
      // each bone's distance with whatever bone happened to sort into that
      // slot for the previous vertex. With two or three adjacent bones the
      // damage is a subtle smear; with a whole skeleton it is every vertex
      // bound to an arbitrary bone, and the mesh explodes into loose triangles
      // the moment anything moves. That is what made importing a whole body
      // look like a bind-pose problem when it never was one.
      scratch[k]!.id = b;
      scratch[k]!.w = w;
      total += w;
    }
    if (total <= 0) {
      scratch[0]!.w = 1;
      total = 1;
    }
    scratch.sort(byWeightDesc);
    let kept = 0;
    for (let k = 0; k < Math.min(MAX_INFLUENCES, scratch.length); k++) kept += scratch[k]!.w;
    const norm = kept > 0 ? 1 / kept : 0;
    for (let k = 0; k < MAX_INFLUENCES; k++) {
      const e = scratch[k];
      outIndex[v * MAX_INFLUENCES + k] = e ? e.id : ids[0]!;
      outWeight[v * MAX_INFLUENCES + k] = e ? e.w * norm : 0;
    }
  }
  return { index: outIndex, weight: outWeight };
}

function byWeightDesc(a: { w: number }, b: { w: number }): number {
  return b.w - a.w;
}

function distanceToSegment(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const ez = bz - az;
  const len2 = ex * ex + ey * ey + ez * ez;
  let t = 0;
  if (len2 > 1e-12) {
    t = ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = px - (ax + ex * t);
  const dy = py - (ay + ey * t);
  const dz = pz - (az + ez * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
