/**
 * Material library. Owner: MATERIALS agent.
 *
 * Central place where every surface in the game gets its look. Terrain,
 * characters, props and structures all request materials by id, so an art pass
 * changes one recipe instead of hunting through subsystem code.
 *
 * All maps come from `makeTextureSet` — no image files ship with the project.
 *
 * ## How to read a recipe
 *
 * A recipe is a height field, a colour ramp over that height, and a stack of
 * masked tints. The height field is built from layers that composite with real
 * blend ops, not a sum — `op: 'sub'` carves cracks *into* the surface instead of
 * adding a second bump on top of it, which is the difference between stone and
 * lumpy porridge.
 *
 * The tints are where the art direction actually lives. `mask.from` picks the
 * physical rule: `cavity` is where grime settles, `convex` is where wear polishes
 * an edge, `slope` is where loose material cannot stay, `noise` is everything
 * else. Four masked tints over one ramp reads as an authored surface; a colour
 * ramp over summed noise reads as static.
 *
 * ## Ground layers share a size
 *
 * `ground.*` and `cliff.stone` are all 512 because they get packed into a
 * `DataArrayTexture` for the terrain splat material, and array layers must agree
 * on dimensions. Do not change one without the others.
 */

import * as THREE from 'three';
import {
  makeTextureSet,
  textureBytes,
  textureGenerationStats,
  type DetailSpec,
  type MaterialRecipe,
  type TextureSet,
} from './textures';
import { applyDetailLayer } from './shading';
import {
  createSplatMaterial,
  splatMaterialBytes,
  type SplatMaterial,
  type SplatMaterialOptions,
} from './terrain-splat';

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

/** Every ground layer that feeds the terrain splat array. */
export const GROUND_LAYER_IDS = [
  'ground.grass',
  'ground.dirt',
  'ground.path',
  'ground.rock',
  'ground.sand',
  'cliff.stone',
] as const satisfies readonly MaterialId[];

const GROUND_SIZE = 512;
const DETAIL_SIZE = 256;

/** Shared detail defaults — one place to retune close-range readability. */
const detail = (spec: Omit<DetailSpec, 'size'> & { size?: number }): DetailSpec => ({
  size: DETAIL_SIZE,
  fade: [24, 78],
  ...spec,
});

