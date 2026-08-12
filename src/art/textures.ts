/**
 * Procedural texture synthesis. Owner: MATERIALS agent.
 *
 * The project ships zero third-party image assets (GDD legal note), so every
 * albedo / normal / ORM map is synthesised at load time and uploaded as a GPU
 * texture. Generation is seeded, so the same build always produces the same maps
 * and visual review iterations stay comparable frame-to-frame.
 *
 * ## Pipeline
 *
 * ```
 * layers  -> height field (composited, masked)    at n = size * supersample
 *         -> multi-radius blur pyramid            (cavity / convexity / slope)
 *         -> albedo (ramp LUT + tint layers)      linear RGB
 *         -> roughness / metalness                (ramp + breakup + tint override)
 *         -> normal (Sobel at n)                  tangent space, +Y up (OpenGL)
 *         -> box downsample n -> size             antialiases albedo, mips normals
 * ```
 *
 * Working at `size * supersample` and filtering down is what stops the fine
 * relief from turning into aliased sparkle: it is the same thing a normal-map
 * mip chain does, done once at the top level where the height field still exists.
 *
 * ## Tileability
 *
 * Everything is toroidal, not mirrored — see `noise.ts` for the two rules. Blur,
 * Sobel and mask sampling all wrap. `analyzeTileability()` measures the seam
 * against the interior and is used by the QA pass; a visible tiling period is an
 * automatic reject in `qa/REVIEW_RUBRIC.md`.
 *
 * ## API stability
 *
 * `TextureSet`, `MaterialRecipe`, `NoiseLayer` and `makeTextureSet` are consumed
 * by terrain, characters and props. Extend, do not rename. Every field added in
 * this pass is optional, so v0 recipes still compile.
 */

import * as THREE from 'three';
import { clamp01, lerp } from '@/core/mathx';
import {
  boxBlurWrap,
  fbm,
  hash01,
  ihash,
  perlin,
  pmod,
  ridged,
  sampleGridWrap,
  shearedPerlin,
  worley,
  worleyResult,
} from './noise';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TextureSet {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  /** Packed: R = ambient occlusion, G = roughness, B = metalness, A = height. */
  orm: THREE.Texture;
  /** Optional standalone height map. Only produced when `exportHeight` is set. */
  height?: THREE.Texture;
  /**
   * Close-range detail map. RG = tangent normal xy, B = roughness delta
   * (0.5 = neutral), A = albedo multiplier (0.5 = neutral). Sampled at
   * `detailScale` times the base UV rate and faded out with distance.
   */
  detail?: THREE.Texture;
  detailScale: number;
  detailFade: [number, number];
  detailStrength: number;
  /** Raw height field at final resolution; used by the splat array builder. */
  heightData: Float32Array;
  size: number;
  dispose(): void;
}

export type BlendOp = 'add' | 'sub' | 'mul' | 'max' | 'min' | 'screen' | 'overlay' | 'replace';

export type LayerKind =
  /** Fractal Brownian motion — the general-purpose "surface variation" term. */
  | 'fbm'
  /** Ridged multifractal — sharp crests, sedimentary rock, cliff faces. */
  | 'ridged'
  /** Absolute-value fBm — moss, corrosion, cloud-like blotches. */
  | 'billow'
  /** Worley F1 — rounded cells; cobbles, pebbles, scales. */
  | 'cell'
  /** Worley F2-F1 — the crack network between cells. Sharp, thin, dark. */
  | 'cracks'
  /** Worley F1 with per-cell height offset — cobblestone with individual stones. */
  | 'cobble'
  /** Analytic running-bond brick courses with recessed mortar. */
  | 'bricks'
  /** Anisotropic thin streaks along an integer shear direction. */
  | 'scratches'
  /** Anisotropic stretched noise — wood grain, brushed metal, fur, cloth nap. */
  | 'grain'
  /** Two perpendicular thread sets with over/under — woven cloth. */
  | 'weave'
  /** Warped sine ridges — wind-blown sand, dunes, ripples. */
  | 'dunes'
  /** Sparse isotropic dots from Worley F1 (grid speckle would be axis-aligned). */
  | 'speckle'
  /** Iterated domain warp — erosion flow, marble, weathering streaks. */
  | 'flow'
  /** Quantised fBm — rock strata, terraced sediment. */
  | 'terrace';

/**
 * A mask gates where a layer or a tint applies. This is the difference between
 * "sum of noise" and authored material: dirt goes in cavities, wear goes on
 * edges, moss goes on flat upward regions, and each is a different mask.
 */
export interface LayerMask {
  /**
   * - `field`     — the height accumulated so far (or the final height, for tints)
   * - `noise`     — a fresh independent noise field
   * - `cavity`    — multi-radius concavity; where dirt and grime collect
   * - `convex`    — multi-radius convexity; where paint chips and metal polishes
   * - `slope`     — gradient magnitude of the height field
   */
  from: 'field' | 'noise' | 'cavity' | 'convex' | 'slope';
  /** Required when `from === 'noise'`. */
  noise?: { kind?: LayerKind; frequency: number; octaves?: number; warp?: number; seed?: number };
  /** Smoothstep window. `low > high` inverts. */
  low: number;
  high: number;
  /** Applied after the window; > 1 tightens the mask toward 0. */
  gamma?: number;
}

export interface NoiseLayer {
  kind: LayerKind;
  /** Cycles per tile. Rounded to an integer — periodicity depends on it. */
  frequency: number;
  amplitude: number;
  octaves?: number;
  gain?: number;
  /** Domain warp, in tile units. 0.02–0.12 is the useful range. */
  warp?: number;
  /** How this layer composites onto the accumulator. Default `add`. */
  op?: BlendOp;
  mask?: LayerMask;
  /** Contrast around 0.5 applied to the layer before compositing. */
  contrast?: number;
  bias?: number;
  invert?: boolean;
  seedOffset?: number;

