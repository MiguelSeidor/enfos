/**
 * Material library. Owner: MATERIALS agent.
 *
 * Central place where every surface in the game gets its look. Terrain,
 * characters, props and structures all request materials by id, so an art pass
 * changes one recipe instead of hunting through subsystem code.
 *
 * All maps come from `makeTextureSet` — no image files ship with the project.
 */

import * as THREE from 'three';
import { makeTextureSet, type MaterialRecipe, type TextureSet } from './textures';

export type MaterialId =
  | 'ground.grass'
  | 'ground.dirt'
  | 'ground.rock'
  | 'ground.path'
  | 'ground.sand'
  | 'cliff.stone'
  | 'prop.bark'
  | 'prop.foliage'
  | 'prop.stone'
  | 'structure.masonry'
  | 'structure.metal'
  | 'structure.gold'
  | 'unit.cloth'
  | 'unit.leather'
  | 'unit.steel'
  | 'unit.skin'
  | 'unit.bone'
  | 'unit.chitin';

const RECIPES: Record<MaterialId, MaterialRecipe> = {
  'ground.grass': {
    id: 'ground.grass',
    size: 512,
    seed: 1101,
    ramp: [
      { stop: 0.0, color: 0x2c3a1e },
      { stop: 0.35, color: 0x415a26 },
      { stop: 0.62, color: 0x577031 },
      { stop: 0.85, color: 0x6d8340 },
      { stop: 1.0, color: 0x88964f },
    ],
    layers: [
      { kind: 'fbm', frequency: 6, amplitude: 1, octaves: 5, warp: 0.4 },
      { kind: 'fbm', frequency: 28, amplitude: 0.45, octaves: 3 },
      { kind: 'speckle', frequency: 180, amplitude: 0.12 },
    ],
    roughness: { min: 0.78, max: 0.98 },
    normalStrength: 2.2,
    aoStrength: 1.1,
    tiling: 1,
  },
  'ground.dirt': {
    id: 'ground.dirt',
    size: 512,
    seed: 2203,
    ramp: [
      { stop: 0.0, color: 0x2b211a },
      { stop: 0.4, color: 0x453427 },
      { stop: 0.75, color: 0x5c4632 },
      { stop: 1.0, color: 0x6f573f },
    ],
    layers: [
      { kind: 'fbm', frequency: 8, amplitude: 1, octaves: 5, warp: 0.6 },
      { kind: 'cell', frequency: 22, amplitude: 0.35 },
      { kind: 'speckle', frequency: 160, amplitude: 0.15 },
    ],
    roughness: { min: 0.85, max: 1.0 },
    normalStrength: 2.6,
    tiling: 1,
  },
  'ground.rock': {
    id: 'ground.rock',
    size: 512,
    seed: 3307,
    ramp: [
      { stop: 0.0, color: 0x26282c },
      { stop: 0.45, color: 0x3c4046 },
      { stop: 0.78, color: 0x545a62 },
      { stop: 1.0, color: 0x6d747c },
    ],
    layers: [
      { kind: 'ridged', frequency: 5, amplitude: 1, octaves: 5, warp: 0.5 },
      { kind: 'cell', frequency: 14, amplitude: 0.5 },
      { kind: 'fbm', frequency: 42, amplitude: 0.25, octaves: 3 },
    ],
    roughness: { min: 0.6, max: 0.92 },
    normalStrength: 3.4,
    aoStrength: 1.4,
    tiling: 1,
  },
  'ground.path': {
    id: 'ground.path',
    size: 512,
    seed: 4409,
    ramp: [
      { stop: 0.0, color: 0x342c22 },
      { stop: 0.5, color: 0x4d4234 },
      { stop: 1.0, color: 0x6b5f4c },
    ],
    layers: [
      { kind: 'cell', frequency: 18, amplitude: 1 },
      { kind: 'fbm', frequency: 30, amplitude: 0.4, octaves: 4 },
    ],
    roughness: { min: 0.7, max: 0.95 },
    normalStrength: 2.8,
    tiling: 1,
  },
  'ground.sand': {
    id: 'ground.sand',
    size: 512,
    seed: 5501,
    ramp: [
      { stop: 0.0, color: 0x6b5c3e },
      { stop: 0.6, color: 0x8b7952 },
      { stop: 1.0, color: 0xa89468 },
    ],
    layers: [
      // Integer shear [3,2] ~= the old 0.6 rad drift, and stays tileable.
      { kind: 'dunes', frequency: 12, amplitude: 1, shear: [3, 2], octaves: 3 },
      { kind: 'fbm', frequency: 60, amplitude: 0.3, octaves: 3 },
    ],
    roughness: { min: 0.8, max: 0.96 },
    normalStrength: 1.4,
    tiling: 1,
  },
  'cliff.stone': {
    id: 'cliff.stone',
    size: 512,
    seed: 6607,
    ramp: [
      { stop: 0.0, color: 0x1f2226 },
      { stop: 0.4, color: 0x353a41 },
      { stop: 0.72, color: 0x4e555e },
      { stop: 1.0, color: 0x707983 },
    ],
    layers: [
      { kind: 'ridged', frequency: 3.5, amplitude: 1, octaves: 6, warp: 0.8 },
      // Near-horizontal banding on a cliff face is sedimentary bedding, which
      // `terrace` models directly (hard riser, soft tread).
      { kind: 'terrace', frequency: 9, amplitude: 0.35, steps: 7, octaves: 4 },
      { kind: 'cell', frequency: 16, amplitude: 0.4 },
    ],
    roughness: { min: 0.55, max: 0.9 },
    normalStrength: 4.0,
    aoStrength: 1.6,
    tiling: 1,
  },
  'prop.bark': {
    id: 'prop.bark',
    size: 256,
    seed: 7703,
    ramp: [
      { stop: 0.0, color: 0x241c14 },
      { stop: 0.5, color: 0x3b2e20 },
      { stop: 1.0, color: 0x574531 },
    ],
    layers: [
      // Fibres stretched along v: many features across u (`across`), few along
      // v (`frequency`). Zero shear keeps the grain vertical, as before.
      { kind: 'grain', frequency: 3, across: 24, amplitude: 1, octaves: 4, shear: [0, 0] },
      { kind: 'fbm', frequency: 14, amplitude: 0.5, octaves: 4, warp: 1.2 },
    ],
    roughness: { min: 0.75, max: 1.0 },
    normalStrength: 3.2,
    tiling: 1,
  },
  'prop.foliage': {
    id: 'prop.foliage',
    size: 256,
    seed: 8809,
    ramp: [
      { stop: 0.0, color: 0x1d3016 },
      { stop: 0.5, color: 0x2f4a1f },
      { stop: 1.0, color: 0x47632b },
    ],
    layers: [
      { kind: 'fbm', frequency: 10, amplitude: 1, octaves: 4 },
      { kind: 'cell', frequency: 26, amplitude: 0.4 },
    ],
    roughness: { min: 0.65, max: 0.9 },
    normalStrength: 1.8,
    tiling: 1,
  },
  'prop.stone': {
    id: 'prop.stone',
    size: 256,
    seed: 9901,
    ramp: [
      { stop: 0.0, color: 0x2a2d31 },
      { stop: 0.55, color: 0x444a51 },
      { stop: 1.0, color: 0x656d76 },
    ],
    layers: [
      { kind: 'cell', frequency: 10, amplitude: 1 },
      { kind: 'fbm', frequency: 34, amplitude: 0.3, octaves: 3 },
    ],
    roughness: { min: 0.6, max: 0.9 },
    normalStrength: 3.0,
    tiling: 1,
  },
  'structure.masonry': {
    id: 'structure.masonry',
    size: 512,
    seed: 11003,
    ramp: [
      { stop: 0.0, color: 0x2c2b28 },
      { stop: 0.45, color: 0x4a4740 },
      { stop: 1.0, color: 0x6e6a5e },
    ],
    layers: [
      { kind: 'cell', frequency: 8, amplitude: 1 },
      { kind: 'fbm', frequency: 40, amplitude: 0.28, octaves: 3 },
    ],
    roughness: { min: 0.6, max: 0.92 },
    normalStrength: 3.6,
    aoStrength: 1.5,
    tiling: 1,
  },
  'structure.metal': {
    id: 'structure.metal',
    size: 256,
    seed: 12007,
    ramp: [
      { stop: 0.0, color: 0x22262b },
      { stop: 0.5, color: 0x3c434c },
      { stop: 1.0, color: 0x5b646f },
    ],
    layers: [
      { kind: 'fbm', frequency: 18, amplitude: 1, octaves: 4 },
      { kind: 'speckle', frequency: 120, amplitude: 0.2 },
    ],
    roughness: { min: 0.22, max: 0.55 },
    metalness: 1,
    normalStrength: 1.6,
    tiling: 1,
  },
  'structure.gold': {
    id: 'structure.gold',
    size: 256,
    seed: 13009,
    ramp: [
      { stop: 0.0, color: 0x6b4a12 },
      { stop: 0.5, color: 0xb07d1e },
      { stop: 1.0, color: 0xe8c05a },
    ],
    layers: [
      { kind: 'fbm', frequency: 16, amplitude: 1, octaves: 4 },
      { kind: 'ridged', frequency: 28, amplitude: 0.25, octaves: 3 },
    ],
    roughness: { min: 0.14, max: 0.42 },
    metalness: 1,
    normalStrength: 1.4,
    tiling: 1,
  },
  'unit.cloth': {
    id: 'unit.cloth',
    size: 256,
    seed: 14011,
    ramp: [
      { stop: 0.0, color: 0x2a2438 },
      { stop: 0.5, color: 0x3d3450 },
      { stop: 1.0, color: 0x554a6b },
    ],
    layers: [
      // The two perpendicular thread sets collapse into one `weave` layer,
      // which also models the over/under crossing the old pair could not.
      { kind: 'weave', frequency: 90, across: 90, amplitude: 1 },
      { kind: 'fbm', frequency: 12, amplitude: 0.3, octaves: 3 },
    ],
    roughness: { min: 0.7, max: 0.95 },
    normalStrength: 1.2,
    tiling: 1,
  },
  'unit.leather': {
    id: 'unit.leather',
    size: 256,
    seed: 15013,
    ramp: [
      { stop: 0.0, color: 0x2b1f16 },
      { stop: 0.5, color: 0x453022 },
      { stop: 1.0, color: 0x5f4430 },
    ],
    layers: [
      { kind: 'cell', frequency: 30, amplitude: 1 },
      { kind: 'fbm', frequency: 50, amplitude: 0.25, octaves: 3 },
    ],
    roughness: { min: 0.5, max: 0.82 },
    normalStrength: 1.8,
    tiling: 1,
  },
  'unit.steel': {
    id: 'unit.steel',
    size: 256,
    seed: 16007,
    ramp: [
      { stop: 0.0, color: 0x30363d },
      { stop: 0.5, color: 0x545c66 },
      { stop: 1.0, color: 0x7d8791 },
    ],
    layers: [
      { kind: 'fbm', frequency: 22, amplitude: 1, octaves: 4 },
      { kind: 'speckle', frequency: 140, amplitude: 0.18 },
    ],
    roughness: { min: 0.16, max: 0.48 },
    metalness: 1,
    normalStrength: 1.5,
    tiling: 1,
  },
  'unit.skin': {
    id: 'unit.skin',
    size: 256,
    seed: 17011,
    ramp: [
      { stop: 0.0, color: 0x6a4a38 },
      { stop: 0.5, color: 0x8a6349 },
      { stop: 1.0, color: 0xa87c5c },
    ],
    layers: [
      { kind: 'fbm', frequency: 20, amplitude: 1, octaves: 4 },
      { kind: 'speckle', frequency: 200, amplitude: 0.08 },
    ],
    roughness: { min: 0.55, max: 0.78 },
    normalStrength: 0.8,
    tiling: 1,
  },
  'unit.bone': {
    id: 'unit.bone',
    size: 256,
    seed: 18013,
    ramp: [
      { stop: 0.0, color: 0x6e6a5c },
      { stop: 0.5, color: 0x968f7c },
      { stop: 1.0, color: 0xc0b9a2 },
    ],
    layers: [
      { kind: 'fbm', frequency: 14, amplitude: 1, octaves: 4 },
      { kind: 'cell', frequency: 40, amplitude: 0.3 },
    ],
    roughness: { min: 0.45, max: 0.78 },
    normalStrength: 1.6,
    tiling: 1,
  },
  'unit.chitin': {
    id: 'unit.chitin',
    size: 256,
    seed: 19001,
    ramp: [
      { stop: 0.0, color: 0x14181f },
      { stop: 0.5, color: 0x252d3a },
      { stop: 1.0, color: 0x3d4a5e },
    ],
    layers: [
      { kind: 'cell', frequency: 16, amplitude: 1 },
      { kind: 'ridged', frequency: 30, amplitude: 0.35, octaves: 3 },
    ],
    roughness: { min: 0.2, max: 0.5 },
    metalness: 0.15,
    normalStrength: 2.4,
    tiling: 1,
  },
};

