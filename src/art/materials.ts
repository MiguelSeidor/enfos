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

/**
 * Shared detail defaults — one place to retune close-range readability.
 *
 * The fade window used to be [24, 78] m. The hero and terrainDetail shots put
 * the camera 25–40 m out, so the detail layer was already 20–70% faded at the
 * exact zoom it exists to serve, and the ground read as flat under it. [40, 130]
 * keeps it at full strength through the whole hero range and still has it gone
 * well before overview distance, where it would only alias.
 */
const detail = (spec: Omit<DetailSpec, 'size'> & { size?: number }): DetailSpec => ({
  size: DETAIL_SIZE,
  fade: [40, 130],
  ...spec,
});

const RECIPES: Record<MaterialId, MaterialRecipe> = {
  // -------------------------------------------------------------------------
  // Ground
  // -------------------------------------------------------------------------
  // Terrain tiles this at 9 m per repeat, so 512 px is 1.76 cm/texel and the
  // 0.5–1.5 m mid band is f6–f18.
  'ground.grass': {
    id: 'ground.grass',
    size: GROUND_SIZE,
    seed: 1101,
    // Green, not yellow-green: hue held near 84 deg by keeping red about 19
    // points above blue. The v2 ramp sat at 71 deg and ran 4.1:1 dark-to-light,
    // which the warm key (0xffcb92 at intensity 7) plus ACES turned into the
    // acid stipple in the combat capture. 2.2:1 and 0.27 saturation at the top
    // stop leaves the chroma to the light rig.
    // Bottom stop lifted 0x30 -> 0x36. The hero capture had 28.4% of pixels
    // under 10% luma with none over 90%; a chunk of that is the render grade,
    // but a ground whose darkest albedo is 0.19 sRGB *before* baked cavity and
    // the cavity tint has nothing left to give once it is in shadow.
    // Widened from a 2.2:1 range to about 3.4:1, by lifting the top stops only.
    //
    // Measured against the paved lane, which is the one ground layer that reads
    // well: its albedo spans 74 luma levels between the 5th and 95th
    // percentiles, where grass spanned 26. All the tuft structure below was
    // being authored into a band too narrow to see, so the ground resolved as
    // flat mottle no matter how good the layers were.
    //
    // The bottom stops are untouched on purpose. They were raised deliberately
    // once before because the hero capture had 28 % of pixels under 10 % luma,
    // and darkening them again would undo that fix — the range has to come from
    // the light end.
    ramp: [
      { stop: 0.0, color: 0x2f3c22 },
      { stop: 0.3, color: 0x415635 },
      { stop: 0.6, color: 0x567142 },
      { stop: 0.84, color: 0x62814a },
      { stop: 1.0, color: 0x739757 },
    ],
    layers: [
      // Turf density drift at ~0.8 m, and the layer that now owns most of the
      // field's range. Value variation at this scale is what a real field has:
      // drier here, lusher there, over metres. It was held at 0.34 to avoid the
      // "large-scale mottled blur" the v2 recipe had, but the blur came from
      // that recipe putting half its range into an f5 (1.8 m) term with no tuft
      // structure inside it. At 0.8 m with three tuft scales modulating on top,
      // the drift reads as the field, not as a blur over it.
      { kind: 'clumps', frequency: 11, amplitude: 0.34, octaves: 3, width: 0.26, warp: 0.07 },
      // Three tuft scales, each grown through its OWN low-frequency density
      // field. The v3 recipe had two tuft layers at uniform density across the
      // whole tile, which is what read as a regular stipple at mid distance:
      // every square metre had the same number of tufts of the same size, and
      // constant density is a screen pattern no matter how the dots are jittered.
      //
      // Real turf grows in patches — tussocks where it is wet, thin scalps where
      // it is trodden. Masking each layer separately means density, dominant
      // tuft size and colour all vary together across the ground.
      //
      // Big tussocks, ~82 cm. Gives the field a second visual unit so it is not
      // one dot size everywhere.
      {
        kind: 'tufts',
        frequency: 11,
        amplitude: 0.5,
        jitter: 1,
        threshold: 0.62,
        across: 7,
        width: 0.7,
        op: 'screen',
        mask: { from: 'noise', noise: { frequency: 4, octaves: 3, warp: 0.12, seed: 8 }, low: 0.3, high: 0.72 },
      },
      // Primary feature: 45 cm tufts, each with its own radius and blade
      // direction.
      {
        kind: 'tufts',
        frequency: 20,
        amplitude: 0.9,
        jitter: 1,
        threshold: 0.34,
        across: 6,
        width: 0.66,
        mask: { from: 'noise', noise: { frequency: 6, octaves: 3, warp: 0.1, seed: 11 }, low: 0.26, high: 0.7 },
      },
      // A finer, sparser tuft set filling the gaps at ~27 cm.
      {
        kind: 'tufts',
        frequency: 33,
        amplitude: 0.42,
        jitter: 1,
        threshold: 0.44,
        across: 5,
        width: 0.58,
        op: 'screen',
        seedOffset: 3,
        mask: { from: 'noise', noise: { frequency: 8, octaves: 3, warp: 0.1, seed: 13 }, low: 0.3, high: 0.74 },
      },
      // Blade strokes, ~5 cm.
      {
        kind: 'grain',
        frequency: 26,
        across: 170,
        shear: [1, 0],
        amplitude: 0.4,
        octaves: 2,
        contrast: 1.3,
        op: 'overlay',
      },
      { kind: 'fbm', frequency: 120, amplitude: 0.24, octaves: 1 },
    ],
    tints: [
      // Sun-bleached khaki, ~1.5 m.
      {
        color: 0x7a7355,
        mask: { from: 'noise', noise: { frequency: 6, octaves: 3, warp: 0.06 }, low: 0.56, high: 0.86 },
        strength: 0.34,
        roughness: 0.95,
      },
      // Dry tips on tuft crowns. Pulled back from 0.34: with every crown lit to
      // the same value the crowns themselves became the stipple.
      {
        color: 0x767a58,
        mask: { from: 'convex', low: 0.3, high: 0.78 },
        strength: 0.27,
        roughness: 0.9,
      },
      // Shade between tufts. With the ramp compressed to 2.2:1 this tint and the
      // AO map carry the depth that the ramp used to fake. 0.62 -> 0.52 for the
      // same reason as the crown tint: the crown/gap contrast was doing as much
      // to sell the screen pattern as the tuft geometry was.
      {
        color: 0x252c1e,
        mask: { from: 'cavity', low: 0.26, high: 0.76, gamma: 1.25 },
        strength: 0.52,
      },
      // Bare soil in the thin spots. f14 = 64 cm: inside the mid band, where the
      // v2 value of f8 put it at 1.1 m and it read as a macro blotch.
      {
        color: 0x4a4133,
        mask: { from: 'noise', noise: { frequency: 14, octaves: 3, warp: 0.08, seed: 3 }, low: 0.62, high: 0.9 },
        strength: 0.55,
        roughness: 0.99,
      },
    ],
    roughness: { min: 0.74, max: 0.96 },
    roughnessBreakup: { frequency: 9, octaves: 3, amount: 0.1 },
    normalStrength: 2.0,
    aoStrength: 1.05,
    bakedCavity: 0.28,
    // 1.95 -> 1.5. The higher value was chosen to force the ramp's full width
    // to be used, and it worked, but the layer that used it was the tufts: a
    // stretch applied to a field the tufts already dominate only drives their
    // crowns further into the top stop. With the range now spent on the clumps,
    // 1.5 is enough to reach both ends of the ramp at the scale that should.
    contrast: 1.35,
    detail: detail({
      scale: 6,
      layers: [
        { kind: 'grain', frequency: 20, across: 64, shear: [1, 0], amplitude: 1, octaves: 2, contrast: 1.3 },
        { kind: 'tufts', frequency: 16, amplitude: 0.6, jitter: 1, threshold: 0.32, across: 5, op: 'screen' },
        { kind: 'speckle', frequency: 34, amplitude: 0.4, threshold: 0.5, op: 'screen' },
      ],
      normalStrength: 1.9,
      albedoAmount: 0.45,
      roughAmount: 0.3,
    }),
  },

  // Terrain tiles this at 12.5 m per repeat (2.44 cm/texel), and — see the note
  // at the bottom of this file — `src/world/groundMaterial.ts` also samples this
  // albedo at 0.62 m per repeat as its close-range detail source. That second
  // use means this map's f6–f20 content becomes the ground's 3–10 cm relief at
  // hero zoom, so the mid band here has to carry two jobs at once.
  'ground.dirt': {
    id: 'ground.dirt',
    size: GROUND_SIZE,
    seed: 2203,
    // 2.5:1 and 0.27 saturation at the top stop. The v2 ramp ran 6.7:1 from
    // 0x21 to 0x7c, which is why every crack read as a near-black slash against
    // a bright plate — and high-contrast structure is exactly what makes a tile
    // period legible. Hue held at 34 deg (warm brown), not the 20-ish that the
    // warm key was pushing into orange.
    // Bottom stop lifted 0x2e -> 0x35 for the same reason as grass: this is the
    // dominant surface in the hero shot, which failed the harness contrast check
    // at 28.4% of pixels below 10% luma.
    // Widened from 2.5:1 to about 3.5:1 by lifting the top stops, for the same
    // reason as grass: dirt measured only 18 luma levels of range against the
    // paved lane's 74, so its gravel and ruts had nowhere to show. Bottom stop
    // held — the darkness complaint that motivated raising it still stands.
    ramp: [
      { stop: 0.0, color: 0x352d25 },
      { stop: 0.38, color: 0x51452f },
      { stop: 0.72, color: 0x6f6049 },
      { stop: 1.0, color: 0x968268 },
    ],
    layers: [
      // Ground undulation.
      //
      // `gain: 0.6`, not the default 0.5, and six octaves rather than four. The
      // v3 comment claimed "fractal so it has no characteristic scale to match",
      // but that is not what an fBm with gain 0.5 does: the base octave carries
      // twice the amplitude of the next and eight times the fourth, so f9 really
      // did have a characteristic scale at 1.4 m. That is what produced the
      // pale worm-and-flame mottle in the hero capture, and it matched tile to
      // tile. A flatter spectrum spreads the energy so no one scale owns the
      // silhouette — the same trap `ridged f7` set on the cliff.
      { kind: 'fbm', frequency: 10, amplitude: 0.62, octaves: 5, gain: 0.6, warp: 0.07 },
      // Root traces and desiccation, sinuous at two scales.
      //
      // Both Worley crack nets are gone. The v3 pass moved them from f11 to
      // f20/f37 believing that was small enough; at a 12.5 m tile f20 is a 63 cm
      // polygon, which is squarely inside the band the eye matches, and `op:sub`
      // at amplitude 0.3 drew it as a high-contrast dark line. It was still the
      // most legible repeat in the terrainDetail capture.
      {
        kind: 'rills',
        frequency: 20,
        amplitude: 0.22,
        threshold: 0.56,
        width: 0.26,
        warp: 0.08,
        op: 'sub',
      },
      {
        kind: 'rills',
        frequency: 34,
        amplitude: 0.14,
        threshold: 0.6,
        width: 0.22,
        warp: 0.06,
        op: 'sub',
        seedOffset: 4,
      },
      // One fine desiccation net at 23 cm — small enough to read as surface
      // texture rather than as a shape.
      { kind: 'cracks', frequency: 54, amplitude: 0.16, width: 0.045, op: 'sub' },
      // Re-wetted / worn patches at ~83 cm, low contrast.
      { kind: 'clumps', frequency: 15, amplitude: 0.2, octaves: 3, width: 0.3, warp: 0.08, op: 'overlay' },
      // Pebbles pressed into the plates: 90 / 45 / 30 cm across three scales,
      // 40% of cells empty. Gated to the raised plates so they do not fill the
      // cracks. This is the layer that carries the hero-zoom crunch.
      {
        kind: 'pebbles',
        frequency: 15,
        amplitude: 0.34,
        jitter: 1,
        threshold: 0.4,
        width: 0.55,
        op: 'screen',
        mask: { from: 'field', low: 0.35, high: 0.72 },
      },
      // Grit at ~21 cm.
      {
        kind: 'speckle',
        frequency: 60,
        amplitude: 0.32,
        threshold: 0.48,
        op: 'screen',
        mask: { from: 'field', low: 0.35, high: 0.75 },
      },
      // f150 with 3 octaves ran its top octave at f600 on a 512 grid — under one
      // sample per cycle, so it contributed pure aliased static at full cost.
      { kind: 'fbm', frequency: 110, amplitude: 0.3, octaves: 1 },
    ],
    tints: [
      {
        color: 0x241d16,
        mask: { from: 'cavity', low: 0.22, high: 0.72, gamma: 1.15 },
        strength: 0.8,
        roughness: 1.0,
      },
      // Pale dust on the high plates and on pebble crowns.
      {
        color: 0x7d7160,
        mask: { from: 'convex', low: 0.3, high: 0.78 },
        strength: 0.45,
        roughness: 0.99,
      },
      // Damp/dry drift. f9 = 1.4 m, up from f4 (3.1 m) which was a macro blotch
      // big enough to be recognisable tile to tile.
      {
        color: 0x453b30,
        mask: { from: 'noise', noise: { frequency: 9, octaves: 3, warp: 0.07 }, low: 0.45, high: 0.8 },
        strength: 0.4,
      },
    ],
    roughness: { min: 0.84, max: 1.0 },
    roughnessBreakup: { frequency: 12, octaves: 3, amount: 0.08 },
    normalStrength: 2.4,
    aoStrength: 1.2,
    bakedCavity: 0.28,
    // Dirt had no field contrast at all and measured the flattest of the four
    // ground layers — 18 luma levels of range where the paved lane has 73.
    contrast: 1.85,
    detail: detail({
      scale: 8,
      layers: [
        { kind: 'fbm', frequency: 40, amplitude: 1, octaves: 4 },
        { kind: 'pebbles', frequency: 12, amplitude: 0.7, jitter: 1, threshold: 0.4, op: 'screen' },
        { kind: 'speckle', frequency: 26, amplitude: 0.5, threshold: 0.4, op: 'screen' },
      ],
      normalStrength: 2.1,
      albedoAmount: 0.36,
      roughAmount: 0.28,
    }),
  },

  // Terrain tiles this at 15 m, and takes its *normal* map at 1.24 m per repeat
  // as the ground's close-range relief. So this recipe's f3–f12 normal content
  // becomes the 10–40 cm bumps under the hero camera — the reason the low
  // frequencies here stay strong while every other ground recipe pushes them up.
  'ground.rock': {
    id: 'ground.rock',
    size: GROUND_SIZE,
    seed: 3307,
    // Widened for the same reason as grass and dirt: 31 luma levels of range
    // against the paved lane's 74. Rock is mostly seen on cliff faces, where
    // the strata and broken slabs below are the whole read, and they were being
    // compressed into near-flat grey.
    ramp: [
      { stop: 0.0, color: 0x303338 },
      { stop: 0.42, color: 0x4c525a },
      { stop: 0.74, color: 0x6b727c },
      { stop: 1.0, color: 0x939ba6 },
    ],
    layers: [
      // `gain: 0.6` for the same reason as the dirt base: ridged multifractal
      // concentrates energy on the base octave's crests, so f6 at gain 0.5 was a
      // network of 2.5 m blobs — a matchable shape at a sixth of the tile. f10
      // with a flatter spectrum keeps the crest character without the signature.
      { kind: 'ridged', frequency: 10, amplitude: 1, octaves: 5, gain: 0.6, warp: 0.06 },
      // Broken slabs at ~94/47/31 cm with per-block size variation. `cobble`
      // put every block on one lattice; at 15 m per tile that lattice was
      // readable as a grid from overview height.
      {
        kind: 'pebbles',
        frequency: 16,
        amplitude: 0.5,
        jitter: 1,
        threshold: 0.34,
        width: 0.6,
        op: 'overlay',
      },
      // Fractures. f24 was a 62 cm polygon net, inside the matchable band and
      // drawn as a hard dark line; at f48 the net reads as fracture texture.
      { kind: 'cracks', frequency: 48, amplitude: 0.2, width: 0.05, op: 'sub' },
      { kind: 'rills', frequency: 22, amplitude: 0.2, threshold: 0.58, width: 0.24, warp: 0.07, op: 'sub' },
      // Scree collecting in the hollows. `low > high` inverts the window.
      {
        kind: 'pebbles',
        frequency: 30,
        amplitude: 0.3,
        jitter: 1,
        threshold: 0.45,
        width: 0.5,
        op: 'screen',
        mask: { from: 'field', low: 0.55, high: 0.2 },
      },
      { kind: 'fbm', frequency: 110, amplitude: 0.24, octaves: 1 },
    ],
    tints: [
      {
        color: 0x24272c,
        mask: { from: 'cavity', low: 0.2, high: 0.7 },
        strength: 0.85,
        roughness: 0.95,
      },
      // Lichen. Sits on flat upward faces, avoids the fresh broken edges.
      {
        color: 0x545c3e,
        mask: { from: 'noise', noise: { frequency: 10, octaves: 4, warp: 0.1, seed: 5 }, low: 0.58, high: 0.86 },
        strength: 0.45,
        roughness: 0.96,
      },
      // Polished exposure on the high faces — the only place rock gets shiny.
      {
        color: 0x848a92,
        mask: { from: 'convex', low: 0.34, high: 0.8 },
        strength: 0.35,
        roughness: 0.55,
      },
    ],
    roughness: { min: 0.58, max: 0.92 },
    roughnessBreakup: { frequency: 14, octaves: 3, amount: 0.1 },
    normalStrength: 3.0,
    aoStrength: 1.4,
    bakedCavity: 0.32,
    // Rock is what every cliff face in the map is made of, and its strata and
    // broken slabs were resolving into near-flat grey. Slightly gentler than
    // grass and dirt because ridged multifractal already concentrates energy in
    // its crests, and over-stretching it turns the crests into white slashes.
    contrast: 1.4,
    detail: detail({
      scale: 7,
      layers: [
        { kind: 'ridged', frequency: 28, amplitude: 1, octaves: 3 },
        { kind: 'pebbles', frequency: 11, amplitude: 0.55, jitter: 1, threshold: 0.36, op: 'screen' },
        { kind: 'cracks', frequency: 18, amplitude: 0.35, width: 0.08, op: 'sub' },
      ],
      normalStrength: 2.2,
      albedoAmount: 0.32,
      roughAmount: 0.3,
    }),
  },

  // Tiled at 8.5 m. The lane runs through the middle of every fight, so this is
  // the surface the camera sits closest to for longest.
  'ground.path': {
    id: 'ground.path',
    size: GROUND_SIZE,
    seed: 4409,
    // Cool grey stone, not brown earth. The old recipe was a compacted dirt
    // trail — gravel pressed into mud with cart ruts — which is why the route
    // read as "where the grass has worn away" rather than as a built road. The
    // lane is the map's one piece of infrastructure and it should look laid,
    // not trodden.
    ramp: [
      { stop: 0.0, color: 0x2f3034 },
      { stop: 0.42, color: 0x4b4d51 },
      { stop: 0.76, color: 0x66686c },
      { stop: 1.0, color: 0x7e8082 },
    ],
    layers: [
      // Flagstone courses. `rows`/`cols` chosen against the layer's 8.5 m tile
      // (see `uLayerScale.w` in world/groundMaterial.ts): 6 × 3 gives slabs
      // roughly 1.4 m across, which is a paving stone a person could lift and
      // reads as masonry rather than as tiling at RTS distance.
      { kind: 'bricks', frequency: 1, rows: 6, cols: 3, mortar: 0.055, amplitude: 1 },
      // Marble veining, gated to the slab faces so it never crosses a joint —
      // veins that run through mortar destroy the illusion of separate stones.
      {
        kind: 'flow',
        frequency: 7,
        amplitude: 0.34,
        octaves: 4,
        warp: 0.22,
        op: 'overlay',
        mask: { from: 'field', low: 0.35, high: 0.85 },
      },
      // Per-slab tonal variation. Without it every stone is the same grey and
      // the courses read as printed, not quarried.
      {
        kind: 'cell',
        frequency: 6,
        amplitude: 0.26,
        jitter: 1,
        op: 'overlay',
      },
      // Wear: chipped edges and hairline fractures.
      { kind: 'cracks', frequency: 22, amplitude: 0.3, op: 'mul' },
      // Fine surface tooth so the stone is not glassy under a low sun.
      { kind: 'fbm', frequency: 46, amplitude: 0.22, octaves: 3, warp: 0.04, op: 'overlay' },
      { kind: 'speckle', frequency: 96, amplitude: 0.18, threshold: 0.5, op: 'screen' },
    ],
    tints: [
      // Grime settled into the joints.
      {
        color: 0x24262a,
        mask: { from: 'cavity', low: 0.2, high: 0.72 },
        strength: 0.82,
      },
      // Traffic polish on the crowns: lighter and markedly smoother, which is
      // what makes a paved road look walked on rather than merely dirty.
      {
        color: 0xb4b6b8,
        mask: { from: 'convex', low: 0.34, high: 0.8 },
        strength: 0.46,
        roughness: 0.42,
      },
      // Slow warm drift across the whole surface so a long straight run of
      // paving does not read as one flat value.
      {
        color: 0x6e6a62,
        mask: { from: 'noise', noise: { frequency: 9, octaves: 3, warp: 0.06, seed: 7 }, low: 0.42, high: 0.86 },
        strength: 0.3,
      },
    ],
    // Lower than the dirt it replaced: cut stone is smoother than earth, and
    // the contrast against the surrounding ground is half of what sells it.
    roughness: { min: 0.4, max: 0.78 },
    roughnessBreakup: { frequency: 12, octaves: 3, amount: 0.08 },
    // Strong, because the joints are the read. The recessed mortar has to hold
    // its shadow from a camera 40 m up.
    normalStrength: 2.6,
    aoStrength: 1.3,
    bakedCavity: 0.32,
    detail: detail({
      scale: 8,
      layers: [
        { kind: 'fbm', frequency: 14, amplitude: 1, octaves: 3, warp: 0.05 },
        { kind: 'speckle', frequency: 34, amplitude: 0.42, threshold: 0.5, op: 'screen' },
      ],
      normalStrength: 1.5,
      albedoAmount: 0.22,
      roughAmount: 0.2,
    }),
  },

  // Tiled at 10 m. Note: nothing in `world/` currently selects this layer — the
  // terrain splat uses grass / dirt / rock / path — so it does not appear in the
  // QA captures. It is still a published `GROUND_LAYER_IDS` member, so it has to
  // be right the day someone adds a shoreline.
  'ground.sand': {
    id: 'ground.sand',
    size: GROUND_SIZE,
    seed: 5501,
    // Pulled down from a 0xb0 top: at 0.69 sRGB the crests were the brightest
    // albedo in the library by a wide margin and would clip under the warm key
    // before the light rig got a say. 2:1, which is about right for dry sand —
    // its apparent contrast comes from ripple shading, not from the ramp.
    ramp: [
      { stop: 0.0, color: 0x625a48 },
      { stop: 0.45, color: 0x7d7460 },
      { stop: 0.78, color: 0x948b76 },
      { stop: 1.0, color: 0xa79d87 },
    ],
    layers: [
      // Primary ripple train, ~42 cm crest to crest. `dunes` phase is
      // (u*sx + v*sy) * frequency, so the cycle count along u is frequency*sx:
      // 8 * [3,2] gives 24 by 16 cycles at ~34 degrees.
      //
      // The v3 recipe chased the fabric read downward in frequency — 36x24 to
      // 12x8 — which only produced coarser fabric, because the defect was never
      // the wavelength. It was that a single sine train with one low-frequency
      // warp stays phase-coherent across the whole tile. The fix is in the
      // generator (two warp scales plus patchy coverage); with that in place a
      // fine ripple is free to be fine.
      {
        kind: 'dunes',
        frequency: 8,
        shear: [3, 2],
        amplitude: 1,
        octaves: 3,
        warp: 0.5,
        threshold: 0.42,
      },
      // A second train at a different angle and scale — real sand interferes.
      {
        kind: 'dunes',
        frequency: 5,
        shear: [1, 3],
        amplitude: 0.4,
        octaves: 2,
        warp: 0.75,
        threshold: 0.55,
        op: 'overlay',
        seedOffset: 2,
      },
      // Wind-scoured hollows and drifts at ~77 cm, kept low-amplitude: at f9 and
      // 0.34 these were the recognisable shape in the tile.
      { kind: 'clumps', frequency: 13, amplitude: 0.24, octaves: 3, width: 0.3, warp: 0.09, op: 'overlay' },
      // Coarse lag: shell fragments and grit concentrated in the hollows, where
      // the wind has taken the fines away. `low > high` inverts the window.
      {
        kind: 'pebbles',
        frequency: 26,
        amplitude: 0.26,
        jitter: 1,
        threshold: 0.6,
        width: 0.5,
        op: 'screen',
        mask: { from: 'field', low: 0.55, high: 0.18 },
      },
      { kind: 'speckle', frequency: 90, amplitude: 0.18, threshold: 0.52, op: 'screen' },
      { kind: 'fbm', frequency: 110, amplitude: 0.16, octaves: 1 },
    ],
    tints: [
      {
        color: 0x4c4638,
        mask: { from: 'cavity', low: 0.3, high: 0.8 },
        strength: 0.5,
      },
      // Coarse grains collect on the crests and catch the light.
      {
        color: 0xbdb29a,
        mask: { from: 'convex', low: 0.34, high: 0.82 },
        strength: 0.42,
        roughness: 0.78,
      },
      // Damp and mineral-stained drifts at ~1.1 m. A bright, near-uniform
      // surface has nothing but colour variation to break its repeat with.
      {
        color: 0x796f58,
        mask: { from: 'noise', noise: { frequency: 9, octaves: 3, warp: 0.08, seed: 4 }, low: 0.52, high: 0.88 },
        strength: 0.35,
      },
    ],
    roughness: { min: 0.8, max: 0.96 },
    roughnessBreakup: { frequency: 8, octaves: 3, amount: 0.07 },
    normalStrength: 1.7,
    aoStrength: 0.85,
    bakedCavity: 0.2,
    detail: detail({
      scale: 9,
      layers: [
        { kind: 'dunes', frequency: 5, shear: [3, 2], amplitude: 1, octaves: 2, warp: 0.6, threshold: 0.4 },
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
    // Projected triplanar at 15 m by `world/groundMaterial.ts`, which desaturates
    // this by 55%, warms it, and multiplies it by up to 1.45 from its own band and
    // fBm terms. That headroom is why the ramp tops out at 0x73 rather than the
    // v3 value of 0x7e: at 0x7e the lit faces landed above 0.7 albedo, ACES pushed
    // them to near-white, and every bit of relief on a sunlit face was crushed
    // flat — the "pale tan slab" in the review. 2.7:1, near-neutral with a slight
    // cool bias since the consumer supplies the warmth.
    ramp: [
      { stop: 0.0, color: 0x2b2e33 },
      { stop: 0.34, color: 0x3d4147 },
      { stop: 0.64, color: 0x51565d },
      { stop: 0.86, color: 0x646a72 },
      { stop: 1.0, color: 0x737a83 },
    ],
    layers: [
      // PRIMARY STRUCTURE: sedimentary bedding, ~68 cm courses.
      //
      // This replaces the v3 `ridged f7 octaves 6` base, which was the actual
      // cause of the "repeating cracked-polygon pattern". Ridged multifractal is
      // not scale-free the way the v3 comment claimed: the `prev` attenuation
      // concentrates energy on the *base* octave's crests, so f7 produced a
      // network of 2 m blobs — one distinctive shape at 1/7 of the tile, which
      // is precisely the stamp rule 1 in `textures.ts` forbids. In the 3x3
      // preview you could match blob for blob between neighbouring tiles.
      //
      // Bedding is the right primary for a cliff and it is structurally immune
      // to the stamp: an anisotropic band field carries almost no information
      // along u, so a repeat reads as *more strata* rather than as the same
      // shape again. There is nothing for the eye to match.
      {
        kind: 'grain',
        frequency: 20,
        across: 5,
        shear: [0, 0],
        amplitude: 1,
        octaves: 3,
        warp: 0.08,
        contrast: 1.4,
      },
      // Fractal roughening over the bands. fBm, not ridged: scale-free, so it
      // adds relief without adding a matchable shape.
      { kind: 'fbm', frequency: 15, amplitude: 0.4, octaves: 5, warp: 0.07, op: 'overlay' },
      // Columnar jointing: near-vertical fractures. This is the term that gives
      // a vertical face vertical relief — bedding alone shades a wall in
      // horizontal stripes and nothing else.
      //
      // `scratches`, not `grain`. A `grain` joint field is a sum of sheared
      // sinusoid-like octaves, so it puts a fracture at *every* cycle: crossed
      // with the bedding that produced a visible basket weave, which is just as
      // regular a lattice as the blob net it replaced. Thresholding keeps only
      // the strongest excursions, so the joints land at irregular spacing and in
      // irregular numbers, which is what real columnar jointing does.
      // `frequency` is the cycle count along v: at 3 a surviving joint ran most
      // of the tile's height, so the two or three that cleared the threshold
      // became per-tile landmarks and the 3x3 preview showed them as a regular
      // grid of dashes. 7 segments them at bedding-plane spacing, which is both
      // how real jointing terminates and enough of them that no one joint is
      // recognisable.
      {
        kind: 'scratches',
        frequency: 7,
        across: 20,
        shear: [0, 0],
        amplitude: 0.34,
        threshold: 0.64,
        op: 'sub',
      },
      // A second, coarser joint set at a different spacing, so the joint pattern
      // itself has no single signature frequency.
      {
        kind: 'scratches',
        frequency: 4,
        across: 9,
        shear: [1, 0],
        amplitude: 0.2,
        threshold: 0.74,
        op: 'sub',
        seedOffset: 5,
      },
      // Broken block faces at 62 / 31 / 21 cm, gated to the proud courses so
      // they sit on the ledges instead of filling the joints.
      {
        kind: 'pebbles',
        frequency: 24,
        amplitude: 0.32,
        jitter: 1,
        threshold: 0.42,
        width: 0.55,
        op: 'screen',
        mask: { from: 'field', low: 0.4, high: 0.82 },
      },
      // Weathering runs down the face. Sinuous, so unlike a Worley net it leaves
      // no polygon to recognise.
      {
        kind: 'rills',
        frequency: 22,
        amplitude: 0.16,
        threshold: 0.6,
        width: 0.22,
        warp: 0.08,
        op: 'sub',
      },
      // One fine fracture set at 29 cm cells. Small enough that the polygon is
      // below the scale the eye matches tile to tile; the v3 pair at f27/f45 sat
      // right in the matchable band.
      { kind: 'cracks', frequency: 52, amplitude: 0.18, width: 0.04, op: 'sub' },
      { kind: 'fbm', frequency: 120, amplitude: 0.24, octaves: 1 },
    ],
    tints: [
      {
        color: 0x22252a,
        mask: { from: 'cavity', low: 0.18, high: 0.68 },
        strength: 0.8,
      },
      // Iron staining running down the face — the warm accent against the cool
      // stone, and the thing that keeps a grey cliff from reading as a grey wall.
      // f12 rather than f4: at 15 m a f4 stain is a 3.75 m blotch, which is a
      // recognisable shape, and colour stamps just as hard as height does.
      {
        color: 0x5c483a,
        mask: { from: 'noise', noise: { frequency: 12, octaves: 4, warp: 0.14, seed: 7 }, low: 0.55, high: 0.9 },
        strength: 0.4,
        roughness: 0.9,
      },
      // Bleached, wind-scoured course faces. Keyed off the bedding through the
      // height field rather than off convexity, so whole courses lighten
      // together the way a real exposed bed does.
      {
        color: 0x848b94,
        mask: { from: 'convex', low: 0.36, high: 0.84 },
        strength: 0.34,
        roughness: 0.62,
      },
    ],
    roughness: { min: 0.54, max: 0.9 },
    roughnessBreakup: { frequency: 11, octaves: 3, amount: 0.1 },
    // 3.2 -> 3.6 with the bedding carrying real mid-scale gradient now. The v3
    // map had strong micro-crinkle and nothing between 30 cm and the tile, which
    // is what made a lit face read as painted rather than lit.
    normalStrength: 3.6,
    aoStrength: 1.45,
    bakedCavity: 0.3,
    contrast: 1.15,
    detail: detail({
      scale: 6,
      layers: [
        { kind: 'grain', frequency: 18, across: 4, shear: [0, 0], amplitude: 1, octaves: 3, contrast: 1.3 },
        { kind: 'pebbles', frequency: 14, amplitude: 0.5, jitter: 1, threshold: 0.34, op: 'screen' },
        { kind: 'cracks', frequency: 24, amplitude: 0.34, width: 0.06, op: 'sub' },
        { kind: 'speckle', frequency: 44, amplitude: 0.3, threshold: 0.55, op: 'screen' },
      ],
      normalStrength: 2.3,
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