  // Kind-specific --------------------------------------------------------
  /** `cell`/`cracks`/`cobble`/`speckle`: feature point scatter, 0..1. */
  jitter?: number;
  /** `cracks`: width of the crack, in cell units. */
  width?: number;
  /** `bricks`: courses per tile (must be even for a running bond). */
  rows?: number;
  /** `bricks`: bricks per course. */
  cols?: number;
  /** `bricks`: mortar gap as a fraction of a brick. */
  mortar?: number;
  /** `scratches`/`grain`/`weave`: integer shear, sets the direction. */
  shear?: [number, number];
  /** `scratches`/`grain`: frequency across the streak direction. */
  across?: number;
  /** `scratches`/`speckle`: sparsity cut, 0..1. Higher = fewer features. */
  threshold?: number;
  /** `terrace`: number of strata. */
  steps?: number;
}

export interface RampStop {
  stop: number;
  color: number;
  /** Optional per-stop roughness; overrides the global roughness ramp. */
  roughness?: number;
}

/** A colour pass applied over the ramp, gated by a mask. */
export interface TintLayer {
  color: number;
  mask: LayerMask;
  /** 0..1 opacity at full mask. */
  strength?: number;
  mode?: 'mix' | 'multiply' | 'screen';
  /** Roughness to blend toward where this tint applies. */
  roughness?: number;
  /** Metalness to blend toward where this tint applies. */
  metalness?: number;
}

/** Close-range detail layer. See `TextureSet.detail`. */
export interface DetailSpec {
  /** Repeats of the detail map per repeat of the base map. */
  scale: number;
  layers: NoiseLayer[];
  size?: number;
  normalStrength?: number;
  /** How strongly the detail modulates base albedo, 0..1. */
  albedoAmount?: number;
  /** How strongly the detail modulates base roughness, 0..1. */
  roughAmount?: number;
  /** View distance in world units over which the detail fades out. */
  fade?: [number, number];
  /** Overall detail normal contribution, 0..1. */
  strength?: number;
}

export interface MaterialRecipe {
  id: string;
  size: number;
  seed: number;
  ramp: RampStop[];
  layers: NoiseLayer[];
  tints?: TintLayer[];
  roughness: { min: number; max: number };
  /** Which field drives the roughness ramp. Default `height`. */
  roughnessSource?: 'height' | 'invHeight' | 'cavity' | 'convex';
  /** Independent roughness breakup — the thing that makes a surface read as real. */
  roughnessBreakup?: { frequency: number; octaves?: number; amount: number };
  metalness?: number;
  normalStrength?: number;
  aoStrength?: number;
  /**
   * Bakes a fraction of the cavity term into albedo. Real materials collect grime
   * in crevices; a little baked cavity also survives when SSAO is disabled on the
   * low tier. Keep under ~0.4 or it double-darkens against the AO map.
   */
  bakedCavity?: number;
  /** Contrast applied to the composited height field before it drives anything. */
  contrast?: number;
  tiling?: number;
  /** Working resolution multiplier. Default 2. */
  supersample?: number;
  detail?: DetailSpec;
  exportHeight?: boolean;
}

// ---------------------------------------------------------------------------
// Scratch buffers
// ---------------------------------------------------------------------------

const scratch = new Map<number, Float32Array>();
function scratchOf(res: number): Float32Array {
  let b = scratch.get(res);
  if (!b || b.length < res * res) {
    b = new Float32Array(res * res);
    scratch.set(res, b);
  }
  return b;
}

const ceil8 = (v: number): number => Math.max(8, Math.ceil(v / 8) * 8);

// ---------------------------------------------------------------------------
// Field synthesis
// ---------------------------------------------------------------------------

interface SynthCtx {
  n: number;
  seed: number;
  warpX: Float32Array;
  warpY: Float32Array;
  warpRes: number;
}

/**
 * Evaluates `fn` on a `res x res` grid and writes it into `dst` at resolution
 * `n`, upsampling with wrapped smootherstep-weighted bilinear when `res < n`.
 *
 * Evaluating each octave at the coarsest resolution that still resolves it is
 * the whole performance story of this module: a 5-octave fBm costs ~1.33x the
 * top octave instead of 5x, which is a 3.7x saving on the dominant term.
 */
function evalInto(dst: Float32Array, n: number, res: number, fn: (u: number, v: number) => number): void {
  if (res >= n) {
    const inv = 1 / n;
    for (let y = 0; y < n; y++) {
      const v = (y + 0.5) * inv;
      const row = y * n;
      for (let x = 0; x < n; x++) dst[row + x] = fn((x + 0.5) * inv, v);
    }
    return;
  }
  const src = scratchOf(res);
  const invR = 1 / res;
  for (let y = 0; y < res; y++) {
    const v = (y + 0.5) * invR;
    const row = y * res;
    for (let x = 0; x < res; x++) src[row + x] = fn((x + 0.5) * invR, v);
  }
  const invN = 1 / n;
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) * invN;
    const row = y * n;
    for (let x = 0; x < n; x++) dst[row + x] = sampleGridWrap(src, res, (x + 0.5) * invN, v);
  }
}

/** Applies the warp field to tile coordinates. Periodic in, periodic out. */
function warpU(ctx: SynthCtx, u: number, v: number, amt: number): number {
  return u + sampleGridWrap(ctx.warpX, ctx.warpRes, u, v) * amt;
}
function warpV(ctx: SynthCtx, u: number, v: number, amt: number): number {
  return v + sampleGridWrap(ctx.warpY, ctx.warpRes, u, v) * amt;
}

/**
 * Fractal kinds evaluated as a pyramid: each octave at its own resolution,
 * accumulated at full resolution. `ridged` keeps its sequential per-octave
 * attenuation (the term that puts detail on crests rather than everywhere) by
 * carrying a full-resolution `prev` buffer through the accumulation.
 */
