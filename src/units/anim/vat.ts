/**
 * Vertex-animation texture baking. Owner: CHARACTERS agent.
 *
 * WHY VAT AND NOT INSTANCED GPU SKINNING
 * --------------------------------------
 * The budget is 300 units at 60 fps on a GTX 970 with ≤ 700 draw calls, so
 * creeps must batch. `THREE.InstancedMesh` cannot skin: a skeleton is per-object
 * state and there is exactly one per mesh. The two ways out are (a) a bone
 * texture indexed per instance, which needs a matrix palette uploaded for every
 * unit every frame — 300 units × ~26 bones × 64 bytes is ~500 KB of per-frame
 * CPU→GPU traffic plus 300 skeleton updates on the CPU — or (b) baking the
 * finished vertex positions once at load and sampling them in the vertex shader.
 *
 * (b) wins outright here because the animation is *procedural and identical per
 * definition*: every Ruin Cleaver plays the same seven clips, differing only in
 * phase. So the bake is shared by the whole batch, per-frame CPU cost is one
 * uniform, and the only per-instance data is a static vec4 (clip row, frame
 * count, start time, rate). Cost is memory, which is small after welding:
 * unique vertices × frames × 8 bytes × 2 textures, a few MB per definition.
 *
 * The trade-off, stated honestly: creeps cannot blend between clips (the shader
 * samples one clip), cannot be re-proportioned per instance, and cannot take
 * per-bone hit reactions. Heroes and bosses keep real skeletons for exactly
 * those reasons. Clip changes on creeps are a hard cut, hidden by the fact that
 * transitions happen on spawn, on death and on attack triggers.
 */

import * as THREE from 'three';
import { applyPose, Poser } from './pose';
import { buildClips, CLIP_IDS, type AnimProfile, type ClipId } from './clips';
import { cloneRig, type Rig } from '../rig/rig';

export interface VatClipRange {
  row: number;
  frames: number;
  /** Playback rate in frames per second; negative marks a non-looping clip. */
  rate: number;
  loop: boolean;
  duration: number;
}

export interface VatBake {
  position: THREE.DataTexture;
  normal: THREE.DataTexture;
  width: number;
  height: number;
  ranges: Record<ClipId, VatClipRange>;
  boundingSphere: THREE.Sphere;
  bytes: number;
  dispose(): void;
}

const DEFAULT_FPS = 18;

export function bakeVat(
  sourceRig: Rig,
  profile: AnimProfile,
  geometry: THREE.BufferGeometry,
  fps = DEFAULT_FPS,
): VatBake {
  const rig = cloneRig(sourceRig);
  const poser = new Poser(rig);
  const clips = buildClips(profile);

  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const skinIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
  const skinWeight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  const vertexCount = position.count;

  const ranges = {} as Record<ClipId, VatClipRange>;
  let totalRows = 0;
  for (const id of CLIP_IDS) {
    const clip = clips[id];
    const frames = Math.max(2, Math.round(clip.duration * fps));
    ranges[id] = {
      row: totalRows,
      frames,
      rate: clip.loop ? fps : -fps,
      loop: clip.loop,
      duration: clip.duration,
    };
    totalRows += frames;
  }

  const width = vertexCount;
  const height = totalRows;
  const posData = new Uint16Array(width * height * 4);
  const nrmData = new Uint16Array(width * height * 4);

  const bone = new THREE.Matrix4();
  const skinned = new THREE.Matrix4();
  const vp = new THREE.Vector3();
  const vn = new THREE.Vector3();
  const acc = new THREE.Vector3();
  const accN = new THREE.Vector3();
  const centre = new THREE.Vector3();
  let maxRadiusSq = 0;
  const toHalf = THREE.DataUtils.toHalfFloat;

  for (const id of CLIP_IDS) {
    const clip = clips[id];
    const range = ranges[id];
    for (let f = 0; f < range.frames; f++) {
      // Looping clips sample [0, duration) so frame N wraps onto frame 0;
      // one-shots sample the closed interval so the final pose is exact.
      const t = clip.loop
        ? (f / range.frames) * clip.duration
        : (f / (range.frames - 1)) * clip.duration;

      poser.reset();
      clip.evaluate(poser, t, profile);
      applyPose(rig, poser.pose);
      rig.skeleton.update();
      const bones = rig.skeleton.boneMatrices;

      const rowBase = (range.row + f) * width * 4;
      for (let v = 0; v < vertexCount; v++) {
        vp.fromBufferAttribute(position, v);
        vn.fromBufferAttribute(normal, v);
        acc.set(0, 0, 0);
        accN.set(0, 0, 0);
        for (let k = 0; k < 4; k++) {
          const w = skinWeight.getComponent(v, k);
          if (w <= 0) continue;
          const bi = skinIndex.getComponent(v, k);
          bone.fromArray(bones, bi * 16);
          skinned.copy(bone);
          _tmpP.copy(vp).applyMatrix4(skinned);
          acc.addScaledVector(_tmpP, w);
          _tmpN.copy(vn).transformDirection(skinned);
          accN.addScaledVector(_tmpN, w);
        }
        accN.normalize();

        const o = rowBase + v * 4;
        posData[o] = toHalf(acc.x);
        posData[o + 1] = toHalf(acc.y);
        posData[o + 2] = toHalf(acc.z);
        posData[o + 3] = toHalf(1);
        nrmData[o] = toHalf(accN.x);
        nrmData[o + 1] = toHalf(accN.y);
        nrmData[o + 2] = toHalf(accN.z);
        nrmData[o + 3] = toHalf(1);

        const dsq = acc.lengthSq();
        if (dsq > maxRadiusSq) maxRadiusSq = dsq;
      }
    }
  }

  const posTex = makeTexture(posData, width, height);
  const nrmTex = makeTexture(nrmData, width, height);

  return {
    position: posTex,
    normal: nrmTex,
    width,
    height,
    ranges,
    // Centred on the character origin: every baked frame is measured from it,
    // so a death animation sprawling sideways still stays inside the sphere.
    boundingSphere: new THREE.Sphere(centre.set(0, 0, 0), Math.sqrt(maxRadiusSq) * 1.05 + 0.1),
    bytes: posData.byteLength + nrmData.byteLength,
    dispose(): void {
      posTex.dispose();
      nrmTex.dispose();
    },
  };
}

const _tmpP = new THREE.Vector3();
const _tmpN = new THREE.Vector3();

function makeTexture(data: Uint16Array, width: number, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  // Nearest sampling: the shader fetches two exact rows and blends them itself,
  // so no float-linear filtering extension is required.
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
