/**
 * Procedural texture synthesis. Owner: MATERIALS agent.
 *
 * The project ships zero third-party image assets (GDD legal note), so every
 * albedo / normal / roughness / AO map is generated at load time into a canvas
 * and uploaded as a GPU texture. Generation is seeded, so the same build always
 * produces the same maps and visual review iterations stay comparable.
 *
 * API stability: `TextureSet`, `makeTextureSet` and the `*Layer` descriptors are
 * consumed by terrain, characters and props. Extend, do not rename.
 */

import * as THREE from 'three';
import { hash2, clamp01, lerp, smoothstep } from '@/core/mathx';

export interface TextureSet {
  albedo: THREE.Texture;
  normal: THREE.Texture;
  /** Packed: R = ambient occlusion, G = roughness, B = metalness. */
  orm: THREE.Texture;
  /** Optional height map for parallax / terrain blending. */
  height?: THREE.Texture;
  dispose(): void;
}

export interface NoiseLayer {
  frequency: number;
  amplitude: number;
  /** 'fbm' = smooth billows, 'ridged' = sharp crests, 'cell' = voronoi cracks. */
  kind: 'fbm' | 'ridged' | 'cell' | 'stripe' | 'speckle';
  octaves?: number;
  warp?: number;
  angle?: number;
}

export interface MaterialRecipe {
  id: string;
  size: number;
  seed: number;
  /** Base colour ramp sampled by the accumulated noise value. */
  ramp: { stop: number; color: number }[];
  layers: NoiseLayer[];
  /** Roughness ramp against the same noise field. */
  roughness: { min: number; max: number };
  metalness?: number;
  /** Strength of the derived normal map. */
  normalStrength?: number;
  /** Multiplies AO derived from the height field. */
  aoStrength?: number;
  tiling?: number;
}

/** Value-noise fBm. Deterministic, seedable, no external dependency. */
function fbm(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * smoothNoise(x * freq, y * freq, seed + i * 131);
    freq *= 2.02;
    amp *= 0.5;
  }
  return sum;
}

function smoothNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smoothstep(x - xi);
  const ty = smoothstep(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

function ridged(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(smoothNoise(x * freq, y * freq, seed + i * 71) * 2 - 1);
    sum += amp * n * n;
    freq *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

/** Cheap Worley/voronoi F1 distance; produces cracks, cobbles, scales. */
function cell(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = xi + dx;
      const cy = yi + dy;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx, cy, seed + 977);
      const ddx = px - x;
      const ddy = py - y;
      const d = ddx * ddx + ddy * ddy;
      if (d < best) best = d;
    }
  }
  return clamp01(Math.sqrt(best));
}

function sampleLayer(layer: NoiseLayer, u: number, v: number, seed: number): number {
  const f = layer.frequency;
  let x = u * f;
  let y = v * f;

  if (layer.warp) {
    const wx = fbm(x * 0.5, y * 0.5, seed + 313, 3) - 0.5;
    const wy = fbm(x * 0.5 + 5.2, y * 0.5 + 1.3, seed + 727, 3) - 0.5;
    x += wx * layer.warp;
    y += wy * layer.warp;
  }

  switch (layer.kind) {
    case 'fbm':
      return fbm(x, y, seed, layer.octaves ?? 4);
    case 'ridged':
      return ridged(x, y, seed, layer.octaves ?? 4);
    case 'cell':
      return cell(x, y, seed);
    case 'stripe': {
      const a = layer.angle ?? 0;
      const s = Math.sin((x * Math.cos(a) + y * Math.sin(a)) * Math.PI);
      return 0.5 + 0.5 * s * (0.6 + 0.4 * fbm(x, y, seed, 2));
    }
    case 'speckle': {
      const n = hash2(Math.floor(x), Math.floor(y), seed);
      return n > 0.88 ? 1 : 0;
    }
  }
}

