/**
 * Authored characters. Owner: CHARACTERS.
 *
 * A character that arrives from an artist already has the three things this
 * project generates badly: a skeleton placed by hand, skin weights painted by
 * hand, and animation authored rather than derived. The sensible thing is to
 * use all three and contribute nothing.
 *
 * So this path does not touch `rig/rig.ts`, `anim/clips.ts` or the proximity
 * weighting. It loads the file, normalises it to the roster's height, and hands
 * the mesh and its own clips to `bakeImportedVat`, which produces exactly the
 * textures the instanced creep renderer already consumes. Everything downstream
 * is unchanged.
 *
 * ## What a file has to arrive as
 *
 * - **One GLB**, mesh and texture together.
 * - **Under 16,384 vertices**, and realistically far under: the vertex
 *   animation texture is one texel per vertex per frame, so a creature's whole
 *   animation set costs `vertices x frames x 16` bytes. Around 2,000 vertices
 *   is 6 MB, which is the same order as a procedural creep.
 * - **Clips named with our ids** (`idle`, `walk`, `run`, `attack`, `cast`,
 *   `hit`, `death`). A missing id falls back to `idle`.
 *
 * Downloads rarely arrive that way. `tools/` holds the conversion: merge the
 * submeshes, weld (a split FBX commonly carries six times the vertices it
 * needs), decimate carrying the skin attributes, trim each clip to the window
 * that actually holds motion, and write one GLB.
 *
 * Licences for everything under `public/models/` are recorded in
 * `public/models/LICENSES.md`. An asset without a recorded licence must not be
 * used -- see the asset policy in ARCHITECTURE.md.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CLIP_IDS, type ClipId } from '../anim/clips';
import type { ImportedSource } from '../anim/vatImported';

export interface AuthoredEntry {
  url: string;
  /** Height in metres the character is scaled to, measured on its own box. */
  height: number;
  /** Yaw in radians for a character not authored facing -Z. */
  yawOffset?: number;
}

/**
 * Character id -> file. A character absent from here uses the procedural
 * builder, which is what lets authored creatures arrive one at a time.
 */
export const AUTHORED_MANIFEST: Record<string, AuthoredEntry> = {
  'creep.cleaver': { url: '/models/orc.glb', height: 2.0 },
};

export interface AuthoredCharacter extends ImportedSource {
  materials: THREE.Material[];
}

/**
 * Collapses the empty wrapper chains a merged FBX leaves in front of every
 * bone.
 *
 * The conversion in tools/ merges one FBX per animation, and each merge left
 * an empty Object3D in front of every bone. They nest, so the real ork_Hips
 * sits at the end of a chain of forty ork_Hips_N wrappers, and the same holds
 * for all 136 bones: 5,684 nodes to express a skeleton of 136.
 *
 * That cost lands twice. Every clone of the character allocates and walks all
 * 5,684 nodes each frame, which is what made five orcs stutter. And three
 * binds animation tracks to nodes BY NAME, so the wrappers put eleven bone
 * names in play twice and a track could bind to a node that drives no
 * vertices, which is the likeliest reason a weapon stops following the hand.
 *
 * Splicing out every wrapper takes the orc to 371 nodes with no duplicated
 * bone name left, no animation track unresolved, and the walk stride
 * unchanged at 0.328 m. A node is only spliced when it is not a bone, not a
 * mesh, has exactly one child, and is named by no animation track, so this is
 * safe on a file that does not have the problem: nothing matches and nothing
 * moves.
 *
 * The asset should really be exported without them. This runs at load because
 * it is cheap, it is general, and it does not need the file rebuilt.
 */
