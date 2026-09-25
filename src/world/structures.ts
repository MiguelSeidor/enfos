/**
 * Landmark architecture. Owner: TERRAIN.
 *
 * Builds the things the player is defending and using: the Core, the two shops,
 * the restoration fountain, the spawn portals and the preparation pad. Until
 * this existed those landmarks were flattened terrain and nothing else — the map
 * had a fountain and shops in its data that a player simply could not see.
 *
 * Everything is procedural geometry over the shared material library, merged per
 * landmark so a whole building is one draw call.
 *
 * Emissive intensities are deliberately kept just under the bloom threshold
 * (1.05, set in renderer.ts). The first pass ran them at 1.9–3.4 and the
 * fountain came out as a featureless white blob that swallowed the buildings
 * around it: past the threshold the bloom pass treats a surface as a light
 * source, and a light source the size of a pool is not a readable landmark.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GameContext, GameModule } from '@/core/contracts';
import { TerrainKey, type TerrainService } from '@/core/services';
import { materials } from '@/art/materials';
import { LANDMARKS, type Landmark, type LandmarkKind } from './layout';

/** Team 0 occupies the -X half; landmarks are authored in mirrored space. */
const SIGNS = [-1, 1] as const;

/**
 * Authored models per landmark, replacing the procedural primitives.
 *
 * `scale` is the world height we want divided by the model's own height, which
 * `tools/fetch-asset.mjs` measures and prints. `lift` re-pivots a mesh centred
 * on its bounding box down onto its feet — every generated model so far has
 * come back centred, so this is the rule rather than the exception.
 *
 * A landmark with no entry, or whose file fails to load, keeps its procedural
 * build. That is what lets art arrive one piece at a time without the map ever
 * being broken mid-pass.
 */
interface StructureModel {
  url: string;
  /** Target height in metres. */
  height: number;
  /** Model-space height, from the fetch tool's `bounds`. */
  modelHeight: number;
  /** Model-space `min Y`, negated to sit the mesh on the ground. */
  minY: number;
  /**
   * Multiplies the imported albedo. Below 1 pulls a bright asset back under the
   * bloom threshold.
   *
   * Generated models come out of image-to-3D with the reference image's
   * lighting partly baked into the texture, so a render lit for a neutral grey
   * studio arrives already near white. Under our sun that crosses the 1.05
   * threshold and the asset blooms into a glowing blob. Darkening the albedo is
   * the right lever rather than dimming the light: the map's other structures
   * are correctly exposed, and this is the one asset that is over-bright.
   */
  albedoScale?: number;
  /** Overrides the reflection strength. Lower calms a glossy imported material. */
  envMapIntensity?: number;
  /** Floor for the imported roughness; a too-shiny import reads as wet plastic. */
  minRoughness?: number;
  /**
   * Procedural detail added on top of the imported mesh.
   *
   * Image-to-3D reconstructs thin translucent things badly — the first fountain
   * came back with its four water jets fused into solid vertical bars, because
   * an 8 cm stream seen head-on is not distinguishable from a rod. Assets that
   * need one are generated without it and it is added here, where it can also
   * move. Reconstructors are bad at energy and water; engines are good at both.
   */
  overlay?: 'portalVeil';
}

const STRUCTURE_MODELS: Partial<Record<LandmarkKind, StructureModel>> = {
  core: { url: '/models/core.glb', height: 11, modelHeight: 1.001, minY: -0.501 },
  shopProgression: { url: '/models/shop-hero.glb', height: 7, modelHeight: 0.91, minY: -0.455 },
  shopSabotage: { url: '/models/shop-sabotage.glb', height: 7, modelHeight: 0.812, minY: -0.406 },
  // 4.5 m tall and, at the model's own 1.94:1 ratio, 8.7 m across — inside the
  // 11 m pad the fountain landmark carves, and deliberately shorter than the
  // shops (7 m) and the Core (11 m) so the basin stays something you walk to
  // rather than something you look at.
  fountain: {
    url: '/models/fountain.glb',
    height: 4.5,
    modelHeight: 0.5061,
    minY: -0.2528,
    // No `albedoScale` here, deliberately. The first pass needed 0.72 because
    // the reference render was lit for a neutral studio and arrived nearly
    // white; the regenerated asset was prompted for a mid-tone, under-exposed
    // texture and measures a mean luma of 67/255 with no near-white pixels at
    // all. Darkening it again would only mud it up. Fixing exposure in the
    // prompt beat correcting it in the material.
    envMapIntensity: 0.55,
    minRoughness: 0.5,
  },
  // 12 m tall, and 15.6 m across at the model's own 1.30:1 ratio — the same
  // span the procedural arch had, so the opening still swallows a wave walking
  // abreast. Generated deliberately *dry*: the archway is empty stone and the
  // energy veil is added below, because image-to-3D reconstructs thin
  // translucent things as solid bars (which is exactly what the first fountain
  // did to its water jets).
  spawnPortal: {
    url: '/models/portal.glb',
    height: 12,
    modelHeight: 0.7722,
    minY: -0.3879,
    envMapIntensity: 0.5,
    minRoughness: 0.55,
    overlay: 'portalVeil',
  },
  spawnPortalB: {
    url: '/models/portal.glb',
    height: 12,
    modelHeight: 0.7722,
    minY: -0.3879,
    envMapIntensity: 0.5,
    minRoughness: 0.55,
    overlay: 'portalVeil',
  },
};

