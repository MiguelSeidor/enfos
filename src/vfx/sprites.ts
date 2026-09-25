/**
 * Procedural VFX imagery. Owner: VFX.
 *
 * Zero third-party assets (GDD legal note), so every sprite and decal used by
 * the effect systems is rasterised here at boot. Two array textures come out:
 *
 * - `makeSpriteArray()`  — 8 x 128px billboard sprites (sparks, shards, smoke…)
 * - `makeDecalArray()`   — 4 x 256px ground patches (scorch, frost, sigil, noise)
 *
 * They are `DataArrayTexture`s rather than a packed atlas on purpose: an atlas
 * bleeds across cell borders as soon as mipmaps exist, and a particle sprite is
 * minified hard at RTS zoom, so mips are not optional. A texture array gives
 * each sprite its own mip chain with no gutter maths.
 *
 * The RGB channel is *not* a colour — it is a per-texel intensity/detail mask
 * that the instance tint multiplies. Alpha is the coverage. Everything is
 * authored in linear space (`NoColorSpace`) because these values are used as
 * multipliers on HDR emissive colours, not as albedo.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Tiny local noise. Deliberately not imported from src/art — that folder is a
// PBR-material pipeline with its own owner, and these are two-dozen-line helpers.
// ---------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Value noise in [0,1]. */
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = fade(x - xi);
  const yf = fade(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a + (b - a) * xf) * (1 - yf) + (c + (d - c) * xf) * yf;
}

function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * f, y * f, seed + o * 1013);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, v: number): number => {
  if (a === b) return v < a ? 0 : 1;
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const enc = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255));

// ---------------------------------------------------------------------------
// Sprite array
// ---------------------------------------------------------------------------

/** Layer indices into the sprite array texture. Mirrored by `specs.ts`. */
export const SPRITE = {
  spark: 0,
  flare: 1,
  shard: 2,
  smoke: 3,
  streak: 4,
  rune: 5,
  dust: 6,
  ember: 7,
} as const;

export const SPRITE_COUNT = 8;
const SPRITE_SIZE = 128;

/**
 * Per-texel sprite evaluation. `x`,`y` are in [-1,1] with +y up; returns
 * `[intensity, alpha]`. Splitting shape (alpha) from internal detail
 * (intensity) is what lets one tint produce a crystal that reads as faceted and
 * a spark that reads as a hot core, rather than eight coloured blobs.
 */
