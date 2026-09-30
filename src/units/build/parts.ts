/**
 * Imported rigid parts. Owner: CHARACTERS.
 *
 * A generated mesh cannot be skinned onto our skeleton: it is authored in its
 * own A-pose with its own limb lengths, our rig's bind pose is different, and
 * the surface collapses toward the bones. That is why `MODEL_MANIFEST` in
 * `assets/models.ts` is still empty.
 *
 * But that failure only applies to geometry that has to *deform*. A head does
 * not deform here, because there is no facial animation. Neither does a helmet,
 * a weapon, a pair of horns, a shoulder plate or a wing held rigid. Those can
 * be authored at any detail, bound at weight 1.0 to a single bone, and they
 * will ride that bone exactly as a procedural part does.
 *
 * Which is the whole point: a rigid part is not a new rendering path. It is an
 * ordinary `BufferGeometry` handed to `CharacterBuilder.add` with
 * `bind.rigid`, so it flows through the slot materials, the faction colour law,
 * the VAT bake and the instanced creep renderer without any of them learning
 * that it came from a file. `Bind.rigid` already existed for armour that must
 * not deform; this reuses it rather than inventing a parallel mechanism.
 *
 * It also targets exactly what fails legibility. At the measured viewing
 * distance -- 41.5 px per world metre, a 1.9 m character 79 px tall -- identity
 * lives in the head and the weapon outline. A 500-triangle generated head buys
 * more than any amount of extra body detail.
 *
 * ## Conventions an imported part must follow
 *
 * - **glTF 2.0 binary** (`.glb`).
 * - **Y up, -Z forward**, same as the rig. `rot` corrects anything else.
 * - **Origin at the joint it hangs from**, not at the mesh's centre. A head's
 *   origin belongs at the base of the neck. `centre` recentres a mesh that was
 *   exported around its bounding box instead.
 * - **Triangle budget.** Creeps are VAT-baked and the bake stores every vertex
 *   for every frame, so a part costs memory per frame even though it is rigid.
 *   Keep heads near 500 triangles; they are 15 px tall on screen.
 *
 * Licences for everything under `public/models/` are recorded in
 * `public/models/LICENSES.md`. An asset without a recorded licence must not be
 * used -- see the asset policy in ARCHITECTURE.md.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export interface PartEntry {
  /** Path under `public/`, e.g. `/models/parts/orc-head.glb`. */
  url: string;
  /** Uniform scale applied at load, normalising the authoring units to metres. */
  scale?: number;
  /** XYZ Euler in radians, applied at load for a part authored facing elsewhere. */
  rot?: [number, number, number];
  /**
   * Recentres the mesh on its own bounding box before placement. Generated
   * meshes are usually centred rather than pivoted where they attach, so
   * without this a head hangs off the neck by half its own size.
   */
  centre?: boolean;
}

/**
 * Part id -> file. Empty until assets land, and that is the working state, not
 * a broken one: `CharacterBuilder.addImported` returns false for an id that is
 * not here, the recipe keeps its procedural part, and nothing else notices. It
 * is what lets heads arrive one creature at a time instead of in a big bang.
 */
export const PART_MANIFEST: Record<string, PartEntry> = {
  'creep.cleaver.head': { url: '/models/parts/orc-head.glb' },
  'creep.cleaver.torso': { url: '/models/parts/orc-torso.glb' },
};

const loader = new GLTFLoader();
const geometries = new Map<string, THREE.BufferGeometry>();
const warned = new Set<string>();

/**
 * Collapses every mesh in a loaded file into one geometry in part space.
 *
 * Node transforms are baked into the vertices rather than kept on a parent,
 * because the result is merged into a character's single geometry and there is
 * no node left to carry them.
 */
function flatten(root: THREE.Object3D, entry: PartEntry): THREE.BufferGeometry | null {
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const geo = (node.geometry as THREE.BufferGeometry).clone();
    geo.applyMatrix4(node.matrixWorld);
    // Only the attributes the character builder consumes; anything else would
    // fail to merge against parts that do not have it.
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    }
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    if (!geo.getAttribute('uv')) {
      const count = geo.getAttribute('position').count;
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    }
    parts.push(geo.index ? geo.toNonIndexed() : geo);
  });
  if (parts.length === 0) return null;

  const merged = new THREE.BufferGeometry();
  const total = parts.reduce((n, g) => n + g.getAttribute('position').count, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let v = 0;
  for (const g of parts) {
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++, v++) {
      position[v * 3] = p.getX(i);
      position[v * 3 + 1] = p.getY(i);
      position[v * 3 + 2] = p.getZ(i);
      normal[v * 3] = n.getX(i);
      normal[v * 3 + 1] = n.getY(i);
      normal[v * 3 + 2] = n.getZ(i);
      uv[v * 2] = t.getX(i);
      uv[v * 2 + 1] = t.getY(i);
    }
    g.dispose();
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));

  if (entry.rot) {
    merged.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...entry.rot)));
  }
  if (entry.scale !== undefined && entry.scale !== 1) merged.scale(entry.scale, entry.scale, entry.scale);
  if (entry.centre) merged.center();
  merged.computeVertexNormals();
  return merged;
}

/** Geometry for a part id, or null when it has no entry or failed to load. */
export function getPart(id: string): THREE.BufferGeometry | null {
  return geometries.get(id) ?? null;
}

export function hasPart(id: string): boolean {
  return geometries.has(id);
}

/** Triangle count, for keeping an eye on the VAT budget. */
export function partTriangles(id: string): number {
  const geo = geometries.get(id);
  return geo ? geo.getAttribute('position').count / 3 : 0;
}

/**
 * Loads every manifested part.
 *
 * Must finish before characters are built, because building is synchronous and
 * a part that arrives late would simply be missing from a mesh already baked
 * into a VAT texture. Never rejects: a part that fails to load leaves the
 * recipe on its procedural fallback.
 */
export async function preloadParts(): Promise<void> {
  await Promise.all(
    Object.entries(PART_MANIFEST).map(async ([id, entry]) => {
      try {
        const gltf = await loader.loadAsync(entry.url);
        const geo = flatten(gltf.scene, entry);
        if (geo) geometries.set(id, geo);
        else if (!warned.has(id)) {
          warned.add(id);
          console.warn(`[parts] ${id}: ${entry.url} has no mesh, using the procedural part`);
        }
      } catch (err) {
        if (!warned.has(id)) {
          warned.add(id);
          console.warn(`[parts] ${id}: could not load ${entry.url}, using the procedural part`, err);
        }
      }
    }),
  );
}

/** Test seam: lets a harness inject a part without a manifest entry or a fetch. */
export function registerPart(id: string, geometry: THREE.BufferGeometry): void {
  geometries.set(id, geometry);
}
