/**
 * glTF model pipeline. Owner: CHARACTERS.
 *
 * Loads authored character models and maps their animation clips onto the clip
 * names the game already drives (`idle`, `walk`, `run`, `attack`, `cast`,
 * `death`). Everything downstream — `UnitViewModule`, the animator, gameplay —
 * keeps talking in those names and never learns where a mesh came from.
 *
 * ## Falling back is a feature, not a safety net
 *
 * A character with no entry here, or whose file is missing, silently falls back
 * to the procedural builder. That is what lets assets arrive one at a time: drop
 * `bulwark.glb` into `public/models/`, add its manifest row, and that one hero
 * upgrades while the rest keep working. No big-bang migration, and the game is
 * never broken by a half-finished art pass.
 *
 * ## Conventions an imported model must follow
 *
 * - **glTF 2.0 binary** (`.glb`), so textures ride inside one file.
 * - **Y up, -Z forward.** `yawOffset` corrects a model authored facing another
 *   way; it is applied once at load, not per frame.
 * - **Origin at the feet**, centred on the ground plane. Units are placed by
 *   their feet, so a model pivoted at the hips floats or sinks.
 * - **Metres.** `scale` normalises a model authored in another unit; the target
 *   is roughly 1.8 m for a human-sized hero.
 *
 * Licences for everything in `public/models/` are recorded in
 * `public/models/LICENSES.md`. An asset without a recorded licence must not be
 * used — see the asset policy in ARCHITECTURE.md.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { ClipId } from '@/units/anim/clips';

export interface ModelEntry {
  /** Path under `public/`, e.g. `/models/bulwark.glb`. */
  url: string;
  /** Uniform scale applied at load to normalise authoring units. */
  scale: number;
  /** Yaw correction in radians for models not authored facing -Z. */
  yawOffset?: number;
  /**
   * Vertical correction in model units, applied before `scale`.
   *
   * Generated meshes are almost always centred on their bounding box rather
   * than pivoted at the feet, so they sink half their height into the ground.
   * `tools/fetch-asset.mjs` prints the measured `min Y`; negate it here.
   */
  originOffset?: number;
  /**
   * Maps our clip ids onto the clip names inside the file. A missing entry
   * falls back to `idle`, so a model that only ships a walk cycle still works.
   */
  clips?: Partial<Record<ClipId, string>>;
}

export interface LoadedModel {
  scene: THREE.Group;
  /** Clips already renamed to our ids, ready for an AnimationMixer. */
  clips: Map<ClipId, THREE.AnimationClip>;
  scale: number;
  yawOffset: number;
}

/**
 * Character id → model. Empty until assets land; every id absent from this map
 * uses the procedural builder.
 *
 * Ids match `src/units/catalog.ts` (`hero.bulwark`, `creep.cleaver`, …).
 */
export const MODEL_MANIFEST: Record<string, ModelEntry> = {
  // Deliberately empty. `bulwark.glb` is downloaded and the whole path works —
  // it loads, binds to our skeleton, and renders — but the result is a crumpled
  // blob, so shipping it would be worse than the procedural build it replaces.
  //
  // The reason is bind-pose mismatch, not a bug in the loading path. Skinning
  // assumes a mesh is authored in the same pose the skeleton's inverse-bind
  // matrices describe. A generated mesh is in *its own* A-pose, with its own
  // limb lengths and arm angles; our rig's bind pose is different. Proximity
  // weighting picks a sensible nearest bone for each vertex, and then
  // `bone.matrixWorld * boneInverse` maps it from a pose the mesh was never in,
  // so the surface collapses toward the bones.
  //
  // Fixing it means fitting the *rig to the mesh* — measuring the mesh's limbs
  // and moving the joints inside it — which is what an auto-rigger does. See
  // docs/AI_ASSET_WORKFLOW.md.
  //
  // Structures do not have this problem and are already in use: they are static,
  // so they never touch a skeleton. See STRUCTURE_MODELS in world/structures.ts.
};

const loader = new GLTFLoader();
const cache = new Map<string, Promise<LoadedModel | null>>();
/** Ids already reported as missing, so a 404 is logged once, not every spawn. */
const warned = new Set<string>();

export function hasModel(characterId: string): boolean {
  return MODEL_MANIFEST[characterId] !== undefined;
}

/**
 * Loads and caches a character model. Resolves to null when the character has
 * no manifest entry or the file cannot be fetched — callers fall back to the
 * procedural builder.
 */
export function loadModel(characterId: string): Promise<LoadedModel | null> {
  const cached = cache.get(characterId);
  if (cached) return cached;

  const entry = MODEL_MANIFEST[characterId];
  if (!entry) {
    const miss = Promise.resolve(null);
    cache.set(characterId, miss);
    return miss;
  }

  const promise = loader
    .loadAsync(entry.url)
    .then((gltf): LoadedModel => {
      const scene = gltf.scene;
      scene.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        node.castShadow = true;
        node.receiveShadow = true;
        // Imported materials often ship with a colour space that assumes an
        // sRGB output pipeline. Ours tone-maps in the composer, so textures
        // must be flagged sRGB or every model reads washed out.
        const material = node.material as THREE.MeshStandardMaterial;
        if (material?.map) material.map.colorSpace = THREE.SRGBColorSpace;
        if (material?.emissiveMap) material.emissiveMap.colorSpace = THREE.SRGBColorSpace;
      });

      const clips = new Map<ClipId, THREE.AnimationClip>();
      const byName = new Map(gltf.animations.map((c) => [c.name, c]));
      for (const [id, name] of Object.entries(entry.clips ?? {})) {
        const clip = byName.get(name);
        if (clip) clips.set(id as ClipId, clip);
      }
      // Unmapped ids fall back to whatever the file calls its first clip, so a
      // model with one animation still moves rather than standing frozen.
      if (clips.size === 0 && gltf.animations.length > 0) {
        clips.set('idle', gltf.animations[0]!);
      }

      // Lift the mesh so its lowest point sits at y=0. Units are placed by their
      // feet; a model centred on its bounding box sinks half its height.
      if (entry.originOffset) scene.position.y = entry.originOffset;

      return {
        scene,
        clips,
        scale: entry.scale,
        yawOffset: entry.yawOffset ?? 0,
      };
    })
    .catch((err: unknown) => {
      if (!warned.has(characterId)) {
        warned.add(characterId);
        console.warn(
          `[models] ${characterId}: could not load ${entry.url}, using the procedural builder`,
          err,
        );
      }
      return null;
    });

  cache.set(characterId, promise);
  return promise;
}

/**
 * Pre-loads every manifested model.
 *
 * Called during boot so the first spawn of a wave does not stall on a fetch —
 * a hitch at the moment forty creeps appear is exactly when it is least
 * affordable. Never rejects: a failed model degrades to procedural.
 */
export async function preloadModels(
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const ids = Object.keys(MODEL_MANIFEST);
  let done = 0;
  await Promise.all(
    ids.map(async (id) => {
      await loadModel(id);
      onProgress?.(++done, ids.length);
    }),
  );
}
