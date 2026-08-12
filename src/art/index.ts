/**
 * Art layer barrel. Owner: MATERIALS agent.
 *
 * Other subsystems should import from `@/art`, not from the individual files —
 * that keeps the internal file layout free to change without a cross-folder
 * edit. See `src/art/README.md` for the recipe format and the terrain splat
 * contract.
 */

export {
  materials,
  MaterialLibrary,
  GROUND_LAYER_IDS,
  textureBytes,
  type MaterialId,
  type MaterialOverrides,
} from './materials';

export {
  makeTextureSet,
  makeDetailMap,
  analyzeTileability,
  analyzeContrast,
  textureGenerationStats,
  resetTextureGenerationStats,
  type TextureSet,
  type MaterialRecipe,
  type NoiseLayer,
  type LayerKind,
  type LayerMask,
  type TintLayer,
  type RampStop,
  type DetailSpec,
  type BlendOp,
  type TileReport,
  type GenerationStats,
} from './textures';

export {
  createSplatMaterial,
  makeSplatMap,
  makeMacroVariationMap,
  splatMaterialBytes,
  type SplatMaterial,
  type SplatMaterialOptions,
  type SplatLayerInput,
} from './terrain-splat';

export { applyDetailLayer, ART_GLSL_BLEND, type DetailPatchOptions } from './shading';

export { perlin, ridged, fbm, billow, worley, worleyResult, shearedPerlin } from './noise';