interface Built {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

/** Stacked, slightly tapered stone drums — reads as a built plinth at any zoom. */
function plinth(radius: number, height: number, steps: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const r = radius * (1 - t * 0.28);
    const h = height / steps;
    const g = new THREE.CylinderGeometry(r * 0.94, r, h, 12, 1);
    g.translate(0, h * (i + 0.5), 0);
    parts.push(g);
  }
  return mergeAll(parts);
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Manual concat: BufferGeometryUtils would pull in an addon for what is a
  // handful of non-indexed position/normal/uv streams.
  //
  // Expand FIRST, then size the buffers. The counts differ: three's primitives
  // are indexed, so a BoxGeometry reports 24 positions but expands to 36. Sizing
  // from the indexed count under-allocated by a third, and because writes past
  // the end of a Float32Array are silently discarded rather than throwing, the
  // parts pushed last simply vanished — the portal lost its lintel and keystone
  // this way, and every other merged structure was losing its final pieces too.
  const expanded = parts.map((part) => {
    const src = part.toNonIndexed();
    if (src !== part) part.dispose();
    return src;
  });

  let vertexCount = 0;
  for (const p of expanded) vertexCount += p.attributes.position.count;

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  let vo = 0;

  for (const src of expanded) {
    const p = src.attributes.position as THREE.BufferAttribute;
    const n = src.attributes.normal as THREE.BufferAttribute;
    const t = src.attributes.uv as THREE.BufferAttribute | undefined;
    for (let i = 0; i < p.count; i++) {
      position[(vo + i) * 3] = p.getX(i);
      position[(vo + i) * 3 + 1] = p.getY(i);
      position[(vo + i) * 3 + 2] = p.getZ(i);
      normal[(vo + i) * 3] = n.getX(i);
      normal[(vo + i) * 3 + 1] = n.getY(i);
      normal[(vo + i) * 3 + 2] = n.getZ(i);
      uv[(vo + i) * 2] = t ? t.getX(i) : 0;
      uv[(vo + i) * 2 + 1] = t ? t.getY(i) : 0;
    }
    vo += p.count;
    src.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/** A squat keep with a pitched roof and a doorway recess. */
function shopBuilding(size: number, height: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const body = new THREE.BoxGeometry(size * 2, height, size * 1.6);
  body.translate(0, height / 2, 0);
  parts.push(body);

  // Roof: a 4-sided cone reads as a pitched roof and costs 8 triangles.
  const roof = new THREE.ConeGeometry(size * 1.65, height * 0.7, 4);
  roof.rotateY(Math.PI / 4);
  roof.translate(0, height + height * 0.35, 0);
  parts.push(roof);

  // Corner posts, so the silhouette is not a plain box at distance.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.BoxGeometry(size * 0.22, height * 1.12, size * 0.22);
      post.translate(sx * size * 0.94, height * 0.56, sz * size * 0.76);
      parts.push(post);
    }
  }
  return mergeAll(parts);
}

/**
 * Canvas-drawn textures for the portal veil.
 *
 * Built once and shared by every portal: there are four of them and the
 * textures are identical, so caching turns four 256² uploads into one. Drawn on
 * a canvas rather than synthesised through the material system because these
 * are pure alpha ramps with no tiling, lighting or normal component — the
 * material pipeline's toroidal noise would be paying for properties this
 * surface does not have.
 */
let veilTex: THREE.CanvasTexture | null = null;
let swirlTex: THREE.CanvasTexture | null = null;

function veilCanvas(size: number): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);
  return { canvas, g };
}

/** Bright at the centre, transparent at the rim, so the arch shows through. */
function portalVeilTexture(): THREE.CanvasTexture {
  if (veilTex) return veilTex;
  const size = 256;
  const { canvas, g } = veilCanvas(size);
  const r = size / 2;

  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, 'rgba(255, 244, 255, 1)');
  grad.addColorStop(0.28, 'rgba(198, 140, 255, 0.85)');
  grad.addColorStop(0.62, 'rgba(120, 62, 200, 0.34)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  veilTex = new THREE.CanvasTexture(canvas);
  veilTex.colorSpace = THREE.SRGBColorSpace;
  return veilTex;
}

/** Sparse radial streaks; rotating this is what makes the gate look open. */
function portalSwirlTexture(): THREE.CanvasTexture {
  if (swirlTex) return swirlTex;
  const size = 256;
  const { canvas, g } = veilCanvas(size);
  const r = size / 2;

  g.translate(r, r);
  g.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    // Deterministic jitter: the same texture every run keeps captures stable.
    const jitter = Math.sin(i * 12.9898) * 0.5;
    const inner = r * (0.18 + Math.abs(jitter) * 0.25);
    const outer = r * (0.62 + Math.abs(Math.cos(i * 4.1)) * 0.3);
    const grad = g.createLinearGradient(
      Math.cos(a) * inner, Math.sin(a) * inner,
      Math.cos(a) * outer, Math.sin(a) * outer,
    );
    grad.addColorStop(0, 'rgba(236, 214, 255, 0.75)');
    grad.addColorStop(1, 'rgba(90, 40, 160, 0)');
    g.strokeStyle = grad;
    g.lineWidth = 2 + Math.abs(jitter) * 4;
    g.beginPath();
    g.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    g.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
    g.stroke();
  }

  // Fade the rim to nothing so the rotating plane has no visible square edge.
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createRadialGradient(0, 0, 0, 0, 0, r);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.7, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = mask;
  g.fillRect(-r, -r, size, size);

  swirlTex = new THREE.CanvasTexture(canvas);
  swirlTex.colorSpace = THREE.SRGBColorSpace;
  return swirlTex;
}