function spriteTexel(layer: number, x: number, y: number): [number, number] {
  const d = Math.hypot(x, y);
  switch (layer) {
    case SPRITE.spark: {
      // Peaked core plus a wide soft skirt: the skirt is what survives at
      // distance, the core is what crosses the bloom threshold up close.
      const core = Math.exp(-d * d * 22);
      const skirt = Math.pow(Math.max(0, 1 - d), 2.4);
      const a = clamp01(core * 0.95 + skirt * 0.55);
      return [clamp01(0.55 + core * 0.6), a];
    }
    case SPRITE.flare: {
      const core = Math.exp(-d * d * 30);
      const hx = Math.exp(-Math.abs(y) * 26) * Math.exp(-Math.abs(x) * 1.6);
      const hy = Math.exp(-Math.abs(x) * 26) * Math.exp(-Math.abs(y) * 1.6);
      const u = (x + y) * 0.7071;
      const v = (x - y) * 0.7071;
      const dx = Math.exp(-Math.abs(v) * 34) * Math.exp(-Math.abs(u) * 2.4);
      const dy = Math.exp(-Math.abs(u) * 34) * Math.exp(-Math.abs(v) * 2.4);
      const cut = Math.exp(-d * d * 1.1);
      const a = clamp01((core + 0.5 * (hx + hy) + 0.22 * (dx + dy)) * cut);
      return [clamp01(0.5 + core * 0.7), a];
    }
    case SPRITE.shard: {
      // Hexagonal ice prism, point up. Hard silhouette on purpose — the whole
      // job of this sprite is to not look like a soft round particle.
      const ay = Math.abs(y);
      const half = 0.38 * (1 - Math.pow(ay, 1.9));
      if (half <= 0) return [0, 0];
      const edge = half - Math.abs(x);
      const a =
        sstep(0, 0.035, edge) * sstep(0, 0.05, 1 - ay) * (0.82 + 0.18 * sstep(0.6, 0, ay));
      const rel = Math.abs(x) / half;
      const spine = Math.exp(-Math.pow(x / 0.07, 2));
      const rim = sstep(0.78, 1, rel);
      // Facet break: two internal bevels at 1/3 and 2/3 of the half-width.
      const facet = Math.exp(-Math.pow((rel - 0.42) / 0.09, 2)) * 0.35;
      const i = clamp01(0.34 + spine * 0.6 + rim * 0.5 + facet);
      return [i, a];
    }
    case SPRITE.smoke: {
      const n = fbm(x * 2.1 + 4, y * 2.1 + 9, 7717, 4);
      const r = d * (0.72 + 0.55 * n);
      const a = sstep(1.02, 0.12, r) * (0.42 + 0.62 * n);
      return [clamp01(0.45 + 0.55 * n), clamp01(a)];
    }
    case SPRITE.streak: {
      // Tracer: a bright head near the top, tapering to nothing at the tail.
      const t = clamp01((y + 1) * 0.5);
      const w = 0.06 + 0.26 * Math.pow(t, 0.85);
      const body = Math.exp(-Math.pow(x / w, 2) * 2.6) * Math.pow(t, 1.5);
      const head = Math.exp(-(x * x + (y - 0.72) * (y - 0.72)) * 26);
      const a = clamp01(body * 0.85 + head);
      return [clamp01(0.4 + head * 0.75 + Math.pow(t, 3) * 0.35), a];
    }
    case SPRITE.rune: {
      const ang = Math.atan2(y, x);
      const r1 = Math.exp(-Math.pow((d - 0.86) / 0.04, 2));
      const gate = sstep(0.15, 0.55, Math.abs(Math.sin(ang * 6)));
      const r2 = Math.exp(-Math.pow((d - 0.6) / 0.03, 2)) * (0.35 + 0.65 * gate);
      const spokePhase = Math.abs(Math.sin(ang * 6));
      const spokes =
        Math.exp(-Math.pow((1 - spokePhase) / 0.06, 2)) * sstep(0.58, 0.74, d) * sstep(0.94, 0.8, d);
      const a = clamp01(r1 + r2 * 0.85 + spokes * 0.7);
      return [clamp01(0.6 + r1 * 0.5), a];
    }
    case SPRITE.dust: {
      const n = fbm(x * 2.6 + 21, y * 2.6 + 3, 3313, 4);
      const g = fbm(x * 7.5 + 55, y * 7.5 + 41, 9091, 3);
      const r = d * (0.78 + 0.42 * n);
      const a = sstep(1.05, 0.02, r) * (0.3 + 0.55 * g) * 0.95;
      return [clamp01(0.5 + 0.5 * g), clamp01(a)];
    }
    default: {
      // ember
      const core = Math.exp(-d * d * 52);
      const halo = Math.exp(-d * d * 5.5) * 0.32;
      // A few satellite sparks so a burst of embers has internal structure.
      let sp = 0;
      for (let k = 0; k < 5; k++) {
        const a0 = hash2(k, 3, 5501) * Math.PI * 2;
        const r0 = 0.32 + hash2(k, 7, 5501) * 0.5;
        const sx = Math.cos(a0) * r0;
        const sy = Math.sin(a0) * r0;
        sp += Math.exp(-((x - sx) * (x - sx) + (y - sy) * (y - sy)) * 340) * 0.7;
      }
      const a = clamp01(core + halo + sp);
      return [clamp01(0.5 + core * 0.6), a];
    }
  }
}

