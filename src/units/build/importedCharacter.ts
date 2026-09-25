/**
 * Binds an imported (unrigged) mesh to our own procedural skeleton.
 *
 * ## Why this exists
 *
 * Image-to-3D generators return a single unrigged blob: no bones, no weights,
 * no animation. The obvious next step is an external auto-rigger, and that path
 * kept failing — Tripo's rig step errored outright, and Mixamo rejected the same
 * mesh at the marker stage. Both fail for the same underlying reason: a shield
 * and a hammer fused into the silhouette, on dense unclean topology, is not the
 * clean humanoid their detectors expect.
 *
 * But we already own a skeleton and a full set of animation clips, and
 * `computeSkinWeights` already derives weights from bone-segment proximity. So
 * instead of asking an external tool to invent a skeleton that matches the mesh,
 * we fit the mesh to the skeleton we control. No accounts, no uploads, no manual
 * marker placement, and every clip we already author works immediately.
 *
 * ## What this does not do
 *
 * Proximity weighting is not the same as an artist's weight paint. It handles a
 * roughly upright humanoid well; it will smear on anything whose limbs are close
 * together, and a prop welded to the body (a shield against a forearm) will be
 * partly driven by the nearest limb bone, which is usually the right answer and
 * occasionally a visible one.
 *
 * The mesh must be normalised into the rig's own space first — see `fitToRig`.
 */

import * as THREE from 'three';
import { buildRig, computeSkinWeights, type Rig } from '../rig/rig';
import { getCharacter, registerBuiltOverride } from '../catalog';
import { loadModel, MODEL_MANIFEST } from '@/assets/models';

/** Every bone is a candidate influence; the weighting keeps the best four. */
function allBoneNames(rig: Rig): string[] {
  return Object.keys(rig.index);
}

export interface ImportOptions {
  /**
   * Target height in metres. The mesh is uniformly scaled so its bounding box
   * matches, which is what lets a generated model — always normalised to
   * roughly one unit — line up with a rig authored in metres.
   */
  height?: number;
  /** Extra yaw in radians for a model not authored facing -Z. */
  yawOffset?: number;
  /** Gaussian falloff for the weighting, in metres. Wider = softer joints. */
  falloff?: number;
}

/**
 * Normalises an imported scene into rig space and returns one merged geometry.
 *
 * Bakes every node transform, recentres on the ground plane at the origin, and
 * scales to the requested height. Skinning needs vertices in the same space the
 * bones live in; a mesh still carrying its own scene transform would be weighted
 * against bones it does not overlap, and every vertex would grab the wrong bone.
 */
export function fitToRig(
  source: THREE.Object3D,
  options: ImportOptions = {},
): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  source.updateWorldMatrix(true, true);
  source.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const geo = node.geometry.clone().applyMatrix4(node.matrixWorld);
    geometries.push(geo.index ? geo.toNonIndexed() : geo);
    const material = Array.isArray(node.material) ? node.material[0]! : node.material;
    if (material && !materials.includes(material)) materials.push(material);
  });

  if (geometries.length === 0) {
    throw new Error('fitToRig: imported object contains no meshes');
  }

  const merged = concatGeometries(geometries);
  merged.computeBoundingBox();
  const box = merged.boundingBox!;

  const currentHeight = box.max.y - box.min.y;
  const scale = options.height && currentHeight > 0 ? options.height / currentHeight : 1;

  // Recentre on X/Z and sit the lowest point at y=0 before scaling, so the
  // result is pivoted at the feet regardless of how the source was authored.
  merged.translate(
    -(box.min.x + box.max.x) / 2,
    -box.min.y,
    -(box.min.z + box.max.z) / 2,
  );
  if (scale !== 1) merged.scale(scale, scale, scale);
  if (options.yawOffset) merged.rotateY(options.yawOffset);
  merged.computeBoundingBox();
  // Needed by anything that culls or pads bounds; HeroView reads it directly.
  merged.computeBoundingSphere();

  // One group spanning the whole mesh.
  //
  // Not cosmetic. `HeroView` builds its SkinnedMesh with an *array* of
  // materials, and three's renderer only walks `geometry.groups` in that case:
  //
  //   if (Array.isArray(material)) for (const g of geometry.groups) { …push… }
  //
  // A geometry with no groups therefore renders nothing at all — no error, no
  // warning, just an invisible mesh that is present, visible, correctly
  // positioned and correctly skinned. Procedurally built characters get their
  // groups from CharacterBuilder; a merged import has to declare its own.
  merged.addGroup(0, merged.getAttribute('position').count, 0);

  return { geometry: merged, materials };
}

/**
 * Attaches skin attributes so the geometry can be driven by `rig`.
 *
 * Weights every vertex against the full bone list rather than a per-part bind:
 * an imported mesh is one undifferentiated blob, so there is no authored mapping
 * from surface region to bone the way there is for a procedurally built part.
 */