/**
 * The energy curtain that fills an imported portal's archway.
 *
 * Sized from the model's own height. The generated asset is deliberately empty
 * stone — a reconstructor turns a translucent membrane into a solid slab — so
 * the gate is only a gate once this is in it.
 *
 * Two layers, as the procedural portal had: a masked sheet whose alpha falls
 * off at the edges so the jambs show through, and a counter-rotating swirl that
 * gives it motion. Both additive, so they brighten the stone behind rather than
 * painting over it.
 */
function portalVeil(height: number): { group: THREE.Group; swirl: THREE.Mesh } {
  const group = new THREE.Group();
  // Fractions of the model's height, read off the reference: the opening spans
  // roughly the lower three quarters, and is about as wide as it is tall.
  const openingH = height * 0.72;
  const openingW = height * 0.78;
  const centreY = height * 0.42;

  const gate = new THREE.Mesh(
    new THREE.PlaneGeometry(openingW, openingH),
    new THREE.MeshBasicMaterial({
      map: portalVeilTexture(),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.62,
      side: THREE.DoubleSide,
      color: 0x8f56d8,
    }),
  );
  gate.position.y = centreY;
  group.add(gate);

  const swirl = new THREE.Mesh(
    new THREE.PlaneGeometry(openingW * 0.82, openingH * 0.82),
    new THREE.MeshBasicMaterial({
      map: portalSwirlTexture(),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      opacity: 0.4,
      side: THREE.DoubleSide,
      color: 0xc79bff,
    }),
  );
  swirl.position.set(0, centreY, 0.06);
  group.add(swirl);

  return { group, swirl };
}

/** What a structure raycast found. */
export interface StructureHit {
  /** The tagged root the hit mesh belongs to — what `setHighlight` wants. */
  root: THREE.Object3D;
  kind: LandmarkKind;
  /** -1 for the local player's half of the map, +1 for the mirror. */
  sign: number;
  /** Distance along the ray, for comparing against a unit hit. */
  distance: number;
}

/**
 * Hit-tests the structures group.
 *
 * A true raycast against the real geometry, unlike unit picking, which has to
 * approximate with a screen-space disc because creeps are GPU-skinned and their
 * CPU-side geometry is a stale bind pose. Buildings are static meshes, so the
 * hitbox *is* the building — which is what was asked for: no more clicking a
 * patch of ground near a shop and hoping.
 */
export function pickStructure(
  raycaster: THREE.Raycaster,
  scene: THREE.Scene,
): StructureHit | null {
  const group = scene.getObjectByName('structures');
  if (!group) return null;

  for (const hit of raycaster.intersectObject(group, true)) {
    // Walk up to the tagged root: the hit is on some mesh deep inside an
    // imported model's hierarchy.
    let node: THREE.Object3D | null = hit.object;
    while (node && !node.userData.landmark) node = node.parent;
    if (!node) continue;
    const tag = node.userData.landmark as { kind: LandmarkKind; sign: number };
    return { root: node, kind: tag.kind, sign: tag.sign, distance: hit.distance };
  }
  return null;
}

export class StructuresModule implements GameModule {
  readonly id = 'structures';
  readonly order = 120;

