/**
 * Vertex animation bake for an authored character. Owner: CHARACTERS.
 *
 * `bakeVat` poses OUR rig with OUR procedurally generated clips. A character
 * that arrives from an artist brings its own skeleton, its own skin weights and
 * its own clips, and all three are better than what we can generate: the weights
 * were painted by a person and the motion was authored rather than derived from
 * a sine wave.
 *
 * Only the posing differs. Reading the bone matrices and applying them to the
 * vertices is the same arithmetic either way, so this is the same loop with an
 * `AnimationMixer` in place of the `Poser`, and it hands back the identical
 * `VatBake` the instanced renderer already consumes. Nothing downstream learns
 * that the character came from a file.
 */

import * as THREE from 'three';
import { CLIP_IDS, type ClipId } from './clips';
import type { VatBake, VatClipRange } from './vat';

const DEFAULT_FPS = 18;

/** Clips a loop rather than playing once. Everything else resolves to a pose. */
const LOOPING: ReadonlySet<ClipId> = new Set<ClipId>(['idle', 'walk', 'run']);

export interface ImportedSource {
  /** The scene graph the clips address. Posed and read, never rendered. */
  root: THREE.Object3D;
  /** The mesh whose geometry is baked. Must carry skinIndex and skinWeight. */
  mesh: THREE.SkinnedMesh;
  /** Clips named with our ids; a missing id falls back to `idle`. */
  clips: Map<ClipId, THREE.AnimationClip>;
}

/**
 * Bakes an authored character's own clips into the same textures the
 * procedural path produces.
 *
 * Throws rather than warns when the character is too wide for a texture: the
 * upload would be rejected silently and the creeps would render as empty space
 * while still attacking, which is the worst way this can fail. See the same
 * guard in `vat.ts`.
 */
export function bakeImportedVat(source: ImportedSource, fps = DEFAULT_FPS): VatBake {
  const { root, mesh, clips } = source;
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const skinIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
  const skinWeight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  if (!skinIndex || !skinWeight) {
    throw new Error('bakeImportedVat: the mesh carries no skin weights');
  }
  const vertexCount = position.count;

  const MAX_TEXTURE = 16384;
  if (vertexCount > MAX_TEXTURE) {
    throw new Error(
      `bakeImportedVat: ${vertexCount} vertices exceeds the ${MAX_TEXTURE} texel limit. ` +
        'Decimate the character before importing it.',
    );
  }

  const mixer = new THREE.AnimationMixer(root);
  const fallback = clips.get('idle') ?? [...clips.values()][0];
  if (!fallback) throw new Error('bakeImportedVat: no clips');

  const ranges = {} as Record<ClipId, VatClipRange>;
  let totalRows = 0;
  const plan: { id: ClipId; clip: THREE.AnimationClip; frames: number; row: number }[] = [];
  for (const id of CLIP_IDS) {
    const clip = clips.get(id) ?? fallback;
    const loop = LOOPING.has(id);
    const frames = Math.max(2, Math.round(clip.duration * fps));
    plan.push({ id, clip, frames, row: totalRows });
    ranges[id] = { row: totalRows, frames, rate: loop ? fps : -fps, loop, duration: clip.duration };
    totalRows += frames;
  }

  const width = vertexCount;
  const height = totalRows;
  const posData = new Uint16Array(width * height * 4);
  const nrmData = new Uint16Array(width * height * 4);

  const bone = new THREE.Matrix4();
  const vp = new THREE.Vector3();
  const vn = new THREE.Vector3();
  const acc = new THREE.Vector3();
  const accN = new THREE.Vector3();
  const tmpP = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const toHalf = THREE.DataUtils.toHalfFloat;
  let maxRadiusSq = 0;

  // No scaling is applied to the baked positions, and that is not an omission.
  // `Skeleton.update` builds each bone matrix as `bone.matrixWorld x
  // boneInverse`, and the bind inverses were captured before this character was
  // scaled to the roster's height. The scale therefore survives in the product,
  // so the skinned result already comes out at final size: measured at 1.98 m
  // against the 2 m the renderer draws.
  //
  // Multiplying by the root scale on top of that is what made every orc two
  // centimetres tall and invisible on the field while still attacking.

  for (const step of plan) {
    const action = mixer.clipAction(step.clip);
    action.reset();
    action.play();
    for (let f = 0; f < step.frames; f++) {
      const t = ranges[step.id].loop
        ? (f / step.frames) * step.clip.duration
        : (f / (step.frames - 1)) * step.clip.duration;
      mixer.setTime(t);
      // Bone matrices come off the scene graph, so it has to be current before
      // the skeleton is read. Skipping this bakes the bind pose every frame and
      // the result looks like it worked.
      root.updateMatrixWorld(true);
      mesh.skeleton.update();
      const bones = mesh.skeleton.boneMatrices;

      const rowBase = (step.row + f) * width * 4;
      for (let v = 0; v < vertexCount; v++) {
        vp.fromBufferAttribute(position, v);
        vn.fromBufferAttribute(normal, v);
        acc.set(0, 0, 0);
        accN.set(0, 0, 0);
        for (let k = 0; k < 4; k++) {
          const w = skinWeight.getComponent(v, k);
          if (w <= 0) continue;
          bone.fromArray(bones, skinIndex.getComponent(v, k) * 16);
          tmpP.copy(vp).applyMatrix4(bone);
          acc.addScaledVector(tmpP, w);
          tmpN.copy(vn).transformDirection(bone);
          accN.addScaledVector(tmpN, w);
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
    action.stop();
  }

  const posTex = makeTexture(posData, width, height);
  const nrmTex = makeTexture(nrmData, width, height);

  return {
    position: posTex,
    normal: nrmTex,
    width,
    height,
    ranges,
    boundingSphere: new THREE.Sphere(new THREE.Vector3(), Math.sqrt(maxRadiusSq) * 1.05 + 0.1),
    bytes: posData.byteLength + nrmData.byteLength,
    dispose(): void {
      posTex.dispose();
      nrmTex.dispose();
    },
  };
}

function makeTexture(data: Uint16Array, width: number, height: number): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