export function skinToRig(
  geometry: THREE.BufferGeometry,
  rig: Rig,
  options: ImportOptions = {},
): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const { index, weight } = computeSkinWeights(rig, position.array, position.count, {
    bones: allBoneNames(rig),
    falloff: options.falloff ?? 0.22,
  });
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(index, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weight, 4));
  return geometry;
}

/** Convenience: normalise, then skin, in one call. */
export function buildImportedCharacter(
  source: THREE.Object3D,
  rig: Rig,
  options: ImportOptions = {},
): { geometry: THREE.BufferGeometry; materials: THREE.Material[] } {
  const fitted = fitToRig(source, options);
  skinToRig(fitted.geometry, rig, options);
  return fitted;
}

/**
 * Boot pass: loads every manifested model, binds it to that character's own rig,
 * and registers the result so `buildCharacter` returns it instead of building
 * procedurally.
 *
 * Runs once, before anything spawns. Never rejects — a model that fails to load
 * or bind leaves its character on the procedural path, which is the whole point
 * of the fallback: a broken asset must not be able to break the game.
 */
export async function prepareImportedCharacters(
  onProgress?: (id: string, ok: boolean) => void,
): Promise<void> {
  const ids = Object.keys(MODEL_MANIFEST);
  for (const id of ids) {
    try {
      const model = await loadModel(id);
      const def = getCharacter(id);
      if (!model || !def) {
        onProgress?.(id, false);
        continue;
      }

      // The rig is built from the character's authored proportions, not from
      // the mesh: the mesh is being fitted to our skeleton, not the reverse.
      const rig = buildRig(def.proportions);
      // `def.visual.scale` is the gameplay scale applied per unit at render
      // time, so the mesh is normalised to the rig's own nominal height here and
      // scaled again downstream — otherwise the scale lands twice.
      const built = buildImportedCharacter(model.scene, rig, {
        height: measureRigHeight(rig),
        yawOffset: model.yawOffset,
      });

      registerBuiltOverride(id, {
        def,
        rig,
        geometry: built.geometry,
        materials: built.materials.filter(
          (m): m is THREE.MeshStandardMaterial => m instanceof THREE.MeshStandardMaterial,
        ),
      });
      onProgress?.(id, true);
    } catch (err) {
      console.warn(`[importedCharacter] ${id}: bind failed, staying procedural`, err);
      onProgress?.(id, false);
    }
  }
}

/**
 * Measures how tall a rig actually is, from its own bones.
 *
 * Not a constant. The first version normalised imported meshes to an assumed
 * 1.8 m and the hero rendered as nothing: the rig for these proportions spans
 * Y from -0.05 to 2.38, so the mesh was 26% shorter than the skeleton driving
 * it and every vertex bound to a bone well above where it sat. A mesh has to be
 * fitted to the skeleton it will be deformed by, and the only reliable source
 * for that height is the skeleton.
 */
function measureRigHeight(rig: Rig): number {
  let lo = Infinity;
  let hi = -Infinity;
  const p = new THREE.Vector3();
  for (const name of allBoneNames(rig)) {
    const bone = rig.bones[rig.index[name]!];
    if (!bone) continue;
    bone.updateWorldMatrix(true, false);
    bone.getWorldPosition(p);
    if (p.y < lo) lo = p.y;
    if (p.y > hi) hi = p.y;
  }
  // Bones mark joints, not the silhouette: the skull top and the sole sit
  // beyond the outermost joint, so a bare joint span under-measures the figure.
  const span = hi - lo;
  return Number.isFinite(span) && span > 0 ? span * 1.06 : 1.8;
}

/**
 * Concatenates non-indexed geometries sharing the same attribute set.
 *
 * Hand-rolled rather than pulling in BufferGeometryUtils: the imported meshes
 * here carry position/normal/uv and nothing else, and an addon import for three
 * attribute streams is not worth the dependency.
 */
function concatGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 1) return parts[0]!;

  let total = 0;
  for (const p of parts) total += p.getAttribute('position').count;

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let at = 0;

  for (const part of parts) {
    const p = part.getAttribute('position');
    const n = part.getAttribute('normal');
    const t = part.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      position[(at + i) * 3] = p.getX(i);
      position[(at + i) * 3 + 1] = p.getY(i);
      position[(at + i) * 3 + 2] = p.getZ(i);
      if (n) {
        normal[(at + i) * 3] = n.getX(i);
        normal[(at + i) * 3 + 1] = n.getY(i);
        normal[(at + i) * 3 + 2] = n.getZ(i);
      }
      if (t) {
        uv[(at + i) * 2] = t.getX(i);
        uv[(at + i) * 2 + 1] = t.getY(i);
      }
    }
    at += p.count;
    part.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}