function sampleRamp(ramp: { stop: number; color: number }[], t: number, out: THREE.Color): THREE.Color {
  const x = clamp01(t);
  if (x <= ramp[0]!.stop) return out.setHex(ramp[0]!.color, THREE.SRGBColorSpace);
  const last = ramp[ramp.length - 1]!;
  if (x >= last.stop) return out.setHex(last.color, THREE.SRGBColorSpace);
  for (let i = 0; i < ramp.length - 1; i++) {
    const a = ramp[i]!;
    const b = ramp[i + 1]!;
    if (x >= a.stop && x <= b.stop) {
      const k = (x - a.stop) / (b.stop - a.stop);
      const ca = new THREE.Color().setHex(a.color, THREE.SRGBColorSpace);
      const cb = new THREE.Color().setHex(b.color, THREE.SRGBColorSpace);
      return out.copy(ca).lerp(cb, k);
    }
  }
  return out.setHex(last.color, THREE.SRGBColorSpace);
}

/**
 * Builds a full PBR texture set from a recipe. Height is accumulated first,
 * then albedo/roughness sample the same field, and the normal map is derived
 * from height by central differences — so all four maps stay consistent.
 */
export function makeTextureSet(recipe: MaterialRecipe): TextureSet {
  const size = recipe.size;
  const heightField = new Float32Array(size * size);

  let maxAmp = 0;
  for (const layer of recipe.layers) maxAmp += layer.amplitude;
  const invAmp = maxAmp > 0 ? 1 / maxAmp : 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let h = 0;
      for (const layer of recipe.layers) {
        h += sampleLayer(layer, u, v, recipe.seed) * layer.amplitude;
      }
      heightField[y * size + x] = clamp01(h * invAmp);
    }
  }

  const albedoData = new Uint8Array(size * size * 4);
  const normalData = new Uint8Array(size * size * 4);
  const ormData = new Uint8Array(size * size * 4);
  const heightData = new Uint8Array(size * size * 4);

  const color = new THREE.Color();
  const strength = recipe.normalStrength ?? 1.6;
  const aoStrength = recipe.aoStrength ?? 1;
  const metal = Math.round((recipe.metalness ?? 0) * 255);

  const at = (x: number, y: number): number =>
    heightField[((y + size) % size) * size + ((x + size) % size)]!;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const h = heightField[y * size + x]!;

      sampleRamp(recipe.ramp, h, color);
      albedoData[i] = Math.round(color.r * 255);
      albedoData[i + 1] = Math.round(color.g * 255);
      albedoData[i + 2] = Math.round(color.b * 255);
      albedoData[i + 3] = 255;

      // Central-difference normal in tangent space.
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      normalData[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      normalData[i + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      normalData[i + 2] = Math.round((1 / len) * 0.5 * 255 + 127);
      normalData[i + 3] = 255;

      // Cavity AO: darken where the local height sits below its neighbourhood.
      const avg = (at(x + 2, y) + at(x - 2, y) + at(x, y + 2) + at(x, y - 2)) * 0.25;
      const ao = clamp01(1 - Math.max(0, avg - h) * 4 * aoStrength);
      const rough = lerp(recipe.roughness.min, recipe.roughness.max, h);
      ormData[i] = Math.round(ao * 255);
      ormData[i + 1] = Math.round(clamp01(rough) * 255);
      ormData[i + 2] = metal;
      ormData[i + 3] = 255;

      const hb = Math.round(h * 255);
      heightData[i] = hb;
      heightData[i + 1] = hb;
      heightData[i + 2] = hb;
      heightData[i + 3] = 255;
    }
  }

  const tiling = recipe.tiling ?? 1;
  const albedo = makeTexture(albedoData, size, THREE.SRGBColorSpace, tiling);
  const normal = makeTexture(normalData, size, THREE.NoColorSpace, tiling);
  const orm = makeTexture(ormData, size, THREE.NoColorSpace, tiling);
  const height = makeTexture(heightData, size, THREE.NoColorSpace, tiling);

  return {
    albedo,
    normal,
    orm,
    height,
    dispose(): void {
      albedo.dispose();
      normal.dispose();
      orm.dispose();
      height.dispose();
    },
  };
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