export function makeSpriteArray(): THREE.DataArrayTexture {
  const s = SPRITE_SIZE;
  const data = new Uint8Array(s * s * 4 * SPRITE_COUNT);
  for (let layer = 0; layer < SPRITE_COUNT; layer++) {
    const base = layer * s * s * 4;
    for (let py = 0; py < s; py++) {
      const y = 1 - ((py + 0.5) / s) * 2;
      for (let px = 0; px < s; px++) {
        const x = ((px + 0.5) / s) * 2 - 1;
        const [i, a] = spriteTexel(layer, x, y);
        const o = base + (py * s + px) * 4;
        const v = enc(i);
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = enc(a);
      }
    }
  }
  const tex = new THREE.DataArrayTexture(data, s, s, SPRITE_COUNT);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.name = 'vfx:sprites';
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Decal array
// ---------------------------------------------------------------------------

export const DECAL = {
  scorch: 0,
  frost: 1,
  sigil: 2,
  /** Generic turbulence, sampled by the analytic ground shapes to break up rings. */
  grain: 3,
} as const;

export const DECAL_COUNT = 4;
const DECAL_SIZE = 256;

/** Returns `[r, g, b, a]` in 0..1. */
function decalTexel(layer: number, x: number, y: number): [number, number, number, number] {
  const d = Math.hypot(x, y);
  const ang = Math.atan2(y, x);
  switch (layer) {
    case DECAL.scorch: {
      const n = fbm(x * 2.4 + 13, y * 2.4 + 6, 1231, 5);
      const fine = fbm(x * 9 + 2, y * 9 + 44, 8821, 3);
      // Irregular burn edge: the noise perturbs the radius, not the alpha, so
      // the boundary stays a shape rather than a dithered fade.
      const r = d * (0.74 + 0.5 * n);
      const mask = sstep(1.0, 0.35, r);
      // Cracks let the ground colour through the char, which is what makes a
      // scorch read as burnt ground instead of a black sticker.
      const crack = sstep(0.44, 0.5, fbm(x * 5.5 + 71, y * 5.5 + 17, 4457, 3));
      const a = clamp01(mask * (0.9 - crack * 0.55));
      // Hot rim just inside the edge, cooling to soot in the middle.
      const rim = sstep(0.55, 0.92, r) * sstep(1.02, 0.86, r);
      const heat = rim * 0.55;
      return [0.045 + heat * 0.85 + fine * 0.03, 0.03 + heat * 0.28, 0.026 + heat * 0.06, a];
    }
    case DECAL.frost: {
      // Radial crystal spikes: a per-sector random length gives an ice star
      // rather than a circle.
      const sectors = 18;
      const si = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * sectors);
      const sf = ((ang + Math.PI) / (Math.PI * 2)) * sectors - si;
      const len = 0.55 + hash2(si, 0, 6607) * 0.45;
      const lenNext = 0.55 + hash2((si + 1) % sectors, 0, 6607) * 0.45;
      const reach = len + (lenNext - len) * fade(sf);
      const spike = sstep(reach, reach * 0.35, d);
      const n = fbm(x * 4 + 8, y * 4 + 2, 2237, 4);
      const body = sstep(0.72, 0.1, d) * (0.55 + 0.5 * n);
      const rim = Math.exp(-Math.pow((d - reach * 0.86) / 0.06, 2)) * 0.8;
      const a = clamp01(Math.max(body, spike * (0.32 + 0.35 * n)) + rim * 0.5);
      const bright = clamp01(0.62 + rim * 0.5 + n * 0.25);
      return [bright * 0.78, bright * 0.94, 1.0 * bright, a * 0.85];
    }
    case DECAL.sigil: {
      const r1 = Math.exp(-Math.pow((d - 0.9) / 0.028, 2));
      const r2 = Math.exp(-Math.pow((d - 0.72) / 0.016, 2));
      const r3 = Math.exp(-Math.pow((d - 0.3) / 0.02, 2));
      // Two counter-rotated triangles inscribed in the inner ring.
      const tri = (rot: number): number => {
        let m = -1e9;
        for (let k = 0; k < 3; k++) {
          const a0 = rot + (k * Math.PI * 2) / 3;
          m = Math.max(m, x * Math.cos(a0) + y * Math.sin(a0));
        }
        return Math.exp(-Math.pow((m - 0.36) / 0.022, 2));
      };
      const ticks =
        Math.exp(-Math.pow((1 - Math.abs(Math.sin(ang * 12))) / 0.05, 2)) *
        sstep(0.74, 0.82, d) *
        sstep(0.96, 0.86, d);
      const a = clamp01(r1 + r2 * 0.8 + r3 * 0.6 + tri(0) * 0.7 + tri(Math.PI / 3) * 0.7 + ticks);
      return [1, 0.72, 1, a];
    }
    default: {
      const n = fbm(x * 3.4 + 31, y * 3.4 + 12, 5527, 5);
      const g = fbm(x * 11 + 5, y * 11 + 77, 1447, 3);
      const v = clamp01(0.28 + n * 0.85 + g * 0.22);
      return [v, v, v, v];
    }
  }
}