function pruneToSkeleton(
  root: THREE.Object3D,
  mesh: THREE.SkinnedMesh,
  clips: readonly THREE.AnimationClip[],
): number {
  const bones = new Set<THREE.Object3D>(mesh.skeleton.bones);
  // A node an animation track names has to survive, whatever else it looks
  // like, or the track silently stops driving anything.
  const animated = new Set<string>();
  for (const clip of clips) {
    for (const track of clip.tracks) animated.add(track.name.split('.')[0]!);
  }

  const splice = (node: THREE.Object3D): boolean => {
    const parent = node.parent;
    if (!parent || node === root) return false;
    if (bones.has(node) || (node as THREE.Mesh).isMesh) return false;
    if (node.children.length !== 1) return false;
    if (animated.has(node.name)) return false;
    const child = node.children[0]!;

    // Only an identity wrapper may go, and that restriction is not caution, it
    // is correctness. Folding a wrapper's transform into its child lasts
    // exactly until an animation track writes that child's position and
    // quaternion, which it does every frame, throwing the folded-in value away.
    // The body survived it because these wrappers are identity; anything that
    // was not would have been silently dropped, which is how the props ended up
    // detached from the orc.
    node.updateMatrix();
    const e = node.matrix.elements;
    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let i = 0; i < 16; i++) if (Math.abs(e[i]! - IDENTITY[i]!) > 1e-6) return false;

    parent.add(child);
    node.removeFromParent();
    return true;
  };

  let removed = 0;
  // Repeat until the tree stops shrinking: the chains are nested, so collapsing
  // one link exposes the next.
  for (;;) {
    const candidates: THREE.Object3D[] = [];
    root.traverse((o) => candidates.push(o));
    let cut = 0;
    for (const node of candidates) if (splice(node)) cut++;
    removed += cut;
    if (cut === 0) break;
  }
  return removed;
}

const loader = new GLTFLoader();
const loaded = new Map<string, AuthoredCharacter>();
const warned = new Set<string>();

export function hasAuthored(id: string): boolean {
  return loaded.has(id);
}

export function getAuthored(id: string): AuthoredCharacter | null {
  return loaded.get(id) ?? null;
}

/**
 * Loads every manifested character.
 *
 * Runs at boot, before anything can spawn, because the bake is synchronous and
 * a character that arrives late would simply be absent from a batch already
 * built. Never rejects: a file that fails to load leaves its creature on the
 * procedural builder.
 */
export async function preloadAuthored(): Promise<void> {
  await Promise.all(
    Object.entries(AUTHORED_MANIFEST).map(async ([id, entry]) => {
      try {
        const gltf = await loader.loadAsync(entry.url);
        const root = gltf.scene;
        let mesh: THREE.SkinnedMesh | null = null;
        root.traverse((o) => {
          if (!mesh && (o as THREE.SkinnedMesh).isSkinnedMesh) mesh = o as THREE.SkinnedMesh;
        });
        if (!mesh) throw new Error('no skinned mesh in the file');
        const skinned: THREE.SkinnedMesh = mesh;

        pruneToSkeleton(root, skinned, gltf.animations);

        root.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        root.scale.setScalar(entry.height / Math.max(size.y, 1e-6));
        if (entry.yawOffset) root.rotation.y += entry.yawOffset;
        root.updateMatrixWorld(true);

        const clips = new Map<ClipId, THREE.AnimationClip>();
        const byName = new Map(gltf.animations.map((c) => [c.name, c]));
        for (const cid of CLIP_IDS) {
          const clip = byName.get(cid);
          if (clip) clips.set(cid, clip);
        }
        if (clips.size === 0 && gltf.animations.length > 0) {
          clips.set('idle', gltf.animations[0]!);
        }
        if (clips.size === 0) throw new Error('no clips in the file');

        // A character can carry more than one material: this orc has one for
        // the body and one for its axes, each with its own texture, drawn as
        // two groups of the same mesh. Keeping only the first would leave the
        // second group's triangles pointing at a material that is not there.
        const materials = (
          Array.isArray(skinned.material) ? skinned.material : [skinned.material]
        ) as THREE.MeshStandardMaterial[];
        // Tone mapping happens in the composer, so an imported colour map has
        // to be flagged sRGB or the character renders washed out.
        for (const material of materials) {
          if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
        }

        loaded.set(id, { root, mesh: skinned, clips, materials });
      } catch (err) {
        if (!warned.has(id)) {
          warned.add(id);
          console.warn(
            `[authored] ${id}: could not load ${entry.url}, using the procedural builder`,
            err,
          );
        }
      }
    }),
  );
}