function synthFractal(
  out: Float32Array,
  tmp: Float32Array,
  prev: Float32Array,
  ctx: SynthCtx,
  layer: NoiseLayer,
  seed: number,
): void {
  const n = ctx.n;
  const total = n * n;
  const octaves = Math.max(1, layer.octaves ?? 4);
  const gain = layer.gain ?? 0.5;
  const warp = layer.warp ?? 0;
  const isRidged = layer.kind === 'ridged';
  const isBillow = layer.kind === 'billow';

  out.fill(0);
  if (isRidged) prev.fill(1);

  let amp = 1;
  let norm = 0;
  let f = Math.max(1, Math.round(layer.frequency));

  for (let o = 0; o < octaves; o++) {
    const res = Math.min(n, ceil8(f * 6));
    const fo = f;
    const so = seed + o * 1013;
    evalInto(tmp, n, res, (u, v) => {
      const wu = warp ? warpU(ctx, u, v, warp) : u;
      const wv = warp ? warpV(ctx, u, v, warp) : v;
      return perlin(wu * fo, wv * fo, fo, fo, so);
    });

    if (isRidged) {
      for (let i = 0; i < total; i++) {
        let val = 1 - Math.abs(tmp[i]!);
        val *= val;
        val *= prev[i]!;
        prev[i] = clamp01(val * 2);
        out[i] += amp * val;
      }
    } else if (isBillow) {
      for (let i = 0; i < total; i++) out[i] += amp * Math.abs(tmp[i]!);
    } else {
      for (let i = 0; i < total; i++) out[i] += amp * (tmp[i]! * 0.5 + 0.5);
    }

    norm += amp;
    amp *= gain;
    f *= 2;
  }

  const inv = 1 / norm;
  for (let i = 0; i < total; i++) out[i] = out[i]! * inv;
}

/** Non-fractal kinds: analytic or single-scale cellular. */
function synthDirect(
  out: Float32Array,
  ctx: SynthCtx,
  layer: NoiseLayer,
  seed: number,
): void {
  const n = ctx.n;
  const f = Math.max(1, Math.round(layer.frequency));
  const warp = layer.warp ?? 0;
  const jitter = layer.jitter ?? 0.9;

  switch (layer.kind) {
    case 'cell': {
      evalInto(out, n, Math.min(n, ceil8(f * 24)), (u, v) => {
        const wu = warp ? warpU(ctx, u, v, warp) : u;
        const wv = warp ? warpV(ctx, u, v, warp) : v;
        worley(wu * f, wv * f, f, f, seed, jitter);
        return clamp01(1 - worleyResult.f1 * 1.6);
      });
      return;
    }
    case 'cracks': {
      const width = layer.width ?? 0.08;
      evalInto(out, n, Math.min(n, ceil8(f * 28)), (u, v) => {
        const wu = warp ? warpU(ctx, u, v, warp) : u;
        const wv = warp ? warpV(ctx, u, v, warp) : v;
        worley(wu * f, wv * f, f, f, seed, jitter);
        const edge = worleyResult.f2 - worleyResult.f1;
        // 1 in the crack, 0 on the plate. Smooth so it survives downsampling.
        return 1 - clamp01(edge / width);
      });
      return;
    }
    case 'cobble': {
      evalInto(out, n, Math.min(n, ceil8(f * 24)), (u, v) => {
        const wu = warp ? warpU(ctx, u, v, warp) : u;
        const wv = warp ? warpV(ctx, u, v, warp) : v;
        worley(wu * f, wv * f, f, f, seed, jitter);
        const r = worleyResult.f1;
        const edge = worleyResult.f2 - worleyResult.f1;
        // Dome per stone, each stone at its own height, mortar sunk between.
        const dome = Math.sqrt(clamp01(1 - r * r * 2.2));
        const stone = (worleyResult.id & 255) / 255;
        const gap = clamp01(edge / 0.09);
        return clamp01((0.45 + 0.55 * dome) * (0.7 + 0.3 * stone)) * gap;
      });
      return;
    }
    case 'bricks': {
      const rows = Math.max(2, Math.round((layer.rows ?? 8) / 2) * 2);
      const cols = Math.max(1, Math.round(layer.cols ?? 4));
      const mortar = layer.mortar ?? 0.06;
      evalInto(out, n, n, (u, v) => {
        const wu = warp ? warpU(ctx, u, v, warp) : u;
        const wv = warp ? warpV(ctx, u, v, warp) : v;
        const ry = wv * rows;
        const row = Math.floor(ry);
        const fy = ry - row;
        const offset = (pmod(row, 2) * 0.5) / cols;
        const rx = (wu + offset) * cols;
        const col = Math.floor(rx);
        const fx = rx - col;
        // Distance to the nearest brick edge, in brick-fraction units.
        const dx = Math.min(fx, 1 - fx);
        const dy = Math.min(fy, 1 - fy);
        const d = Math.min(dx, dy);
        const face = clamp01((d - mortar) / mortar);
        const h = hash01(pmod(col, cols), pmod(row, rows), seed);
        // Individual bricks sit at slightly different depths.
        return face * (0.72 + 0.28 * h);
      });
      return;
    }
    case 'scratches': {
      const sh = layer.shear ?? [1, 0];
      const across = Math.max(1, Math.round(layer.across ?? f * 8));
      const thr = layer.threshold ?? 0.72;
      evalInto(out, n, n, (u, v) => {
        const s = shearedPerlin(u, v, across, f, sh[0], sh[1], seed);
        const t = Math.abs(s);
        // Thin bright filaments where the stretched field crosses the threshold.
        return clamp01((t - thr) / (1 - thr));
      });
      return;
    }
    case 'grain': {
      const sh = layer.shear ?? [0, 0];
      const across = Math.max(1, Math.round(layer.across ?? f * 6));
      const oct = layer.octaves ?? 3;
      evalInto(out, n, n, (u, v) => {
        let sum = 0;
        let amp = 1;
        let norm = 0;
        for (let o = 0; o < oct; o++) {
          const m = 1 << o;
          sum += amp * shearedPerlin(u, v, across * m, f * m, sh[0], sh[1], seed + o * 733);
          norm += amp;
          amp *= 0.5;
        }
        return sum / norm * 0.5 + 0.5;
      });
      return;
    }
    case 'weave': {
      const across = Math.max(1, Math.round(layer.across ?? f));
      evalInto(out, n, n, (u, v) => {
        const a = Math.sin(u * f * Math.PI * 2);
        const b = Math.sin(v * across * Math.PI * 2);
        // Over/under: whichever thread is on top owns the pixel.
        const warpT = 0.5 + 0.5 * a;
        const weftT = 0.5 + 0.5 * b;
        const overUnder = Math.sin(u * f * Math.PI) * Math.sin(v * across * Math.PI) > 0;
        const top = overUnder ? warpT : weftT;
        const bottom = overUnder ? weftT : warpT;
        return clamp01(top * 0.75 + bottom * 0.25);
      });
      return;
    }
    case 'dunes': {
      const oct = layer.octaves ?? 3;
      const sh = layer.shear ?? [1, 0];
      evalInto(out, n, Math.min(n, ceil8(f * 16)), (u, v) => {
        const d = fbm(u, v, Math.max(1, Math.round(f / 3)), seed + 51, oct);
        const phase = (u * sh[0] + v * sh[1]) * f + d * 0.6;
        const s = Math.sin(phase * Math.PI * 2);
        // Sharpened crests, soft troughs — the asymmetry of a wind ripple.
        return clamp01(Math.pow(0.5 + 0.5 * s, 0.65));
      });
      return;
    }
    case 'speckle': {
      const thr = layer.threshold ?? 0.62;
      evalInto(out, n, Math.min(n, ceil8(f * 12)), (u, v) => {
        worley(u * f, v * f, f, f, seed, 1);
        const r = clamp01(1 - worleyResult.f1 * 2.4);
        const pick = ((worleyResult.id >>> 8) & 255) / 255;
        return pick > thr ? r : 0;
      });
      return;
    }
    case 'flow': {
      const oct = layer.octaves ?? 4;
      const amt = layer.warp ?? 0.09;
      const base = Math.max(1, Math.round(f));
      evalInto(out, n, Math.min(n, ceil8(f * 12)), (u, v) => {
        // Two-step iterated warp: q warps p, p warps the final sample.
        const qx = fbm(u, v, base, seed + 7, 3);
        const qy = fbm(u, v, base, seed + 907, 3);
        const px = fbm(u + qx * amt, v + qy * amt, base, seed + 1301, 3);
        const py = fbm(u + qx * amt, v + qy * amt, base, seed + 2003, 3);
        return fbm(u + px * amt * 1.6, v + py * amt * 1.6, base, seed + 3109, oct) * 0.5 + 0.5;
      });
      return;
    }
    case 'terrace': {
      const steps = Math.max(2, layer.steps ?? 6);
      const oct = layer.octaves ?? 4;
      evalInto(out, n, Math.min(n, ceil8(f * 10)), (u, v) => {
        const wu = warp ? warpU(ctx, u, v, warp) : u;
        const wv = warp ? warpV(ctx, u, v, warp) : v;
        const h = fbm(wu, wv, f, seed, oct) * 0.5 + 0.5;
        const q = Math.floor(h * steps) / steps;
        const frac = h * steps - Math.floor(h * steps);
        // Hard riser, soft tread — sedimentary bedding.
        return clamp01(q + (frac * frac * frac) / steps);
      });
      return;
    }
    default:
      out.fill(0.5);
  }
}