export function makeDecalArray(): THREE.DataArrayTexture {
  const s = DECAL_SIZE;
  const data = new Uint8Array(s * s * 4 * DECAL_COUNT);
  for (let layer = 0; layer < DECAL_COUNT; layer++) {
    const base = layer * s * s * 4;
    for (let py = 0; py < s; py++) {
      const y = 1 - ((py + 0.5) / s) * 2;
      for (let px = 0; px < s; px++) {
        const x = ((px + 0.5) / s) * 2 - 1;
        const [r, g, b, a] = decalTexel(layer, x, y);
        const o = base + (py * s + px) * 4;
        data[o] = enc(r);
        data[o + 1] = enc(g);
        data[o + 2] = enc(b);
        data[o + 3] = enc(a);
      }
    }
  }
  const tex = new THREE.DataArrayTexture(data, s, s, DECAL_COUNT);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.name = 'vfx:decals';
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Terrain height field
// ---------------------------------------------------------------------------

export interface HeightFieldTexture {
  texture: THREE.DataTexture;
  min: THREE.Vector2;
  size: THREE.Vector2;
  range: THREE.Vector2;
  dispose(): void;
}

/**
 * Bakes `TerrainService.heightAt` into a texture the ground shader can read in
 * the vertex stage.
 *
 * This is what stops flat ground quads from slicing through slopes — the single
 * most common way a decal or telegraph fails the rubric's clipping check. Height
 * is stored as 16 bits split across R (coarse) and G (fine), because an 8-bit
 * height over a 40 m range terraces visibly along a shallow slope.
 */
export function makeHeightField(
  heightAt: (x: number, z: number) => number,
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  resolution = 256,
): HeightFieldTexture {
  const n = resolution;
  const spanX = bounds.maxX - bounds.minX;
  const spanZ = bounds.maxZ - bounds.minZ;
  const raw = new Float32Array(n * n);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < n; j++) {
    const z = bounds.minZ + (j / (n - 1)) * spanZ;
    for (let i = 0; i < n; i++) {
      const x = bounds.minX + (i / (n - 1)) * spanX;
      const h = heightAt(x, z);
      raw[j * n + i] = h;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-3) {
    lo = 0;
    hi = 1;
  }
  const inv = 1 / (hi - lo);
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const t = clamp01((raw[i] - lo) * inv);
    const coarse = Math.min(255, Math.floor(t * 255));
    const fine = Math.min(255, Math.round((t * 255 - coarse) * 255));
    data[i * 4] = coarse;
    data[i * 4 + 1] = fine;
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.name = 'vfx:heightField';
  tex.needsUpdate = true;

  return {
    texture: tex,
    min: new THREE.Vector2(bounds.minX, bounds.minZ),
    size: new THREE.Vector2(spanX, spanZ),
    range: new THREE.Vector2(lo, hi - lo),
    dispose: () => tex.dispose(),
  };
}