const RECIPES: Record<MaterialId, MaterialRecipe> = {
  // -------------------------------------------------------------------------
  // Ground
  // -------------------------------------------------------------------------
  'ground.grass': {
    id: 'ground.grass',
    size: GROUND_SIZE,
    seed: 1101,
    ramp: [
      { stop: 0.0, color: 0x1e2c14 },
      { stop: 0.3, color: 0x354a1e },
      { stop: 0.58, color: 0x4c6528 },
      { stop: 0.82, color: 0x627c33 },
      { stop: 1.0, color: 0x84934a },
    ],
    layers: [
      // Clumping at the metre scale — the thing that stops a lawn look.
      { kind: 'fbm', frequency: 5, amplitude: 1, octaves: 5, warp: 0.05 },
      // Tufts. Worley cells at tuft scale, screened so they sit on top.
      { kind: 'cell', frequency: 26, amplitude: 0.42, op: 'screen', jitter: 1 },
      // Blade direction. Stretched noise, faint, breaks the isotropy of fBm.
      {
        kind: 'grain',
        frequency: 26,
        across: 130,
        shear: [1, 0],
        amplitude: 0.3,
        octaves: 2,
        op: 'overlay',
      },
      { kind: 'fbm', frequency: 96, amplitude: 0.22, octaves: 3 },
    ],
    tints: [
      // Sun-bleached patches. Low frequency so they read as terrain, not noise.
      {
        color: 0x9a9448,
        mask: { from: 'noise', noise: { frequency: 3, octaves: 3, warp: 0.06 }, low: 0.52, high: 0.82 },
        strength: 0.72,
        roughness: 0.95,
      },
      // Deep shade between clumps — cool, not just dark.
      {
        color: 0x16240f,
        mask: { from: 'cavity', low: 0.28, high: 0.78, gamma: 1.3 },
        strength: 0.62,
      },
      // Soil showing through where the grass thins out.
      {
        color: 0x3d3020,
        mask: { from: 'noise', noise: { frequency: 7, octaves: 4, warp: 0.09, seed: 3 }, low: 0.62, high: 0.9 },
        strength: 0.55,
        roughness: 0.99,
      },
    ],
    roughness: { min: 0.74, max: 0.96 },
    roughnessBreakup: { frequency: 9, octaves: 3, amount: 0.1 },
    normalStrength: 2.0,
    aoStrength: 1.05,
    bakedCavity: 0.3,
    contrast: 1.08,
    detail: detail({
      scale: 7,
      layers: [
        { kind: 'grain', frequency: 30, across: 150, shear: [1, 0], amplitude: 1, octaves: 3 },
        { kind: 'speckle', frequency: 34, amplitude: 0.45, threshold: 0.45, op: 'screen' },
      ],
      normalStrength: 1.15,
      albedoAmount: 0.34,
      roughAmount: 0.26,
    }),
  },

  'ground.dirt': {
    id: 'ground.dirt',
    size: GROUND_SIZE,
    seed: 2203,
    ramp: [
      { stop: 0.0, color: 0x241b14 },
      { stop: 0.38, color: 0x3d2e21 },
      { stop: 0.72, color: 0x55402c },
      { stop: 1.0, color: 0x6e563c },
    ],
    layers: [
      { kind: 'fbm', frequency: 6, amplitude: 1, octaves: 5, warp: 0.08 },
      // Dried mud plates. Subtracted, so the cracks are cut in, not piled on.
      { kind: 'cracks', frequency: 11, amplitude: 0.5, width: 0.1, op: 'sub' },
      { kind: 'cracks', frequency: 23, amplitude: 0.22, width: 0.07, op: 'sub' },
      // Embedded grit, gated to the raised plates so it does not fill the cracks.
      {
        kind: 'speckle',
        frequency: 60,
        amplitude: 0.3,
        threshold: 0.55,
        op: 'screen',
        mask: { from: 'field', low: 0.4, high: 0.75 },
      },
      { kind: 'fbm', frequency: 110, amplitude: 0.18, octaves: 3 },
    ],
    tints: [
      {
        color: 0x191009,
        mask: { from: 'cavity', low: 0.22, high: 0.72, gamma: 1.15 },
        strength: 0.8,
        roughness: 1.0,
      },
      // Pale dust on the high plates.
      {
        color: 0x8b7757,
        mask: { from: 'convex', low: 0.3, high: 0.78 },
        strength: 0.45,
        roughness: 0.99,
      },
      {
        color: 0x4a3a2a,
        mask: { from: 'noise', noise: { frequency: 4, octaves: 3, warp: 0.07 }, low: 0.45, high: 0.8 },
        strength: 0.4,
      },
    ],
    roughness: { min: 0.84, max: 1.0 },
    roughnessBreakup: { frequency: 12, octaves: 3, amount: 0.08 },
    normalStrength: 2.6,
    aoStrength: 1.25,
    bakedCavity: 0.34,
    detail: detail({
      scale: 8,
      layers: [
        { kind: 'fbm', frequency: 40, amplitude: 1, octaves: 4 },
        { kind: 'speckle', frequency: 26, amplitude: 0.6, threshold: 0.4, op: 'screen' },
        { kind: 'cracks', frequency: 14, amplitude: 0.35, width: 0.09, op: 'sub' },
      ],
      normalStrength: 1.5,
      albedoAmount: 0.36,
      roughAmount: 0.28,
    }),
  },

  'ground.rock': {
    id: 'ground.rock',
    size: GROUND_SIZE,
    seed: 3307,
    ramp: [
      { stop: 0.0, color: 0x1d2024 },
      { stop: 0.42, color: 0x343941 },
      { stop: 0.74, color: 0x4d545e },
      { stop: 1.0, color: 0x6b737d },
    ],
    layers: [
      { kind: 'ridged', frequency: 4, amplitude: 1, octaves: 5, warp: 0.06 },
      // Broken slabs rather than round pebbles: low jitter keeps cells blocky.
      { kind: 'cobble', frequency: 9, amplitude: 0.55, jitter: 0.75, op: 'overlay' },
      { kind: 'cracks', frequency: 9, amplitude: 0.45, width: 0.12, op: 'sub' },
      { kind: 'fbm', frequency: 100, amplitude: 0.2, octaves: 3 },
    ],
    tints: [
      {
        color: 0x101216,
        mask: { from: 'cavity', low: 0.2, high: 0.7 },
        strength: 0.85,
        roughness: 0.95,
      },
      // Lichen. Sits on flat upward faces, avoids the fresh broken edges.
      {
        color: 0x5c6b3a,
        mask: { from: 'noise', noise: { frequency: 6, octaves: 4, warp: 0.1, seed: 5 }, low: 0.58, high: 0.86 },
        strength: 0.5,
        roughness: 0.96,
      },
      // Polished exposure on the high faces — the only place rock gets shiny.
      {
        color: 0x8d959d,
        mask: { from: 'convex', low: 0.34, high: 0.8 },
        strength: 0.35,
        roughness: 0.55,
      },
    ],
    roughness: { min: 0.58, max: 0.92 },
    roughnessBreakup: { frequency: 14, octaves: 3, amount: 0.1 },
    normalStrength: 3.2,
    aoStrength: 1.45,
    bakedCavity: 0.34,
    detail: detail({
      scale: 7,
      layers: [
        { kind: 'ridged', frequency: 28, amplitude: 1, octaves: 3 },
        { kind: 'cracks', frequency: 18, amplitude: 0.4, width: 0.1, op: 'sub' },
      ],
      normalStrength: 1.6,
      albedoAmount: 0.32,
      roughAmount: 0.3,
    }),
  },

  'ground.path': {
    id: 'ground.path',
    size: GROUND_SIZE,
    seed: 4409,
    ramp: [
      { stop: 0.0, color: 0x2a2319 },
      { stop: 0.45, color: 0x463c2c },
      { stop: 0.78, color: 0x5d5140 },
      { stop: 1.0, color: 0x776850 },
    ],
    layers: [
      // Compacted base, deliberately smooth: a trail is flatter than the ground.
      { kind: 'fbm', frequency: 7, amplitude: 1, octaves: 4, warp: 0.05 },
      // Gravel pressed into the surface, only where the base is not rutted.
      {
        kind: 'cobble',
        frequency: 30,
        amplitude: 0.4,
        jitter: 1,
        op: 'screen',
        mask: { from: 'field', low: 0.35, high: 0.8 },
      },
      // Ruts along the direction of travel.
      {
        kind: 'grain',
        frequency: 40,
        across: 4,
        shear: [0, 0],
        amplitude: 0.35,
        octaves: 2,
        op: 'overlay',
      },
      { kind: 'speckle', frequency: 70, amplitude: 0.22, threshold: 0.5, op: 'screen' },
      { kind: 'fbm', frequency: 104, amplitude: 0.16, octaves: 3 },
    ],
    tints: [
      {
        color: 0x191309,
        mask: { from: 'cavity', low: 0.24, high: 0.74 },
        strength: 0.78,
      },
      // Dust polished into the crown of the trail by traffic.
      {
        color: 0x93825f,
        mask: { from: 'convex', low: 0.3, high: 0.75 },
        strength: 0.5,
        roughness: 0.88,
      },
      {
        color: 0x574a33,
        mask: { from: 'noise', noise: { frequency: 5, octaves: 3, warp: 0.05, seed: 2 }, low: 0.45, high: 0.85 },
        strength: 0.35,
      },
    ],
    roughness: { min: 0.7, max: 0.95 },
    roughnessBreakup: { frequency: 10, octaves: 3, amount: 0.09 },
    normalStrength: 2.3,
    aoStrength: 1.2,
    bakedCavity: 0.3,
    detail: detail({
      scale: 8,
      layers: [
        { kind: 'cobble', frequency: 22, amplitude: 1, jitter: 1 },
        { kind: 'speckle', frequency: 30, amplitude: 0.5, threshold: 0.42, op: 'screen' },
      ],
      normalStrength: 1.4,
      albedoAmount: 0.34,
      roughAmount: 0.26,
    }),
  },

  'ground.sand': {
    id: 'ground.sand',
    size: GROUND_SIZE,
    seed: 5501,
    ramp: [
      { stop: 0.0, color: 0x5f5134 },
      { stop: 0.45, color: 0x7e6d48 },
      { stop: 0.78, color: 0x9a865c },
      { stop: 1.0, color: 0xb3a072 },
    ],
    layers: [
      // Wind ripples. `dunes` phase is (u*sx + v*sy) * frequency, so the cycle
      // count along u is frequency*sx: 4 * [3,2] gives 12 by 8 cycles at ~34
      // degrees. The migrated value (frequency 12, shear [3,2]) was 36 by 24 —
      // three times finer than the stripe it replaced, which read as fabric.
      { kind: 'dunes', frequency: 4, shear: [3, 2], amplitude: 1, octaves: 3 },
      // A second ripple set at a different angle, the way real sand interferes.
      { kind: 'dunes', frequency: 3, shear: [1, 3], amplitude: 0.35, octaves: 2, op: 'overlay' },
      { kind: 'fbm', frequency: 9, amplitude: 0.4, octaves: 4, warp: 0.06, op: 'add' },
      { kind: 'speckle', frequency: 90, amplitude: 0.16, threshold: 0.5, op: 'screen' },
      { kind: 'fbm', frequency: 120, amplitude: 0.14, octaves: 2 },
    ],
    tints: [
      {
        color: 0x4a3f28,
        mask: { from: 'cavity', low: 0.3, high: 0.8 },
        strength: 0.5,
      },
      // Coarse grains collect on the crests and catch the light.
      {
        color: 0xc9b783,
        mask: { from: 'convex', low: 0.34, high: 0.82 },
        strength: 0.45,
        roughness: 0.78,
      },
    ],
    roughness: { min: 0.8, max: 0.96 },
    roughnessBreakup: { frequency: 8, octaves: 3, amount: 0.07 },
    normalStrength: 1.5,
    aoStrength: 0.85,
    bakedCavity: 0.2,
    detail: detail({
      scale: 9,
      layers: [
        { kind: 'dunes', frequency: 6, shear: [3, 2], amplitude: 1, octaves: 2 },
        { kind: 'speckle', frequency: 40, amplitude: 0.55, threshold: 0.35, op: 'screen' },
      ],
      normalStrength: 0.9,
      albedoAmount: 0.28,
      roughAmount: 0.2,
    }),
  },

  'cliff.stone': {
    id: 'cliff.stone',
    size: GROUND_SIZE,
    seed: 6607,
    ramp: [
      { stop: 0.0, color: 0x191c20 },
      { stop: 0.36, color: 0x2f343b },
      { stop: 0.68, color: 0x474e58 },
      { stop: 0.88, color: 0x616a75 },
      { stop: 1.0, color: 0x7d8792 },
    ],
    layers: [
      { kind: 'ridged', frequency: 3, amplitude: 1, octaves: 6, warp: 0.07 },
      // Sedimentary bedding. `grain` stretched the other way from bark: many
      // cycles along v, almost none across u, which is a horizontal band. The
      // migrated `terrace` version quantised an isotropic fBm, so it produced
      // blotches rather than strata — right idea, wrong axis.
      {
        kind: 'grain',
        frequency: 22,
        across: 3,
        shear: [0, 0],
        amplitude: 0.5,
        octaves: 3,
        contrast: 1.7,
        op: 'overlay',
      },
      // Fractures across the bedding.
      { kind: 'cracks', frequency: 7, amplitude: 0.5, width: 0.13, op: 'sub' },
      { kind: 'cracks', frequency: 17, amplitude: 0.25, width: 0.08, op: 'sub' },
      { kind: 'fbm', frequency: 108, amplitude: 0.2, octaves: 3 },
    ],
    tints: [
      {
        color: 0x0d0f13,
        mask: { from: 'cavity', low: 0.18, high: 0.68 },
        strength: 0.88,
      },
      // Iron staining running down the face — the warm accent against the blue
      // stone, and the thing that keeps a grey cliff from reading as a grey wall.
      {
        color: 0x6d4a2c,
        mask: { from: 'noise', noise: { frequency: 4, octaves: 4, warp: 0.14, seed: 7 }, low: 0.55, high: 0.9 },
        strength: 0.42,
        roughness: 0.9,
      },
      {
        color: 0x9aa2ab,
        mask: { from: 'convex', low: 0.36, high: 0.84 },
        strength: 0.4,
        roughness: 0.6,
      },
    ],
    roughness: { min: 0.54, max: 0.9 },
    roughnessBreakup: { frequency: 11, octaves: 3, amount: 0.1 },
    normalStrength: 3.6,
    aoStrength: 1.5,
    bakedCavity: 0.36,
    contrast: 1.1,
    detail: detail({
      scale: 6,
      layers: [
        { kind: 'ridged', frequency: 26, amplitude: 1, octaves: 3 },
        { kind: 'cracks', frequency: 16, amplitude: 0.45, width: 0.09, op: 'sub' },
        { kind: 'speckle', frequency: 44, amplitude: 0.3, threshold: 0.55, op: 'screen' },
      ],
      normalStrength: 1.7,
      albedoAmount: 0.3,
      roughAmount: 0.3,
    }),
  },

  // -------------------------------------------------------------------------
  // Props
  // -------------------------------------------------------------------------
  'prop.bark': {
    id: 'prop.bark',
    size: 256,
    seed: 7703,
    ramp: [
      { stop: 0.0, color: 0x1c150e },
      { stop: 0.45, color: 0x33281b },
      { stop: 0.8, color: 0x4d3d2a },
      { stop: 1.0, color: 0x63523a },
    ],
    layers: [
      // Fibres run along v: many cycles across u, few along v. The coordinator's
      // axis choice was right; the frequencies are pushed further apart here so
      // the fibres actually read as fibres rather than as diagonal noise.
      { kind: 'grain', frequency: 2, across: 34, shear: [0, 0], amplitude: 1, octaves: 4 },
      // Deep vertical furrows — the silhouette-level feature of bark.
      { kind: 'grain', frequency: 1, across: 9, shear: [0, 0], amplitude: 0.6, octaves: 2, contrast: 2.0, op: 'sub' },
      { kind: 'fbm', frequency: 12, amplitude: 0.3, octaves: 4, warp: 0.09, op: 'overlay' },
      { kind: 'fbm', frequency: 70, amplitude: 0.18, octaves: 3 },
    ],
    tints: [
      { color: 0x0d0906, mask: { from: 'cavity', low: 0.2, high: 0.7 }, strength: 0.85 },
      {
        color: 0x5b6b3c,
        mask: { from: 'noise', noise: { frequency: 5, octaves: 3, warp: 0.1, seed: 4 }, low: 0.62, high: 0.92 },
        strength: 0.4,
        roughness: 0.97,
      },
    ],
    roughness: { min: 0.76, max: 1.0 },
    roughnessBreakup: { frequency: 10, octaves: 3, amount: 0.08 },
    normalStrength: 3.0,
    aoStrength: 1.4,
    bakedCavity: 0.36,
    detail: detail({
      scale: 5,
      layers: [
        { kind: 'grain', frequency: 3, across: 44, shear: [0, 0], amplitude: 1, octaves: 3 },
      ],
      normalStrength: 1.4,
      albedoAmount: 0.3,
      roughAmount: 0.22,
    }),
  },

  'prop.foliage': {
    id: 'prop.foliage',
    size: 256,
    seed: 8809,
    ramp: [
      { stop: 0.0, color: 0x152410 },
      { stop: 0.45, color: 0x27401a },
      { stop: 0.78, color: 0x3a5824 },
      { stop: 1.0, color: 0x557230 },
    ],
    layers: [
      // Leaf clusters, not a green fog: cells give each clump its own value.
      { kind: 'cell', frequency: 12, amplitude: 1, jitter: 1 },
      { kind: 'cracks', frequency: 12, amplitude: 0.4, width: 0.14, op: 'sub' },
      { kind: 'fbm', frequency: 8, amplitude: 0.45, octaves: 4, warp: 0.07, op: 'overlay' },
      { kind: 'fbm', frequency: 64, amplitude: 0.2, octaves: 3 },
    ],
    tints: [
      { color: 0x0e1a0a, mask: { from: 'cavity', low: 0.24, high: 0.74 }, strength: 0.7 },
      // Translucent sun-struck leaves at the outer edge of a clump.
      {
        color: 0x7f9440,
        mask: { from: 'convex', low: 0.3, high: 0.8 },
        strength: 0.55,
        roughness: 0.6,
      },
      {
        color: 0x6b6a2c,
        mask: { from: 'noise', noise: { frequency: 6, octaves: 3, seed: 9 }, low: 0.62, high: 0.9 },
        strength: 0.35,
      },
    ],
    roughness: { min: 0.6, max: 0.88 },
    roughnessBreakup: { frequency: 9, octaves: 3, amount: 0.1 },
    normalStrength: 1.9,
    aoStrength: 1.2,
    bakedCavity: 0.3,
  },

  'prop.stone': {
    id: 'prop.stone',
    size: 256,
    seed: 9901,
    ramp: [
      { stop: 0.0, color: 0x212429 },
      { stop: 0.5, color: 0x3d434b },
      { stop: 0.82, color: 0x565e68 },
      { stop: 1.0, color: 0x6f7780 },
    ],
    layers: [
      { kind: 'ridged', frequency: 5, amplitude: 1, octaves: 4, warp: 0.06 },
      { kind: 'cobble', frequency: 7, amplitude: 0.5, jitter: 0.8, op: 'overlay' },
      { kind: 'cracks', frequency: 11, amplitude: 0.4, width: 0.11, op: 'sub' },
      { kind: 'fbm', frequency: 72, amplitude: 0.2, octaves: 3 },
    ],
    tints: [
      { color: 0x101318, mask: { from: 'cavity', low: 0.2, high: 0.7 }, strength: 0.85 },
      {
        color: 0x5f6d3d,
        mask: { from: 'noise', noise: { frequency: 5, octaves: 3, warp: 0.1, seed: 6 }, low: 0.6, high: 0.88 },
        strength: 0.45,
        roughness: 0.95,
      },
      { color: 0x939ba3, mask: { from: 'convex', low: 0.35, high: 0.82 }, strength: 0.35, roughness: 0.58 },
    ],
    roughness: { min: 0.58, max: 0.9 },
    roughnessBreakup: { frequency: 13, octaves: 3, amount: 0.1 },
    normalStrength: 2.8,
    aoStrength: 1.4,
    bakedCavity: 0.34,
    detail: detail({
      scale: 5,
      layers: [
        { kind: 'ridged', frequency: 24, amplitude: 1, octaves: 3 },
        { kind: 'speckle', frequency: 38, amplitude: 0.3, threshold: 0.55, op: 'screen' },
      ],
      normalStrength: 1.5,
      albedoAmount: 0.3,
      roughAmount: 0.28,
    }),
  },

  // -------------------------------------------------------------------------
  // Structures
  // -------------------------------------------------------------------------
  'structure.masonry': {
    id: 'structure.masonry',
    size: 512,
    seed: 11003,
    ramp: [
      { stop: 0.0, color: 0x23221f },
      { stop: 0.4, color: 0x413e37 },
      { stop: 0.75, color: 0x5c584d },
      { stop: 1.0, color: 0x777260 },
    ],
    layers: [
      // Real courses with recessed mortar. Worley cells never read as masonry —
      // masonry is rectilinear and regular, and the eye knows it immediately.
      { kind: 'bricks', frequency: 1, rows: 10, cols: 5, mortar: 0.05, amplitude: 1 },
      // Weathering across the wall, gated to the brick faces.
      {
        kind: 'fbm',
        frequency: 6,
        amplitude: 0.4,
        octaves: 4,
        warp: 0.06,
        op: 'overlay',
        mask: { from: 'field', low: 0.3, high: 0.7 },
      },
      { kind: 'cracks', frequency: 19, amplitude: 0.28, width: 0.08, op: 'sub' },
      { kind: 'fbm', frequency: 96, amplitude: 0.22, octaves: 3 },
    ],
    tints: [
      { color: 0x0f0e0c, mask: { from: 'cavity', low: 0.16, high: 0.66 }, strength: 0.9 },
      // Per-course colour drift so the bricks are not all one stone.
      {
        color: 0x6b5f4a,
        mask: { from: 'noise', noise: { frequency: 8, octaves: 2, seed: 11 }, low: 0.45, high: 0.75 },
        strength: 0.4,
      },
      {
        color: 0x4d5a3a,
        mask: { from: 'noise', noise: { frequency: 4, octaves: 4, warp: 0.12, seed: 12 }, low: 0.66, high: 0.94 },
        strength: 0.38,
        roughness: 0.96,
      },
      { color: 0x8d8877, mask: { from: 'convex', low: 0.4, high: 0.85 }, strength: 0.3, roughness: 0.62 },
    ],
    roughness: { min: 0.58, max: 0.92 },
    roughnessBreakup: { frequency: 15, octaves: 3, amount: 0.09 },
    normalStrength: 3.4,
    aoStrength: 1.5,
    bakedCavity: 0.36,
    detail: detail({
      scale: 6,
      layers: [
        { kind: 'fbm', frequency: 34, amplitude: 1, octaves: 4 },
        { kind: 'speckle', frequency: 40, amplitude: 0.4, threshold: 0.5, op: 'screen' },
      ],
      normalStrength: 1.3,
      albedoAmount: 0.28,
      roughAmount: 0.26,
    }),
  },

  'structure.metal': {
    id: 'structure.metal',
    size: 256,
    seed: 12007,
    ramp: [
      { stop: 0.0, color: 0x1b1f24 },
      { stop: 0.45, color: 0x333a43 },
      { stop: 0.8, color: 0x4d5661 },
      { stop: 1.0, color: 0x6a7482 },
    ],
    layers: [
      // Hammered plate: broad dents, then the tool marks on top.
      { kind: 'fbm', frequency: 9, amplitude: 1, octaves: 4, warp: 0.05 },
      { kind: 'cell', frequency: 14, amplitude: 0.35, jitter: 0.9, op: 'overlay' },
      // Anisotropic tool marks. This is what makes a metal read as forged rather
      // than as grey plastic — specular stretches along the scratch direction.
      { kind: 'scratches', frequency: 4, across: 150, shear: [1, 0], amplitude: 0.5, threshold: 0.66, op: 'screen' },
      { kind: 'fbm', frequency: 76, amplitude: 0.16, octaves: 3 },
    ],
    tints: [
      { color: 0x0a0c0f, mask: { from: 'cavity', low: 0.22, high: 0.72 }, strength: 0.7, roughness: 0.7 },
      // Rust in the recesses. Non-metal, so it also kills metalness locally —
      // rust that stays metallic is the classic tell of a fake PBR set.
      {
        color: 0x6b3a1c,
        mask: { from: 'noise', noise: { frequency: 5, octaves: 4, warp: 0.11, seed: 8 }, low: 0.6, high: 0.9 },
        strength: 0.6,
        roughness: 0.94,
        metalness: 0.0,
      },
      // Burnished high points.
      { color: 0x99a4b2, mask: { from: 'convex', low: 0.35, high: 0.85 }, strength: 0.5, roughness: 0.2 },
    ],
    roughness: { min: 0.24, max: 0.62 },
    roughnessBreakup: { frequency: 18, octaves: 3, amount: 0.12 },
    metalness: 1,
    normalStrength: 1.5,
    aoStrength: 1.1,
    bakedCavity: 0.22,
    detail: detail({
      scale: 5,
      layers: [
        { kind: 'scratches', frequency: 3, across: 190, shear: [1, 0], amplitude: 1, threshold: 0.7 },
        { kind: 'fbm', frequency: 46, amplitude: 0.4, octaves: 3, op: 'overlay' },
      ],
      normalStrength: 0.8,
      albedoAmount: 0.18,
      roughAmount: 0.3,
    }),
  },

  'structure.gold': {
    id: 'structure.gold',
    size: 256,
    seed: 13009,
    ramp: [
      { stop: 0.0, color: 0x4a3208 },
      { stop: 0.35, color: 0x8a5f13 },
      { stop: 0.7, color: 0xc08f26 },
      { stop: 0.9, color: 0xe3bb58 },
      { stop: 1.0, color: 0xf7dc93 },
    ],
    layers: [
      { kind: 'fbm', frequency: 7, amplitude: 1, octaves: 4, warp: 0.05 },
      // Chased/repoussé relief — gold in this game is decorative, not structural.
      { kind: 'ridged', frequency: 11, amplitude: 0.45, octaves: 3, warp: 0.04, op: 'overlay' },
      { kind: 'scratches', frequency: 5, across: 130, shear: [2, 1], amplitude: 0.3, threshold: 0.74, op: 'screen' },
      { kind: 'fbm', frequency: 84, amplitude: 0.12, octaves: 3 },
    ],
    tints: [
      // Tarnish in the recesses: gold's dark values must stay chromatic or the
      // metal reads as painted plastic under the sky IBL.
      { color: 0x40290a, mask: { from: 'cavity', low: 0.2, high: 0.7 }, strength: 0.75, roughness: 0.6 },
      { color: 0xffe9ae, mask: { from: 'convex', low: 0.34, high: 0.84 }, strength: 0.55, roughness: 0.13 },
    ],
    roughness: { min: 0.16, max: 0.46 },
    roughnessBreakup: { frequency: 16, octaves: 3, amount: 0.08 },
    metalness: 1,
    normalStrength: 1.5,
    aoStrength: 1.0,
    bakedCavity: 0.2,
    detail: detail({
      scale: 5,
      layers: [
        { kind: 'scratches', frequency: 4, across: 170, shear: [2, 1], amplitude: 1, threshold: 0.74 },
        { kind: 'fbm', frequency: 50, amplitude: 0.35, octaves: 3, op: 'overlay' },
      ],
      normalStrength: 0.7,
      albedoAmount: 0.16,
      roughAmount: 0.24,
    }),
  },

  // -------------------------------------------------------------------------
  // Units
  // -------------------------------------------------------------------------
  'unit.cloth': {
    id: 'unit.cloth',
    size: 256,
    seed: 14011,
    ramp: [
      { stop: 0.0, color: 0x201b2c },
      { stop: 0.45, color: 0x342c46 },
      { stop: 0.8, color: 0x483c5f },
      { stop: 1.0, color: 0x5d4f76 },
    ],
    layers: [
      // 26 threads over 256px is ~10px per thread, which survives mipping. The
      // migrated 90x90 was under 3px per thread: below the filter's resolving
      // power, so it averaged to flat grey at any real viewing distance.
      { kind: 'weave', frequency: 26, across: 26, amplitude: 1 },
      // Folds and drape at a much larger scale than the weave.
      { kind: 'fbm', frequency: 5, amplitude: 0.5, octaves: 4, warp: 0.09, op: 'overlay' },
      { kind: 'fbm', frequency: 60, amplitude: 0.16, octaves: 3 },
    ],
    tints: [
      { color: 0x140f1c, mask: { from: 'cavity', low: 0.26, high: 0.76 }, strength: 0.65 },
      // Sheen on the raised threads — cloth's whole specular identity.
      { color: 0x7a6b96, mask: { from: 'convex', low: 0.32, high: 0.82 }, strength: 0.45, roughness: 0.62 },
      {
        color: 0x3a3348,
        mask: { from: 'noise', noise: { frequency: 4, octaves: 3, seed: 13 }, low: 0.5, high: 0.85 },
        strength: 0.3,
      },
    ],
    roughness: { min: 0.68, max: 0.95 },
    roughnessBreakup: { frequency: 12, octaves: 3, amount: 0.08 },
    normalStrength: 1.3,
    aoStrength: 1.15,
    bakedCavity: 0.28,
    detail: detail({
      scale: 4,
      layers: [{ kind: 'weave', frequency: 30, across: 30, amplitude: 1 }],
      normalStrength: 0.9,
      albedoAmount: 0.22,
      roughAmount: 0.2,
    }),
  },

  'unit.leather': {
    id: 'unit.leather',
    size: 256,
    seed: 15013,
    ramp: [
      { stop: 0.0, color: 0x231910 },
      { stop: 0.45, color: 0x3b2a1c },
      { stop: 0.8, color: 0x523a28 },
      { stop: 1.0, color: 0x6a4d35 },
    ],
    layers: [
      // Pebbled hide grain.
      { kind: 'cell', frequency: 26, amplitude: 1, jitter: 1 },
      { kind: 'cracks', frequency: 26, amplitude: 0.4, width: 0.12, op: 'sub' },
      { kind: 'fbm', frequency: 6, amplitude: 0.45, octaves: 4, warp: 0.08, op: 'overlay' },
      { kind: 'fbm', frequency: 80, amplitude: 0.18, octaves: 3 },
    ],
    tints: [
      { color: 0x120c07, mask: { from: 'cavity', low: 0.24, high: 0.74 }, strength: 0.8 },
      // Worn, polished high points — leather's characteristic uneven sheen.
      { color: 0x8a6845, mask: { from: 'convex', low: 0.32, high: 0.82 }, strength: 0.5, roughness: 0.38 },
    ],
    roughness: { min: 0.46, max: 0.84 },
    roughnessBreakup: { frequency: 14, octaves: 3, amount: 0.12 },
    normalStrength: 1.9,
    aoStrength: 1.25,
    bakedCavity: 0.32,
    detail: detail({
      scale: 4,
      layers: [
        { kind: 'cell', frequency: 30, amplitude: 1, jitter: 1 },
        { kind: 'cracks', frequency: 30, amplitude: 0.4, width: 0.1, op: 'sub' },
      ],
      normalStrength: 1.1,
      albedoAmount: 0.26,
      roughAmount: 0.26,
    }),
  },

  'unit.steel': {
    id: 'unit.steel',
    size: 256,
    seed: 16007,
    ramp: [
      { stop: 0.0, color: 0x282d34 },
      { stop: 0.45, color: 0x474f5a },
      { stop: 0.8, color: 0x687381 },
      { stop: 1.0, color: 0x8c97a3 },
    ],
    layers: [
      { kind: 'fbm', frequency: 8, amplitude: 1, octaves: 4, warp: 0.04 },
      // Grinding marks, one dominant direction: the reason a sword catches the
      // sun as a streak rather than as a uniform sheen.
      { kind: 'scratches', frequency: 3, across: 190, shear: [1, 0], amplitude: 0.55, threshold: 0.63, op: 'screen' },
      { kind: 'scratches', frequency: 5, across: 110, shear: [3, 1], amplitude: 0.25, threshold: 0.76, op: 'screen' },
      { kind: 'fbm', frequency: 88, amplitude: 0.14, octaves: 3 },
    ],
    tints: [
      { color: 0x14181d, mask: { from: 'cavity', low: 0.24, high: 0.74 }, strength: 0.6, roughness: 0.66 },
      {
        color: 0x5d3418,
        mask: { from: 'noise', noise: { frequency: 6, octaves: 4, warp: 0.1, seed: 14 }, low: 0.72, high: 0.95 },
        strength: 0.45,
        roughness: 0.92,
        metalness: 0.0,
      },
      { color: 0xb3bdc9, mask: { from: 'convex', low: 0.34, high: 0.86 }, strength: 0.55, roughness: 0.12 },
    ],
    roughness: { min: 0.18, max: 0.5 },
    roughnessBreakup: { frequency: 20, octaves: 3, amount: 0.1 },
    metalness: 1,
    normalStrength: 1.2,
    aoStrength: 1.0,
    bakedCavity: 0.18,
    detail: detail({
      scale: 4,
      layers: [
        { kind: 'scratches', frequency: 3, across: 220, shear: [1, 0], amplitude: 1, threshold: 0.72 },
      ],
      normalStrength: 0.6,
      albedoAmount: 0.14,
      roughAmount: 0.3,
    }),
  },

  'unit.skin': {
    id: 'unit.skin',
    size: 256,
    seed: 17011,
    ramp: [
      { stop: 0.0, color: 0x5a3c2c },
      { stop: 0.4, color: 0x7a553d },
      { stop: 0.75, color: 0x966b4e },
      { stop: 1.0, color: 0xb08466 },
    ],
    layers: [
      { kind: 'fbm', frequency: 6, amplitude: 1, octaves: 4, warp: 0.06 },
      // Pores at a scale that survives mipping, plus the fine crease network.
      { kind: 'cell', frequency: 34, amplitude: 0.25, jitter: 1, op: 'overlay' },
      { kind: 'cracks', frequency: 34, amplitude: 0.18, width: 0.16, op: 'sub' },
      { kind: 'fbm', frequency: 96, amplitude: 0.12, octaves: 3 },
    ],
    tints: [
      // Subsurface warmth in the creases — skin's shadows go red, not grey.
      { color: 0x7d3a2c, mask: { from: 'cavity', low: 0.3, high: 0.8 }, strength: 0.45 },
      { color: 0xc49a78, mask: { from: 'convex', low: 0.34, high: 0.84 }, strength: 0.4, roughness: 0.44 },
      {
        color: 0x6b5240,
        mask: { from: 'noise', noise: { frequency: 5, octaves: 3, seed: 15 }, low: 0.55, high: 0.88 },
        strength: 0.3,
      },
    ],
    roughness: { min: 0.5, max: 0.76 },
    roughnessBreakup: { frequency: 16, octaves: 3, amount: 0.1 },
    normalStrength: 0.9,
    aoStrength: 0.95,
    bakedCavity: 0.22,
  },

  'unit.bone': {
    id: 'unit.bone',
    size: 256,
    seed: 18013,
    ramp: [
      { stop: 0.0, color: 0x5f5a4c },
      { stop: 0.4, color: 0x847d68 },
      { stop: 0.75, color: 0xa79f86 },
      { stop: 1.0, color: 0xcdc4a8 },
    ],
    layers: [
      { kind: 'fbm', frequency: 6, amplitude: 1, octaves: 4, warp: 0.05 },
      // Longitudinal fibre, the way real bone splits.
      { kind: 'grain', frequency: 3, across: 40, shear: [0, 0], amplitude: 0.4, octaves: 3, op: 'overlay' },
      { kind: 'cracks', frequency: 13, amplitude: 0.35, width: 0.09, op: 'sub' },
      { kind: 'fbm', frequency: 84, amplitude: 0.16, octaves: 3 },
    ],
    tints: [
      // Old bone stains in its cracks; clean bone in the cracks reads as plastic.
      { color: 0x453d2c, mask: { from: 'cavity', low: 0.22, high: 0.72 }, strength: 0.8 },
      { color: 0xe4dcc0, mask: { from: 'convex', low: 0.34, high: 0.84 }, strength: 0.45, roughness: 0.38 },
    ],
    roughness: { min: 0.4, max: 0.76 },
    roughnessBreakup: { frequency: 15, octaves: 3, amount: 0.1 },
    normalStrength: 1.6,
    aoStrength: 1.25,
    bakedCavity: 0.3,
  },

  'unit.chitin': {
    id: 'unit.chitin',
    size: 256,
    seed: 19001,
    ramp: [
      { stop: 0.0, color: 0x0f1219 },
      { stop: 0.4, color: 0x1e2531 },
      { stop: 0.75, color: 0x323d4e },
      { stop: 1.0, color: 0x4a5a70 },
    ],
    layers: [
      // Overlapping plates.
      { kind: 'cobble', frequency: 9, amplitude: 1, jitter: 0.85 },
      { kind: 'cracks', frequency: 9, amplitude: 0.45, width: 0.1, op: 'sub' },
      { kind: 'ridged', frequency: 22, amplitude: 0.3, octaves: 3, op: 'overlay' },
      { kind: 'fbm', frequency: 92, amplitude: 0.14, octaves: 3 },
    ],
    tints: [
      { color: 0x070a0e, mask: { from: 'cavity', low: 0.2, high: 0.7 }, strength: 0.85 },
      // Iridescent highlight on the plate crowns: the one saturated accent on an
      // otherwise near-black material, so enemies still read against dark ground.
      { color: 0x4d7fa8, mask: { from: 'convex', low: 0.36, high: 0.86 }, strength: 0.5, roughness: 0.16 },
    ],
    roughness: { min: 0.18, max: 0.52 },
    roughnessBreakup: { frequency: 17, octaves: 3, amount: 0.1 },
    metalness: 0.15,
    normalStrength: 2.4,
    aoStrength: 1.35,
    bakedCavity: 0.3,
    detail: detail({
      scale: 4,
      layers: [
        { kind: 'cobble', frequency: 20, amplitude: 1, jitter: 0.9 },
        { kind: 'ridged', frequency: 34, amplitude: 0.4, octaves: 3, op: 'overlay' },
      ],
      normalStrength: 1.2,
      albedoAmount: 0.2,
      roughAmount: 0.24,
    }),
  },
};