function synthLayer(
  out: Float32Array,
  tmp: Float32Array,
  prev: Float32Array,
  ctx: SynthCtx,
  layer: NoiseLayer,
): void {
  const seed = ctx.seed + (layer.seedOffset ?? 0) * 7919 + hashKind(layer.kind);
  if (layer.kind === 'fbm' || layer.kind === 'ridged' || layer.kind === 'billow') {
    synthFractal(out, tmp, prev, ctx, layer, seed);
  } else {
    synthDirect(out, ctx, layer, seed);
  }

  const total = ctx.n * ctx.n;
  const contrast = layer.contrast ?? 1;
  const bias = layer.bias ?? 0;
  const invert = layer.invert === true;
  if (contrast !== 1 || bias !== 0 || invert) {
    for (let i = 0; i < total; i++) {
      let v = clamp01((out[i]! - 0.5) * contrast + 0.5 + bias);
      if (invert) v = 1 - v;
      out[i] = v;
    }
  }
}

function hashKind(kind: LayerKind): number {
  let h = 0;
  for (let i = 0; i < kind.length; i++) h = (Math.imul(h, 31) + kind.charCodeAt(i)) | 0;
  return h & 0xffff;
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

interface DerivedFields {
  cavity: Float32Array;
  convex: Float32Array;
  slope: Float32Array;
}

function buildMask(
  dst: Float32Array,
  ctx: SynthCtx,
  mask: LayerMask,
  field: Float32Array,
  derived: DerivedFields | null,
): void {
  const n = ctx.n;
  const total = n * n;
  let src: Float32Array;

  switch (mask.from) {
    case 'noise': {
      const spec = mask.noise ?? { frequency: 4 };
      const kind = spec.kind ?? 'fbm';
      const f = Math.max(1, Math.round(spec.frequency));
      const oct = spec.octaves ?? 4;
      const seed = ctx.seed + 4507 + (spec.seed ?? 0) * 131;
      const warp = spec.warp ?? 0;
      evalInto(dst, n, Math.min(n, ceil8(f * (1 << oct) * 1.5)), (u, v) => {
        const wu = warp ? warpU(ctx, u, v, warp) : u;
        const wv = warp ? warpV(ctx, u, v, warp) : v;
        if (kind === 'ridged') return ridged(wu, wv, f, seed, oct);
        return fbm(wu, wv, f, seed, oct) * 0.5 + 0.5;
      });
      src = dst;
      break;
    }
    case 'cavity':
      src = derived ? derived.cavity : field;
      break;
    case 'convex':
      src = derived ? derived.convex : field;
      break;
    case 'slope':
      src = derived ? derived.slope : field;
      break;
    default:
      src = field;
  }

  const lo = mask.low;
  const hi = mask.high;
  const inv = hi === lo ? 0 : 1 / (hi - lo);
  const gamma = mask.gamma ?? 1;
  for (let i = 0; i < total; i++) {
    let t = clamp01((src[i]! - lo) * inv);
    t = t * t * (3 - 2 * t);
    dst[i] = gamma === 1 ? t : Math.pow(t, gamma);
  }
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

function composite(
  acc: Float32Array,
  layerBuf: Float32Array,
  maskBuf: Float32Array | null,
  total: number,
  op: BlendOp,
  amplitude: number,
  first: boolean,
): void {
  for (let i = 0; i < total; i++) {
    const w = amplitude * (maskBuf ? maskBuf[i]! : 1);
    if (w === 0) continue;
    const s = layerBuf[i]!;
    const a = first ? 0 : acc[i]!;
    let r: number;
    switch (op) {
      case 'add':
        r = a + s * w;
        break;
      case 'sub':
        r = a - s * w;
        break;
      case 'mul':
        r = a * (1 - w) + a * s * w;
        break;
      case 'max':
        r = a * (1 - w) + Math.max(a, s) * w;
        break;
      case 'min':
        r = a * (1 - w) + Math.min(a, s) * w;
        break;
      case 'screen':
        r = a * (1 - w) + (1 - (1 - a) * (1 - s)) * w;
        break;
      case 'overlay': {
        const o = a < 0.5 ? 2 * a * s : 1 - 2 * (1 - a) * (1 - s);
        r = a * (1 - w) + o * w;
        break;
      }
      default:
        r = a * (1 - w) + s * w;
    }
    acc[i] = r;
  }
}

function normalize01(buf: Float32Array, total: number, contrast: number): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < total; i++) {
    const v = buf[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  const inv = span > 1e-6 ? 1 / span : 1;
  if (contrast === 1) {
    for (let i = 0; i < total; i++) buf[i] = (buf[i]! - lo) * inv;
  } else {
    for (let i = 0; i < total; i++) {
      const v = (buf[i]! - lo) * inv;
      buf[i] = clamp01((v - 0.5) * contrast + 0.5);
    }
  }
}

// ---------------------------------------------------------------------------
// Derived fields: multi-radius cavity, convexity, slope
// ---------------------------------------------------------------------------

/**
 * Multi-radius ambient/cavity term.
 *
 * The v0 version compared a pixel against four taps two texels away, which only
 * sees single-texel noise and produces a high-frequency grain rather than
 * occlusion. Real cavity occlusion is scale-dependent: a pixel is dark because it
 * sits below its neighbourhood at *several* radii at once. Comparing against
 * box-blurred copies at 1/2/4/8/16/32 texels and weighting toward the mid radii
 * gives a term that tracks actual recesses (mortar lines, cracks, scale gaps)
 * instead of tracking noise.
 */
function buildDerived(
  height: Float32Array,
  n: number,
  scale: number,
  blurA: Float32Array,
  blurB: Float32Array,
  tmp: Float32Array,
): DerivedFields {
  const total = n * n;
  const cavity = new Float32Array(total);
  const convex = new Float32Array(total);
  const slope = new Float32Array(total);

  const radii = [1, 2, 4, 8, 16, 32];
  const weights = [0.35, 0.55, 0.85, 1.0, 0.8, 0.5];
  let wsum = 0;
  for (const w of weights) wsum += w;
  const invW = 1 / wsum;

  for (let r = 0; r < radii.length; r++) {
    const radius = Math.max(1, Math.round(radii[r]! * scale));
    if (radius >= n / 2) continue;
    boxBlurWrap(height, blurA, blurB, n, radius);
    const w = weights[r]! * invW;
    // Larger radii need a smaller gain: the height delta grows with radius.
    const gain = 3.2 / Math.pow(radii[r]!, 0.35);
    for (let i = 0; i < total; i++) {
      const d = (blurA[i]! - height[i]!) * gain;
      if (d > 0) cavity[i] += w * clamp01(d);
      else convex[i] += w * clamp01(-d);
    }
  }

  // Slope from a one-texel central difference, scaled to be resolution neutral.
  const k = n / 512;
  for (let y = 0; y < n; y++) {
    const ym = pmod(y - 1, n) * n;
    const yp = pmod(y + 1, n) * n;
    const row = y * n;
    for (let x = 0; x < n; x++) {
      const xm = pmod(x - 1, n);
      const xp = pmod(x + 1, n);
      const gx = (height[row + xp]! - height[row + xm]!) * k;
      const gy = (height[yp + x]! - height[ym + x]!) * k;
      slope[row + x] = clamp01(Math.hypot(gx, gy) * 6);
    }
  }

  // `tmp` is reused by the caller; touch it so the parameter is not dead weight.
  tmp[0] = cavity[0]!;
  return { cavity, convex, slope };
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const LUT_N = 512;

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

function hexToLinear(hex: number, out: [number, number, number]): void {
  out[0] = srgbToLinear(((hex >> 16) & 255) / 255);
  out[1] = srgbToLinear(((hex >> 8) & 255) / 255);
  out[2] = srgbToLinear((hex & 255) / 255);
}

/**
 * Bakes the ramp into a LUT of linear RGB plus optional per-stop roughness.
 * Interpolating in linear light is what keeps a dark-to-light ramp from going
 * muddy in the middle, which is where the v0 ground ramps lost their contrast.
 */
function buildRampLut(ramp: RampStop[]): { rgb: Float32Array; rough: Float32Array; hasRough: boolean } {
  const rgb = new Float32Array(LUT_N * 3);
  const rough = new Float32Array(LUT_N);
  const sorted = [...ramp].sort((a, b) => a.stop - b.stop);
  const hasRough = sorted.some((s) => s.roughness !== undefined);
  const ca: [number, number, number] = [0, 0, 0];
  const cb: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < LUT_N; i++) {
    const t = i / (LUT_N - 1);
    let a = sorted[0]!;
    let b = sorted[sorted.length - 1]!;
    let k = 0;
    if (t <= a.stop) {
      b = a;
    } else if (t >= b.stop) {
      a = b;
    } else {
      for (let s = 0; s < sorted.length - 1; s++) {
        if (t >= sorted[s]!.stop && t <= sorted[s + 1]!.stop) {
          a = sorted[s]!;
          b = sorted[s + 1]!;
          k = (t - a.stop) / Math.max(1e-6, b.stop - a.stop);
          break;
        }
      }
    }
    hexToLinear(a.color, ca);
    hexToLinear(b.color, cb);
    rgb[i * 3] = lerp(ca[0], cb[0], k);
    rgb[i * 3 + 1] = lerp(ca[1], cb[1], k);
    rgb[i * 3 + 2] = lerp(ca[2], cb[2], k);
    rough[i] = lerp(a.roughness ?? 0, b.roughness ?? 0, k);
  }
  return { rgb, rough, hasRough };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface GenerationStats {
  id: string;
  ms: number;
  bytes: number;
}

const generationStats: GenerationStats[] = [];
export function textureGenerationStats(): readonly GenerationStats[] {
  return generationStats;
}
export function resetTextureGenerationStats(): void {
  generationStats.length = 0;
}

export function makeTextureSet(recipe: MaterialRecipe): TextureSet {
  const t0 =
    typeof performance !== 'undefined' ? performance.now() : Date.now();

  const size = recipe.size;
  const ss = Math.max(1, Math.round(recipe.supersample ?? 2));
  const n = size * ss;
  const total = n * n;

  // --- Warp field ---------------------------------------------------------
  const warpRes = Math.min(192, Math.max(48, Math.round(n / 8)));
  const warpX = new Float32Array(warpRes * warpRes);
  const warpY = new Float32Array(warpRes * warpRes);
  for (let y = 0; y < warpRes; y++) {
    const v = (y + 0.5) / warpRes;
    for (let x = 0; x < warpRes; x++) {
      const u = (x + 0.5) / warpRes;
      warpX[y * warpRes + x] = fbm(u, v, 3, recipe.seed + 991, 4);
      warpY[y * warpRes + x] = fbm(u, v, 3, recipe.seed + 1777, 4);
    }
  }
  const ctx: SynthCtx = { n, seed: recipe.seed, warpX, warpY, warpRes };

  // --- Height field -------------------------------------------------------
  const acc = new Float32Array(total);
  const layerBuf = new Float32Array(total);
  const tmpA = new Float32Array(total);
  const tmpB = new Float32Array(total);
  const maskBuf = new Float32Array(total);

  let first = true;
  for (const layer of recipe.layers) {
    synthLayer(layerBuf, tmpA, tmpB, ctx, layer);
    let mask: Float32Array | null = null;
    if (layer.mask) {
      // Layer masks read the accumulator so far, never the derived fields —
      // those do not exist until the height field is final.
      buildMask(maskBuf, ctx, layer.mask, acc, null);
      mask = maskBuf;
    }
    composite(acc, layerBuf, mask, total, layer.op ?? 'add', layer.amplitude, first && !layer.op);
    first = false;
  }
  normalize01(acc, total, recipe.contrast ?? 1);
  const height = acc;

  // --- Derived fields -----------------------------------------------------
  const derived = buildDerived(height, n, n / 512, tmpA, tmpB, layerBuf);

  // --- Albedo / roughness / metalness ------------------------------------
  const lut = buildRampLut(recipe.ramp);
  const albedoLin = new Float32Array(total * 3);
  const roughF = new Float32Array(total);
  const metalF = new Float32Array(total);
  const baseMetal = recipe.metalness ?? 0;
  const rSrc = recipe.roughnessSource ?? 'height';
  const rMin = recipe.roughness.min;
  const rMax = recipe.roughness.max;

  for (let i = 0; i < total; i++) {
    const h = height[i]!;
    const li = (h * (LUT_N - 1)) | 0;
    albedoLin[i * 3] = lut.rgb[li * 3]!;
    albedoLin[i * 3 + 1] = lut.rgb[li * 3 + 1]!;
    albedoLin[i * 3 + 2] = lut.rgb[li * 3 + 2]!;

    const drive =
      rSrc === 'invHeight'
        ? 1 - h
        : rSrc === 'cavity'
          ? derived.cavity[i]!
          : rSrc === 'convex'
            ? derived.convex[i]!
            : h;
    roughF[i] = lut.hasRough ? lut.rough[li]! : lerp(rMin, rMax, drive);
    metalF[i] = baseMetal;
  }

  // Independent roughness breakup. Roughness that only tracks albedo reads as a
  // printed texture; breaking it with its own field is what makes a surface look
  // like it has been touched by the world.
  if (recipe.roughnessBreakup) {
    const bk = recipe.roughnessBreakup;
    const f = Math.max(1, Math.round(bk.frequency));
    const oct = bk.octaves ?? 3;
    evalInto(layerBuf, n, Math.min(n, ceil8(f * (1 << oct) * 1.5)), (u, v) =>
      fbm(u, v, f, recipe.seed + 6151, oct),
    );
    for (let i = 0; i < total; i++) {
      roughF[i] = clamp01(roughF[i]! + layerBuf[i]! * bk.amount);
    }
  }

  // --- Tints --------------------------------------------------------------
  const tintCol: [number, number, number] = [0, 0, 0];
  for (const tint of recipe.tints ?? []) {
    buildMask(maskBuf, ctx, tint.mask, height, derived);
    hexToLinear(tint.color, tintCol);
    const strength = tint.strength ?? 1;
    const mode = tint.mode ?? 'mix';
    for (let i = 0; i < total; i++) {
      const w = maskBuf[i]! * strength;
      if (w <= 0.001) continue;
      const o = i * 3;
      for (let c = 0; c < 3; c++) {
        const base = albedoLin[o + c]!;
        const t = tintCol[c]!;
        const blended =
          mode === 'multiply' ? base * t * 2 : mode === 'screen' ? 1 - (1 - base) * (1 - t) : t;
        albedoLin[o + c] = base + (blended - base) * w;
      }
      if (tint.roughness !== undefined) roughF[i] = lerp(roughF[i]!, tint.roughness, w);
      if (tint.metalness !== undefined) metalF[i] = lerp(metalF[i]!, tint.metalness, w);
    }
  }

  // --- Baked cavity into albedo ------------------------------------------
  const baked = recipe.bakedCavity ?? 0.28;
  if (baked > 0) {
    for (let i = 0; i < total; i++) {
      const d = 1 - derived.cavity[i]! * baked;
      const o = i * 3;
      albedoLin[o] = albedoLin[o]! * d;
      albedoLin[o + 1] = albedoLin[o + 1]! * d;
      albedoLin[o + 2] = albedoLin[o + 2]! * d;
    }
  }

  // --- AO -----------------------------------------------------------------
  const aoStrength = recipe.aoStrength ?? 1;
  const aoF = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    aoF[i] = clamp01(1 - derived.cavity[i]! * aoStrength);
  }

  // --- Normal -------------------------------------------------------------
  const nx = new Float32Array(total);
  const ny = new Float32Array(total);
  const nz = new Float32Array(total);
  buildNormals(height, n, recipe.normalStrength ?? 1.6, nx, ny, nz);

  // --- Downsample and encode ---------------------------------------------
  const albedoData = new Uint8Array(size * size * 4);
  const normalData = new Uint8Array(size * size * 4);
  const ormData = new Uint8Array(size * size * 4);
  const heightOut = new Float32Array(size * size);

  const inv = 1 / (ss * ss);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let ax = 0;
      let ay = 0;
      let az = 0;
      let ao = 0;
      let ro = 0;
      let me = 0;
      let he = 0;
      for (let sy = 0; sy < ss; sy++) {
        const row = (y * ss + sy) * n + x * ss;
        for (let sx = 0; sx < ss; sx++) {
          const i = row + sx;
          const o = i * 3;
          r += albedoLin[o]!;
          g += albedoLin[o + 1]!;
          b += albedoLin[o + 2]!;
          ax += nx[i]!;
          ay += ny[i]!;
          az += nz[i]!;
          ao += aoF[i]!;
          ro += roughF[i]!;
          me += metalF[i]!;
          he += height[i]!;
        }
      }
      const d = (y * size + x) * 4;
      albedoData[d] = enc(linearToSrgb(r * inv));
      albedoData[d + 1] = enc(linearToSrgb(g * inv));
      albedoData[d + 2] = enc(linearToSrgb(b * inv));
      albedoData[d + 3] = 255;

      const len = Math.hypot(ax, ay, az) || 1;
      normalData[d] = enc((ax / len) * 0.5 + 0.5);
      normalData[d + 1] = enc((ay / len) * 0.5 + 0.5);
      normalData[d + 2] = enc((az / len) * 0.5 + 0.5);
      normalData[d + 3] = 255;

      const hv = he * inv;
      ormData[d] = enc(ao * inv);
      ormData[d + 1] = enc(ro * inv);
      ormData[d + 2] = enc(me * inv);
      ormData[d + 3] = enc(hv);
      heightOut[y * size + x] = hv;
    }
  }

  const tiling = recipe.tiling ?? 1;
  const albedo = makeTexture(albedoData, size, THREE.SRGBColorSpace, tiling);
  const normal = makeTexture(normalData, size, THREE.NoColorSpace, tiling);
  const orm = makeTexture(ormData, size, THREE.NoColorSpace, tiling);
  albedo.name = `${recipe.id}:albedo`;
  normal.name = `${recipe.id}:normal`;
  orm.name = `${recipe.id}:orm`;

  let heightTex: THREE.DataTexture | undefined;
  if (recipe.exportHeight) {
    const hd = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const b = enc(heightOut[i]!);
      hd[i * 4] = b;
      hd[i * 4 + 1] = b;
      hd[i * 4 + 2] = b;
      hd[i * 4 + 3] = 255;
    }
    heightTex = makeTexture(hd, size, THREE.NoColorSpace, tiling);
    heightTex.name = `${recipe.id}:height`;
  }

  let detailTex: THREE.DataTexture | undefined;
  const ds = recipe.detail;
  if (ds) {
    detailTex = makeDetailMap(ds, recipe.seed + 31337, recipe.id);
  }

  const bytes =
    textureBytes(size) * (2 + 1) + (heightTex ? textureBytes(size) : 0) +
    (detailTex ? textureBytes(ds?.size ?? 256) : 0);

  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  generationStats.push({ id: recipe.id, ms, bytes });

  return {
    albedo,
    normal,
    orm,
    height: heightTex,
    detail: detailTex,
    detailScale: ds?.scale ?? 8,
    detailFade: ds?.fade ?? [26, 70],
    detailStrength: ds?.strength ?? 1,
    heightData: heightOut,
    size,
    dispose(): void {
      albedo.dispose();
      normal.dispose();
      orm.dispose();
      heightTex?.dispose();
      detailTex?.dispose();
    },
  };
}