  private readonly root = new THREE.Group();
  private terrain!: TerrainService;
  private readonly spinners: THREE.Object3D[] = [];
  private readonly veils: THREE.Mesh[] = [];
  /** Currently rim-lit structure, so the highlight can be cleared. */
  private highlighted: THREE.Object3D | null = null;
  private readonly geometries: THREE.BufferGeometry[] = [];
  private time = 0;
  /** Guards against a second `core:destroyed` re-shattering an already-dead Core. */
  private detonated = false;
  private readonly shards: { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  /**
   * The local player's Core, whichever way it was built.
   *
   * Held explicitly rather than found through `spinners`: the spinner list only
   * exists on the procedural fallback, and the Core normally loads from a GLB —
   * so keying the detonation off it meant the shipped Core never shattered.
   */
  private coreObject: THREE.Object3D | null = null;
  /** Expanding light shell and ground ring; null until the Core detonates. */
  private flash: THREE.Mesh | null = null;
  private ring: THREE.Mesh | null = null;
  private blastAge = 0;

  async init(ctx: GameContext): Promise<void> {
    this.root.name = 'structures';
    ctx.scene.add(this.root);
    this.terrain = ctx.services.get(TerrainKey);

    // The Core coming apart is the loss state made visible. Driven from the
    // event rather than polled, so it fires exactly once on the tick the last
    // life is spent.
    ctx.bus.on('core:destroyed', () => this.detonateCore(ctx));

    // Load the authored models first, so a landmark that has one never briefly
    // shows its procedural stand-in and then pops.
    const loader = new GLTFLoader();
    const loaded = new Map<LandmarkKind, THREE.Object3D>();
    await Promise.all(
      (Object.entries(STRUCTURE_MODELS) as [LandmarkKind, StructureModel][]).map(
        async ([kind, spec]) => {
          try {
            const gltf = await loader.loadAsync(spec.url);
            const scale = spec.height / spec.modelHeight;
            gltf.scene.traverse((node) => {
              if (!(node instanceof THREE.Mesh)) return;
              node.castShadow = true;
              node.receiveShadow = true;
              const material = node.material as THREE.MeshStandardMaterial;
              if (!material) return;
              // Imported maps default to linear; ours tone-maps in the composer,
              // so an unflagged albedo reads washed out.
              if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
              // Exposure corrections, applied only where a spec asks for them.
              // Multiplying `color` scales the sampled map, so this darkens the
              // texture without having to touch the texture itself.
              if (spec.albedoScale !== undefined) {
                material.color.multiplyScalar(spec.albedoScale);
              }
              if (spec.envMapIntensity !== undefined) {
                material.envMapIntensity = spec.envMapIntensity;
              }
              if (spec.minRoughness !== undefined) {
                material.roughness = Math.max(material.roughness, spec.minRoughness);
              }
            });
            gltf.scene.scale.setScalar(scale);
            gltf.scene.position.y = -spec.minY * scale;
            loaded.set(kind, gltf.scene);
          } catch (err) {
            console.warn(`[structures] ${kind}: ${spec.url} failed, using procedural`, err);
          }
        },
      ),
    );

    for (const sign of SIGNS) {
      for (const mark of LANDMARKS) {
        const model = loaded.get(mark.kind);
        if (model) {
          // clone(true) so both mirrored sites share geometry and materials but
          // get their own transforms.
          const holder = new THREE.Group();
          holder.add(model.clone(true));

          // Detail the reconstructor could not carry. Added to the holder, not
          // to the model clone, so it is unaffected by the model's own scale —
          // the veil is already sized in world metres.
          const spec = STRUCTURE_MODELS[mark.kind];
          if (spec?.overlay === 'portalVeil') {
            const { group, swirl } = portalVeil(spec.height);
            holder.add(group);
            this.veils.push(swirl);
          }

          this.place(holder, mark, sign);
          // Team 0 plays the -X half, so that is the Core the detonation is for.
          if (mark.kind === 'core' && sign === -1) this.coreObject = holder;
          continue;
        }
        this.build(mark, sign);
        if (mark.kind === 'core' && sign === -1) {
          this.coreObject = this.spinners[this.spinners.length - 1] ?? null;
        }
      }
    }
  }

  private place(object: THREE.Object3D, mark: Landmark, sign: number): void {
    const x = sign * mark.u;
    const z = mark.v;
    object.position.set(x, this.terrain.heightAt(x, z), z);
    object.castShadow = true;
    object.receiveShadow = true;

    // Tagged so a raycast hit anywhere in the subtree can be traced back to the
    // landmark it belongs to. `sign` matters: the two sites are mirrored and
    // only the local player's shops are usable.
    object.userData.landmark = { kind: mark.kind, sign };

    // Per-instance materials. `Object3D.clone()` shares material references, so
    // without this, highlighting the near shop would light up its mirror on the
    // far side of the map too. Eight structures is a negligible cost for
    // correctness here.
    object.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const src = node.material;
      const cloned = Array.isArray(src) ? src.map((m) => m.clone()) : src.clone();
      node.material = cloned;
      for (const m of Array.isArray(cloned) ? cloned : [cloned]) {
        const std = m as THREE.MeshStandardMaterial;
        if (std.emissive) std.userData.baseEmissive = std.emissive.getHex();
      }
    });