export interface MaterialOverrides {
  color?: number;
  tiling?: number;
  emissive?: number;
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  /** Disables the close-range detail patch for this variant. */
  noDetail?: boolean;
  key?: string;
}

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
      if (set.detail) set.detail.anisotropy = value;
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
      if (set.detail) set.detail.anisotropy = this.anisotropy;
      this.sets.set(id, set);
    }
    return set;
  }

  /**
   * Generates a batch up front. Call this during boot for the materials the
   * first frame needs; everything else stays lazy so the boot bar does not stall
   * on textures nothing is looking at yet.
   */
  preload(ids: readonly MaterialId[]): void {
    for (const id of ids) this.textures(id);
  }

  /**
   * Returns a shared PBR material. `overrides` produces a distinct cached
   * variant, so tinted units still share one texture upload.
   */
  get(id: MaterialId, overrides?: MaterialOverrides): THREE.MeshStandardMaterial {
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
    if (set.detail && overrides?.noDetail !== true) {
      applyDetailLayer(mat, {
        map: set.detail,
        scale: set.detailScale * (overrides?.tiling ?? 1),
        normalStrength: set.detailStrength,
        fade: set.detailFade,
      });
    }
    this.materials.set(cacheKey, mat);
    return mat;
  }

  recipe(id: MaterialId): MaterialRecipe {
    return RECIPES[id];
  }

  /**
   * Builds the terrain splat material from material ids. This is the entry point
   * the TERRAIN agent should use — see `terrain-splat.ts` for the full contract.
   */
  splatMaterial(
    options: Omit<SplatMaterialOptions, 'layers' | 'slopeLayer'> & {
      layers: { id: MaterialId; tileSize: number; tint?: number; heightBias?: number; roughnessScale?: number }[];
      slopeLayer?: { id: MaterialId; tileSize: number; tint?: number; roughnessScale?: number };
    },
  ): SplatMaterial {
    const layers = options.layers.map((l) => ({ ...l, set: this.textures(l.id) }));
    const slopeLayer = options.slopeLayer
      ? { ...options.slopeLayer, set: this.textures(options.slopeLayer.id) }
      : undefined;
    return createSplatMaterial({ ...options, layers, slopeLayer });
  }

  /** Per-material generation time and upload size; used by the QA pass. */
  report(): {
    materials: number;
    totalMs: number;
    slowest: { id: string; ms: number } | null;
    textureBytes: number;
    splatBytes: number;
    totalMb: number;
  } {
    const stats = textureGenerationStats();
    let totalMs = 0;
    let bytes = 0;
    let slowest: { id: string; ms: number } | null = null;
    for (const s of stats) {
      totalMs += s.ms;
      bytes += s.bytes;
      if (!slowest || s.ms > slowest.ms) slowest = { id: s.id, ms: s.ms };
    }
    const splatBytes = splatMaterialBytes(5, GROUND_SIZE, DETAIL_SIZE);
    return {
      materials: stats.length,
      totalMs: Math.round(totalMs),
      slowest,
      textureBytes: bytes,
      splatBytes,
      totalMb: Math.round(((bytes + splatBytes) / (1024 * 1024)) * 10) / 10,
    };
  }

  dispose(): void {
    for (const set of this.sets.values()) set.dispose();
    for (const mat of this.materials.values()) mat.dispose();
    this.sets.clear();
    this.materials.clear();
  }
}

export { textureBytes };

/** Single shared instance; subsystems import this rather than constructing one. */
export const materials = new MaterialLibrary();