const enc = (v: number): number => {
  const x = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  return x;
};

/**
 * Sobel-derived tangent-space normals, resolution independent.
 *
 * The v0 version multiplied a raw central difference by `normalStrength`, which
 * made the apparent relief depend on texture size — a 1024 map read half as deep
 * as a 512 map from the same recipe. Here the gradient is scaled by `n / 512`, so
 * `normalStrength` means the same thing at every resolution and existing recipe
 * values keep their intent.
 *
 * Convention: OpenGL / +Y up, matching `THREE.MeshStandardMaterial.normalMap`.
 * `DataTexture` does not flip Y, so row index and V increase together and the
 * green channel is `-dh/dv`.
 */
function buildNormals(
  height: Float32Array,
  n: number,
  strength: number,
  nx: Float32Array,
  ny: Float32Array,
  nz: Float32Array,
): void {
  const k = strength * (n / 512) * 0.25;
  for (let y = 0; y < n; y++) {
    const ym = pmod(y - 1, n) * n;
    const y0 = y * n;
    const yp = pmod(y + 1, n) * n;
    for (let x = 0; x < n; x++) {
      const xm = pmod(x - 1, n);
      const xp = pmod(x + 1, n);
      const h00 = height[ym + xm]!;
      const h10 = height[ym + x]!;
      const h20 = height[ym + xp]!;
      const h01 = height[y0 + xm]!;
      const h21 = height[y0 + xp]!;
      const h02 = height[yp + xm]!;
      const h12 = height[yp + x]!;
      const h22 = height[yp + xp]!;

      const gx = (h20 + 2 * h21 + h22 - (h00 + 2 * h01 + h02)) * k;
      const gy = (h02 + 2 * h12 + h22 - (h00 + 2 * h10 + h20)) * k;

      const len = Math.sqrt(gx * gx + gy * gy + 1);
      const i = y0 + x;
      nx[i] = -gx / len;
      ny[i] = -gy / len;
      nz[i] = 1 / len;
    }
  }
}

