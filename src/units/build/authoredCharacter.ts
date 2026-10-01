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
  /** Re-binds mis-weighted mesh islands onto the bone that should drive them. See `rebindIslands`. */
  rebind?: { dominatedBy: string; to: string; note?: string }[];
  /**
   * Prop bones to re-parent onto the bone that should carry them, named as they
   * appear in the file. See `attachProps`.
   *
   * `position` and `rotation` place the prop in the host bone's own space, in
   * metres and radians, and are needed whenever the file's own placement is
   * wrong rather than merely parented to the wrong bone. Leaving them out keeps
   * the pose the prop already holds.
   */
  attach?: {
    bone: string;
    to: string;
    position?: [number, number, number];
    rotation?: [number, number, number];
  }[];
}

/**
 * Character id -> file. A character absent from here uses the procedural
 * builder, which is what lets authored creatures arrive one at a time.
 */
export const AUTHORED_MANIFEST: Record<string, AuthoredEntry> = {
  'creep.cleaver': {
    url: '/models/orc.glb',
    height: 2.0,
    // Both axes are mis-bound in the file and neither follows the hand that
    // holds it. The conversion gave the right one to the hips and left the
    // left one on a bone that hangs off the spine, so they drift away from the
    // orc as it moves. Nothing is moved here, only re-bound: the artist
    // already placed them correctly in the bind pose.
    rebind: [
      { dominatedBy: 'ork_Hips', to: 'ork_RightHand', note: 'right axe' },
      { dominatedBy: 'ork_hammer_1', to: 'ork_LeftHand', note: 'left axe' },
    ],
  },
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

/**
 * Re-parents a prop bone onto the bone that should carry it, keeping the pose
 * it holds at bind, and drops the prop's own animation tracks.
 *
 * A weapon is rigid. The honest way to rig one is to hang it off the hand so it
 * follows for free, and plenty of rigs do not: they leave it on the chest and
 * key it to meet the hand in every clip. That works until something touches the
 * clips. Ours trims them, and trimming reduced this orc's hammer to one
 * keyframe in walk, run and attack and to none in death, which leaves the
 * weapon frozen against the torso while the arm moves.
 *
 * Hanging it off the hand makes the clips irrelevant to it, which is the
 * property a weapon should have had from the start. Its tracks have to go with
 * it: left in place they would drive the prop away from the hand it now
 * follows.
 */
function attachProps(
  root: THREE.Object3D,
  mesh: THREE.SkinnedMesh,
  clips: readonly THREE.AnimationClip[],
  attach: readonly {
    bone: string;
    to: string;
    position?: [number, number, number];
    rotation?: [number, number, number];
  }[],
): string[] {
  const done: string[] = [];
  const find = (name: string): THREE.Bone | undefined =>
    mesh.skeleton.bones.find((b) => b.name === name);

  for (const link of attach) {
    const prop = find(link.bone);
    const host = find(link.to);
    if (!prop || !host) continue;

    root.updateMatrixWorld(true);
    const local = new THREE.Matrix4().copy(host.matrixWorld).invert().multiply(prop.matrixWorld);
    host.add(prop);
    local.decompose(prop.position, prop.quaternion, prop.scale);
    // An explicit placement replaces the file's, but the scale stays: it holds
    // the unit conversion the whole character depends on.
    if (link.position) prop.position.fromArray(link.position);
    if (link.rotation) prop.quaternion.setFromEuler(new THREE.Euler(...link.rotation));

    for (const clip of clips) {
      clip.tracks = clip.tracks.filter((t) => t.name.split('.')[0] !== prop.name);
    }
    done.push(`${link.bone} -> ${link.to}`);
  }
  root.updateMatrixWorld(true);
  return done;
}

/**
 * Re-binds a mis-weighted island of mesh onto the bone that should drive it.
 *
 * This orc carries an axe in each hand, and in the converted file neither is
 * bound to the hand holding it. The right one is weighted to the hips; the left
 * one to a bone that hangs off the spine. Both therefore stay with the torso
 * while the arms move, which on screen is a weapon drifting beside the orc.
 *
 * The cause is upstream: the axes arrive as their own unskinned file
 * (`axe.fbx`) and the FBX merge had nothing to weight them to, so they fell to
 * whatever bone was at hand. The artist's bind pose is correct, though, and
 * that is the whole point of fixing it this way. Nothing here moves a vertex.
 * It changes which bone owns one, which is the only thing that was ever wrong,
 * and it leaves the weapons exactly where they were placed.
 *
 * An island is a connected component of the index buffer. A rule claims one
 * when nearly all of its vertices answer to the named bone, and the largest
 * island -- the body -- is never claimed, so naming a bone that also drives
 * real anatomy is safe.
 */
function rebindIslands(
  mesh: THREE.SkinnedMesh,
  rules: readonly { dominatedBy: string; to: string }[],
): { rule: string; verts: number }[] {
  const bones = mesh.skeleton.bones;
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const skinIndex = geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
  const skinWeight = geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
  const index = geometry.getIndex();
  if (!index) return [];

  const parent = new Int32Array(position.count);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let t = 0; t < index.count; t += 3) {
    union(index.getX(t), index.getX(t + 1));
    union(index.getX(t + 1), index.getX(t + 2));
  }

  const heaviest = (v: number): number => {
    let best = 0;
    let bone = -1;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(v, k);
      if (w > best) {
        best = w;
        bone = skinIndex.getComponent(v, k);
      }
    }
    return bone;
  };

  const islands = new Map<number, { verts: number[]; tally: Map<number, number> }>();
  for (let v = 0; v < position.count; v++) {
    const key = find(v);
    let island = islands.get(key);
    if (!island) {
      island = { verts: [], tally: new Map() };
      islands.set(key, island);
    }
    island.verts.push(v);
    const bone = heaviest(v);
    if (bone >= 0) island.tally.set(bone, (island.tally.get(bone) ?? 0) + 1);
  }
  const body = Math.max(...[...islands.values()].map((i) => i.verts.length));

  const applied: { rule: string; verts: number }[] = [];
  for (const rule of rules) {
    const from = bones.findIndex((b) => b.name === rule.dominatedBy);
    const to = bones.findIndex((b) => b.name === rule.to);
    if (from < 0 || to < 0) continue;
    let moved = 0;
    for (const island of islands.values()) {
      if (island.verts.length === body) continue;
      if ((island.tally.get(from) ?? 0) < island.verts.length * 0.9) continue;
      for (const v of island.verts) {
        skinIndex.setXYZW(v, to, 0, 0, 0);
        skinWeight.setXYZW(v, 1, 0, 0, 0);
        moved++;
      }
    }
    if (moved) applied.push({ rule: `${rule.dominatedBy} -> ${rule.to}`, verts: moved });
  }
  if (applied.length) {
    skinIndex.needsUpdate = true;
    skinWeight.needsUpdate = true;
  }
  return applied;
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
        if (entry.attach) attachProps(root, skinned, gltf.animations, entry.attach);
        if (entry.rebind) rebindIslands(skinned, entry.rebind);

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

        const material = Array.isArray(skinned.material) ? skinned.material[0]! : skinned.material;
        // Tone mapping happens in the composer, so an imported colour map has
        // to be flagged sRGB or the whole character renders washed out.
        const std = material as THREE.MeshStandardMaterial;
        if (std.map) std.map.colorSpace = THREE.SRGBColorSpace;

        loaded.set(id, { root, mesh: skinned, clips, materials: [material] });
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