export class MaterialLibrary {
  private readonly sets = new Map<MaterialId, TextureSet>();
  private readonly materials = new Map<string, THREE.MeshStandardMaterial>();
  private anisotropy = 8;

  setAnisotropy(value: number): void {
    this.anisotropy = value;
    for (const set of this.sets.values()) {
      set.albedo.anisotropy = value;
      set.normal.anisotropy = value;
      set.orm.anisotropy = value;
    }
  }

  /** Generates (or returns cached) texture maps for a material id. */
  textures(id: MaterialId): TextureSet {
    let set = this.sets.get(id);
    if (!set) {
      set = makeTextureSet(RECIPES[id]);
      set.albedo.anisotropy = this.anisotropy;
      set.normal.anisotropy = this.anisotropy;
      set.orm.anisotropy = this.anisotropy;
      this.sets.set(id, set);
    }
    return set;
  }

  /**
   * Returns a shared PBR material. `overrides` produces a distinct cached
   * variant, so tinted units still share one texture upload.
   */
  get(
    id: MaterialId,
    overrides?: {
      color?: number;
      tiling?: number;
      emissive?: number;
      emissiveIntensity?: number;
      roughness?: number;
      metalness?: number;
      key?: string;
    },
  ): THREE.MeshStandardMaterial {
    const cacheKey = `${id}|${overrides?.key ?? JSON.stringify(overrides ?? {})}`;
    const cached = this.materials.get(cacheKey);
    if (cached) return cached;

    const set = this.textures(id);
    const mat = new THREE.MeshStandardMaterial({
      map: set.albedo,
      normalMap: set.normal,
      aoMap: set.orm,
      roughnessMap: set.orm,
      metalnessMap: set.orm,
      roughness: overrides?.roughness ?? 1,
      metalness: overrides?.metalness ?? 1,
      envMapIntensity: 1,
    });
    if (overrides?.color !== undefined) mat.color.setHex(overrides.color, THREE.SRGBColorSpace);
    if (overrides?.emissive !== undefined) {
      mat.emissive.setHex(overrides.emissive, THREE.SRGBColorSpace);
      mat.emissiveIntensity = overrides.emissiveIntensity ?? 1;
    }
    if (overrides?.tiling !== undefined) {
      // Clone so per-material tiling does not mutate the shared texture.
      mat.map = set.albedo.clone();
      mat.normalMap = set.normal.clone();
      mat.aoMap = set.orm.clone();
      mat.roughnessMap = mat.aoMap;
      mat.metalnessMap = mat.aoMap;
      for (const t of [mat.map, mat.normalMap, mat.aoMap]) {
        t.repeat.set(overrides.tiling, overrides.tiling);
        t.needsUpdate = true;
      }
    }
    this.materials.set(cacheKey, mat);
    return mat;
  }

  recipe(id: MaterialId): MaterialRecipe {
    return RECIPES[id];
  }

  dispose(): void {
    for (const set of this.sets.values()) set.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    this.sets.clear();
    this.materials.clear();
  }
}

/** Single shared instance; subsystems import this rather than constructing one. */
export const materials = new MaterialLibrary();