/**
 * Detail map: a small, high-frequency companion sampled at `scale` times the base
 * UV rate and faded out with view distance.
 *
 * This is the answer to the single biggest failure of the v0 library — at hero
 * zoom a 512px ground tile stretched over metres of world turns to soup, because
 * there is simply no signal above its Nyquist. A second map at 8-16x the tile
 * rate supplies that signal at a memory cost of one 256px texture per material.
 *
 * Packing: R,G = tangent normal xy, B = roughness delta (0.5 neutral),
 * A = albedo multiplier (0.5 neutral). Z is reconstructed in the shader.
 */
export function makeDetailMap(spec: DetailSpec, seed: number, id: string): THREE.DataTexture {
  const size = spec.size ?? 256;
  const ss = 2;
  const n = size * ss;
  const total = n * n;

  const warpRes = 64;
  const warpX = new Float32Array(warpRes * warpRes);
  const warpY = new Float32Array(warpRes * warpRes);
  for (let y = 0; y < warpRes; y++) {
    const v = (y + 0.5) / warpRes;
    for (let x = 0; x < warpRes; x++) {
      const u = (x + 0.5) / warpRes;
      warpX[y * warpRes + x] = fbm(u, v, 3, seed + 17, 3);
      warpY[y * warpRes + x] = fbm(u, v, 3, seed + 29, 3);
    }
  }
  const ctx: SynthCtx = { n, seed, warpX, warpY, warpRes };

  const acc = new Float32Array(total);
  const buf = new Float32Array(total);
  const tmpA = new Float32Array(total);
  const tmpB = new Float32Array(total);

  let first = true;
  for (const layer of spec.layers) {
    synthLayer(buf, tmpA, tmpB, ctx, layer);
    composite(acc, buf, null, total, layer.op ?? 'add', layer.amplitude, first && !layer.op);
    first = false;
  }
  normalize01(acc, total, 1);

  const nx = new Float32Array(total);
  const ny = new Float32Array(total);
  const nz = new Float32Array(total);
  buildNormals(acc, n, spec.normalStrength ?? 1.4, nx, ny, nz);

  const albedoAmount = spec.albedoAmount ?? 0.35;
  const roughAmount = spec.roughAmount ?? 0.3;
  const data = new Uint8Array(size * size * 4);
  const inv = 1 / (ss * ss);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ax = 0;
      let ay = 0;
      let az = 0;
      let h = 0;
      for (let sy = 0; sy < ss; sy++) {
        const row = (y * ss + sy) * n + x * ss;
        for (let sx = 0; sx < ss; sx++) {
          const i = row + sx;
          ax += nx[i]!;
          ay += ny[i]!;
          az += nz[i]!;
          h += acc[i]!;
        }
      }
      const len = Math.hypot(ax, ay, az) || 1;
      const d = (y * size + x) * 4;
      data[d] = enc((ax / len) * 0.5 + 0.5);
      data[d + 1] = enc((ay / len) * 0.5 + 0.5);
      const hv = h * inv - 0.5;
      data[d + 2] = enc(0.5 + hv * roughAmount);
      data[d + 3] = enc(0.5 + hv * albedoAmount);
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.name = `${id}:detail`;
  tex.needsUpdate = true;
  return tex;
}