    this.root.add(object);
  }

  /**
   * Rim-lights a structure, or clears the highlight when passed null.
   *
   * Emissive rather than an outline pass: the renderer's pass order is already
   * documented and load-bearing, and threading a selective outline through it
   * costs a full-screen buffer for one hovered building. Boosting emissive on
   * the hovered instance reads as the same "this is live" cue the units get
   * from their ring, and it is free.
   */
  setHighlight(root: THREE.Object3D | null): void {
    if (this.highlighted === root) return;

    const apply = (obj: THREE.Object3D | null, on: boolean): void => {
      obj?.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const mats = Array.isArray(node.material) ? node.material : [node.material];
        for (const m of mats) {
          const std = m as THREE.MeshStandardMaterial;
          if (!std.emissive) continue;
          const base = (std.userData.baseEmissive as number | undefined) ?? 0x000000;
          // Kept well under the bloom threshold: this is a readable tint, not a
          // light source. Anything hotter and a hovered shop blooms into a blob,
          // which is the mistake the shop banners already taught.
          std.emissive.setHex(on ? 0x4a3a18 : base);
        }
      });
    };

    apply(this.highlighted, false);
    apply(root, true);
    this.highlighted = root;
  }

  private mesh(built: Built, mark: Landmark, sign: number): THREE.Mesh {
    const m = new THREE.Mesh(built.geometry, built.material);
    m.castShadow = true;
    m.receiveShadow = true;
    this.geometries.push(built.geometry);
    this.place(m, mark, sign);
    return m;
  }

  private build(mark: Landmark, sign: number): void {
    switch (mark.kind) {
      case 'core':
        this.buildCore(mark, sign);
        break;
      case 'fountain':
        this.buildFountain(mark, sign);
        break;
      case 'shopProgression':
        this.buildShop(mark, sign, 0xd8b45a, 'structure.gold');
        break;
      case 'shopSabotage':
        this.buildShop(mark, sign, 0x9a5fd0, 'structure.metal');
        break;
      case 'spawnPortal':
      case 'spawnPortalB':
        this.buildPortal(mark, sign);
        break;
      default:
        break;
    }
  }

  private buildCore(mark: Landmark, sign: number): void {
    this.mesh(
      {
        geometry: plinth(mark.radius * 0.72, 2.6, 3),
        material: materials.get('structure.masonry', { tiling: 3, key: 'core-base' }),
      },
      mark,
      sign,
    );

    // The crystal itself: a tall octahedron, emissive well above 1 so the bloom
    // threshold treats it as a light rather than a bright surface.
    const crystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(2.6, 0),
      new THREE.MeshStandardMaterial({
        color: 0x2b6cff,
        emissive: 0x4f9dff,
        emissiveIntensity: 0.42,
        roughness: 0.15,
        metalness: 0.1,
        toneMapped: true,
      }),
    );
    crystal.scale.set(1, 2.1, 1);
    crystal.position.y = 6.4;
    crystal.castShadow = true;
    const pivot = new THREE.Group();
    pivot.add(crystal);
    this.place(pivot, mark, sign);
    this.spinners.push(pivot);
  }

  /**
   * The restoration fountain.
   *
   * The first version read as a flat cyan disc on the ground, and the VFX agent
   * proved why by disabling its own layer and finding the disc unchanged: the
   * masonry was there, but a 0.8 m basin on a pad that the terrain flattens to
   * the same height leaves the stonework level with the ground. Only the water
   * plane, sitting 6 cm proud, was ever visible.
   *
   * So the whole structure now stands on a raised kerb, the basin is deep enough
   * to have an inner wall, and the water sits *below* the rim where a pool
   * belongs. The visible silhouette is stone; the water is what you see inside
   * it, not instead of it.
   */
  private buildFountain(mark: Landmark, sign: number): void {
    // Scaled down from the pad radius: at full 5.5 m the fountain out-massed
    // both shops and became the centrepiece of the base, which is the Core's
    // job. 0.68 keeps it a landmark you walk to, not the thing you look at.
    const r = mark.radius * 0.68;
    const KERB = 0.85;
    const WALL = 1.7;

    this.mesh(
      {
        geometry: (() => {
          const parts: THREE.BufferGeometry[] = [];

          // Three stepped courses, not two, each one inset from the one below.
          // The reference render reads as a *built* plinth because the steps
          // are broad and shallow — a wide skirt the eye can follow around the
          // whole circumference — where two tall drums read as a tub.
          const STEPS = [
            { rt: 1.3, rb: 1.38, h: 0.42, y: 0.21 },
            { rt: 1.17, rb: 1.24, h: 0.42, y: 0.63 },
            { rt: 1.04, rb: 1.11, h: 0.42, y: 1.05 },
          ];
          for (const s of STEPS) {
            const step = new THREE.CylinderGeometry(r * s.rt, r * s.rb, s.h, 28);
            step.translate(0, s.y, 0);
            parts.push(step);
          }

          // Outer wall of the basin, open at the top.
          const wall = new THREE.CylinderGeometry(r * 0.98, r * 1.02, WALL, 28, 1, true);
          wall.translate(0, KERB + WALL / 2, 0);
          parts.push(wall);

          // No inner wall: the water plane covers the inside, and mirroring a
          // cylinder to face its normals inward also mirrors its UVs, which put
          // a visibly reversed stone pattern on the one surface you look
          // straight down at.

          // Coping ring capping the wall.
          const coping = new THREE.TorusGeometry(r * 0.98, 0.34, 8, 32);
          coping.rotateX(Math.PI / 2);
          coping.translate(0, KERB + WALL, 0);
          parts.push(coping);

          // Floor of the basin.
          const floor = new THREE.CylinderGeometry(r * 0.88, r * 0.88, 0.3, 24);
          floor.translate(0, KERB + 0.15, 0);
          parts.push(floor);

          // ── Centrepiece, following the reference: an octagonal shaft banded
          //    top and bottom, carrying a shallow spill bowl.
          const SHAFT = 2.5;
          const shaftBase = KERB + 0.3;
          // 8 radial segments and a flat-shaded look: the facets *are* the
          // design, so a smooth 24-sided column would lose it entirely.
          const shaft = new THREE.CylinderGeometry(r * 0.3, r * 0.34, SHAFT, 8);
          shaft.translate(0, shaftBase + SHAFT / 2, 0);
          parts.push(shaft);

          // Bands where the reference puts bronze. Modelled as slightly proud
          // collars rather than painted on, so they catch the light and read at
          // the 40 m camera distance the art direction targets.
          for (const y of [shaftBase + 0.22, shaftBase + SHAFT - 0.22]) {
            const band = new THREE.CylinderGeometry(r * 0.37, r * 0.37, 0.34, 8);
            band.translate(0, y, 0);
            parts.push(band);
          }

          // Spill bowl: a wide shallow dish on a short neck.
          const neck = new THREE.CylinderGeometry(r * 0.22, r * 0.3, 0.4, 8);
          neck.translate(0, shaftBase + SHAFT + 0.2, 0);
          parts.push(neck);
          const bowl = new THREE.CylinderGeometry(r * 0.56, r * 0.24, 0.5, 20);
          bowl.translate(0, shaftBase + SHAFT + 0.65, 0);
          parts.push(bowl);
          const bowlRim = new THREE.TorusGeometry(r * 0.56, 0.13, 6, 20);
          bowlRim.rotateX(Math.PI / 2);
          bowlRim.translate(0, shaftBase + SHAFT + 0.9, 0);
          parts.push(bowlRim);

          // Four crystal housings on the coping at the cardinal points. Wedges
          // that sit on the rim and hang down the outer wall, as in the
          // reference — the crystals themselves are separate, because they are
          // emissive and this mesh is not.
          for (let i = 0; i < 4; i++) {
            const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
            const housing = new THREE.BoxGeometry(0.95, 1.15, 0.55);
            housing.translate(0, KERB + WALL - 0.35, r * 1.0);
            housing.rotateY(a);
            parts.push(housing);
          }

          return mergeAll(parts);
        })(),
        material: materials.get('structure.masonry', { tiling: 2.4, key: 'fountain' }),
      },
      mark,
      sign,
    );

    // Water sits inside the basin, below the coping. Not emissive: a lit,
    // low-roughness surface picks up the sky and the Core's glow on its own,
    // which is what makes it read as water rather than as a glowing plate.
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(r * 0.86, 28),
      new THREE.MeshStandardMaterial({
        color: 0x2a6076,
        // Low metalness and a restrained env intensity on purpose: at 0.35/1.6
        // the sky reflection ramped across the disc and the flat plane read as
        // a dome. Water seen from above wants a broad soft sheen, not a mirror.
        roughness: 0.22,
        metalness: 0.1,
        envMapIntensity: 0.7,
        transparent: true,
        opacity: 0.9,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = KERB + WALL * 0.72;
    const holder = new THREE.Group();
    holder.add(water);

    // Water in the upper bowl too. Small, but it is what tells you the thing is
    // running rather than a dry monument.
    const bowlWater = new THREE.Mesh(
      new THREE.CircleGeometry(r * 0.48, 20),
      (water.material as THREE.Material).clone(),
    );
    bowlWater.rotation.x = -Math.PI / 2;
    bowlWater.position.y = KERB + 0.3 + 2.5 + 0.86;
    holder.add(bowlWater);

    // No falling water, deliberately — neither here nor over the imported
    // model. Two attempts were made: tapered cylinders, and curved ribbons with
    // a scrolling streak texture. Both were rejected on sight, and they were
    // right to be: at this camera distance a stream is a handful of pixels
    // wide, so any geometry that reads at all reads as a solid rod, and any
    // geometry thin enough not to reads as nothing. The still pool and the full
    // upper bowl already say the fountain is running. Doing this properly wants
    // a particle system or a proper water shader, not another mesh.

    // The four crystals. Separate from the masonry mesh because they are
    // emissive and it is not; kept dim on purpose — at anything brighter they
    // clip the bloom threshold and turn into four white blobs.
    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0x2f7f96,
      emissive: 0x49c4e0,
      emissiveIntensity: 0.5,
      roughness: 0.25,
      metalness: 0.2,
    });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), crystalMat);
      crystal.position.set(
        Math.cos(a) * r * 1.0,
        KERB + WALL + 0.12,
        Math.sin(a) * r * 1.0,
      );
      crystal.scale.set(1, 0.62, 1);
      holder.add(crystal);
    }

    this.place(holder, mark, sign);
  }

  private buildShop(mark: Landmark, sign: number, accent: number, trim: string): void {
    this.mesh(
      {
        geometry: shopBuilding(mark.radius * 0.62, 5.2),
        material: materials.get('structure.masonry', { tiling: 2, key: 'shop' }),
      },
      mark,
      sign,
    );

    // A lit banner over the door: the only thing that distinguishes the two
    // shops at a glance, so it carries the accent colour of its currency.
    // 1.4 × 2.4 m, not 4 × 6. At pad-radius scale this was a billboard the size
    // of the building's wall, and a lit plane that big reads as a white panel
    // whatever its emissive is set to — the fix was never the glow, it was the
    // geometry.
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 2.4),
      new THREE.MeshStandardMaterial({
        color: accent,
        emissive: accent,
        // The render pipeline gained a highlight-shoulder pass that expands the
        // top of the range, so what used to sit safely under the bloom
        // threshold now clips. Banners are signage, not light sources.
        emissiveIntensity: 0.22,
        roughness: 0.6,
        side: THREE.DoubleSide,
      }),
    );
    banner.position.set(0, 3.4, mark.radius * 0.62);
    const holder = new THREE.Group();
    holder.add(banner);
    this.place(holder, mark, sign);
    void materials.get(trim as never, { key: 'shop-trim' });
  }

  private buildPortal(mark: Landmark, sign: number): void {
    this.mesh(
      {
        // Every part is derived from `half`, the leg separation. Previously the
        // legs were placed from `mark.radius * 0.55` and the lintel sized from
        // `mark.radius * 1.5` independently, so the two only agreed by accident
        // — at the portals' actual radius the lintel fell short of the columns
        // and hung in the air between them.
        geometry: (() => {
          const parts: THREE.BufferGeometry[] = [];
          const half = mark.radius * 0.62;
          const legTop = 1.1;
          const legBottom = 1.5;
          const legHeight = 9;

          for (const sx of [-1, 1]) {
            const leg = new THREE.CylinderGeometry(legTop, legBottom, legHeight, 10);
            leg.translate(sx * half, legHeight / 2, 0);
            parts.push(leg);

            // Plinth: gives each column a base so it meets the ground as
            // masonry rather than as a cylinder pushed into the dirt.
            const plinth = new THREE.BoxGeometry(legBottom * 2.4, 0.7, legBottom * 2.4);
            plinth.translate(sx * half, 0.35, 0);
            parts.push(plinth);

            // Capital, matching the plinth, so the lintel lands on something.
            const capital = new THREE.BoxGeometry(legTop * 2.6, 0.55, legTop * 2.6);
            capital.translate(sx * half, legHeight + 0.28, 0);
            parts.push(capital);
          }

          // Spans column centre to column centre plus each capital's half-width,
          // so it always rests on both.
          const lintelWidth = half * 2 + legTop * 2.6;
          const lintel = new THREE.BoxGeometry(lintelWidth, 1.5, 2.4);
          lintel.translate(0, legHeight + 1.3, 0);
          parts.push(lintel);

          // Keystone, centred on the lintel, to break the flat top edge.
          const keystone = new THREE.BoxGeometry(2.2, 1.5, 2.8);
          keystone.translate(0, legHeight + 2.4, 0);
          parts.push(keystone);

          return mergeAll(parts);
        })(),
        material: materials.get('structure.masonry', { tiling: 2, key: 'portal' }),
      },
      mark,
      sign,
    );

    // The veil used to be one opaque emissive plane, which at any close camera
    // read as a flat magenta billboard filling the arch — the single most
    // artificial thing on the map. It is now three parts: a masked gate whose
    // alpha falls off at the edges so the arch's stone shows through, a
    // counter-rotating swirl that gives it motion, and a rim glow that keeps
    // the silhouette readable from a distance without lighting the whole plane.
    const holder = new THREE.Group();
    // Fills the opening between the columns, derived from the same `half` the
    // arch is built from so the veil can never overhang the stone.
    const gateWidth = mark.radius * 1.24;

    const gate = new THREE.Mesh(
      new THREE.PlaneGeometry(gateWidth, 8.6, 1, 1),
      new THREE.MeshBasicMaterial({
        map: portalVeilTexture(),
        // Additive, so the veil brightens the stone behind it instead of
        // painting over it. Opacity then reads as depth rather than as paint.
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0.62,
        side: THREE.DoubleSide,
        color: 0x8f56d8,
      }),
    );
    gate.position.y = 4.4;
    holder.add(gate);

    const swirl = new THREE.Mesh(
      new THREE.PlaneGeometry(gateWidth * 0.82, 6.8),
      new THREE.MeshBasicMaterial({
        map: portalSwirlTexture(),
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
        opacity: 0.4,
        side: THREE.DoubleSide,
        color: 0xc79bff,
      }),
    );
    swirl.position.y = 4.4;
    swirl.position.z = 0.06;
    holder.add(swirl);
    this.veils.push(swirl);

    this.place(holder, mark, sign);
  }

  /**
   * Blows the Core apart.
   *
   * The crystal is the only spinner on the map, so it is found by identity
   * rather than by searching for a name that a swapped-in model might not have.
   * Shards are the crystal's own geometry reused at small scale — cheap, and
   * they match the thing that just shattered, which a generic particle would
   * not.
   */
  private detonateCore(ctx: GameContext): void {
    if (this.detonated) return;
    this.detonated = true;

    const core = this.coreObject;
    if (!core) return;

    // First mesh in the Core's subtree, whether that is the procedural crystal
    // or a node of the imported model — either way it is what the shards are
    // made of, so the debris matches the thing that shattered.
    let source: THREE.Mesh | null = null;
    core.traverse((node) => {
      if (!source && node instanceof THREE.Mesh) source = node;
    });

    const origin = new THREE.Vector3();
    core.getWorldPosition(origin);
    // Roughly the crystal's own height, so shards burst from the tip rather
    // than from the base of the plinth.
    origin.y += 7;

    if (source) {
      const crystal = source as THREE.Mesh;
      // 48, not 14: a dozen pieces reads as the Core "disappearing and leaving
      // some litter". Enough debris to look like the thing came apart is the
      // whole point of the shot.
      for (let i = 0; i < 48; i++) {
        const shard = new THREE.Mesh(crystal.geometry, crystal.material);
        const s = 0.05 + (i % 7) * 0.022;
        shard.scale.setScalar(s);
        // Spread the origin through the crystal's volume so the burst starts as
        // a body breaking apart rather than as a point source.
        const spreadA = (i * 2.39996) % (Math.PI * 2);
        const spreadR = ((i % 5) / 5) * 1.6;
        shard.position.set(
          origin.x + Math.cos(spreadA) * spreadR,
          origin.y + (((i % 9) / 9) - 0.5) * 5,
          origin.z + Math.sin(spreadA) * spreadR,
        );
        // Deterministic spread: the same seed must produce the same debris, or
        // a replay of a lost match looks different from the match.
        const a = (i * 2.39996) % (Math.PI * 2);
        const speed = 7 + (i % 6) * 3.4;
        const up = 6 + (i % 5) * 3.6;
        this.shards.push({
          mesh: shard,
          vel: new THREE.Vector3(Math.cos(a) * speed, up, Math.sin(a) * speed),
          spin: new THREE.Vector3(a * 1.4, a * 2.1, a * 0.9),
        });
        this.root.add(shard);
      }
    }

    // The deflagration itself: an expanding shell and a ground ring, both
    // additive so they read as light rather than as geometry.
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0x9fd8ff,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), flashMat);
    this.flash.position.copy(origin);
    this.root.add(this.flash);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xbfe6ff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 1, 40), ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.set(origin.x, this.terrain.heightAt(origin.x, origin.z) + 0.25, origin.z);
    this.root.add(this.ring);
    this.blastAge = 0;
    // Hide the whole Core, not just the mesh the shards came from: an imported
    // model is many meshes and hiding one leaves the rest standing.
    core.visible = false;

    ctx.bus.emit('camera:shake', { intensity: 1.6, duration: 1.4 });
    ctx.bus.emit('vfx:request', { vfxId: 'impact', pos: { x: origin.x, z: origin.z }, scale: 3.4 });
  }

  update(dt: number): void {
    this.time += dt;

    // The blast: a shell that expands and fades over ~0.7 s, and a ground ring
    // that runs out further and slower so the shockwave reads after the flash
    // has gone.
    if (this.flash || this.ring) {
      this.blastAge += dt;
      const t = this.blastAge;
      if (this.flash) {
        const r = 2 + t * 34;
        this.flash.scale.setScalar(r);
        const mat = this.flash.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 1 - t / 0.7);
        if (mat.opacity <= 0) {
          this.flash.removeFromParent();
          this.flash.geometry.dispose();
          mat.dispose();
          this.flash = null;
        }
      }
      if (this.ring) {
        this.ring.scale.setScalar(2 + t * 26);
        const mat = this.ring.material as THREE.MeshBasicMaterial;
        mat.opacity = Math.max(0, 0.9 * (1 - t / 1.6));
        if (mat.opacity <= 0) {
          this.ring.removeFromParent();
          this.ring.geometry.dispose();
          mat.dispose();
          this.ring = null;
        }
      }
    }

    // Debris. Plain ballistics with a floor at the plaza height — a physics
    // solver for shards that exist for three seconds would be a dependency
    // bought for one animation.
    if (this.shards.length > 0) {
      for (const shard of this.shards) {
        if (shard.vel.lengthSq() === 0) continue;
        shard.vel.y -= 16 * dt;
        shard.mesh.position.addScaledVector(shard.vel, dt);
        shard.mesh.rotation.x += shard.spin.x * dt;
        shard.mesh.rotation.y += shard.spin.y * dt;
        shard.mesh.rotation.z += shard.spin.z * dt;
        // Per-shard ground, not one sample shared by all of them: they scatter
        // 20 m across a terraced plaza and a single height would bury half of
        // them and leave the rest hovering.
        const ground = this.terrain.heightAt(shard.mesh.position.x, shard.mesh.position.z);
        if (shard.mesh.position.y < ground) {
          shard.mesh.position.y = ground;
          shard.vel.set(0, 0, 0);
        }
      }
    }
    // A slowly turning Core crystal is the map's one moving landmark, which is
    // what makes it read as alive rather than as scenery.
    for (const spinner of this.spinners) {
      spinner.rotation.y = this.time * 0.35;
      spinner.children[0]!.position.y = 6.4 + Math.sin(this.time * 1.2) * 0.28;
    }
    // Portal swirls turn in-plane and breathe, so a portal reads as an open
    // gate rather than as a painted panel. Rotation only — the texture is
    // radially symmetric, so no UV scroll is needed and none is paid for.
    for (const veil of this.veils) {
      veil.rotation.z = this.time * -0.22;
      const m = veil.material as THREE.MeshBasicMaterial;
      m.opacity = 0.34 + Math.sin(this.time * 0.9) * 0.08;
    }

  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    this.root.removeFromParent();
  }
}

/** Landmark kinds that carry a world-space label in the HUD. */
export const LABELLED_LANDMARKS: readonly { kind: LandmarkKind; text: string }[] = [
  { kind: 'core', text: 'NÚCLEO' },
  { kind: 'fountain', text: 'FUENTE' },
  { kind: 'shopProgression', text: 'T1 · HÉROE' },
  { kind: 'shopSabotage', text: 'T2 · SABOTAJE' },
];