function makeTexture(
  data: Uint8Array,
  size: number,
  colorSpace: THREE.ColorSpace,
  tiling: number,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(tiling, tiling);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** RGBA8 + full mip chain, in bytes. */
export function textureBytes(size: number): number {
  return Math.round(size * size * 4 * 1.3334);
}

// ---------------------------------------------------------------------------
// QA helpers
// ---------------------------------------------------------------------------

export interface TileReport {
  id: string;
  /** Mean absolute step across the wrap seam, in 0-255 units. */
  seamStep: number;
  /** Mean absolute step one texel inside the tile, for comparison. */
  interiorStep: number;
  /** seamStep / interiorStep. 1.0 means the seam is indistinguishable. */
  ratio: number;
  seamless: boolean;
}

/**
 * Measures whether a generated map actually wraps.
 *
 * A toroidal field has the same statistics across the wrap edge as anywhere
 * else, so the test is a ratio, not an absolute: if the mean step across the
 * seam is within ~1.35x of the mean interior step, no seam is visible. This
 * catches the class of bug where one layer forgets to wrap and produces a hard
 * line down the middle of every tile.
 */
export function analyzeTileability(tex: THREE.DataTexture, id: string): TileReport {
  const img = tex.image as { data: Uint8Array; width: number; height: number };
  const data = img.data;
  const w = img.width;
  const h = img.height;

  let seam = 0;
  let interior = 0;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      seam += Math.abs(data[(y * w + 0) * 4 + c]! - data[(y * w + (w - 1)) * 4 + c]!);
      interior += Math.abs(data[(y * w + 1) * 4 + c]! - data[(y * w + 0) * 4 + c]!);
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      seam += Math.abs(data[(0 * w + x) * 4 + c]! - data[((h - 1) * w + x) * 4 + c]!);
      interior += Math.abs(data[(1 * w + x) * 4 + c]! - data[(0 * w + x) * 4 + c]!);
    }
  }
  const nSamples = (w + h) * 3;
  const seamStep = seam / nSamples;
  const interiorStep = interior / nSamples;
  const ratio = interiorStep > 0.01 ? seamStep / interiorStep : seamStep;
  return { id, seamStep, interiorStep, ratio, seamless: ratio < 1.35 };
}

/** Cheap statistical read used to catch flat / washed-out maps. */
export function analyzeContrast(tex: THREE.DataTexture): {
  min: number;
  max: number;
  mean: number;
  stdev: number;
} {
  const data = (tex.image as { data: Uint8Array }).data;
  let min = 255;
  let max = 0;
  let sum = 0;
  let sum2 = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    if (l < min) min = l;
    if (l > max) max = l;
    sum += l;
    sum2 += l * l;
    count++;
  }
  const mean = sum / count;
  return { min, max, mean, stdev: Math.sqrt(Math.max(0, sum2 / count - mean * mean)) };
}

/** Re-exported so callers can seed their own deterministic variation. */
export { ihash as textureHash };
