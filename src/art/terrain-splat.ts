/**
 * Terrain splat material. Owner: MATERIALS agent. Consumer: TERRAIN agent.
 *
 * ============================================================================
 * CONTRACT FOR THE TERRAIN AGENT — read this block, not the shader.
 * ============================================================================
 *
 * You give me up to 4 ground layers plus 1 optional slope/cliff layer and a
 * splat weight map. I give you a `THREE.MeshStandardMaterial` that blends them
 * with world-space projection, height-aware blending, per-layer normal blending
 * and a close-range detail pass. It is a normal standard material: shadows, fog,
 * the sky IBL and the post chain all work untouched.
 *
 * ```ts
 * import { materials } from '@/art';
 * import { createSplatMaterial, makeSplatMap } from '@/art';
 *
 * // 1. Weight map. You own the rules — I only blend what you hand me.
 * //    `fill` receives world x/z and writes 4 weights (auto-normalised).
 * const splat = makeSplatMap(256, MAP_SIZE, (x, z, out) => {
 *   const h = this.heightAt(x, z);
 *   const slope = 1 - this.normalAt(x, z, tmp).y;
 *   out[0] = grassAmount(h, slope);   // layer 0
 *   out[1] = dirtAmount(h, slope);    // layer 1
 *   out[2] = laneAmount(x, z);        // layer 2
 *   out[3] = rockAmount(h, slope);    // layer 3
 * });
 *
 * // 2. Material.
 * const mat = createSplatMaterial({
 *   layers: [
 *     { id: 'ground.grass', tileSize: 7 },
 *     { id: 'ground.dirt',  tileSize: 6 },
 *     { id: 'ground.path',  tileSize: 5 },
 *     { id: 'ground.rock',  tileSize: 9 },
 *   ],
 *   slopeLayer: { id: 'cliff.stone', tileSize: 11 },
 *   splatMap: splat,
 *   extent: MAP_SIZE,
 * });
 * mesh.material = mat;
 * ```
 *
 * Requirements on your geometry: **position + normal only**. No UVs are used —
 * everything is projected from world space, which is also why the lane carving
 * and the rim never show UV stretching. Keep the mesh at identity scale (the
 * world normal is transformed with `mat3(modelMatrix)`).
 *
 * `extent` is the world size of the square the splat map covers, centred on the
 * origin: splat UV = `worldPos.xz / extent + 0.5`. Pass your `MAP_SIZE`.
 *
 * Cost: 22 texture fetches per pixel with a slope layer and detail enabled, 12
 * without either. Everything is fetched unconditionally — branching around a
 * texture fetch would put an implicit-LOD read in non-uniform control flow,
 * which is undefined behaviour in GLSL ES 3.0.
 *
 * If you need something this API does not expose, say so in your report rather
 * than editing this file — `src/art/**` is MATERIALS-owned.
 * ============================================================================
 */

import * as THREE from 'three';
import { clamp01 } from '@/core/mathx';
import { fbm } from './noise';
import { ART_GLSL_BLEND } from './shading';
import type { TextureSet } from './textures';

export interface SplatLayerInput {
  /** Texture set to use for this layer. All layers must share one `size`. */
  set: TextureSet;
  /** World metres covered by one repeat of this layer's tile. */
  tileSize: number;
  /** Multiplied into the layer albedo. Cheap per-map variation. */
  tint?: number;
  /**
   * Pushes this layer up or down in the height blend. Positive values make the
   * layer win its boundaries (gravel over grass), negative recede it.
   */
  heightBias?: number;
  /** Scales this layer's roughness. */
  roughnessScale?: number;
}

export interface SplatMaterialOptions {
  /** 1..4 ground layers, matched to the splat map's RGBA channels in order. */
  layers: SplatLayerInput[];
  /** Optional 5th layer projected triplanar and driven by slope. */
  slopeLayer?: SplatLayerInput;
  /** RGBA weight map. See `makeSplatMap`. */
  splatMap: THREE.Texture;
  /** World size of the square the splat map covers, centred on the origin. */
  extent: number;
  /** Slope (1 - normal.y) window over which the slope layer takes over. */
  slopeRange?: [number, number];
  /** Contrast on the slope transition. 1 = linear, higher = crisper. */
  slopeSharpness?: number;
  /** How much the slope layer's own height map perturbs its boundary. */
  slopeHeightBias?: number;
  /** Triplanar blend exponent for the slope layer. */
  triplanarSharpness?: number;
  /** Width of the height-blend transition band. Lower = crisper boundaries. */
  blendDepth?: number;
  /** Large-scale colour drift that breaks up perceived repetition. */
  macroVariation?: boolean;
  /** World metres per repeat of the macro variation map. */
  macroScale?: number;
  /** Strength of the macro variation, 0..1. */
  macroAmount?: number;
  /** Close-range detail pass. Requires layers to carry detail maps. */
  detail?: boolean;
  detailFade?: [number, number];
  detailNormal?: number;
  detailAlbedo?: number;
  detailRough?: number;
  aoIntensity?: number;
  envMapIntensity?: number;
  seed?: number;
}

export interface SplatMaterial extends THREE.MeshStandardMaterial {
  userData: {
    artSplat: {
      uniforms: Record<string, { value: unknown }>;
      /** Dispose the array textures this material owns. */
      disposeArrays(): void;
    };
  };
}

// ---------------------------------------------------------------------------
// Array texture assembly
// ---------------------------------------------------------------------------

function textureBuffer(tex: THREE.Texture): Uint8Array {
  const img = tex.image as { data: Uint8Array };
  return img.data;
}

function buildArray(
  sets: TextureSet[],
  pick: (s: TextureSet) => THREE.Texture | undefined,
  size: number,
  colorSpace: THREE.ColorSpace,
  neutral: [number, number, number, number],
  name: string,
): THREE.DataArrayTexture {
  const depth = sets.length;
  const layerBytes = size * size * 4;
  const data = new Uint8Array(layerBytes * depth);

  for (let i = 0; i < depth; i++) {
    const tex = pick(sets[i]!);
    const offset = i * layerBytes;
    if (!tex) {
      for (let p = 0; p < layerBytes; p += 4) {
        data[offset + p] = neutral[0];
        data[offset + p + 1] = neutral[1];
        data[offset + p + 2] = neutral[2];
        data[offset + p + 3] = neutral[3];
      }
      continue;
    }
    const src = textureBuffer(tex);
    const srcSize = (tex.image as { width: number }).width;
    if (srcSize === size) {
      data.set(src, offset);
    } else {
      // Nearest resample. Only hit when a recipe declares an off-size detail
      // map; the base maps are validated to match above.
      const ratio = srcSize / size;
      for (let y = 0; y < size; y++) {
        const sy = Math.min(srcSize - 1, (y * ratio) | 0);
        for (let x = 0; x < size; x++) {
          const sx = Math.min(srcSize - 1, (x * ratio) | 0);
          const s = (sy * srcSize + sx) * 4;
          const d = offset + (y * size + x) * 4;
          data[d] = src[s]!;
          data[d + 1] = src[s + 1]!;
          data[d + 2] = src[s + 2]!;
          data[d + 3] = src[s + 3]!;
        }
      }
    }
  }

  const arr = new THREE.DataArrayTexture(data, size, size, depth);
  arr.format = THREE.RGBAFormat;
  arr.type = THREE.UnsignedByteType;
  arr.colorSpace = colorSpace;
  arr.wrapS = THREE.RepeatWrapping;
  arr.wrapT = THREE.RepeatWrapping;
  arr.magFilter = THREE.LinearFilter;
  arr.minFilter = THREE.LinearMipmapLinearFilter;
  arr.generateMipmaps = true;
  arr.anisotropy = 8;
  arr.name = name;
  arr.needsUpdate = true;
  return arr;
}

/**
 * Builds the RGBA weight map the splat material consumes.
 *
 * `fill` is called per texel with world x/z and writes 4 raw weights into `out`;
 * they are normalised for you, so returning `1,1,0,0` means "half and half".
 * If every weight is zero the texel falls back to layer 0.
 *
 * Resolution: 256 covers a 240m map at roughly one texel per metre, which is the
 * right order — the splat map controls *where* materials go, and the height
 * blend plus the per-layer tiling supply everything finer than that.
 */
export function makeSplatMap(
  size: number,
  extent: number,
  fill: (x: number, z: number, out: Float32Array) => void,
): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const w = new Float32Array(4);
  for (let j = 0; j < size; j++) {
    const z = ((j + 0.5) / size - 0.5) * extent;
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size - 0.5) * extent;
      w[0] = 0;
      w[1] = 0;
      w[2] = 0;
      w[3] = 0;
      fill(x, z, w);
      let sum = w[0]! + w[1]! + w[2]! + w[3]!;
      if (sum <= 1e-5) {
        w[0] = 1;
        sum = 1;
      }
      const d = (j * size + i) * 4;
      for (let c = 0; c < 4; c++) {
        data[d + c] = Math.round(clamp01(w[c]! / sum) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.name = 'terrain:splat';
  tex.needsUpdate = true;
  return tex;
}

/**
 * Low-frequency colour drift sampled at tens of metres per repeat.
 *
 * Tiling is perceived at two scales: the tile period itself (killed by toroidal
 * synthesis) and the *statistical* uniformity of a field where every square
 * metre has the same mean colour. Real ground does not — it has metre-scale
 * patches of wetter, drier, lighter and darker material. This map supplies that
 * second scale for a single extra fetch, and it is the cheapest available fix
 * for "the ground reads as wallpaper".
 */
export function makeMacroVariationMap(size: number, seed: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const value = fbm(u, v, 2, seed, 4) * 0.5 + 0.5;
      const warm = fbm(u, v, 3, seed + 4001, 3) * 0.5 + 0.5;
      const patch = fbm(u, v, 5, seed + 8009, 2) * 0.5 + 0.5;
      // Centred on 0.5 = neutral; the shader remaps to a multiplier around 1.
      const d = (y * size + x) * 4;
      data[d] = Math.round(clamp01(0.5 + (value - 0.5) * 1.0 + (warm - 0.5) * 0.45) * 255);
      data[d + 1] = Math.round(clamp01(0.5 + (value - 0.5) * 0.95) * 255);
      data[d + 2] = Math.round(clamp01(0.5 + (value - 0.5) * 0.9 - (warm - 0.5) * 0.4) * 255);
      data[d + 3] = Math.round(clamp01(patch) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.name = 'terrain:macro';
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

const SPLAT_COMMON = /* glsl */ `
varying vec3 vArtWorld;
varying vec3 vArtNormalW;
varying float vArtDist;

uniform sampler2DArray artAlbedoArr;
uniform sampler2DArray artNormalArr;
uniform sampler2DArray artOrmArr;
uniform sampler2D artSplat;
uniform vec2 artExtent;
uniform vec4 artTile;
uniform vec4 artHeightBias;
uniform vec4 artRoughScale;
uniform mat4 artTint;
uniform float artBlendDepth;
uniform float artAoIntensity;

#ifdef ART_SLOPE
uniform float artSlopeTile;
uniform vec2 artSlopeRange;
uniform float artSlopeSharp;
uniform float artSlopeHeightBias;
uniform float artTriSharp;
uniform vec3 artSlopeTint;
uniform float artSlopeRough;
#endif

#ifdef ART_MACRO
uniform sampler2D artMacro;
uniform float artMacroScale;
uniform float artMacroAmount;
#endif

#ifdef ART_DETAIL
uniform sampler2DArray artDetailArr;
uniform float artDetailScale;
uniform vec2 artDetailFade;
uniform float artDetailNormal;
uniform float artDetailAlbedo;
uniform float artDetailRough;
#endif

${ART_GLSL_BLEND}

// Re-seats a tangent-space normal onto an arbitrary world basis normal using the
// whiteout construction (Golus). The tangent xy keeps full authority and z is
// recovered by the normalize, so relief survives the reorientation. Applied per
// projection plane, this is also the triplanar normal blend.
vec3 artReseatY( vec3 t, vec3 g ) {
  vec3 n = vec3( t.xy + g.xz, abs( t.z ) * g.y );
  return n.xzy;
}
`;

const SPLAT_EVAL = /* glsl */ `
  vec3 artG = normalize( vArtNormalW );
  vec4 artW = texture2D( artSplat, vArtWorld.xz / artExtent + 0.5 );

  vec2 artUv0 = vArtWorld.xz / artTile.x;
  vec2 artUv1 = vArtWorld.xz / artTile.y;
  vec2 artUv2 = vArtWorld.xz / artTile.z;
  vec2 artUv3 = vArtWorld.xz / artTile.w;

  vec4 artO0 = texture( artOrmArr, vec3( artUv0, 0.0 ) );
  vec4 artO1 = texture( artOrmArr, vec3( artUv1, 1.0 ) );
  vec4 artO2 = texture( artOrmArr, vec3( artUv2, 2.0 ) );
  vec4 artO3 = texture( artOrmArr, vec3( artUv3, 3.0 ) );

  // Height-aware splat blend (Mishkinis). Adding the layer height to the splat
  // weight before the max-cut lets a tall feature — a cobble, a tuft — poke
  // through a layer that is nominally winning, which is what turns a linear
  // cross-fade into an interlocking boundary.
  vec4 artT = vec4( artO0.a, artO1.a, artO2.a, artO3.a ) + artW + artHeightBias;
  float artMa = max( max( artT.x, artT.y ), max( artT.z, artT.w ) ) - artBlendDepth;
  vec4 artB = max( artT - artMa, 0.0 ) * step( 0.0001, artW );
  float artBSum = artB.x + artB.y + artB.z + artB.w;
  artB = artBSum > 1e-4 ? artB / artBSum : vec4( 1.0, 0.0, 0.0, 0.0 );

  vec4 artA0 = texture( artAlbedoArr, vec3( artUv0, 0.0 ) );
  vec4 artA1 = texture( artAlbedoArr, vec3( artUv1, 1.0 ) );
  vec4 artA2 = texture( artAlbedoArr, vec3( artUv2, 2.0 ) );
  vec4 artA3 = texture( artAlbedoArr, vec3( artUv3, 3.0 ) );

  vec3 artAlbedo =
      artB.x * artA0.rgb * artTint[0].rgb
    + artB.y * artA1.rgb * artTint[1].rgb
    + artB.z * artA2.rgb * artTint[2].rgb
    + artB.w * artA3.rgb * artTint[3].rgb;

  vec3 artN0 = texture( artNormalArr, vec3( artUv0, 0.0 ) ).xyz * 2.0 - 1.0;
  vec3 artN1 = texture( artNormalArr, vec3( artUv1, 1.0 ) ).xyz * 2.0 - 1.0;
  vec3 artN2 = texture( artNormalArr, vec3( artUv2, 2.0 ) ).xyz * 2.0 - 1.0;
  vec3 artN3 = texture( artNormalArr, vec3( artUv3, 3.0 ) ).xyz * 2.0 - 1.0;

  // Whiteout blend across layers: weight the xy perturbations and recover z.
  // Weighting all three components instead (a naive lerp) would shrink the
  // perturbation wherever two layers disagree — i.e. it would flatten the
  // surface precisely along every material boundary, the one place the eye is
  // already looking.
  vec2 artNxy =
      artB.x * artN0.xy + artB.y * artN1.xy + artB.z * artN2.xy + artB.w * artN3.xy;
  vec3 artNt = normalize( vec3( artNxy, 1.0 ) );
  vec3 artWorldN = normalize( artReseatY( artNt, artG ) );

  float artRough = dot( artB, vec4( artO0.g, artO1.g, artO2.g, artO3.g ) * artRoughScale );
  float artMetal = dot( artB, vec4( artO0.b, artO1.b, artO2.b, artO3.b ) );
  float artAO    = dot( artB, vec4( artO0.r, artO1.r, artO2.r, artO3.r ) );
  float artDetailLayer = 0.0;
  {
    float m = artB.x;
    if ( artB.y > m ) { m = artB.y; artDetailLayer = 1.0; }
    if ( artB.z > m ) { m = artB.z; artDetailLayer = 2.0; }
    if ( artB.w > m ) { artDetailLayer = 3.0; }
  }
  float artDetailTile = artTile[ int( artDetailLayer ) ];

#ifdef ART_SLOPE
  {
    vec2 uvX = vArtWorld.zy / artSlopeTile;
    vec2 uvY = vArtWorld.xz / artSlopeTile;
    vec2 uvZ = vArtWorld.xy / artSlopeTile;
    vec3 bw = pow( abs( artG ), vec3( artTriSharp ) );
    bw /= ( bw.x + bw.y + bw.z );

    vec4 sA = texture( artAlbedoArr, vec3( uvX, 4.0 ) ) * bw.x
            + texture( artAlbedoArr, vec3( uvY, 4.0 ) ) * bw.y
            + texture( artAlbedoArr, vec3( uvZ, 4.0 ) ) * bw.z;
    vec4 sO = texture( artOrmArr, vec3( uvX, 4.0 ) ) * bw.x
            + texture( artOrmArr, vec3( uvY, 4.0 ) ) * bw.y
            + texture( artOrmArr, vec3( uvZ, 4.0 ) ) * bw.z;

    vec3 tX = texture( artNormalArr, vec3( uvX, 4.0 ) ).xyz * 2.0 - 1.0;
    vec3 tY = texture( artNormalArr, vec3( uvY, 4.0 ) ).xyz * 2.0 - 1.0;
    vec3 tZ = texture( artNormalArr, vec3( uvZ, 4.0 ) ).xyz * 2.0 - 1.0;
    vec3 nX = vec3( tX.xy + artG.zy, abs( tX.z ) * artG.x );
    vec3 nY = vec3( tY.xy + artG.xz, abs( tY.z ) * artG.y );
    vec3 nZ = vec3( tZ.xy + artG.xy, abs( tZ.z ) * artG.z );
    vec3 sN = normalize( nX.zyx * bw.x + nY.xzy * bw.y + nZ.xyz * bw.z );

    float slope = 1.0 - artG.y;
    float sw = smoothstep( artSlopeRange.x, artSlopeRange.y, slope );
    sw = clamp( ( sw - 0.5 ) * artSlopeSharp + 0.5 + ( sO.a - 0.5 ) * artSlopeHeightBias, 0.0, 1.0 );

    artAlbedo = mix( artAlbedo, sA.rgb * artSlopeTint, sw );
    artRough  = mix( artRough, sO.g * artSlopeRough, sw );
    artMetal  = mix( artMetal, sO.b, sw );
    artAO     = mix( artAO, sO.r, sw );
    // World normals are directions, not tangent-space encodings, so a
    // normalised lerp between them is a valid interpolation.
    artWorldN = normalize( mix( artWorldN, sN, sw ) );
  }
#endif

#ifdef ART_MACRO
  {
    vec4 macro = texture2D( artMacro, vArtWorld.xz / artMacroScale );
    artAlbedo *= mix( vec3( 1.0 ), macro.rgb * 2.0, artMacroAmount );
    artRough = clamp( artRough + ( macro.a - 0.5 ) * artMacroAmount * 0.35, 0.04, 1.0 );
  }
#endif

#ifdef ART_DETAIL
  {
    float fadeT = 1.0 - smoothstep( artDetailFade.x, artDetailFade.y, vArtDist );
    vec4 d = texture(
      artDetailArr,
      vec3( vArtWorld.xz / artDetailTile * artDetailScale, artDetailLayer )
    );
    artAlbedo *= 1.0 + ( d.a * 2.0 - 1.0 ) * fadeT * artDetailAlbedo;
    artRough = clamp( artRough + ( d.b * 2.0 - 1.0 ) * fadeT * artDetailRough, 0.04, 1.0 );
    vec3 dT = vec3( ( d.rg * 2.0 - 1.0 ) * fadeT * artDetailNormal, 1.0 );
    artWorldN = normalize( artReseatY( dT, artWorldN ) );
  }
#endif
`;

export function createSplatMaterial(options: SplatMaterialOptions): SplatMaterial {
  const layers = options.layers.slice(0, 4);
  if (layers.length === 0) throw new Error('[art] createSplatMaterial needs at least one layer');

  const size = layers[0]!.set.size;
  for (const l of layers) {
    if (l.set.size !== size) {
      throw new Error(
        `[art] splat layers must share a texture size (got ${l.set.size} and ${size}). ` +
          'Set the same `size` on every ground recipe.',
      );
    }
  }

  // Pad to 4 so the shader can index a vec4 unconditionally.
  const padded: SplatLayerInput[] = [...layers];
  while (padded.length < 4) padded.push(layers[layers.length - 1]!);
  const all = options.slopeLayer ? [...padded, options.slopeLayer] : padded;
  const sets = all.map((l) => l.set);

  const albedoArr = buildArray(
    sets,
    (s) => s.albedo,
    size,
    THREE.SRGBColorSpace,
    [128, 128, 128, 255],
    'terrain:albedoArray',
  );
  const normalArr = buildArray(
    sets,
    (s) => s.normal,
    size,
    THREE.NoColorSpace,
    [128, 128, 255, 255],
    'terrain:normalArray',
  );
  const ormArr = buildArray(
    sets,
    (s) => s.orm,
    size,
    THREE.NoColorSpace,
    [255, 200, 0, 128],
    'terrain:ormArray',
  );

  const useDetail = options.detail !== false && sets.some((s) => s.detail);
  const detailSize = sets.find((s) => s.detail)?.detail
    ? ((sets.find((s) => s.detail)!.detail!.image as { width: number }).width ?? 256)
    : 256;
  const detailArr = useDetail
    ? buildArray(
        sets,
        (s) => s.detail,
        detailSize,
        THREE.NoColorSpace,
        [128, 128, 128, 128],
        'terrain:detailArray',
      )
    : null;

  const useMacro = options.macroVariation !== false;
  const macroTex = useMacro ? makeMacroVariationMap(256, options.seed ?? 90210) : null;

  const tintMatrix = new THREE.Matrix4();
  const tintArr: number[] = [];
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Color(padded[i]!.tint ?? 0xffffff);
    tintArr.push(c.r, c.g, c.b, 1);
  }
  tintMatrix.fromArray(tintArr);

  const uniforms: Record<string, { value: unknown }> = {
    artAlbedoArr: { value: albedoArr },
    artNormalArr: { value: normalArr },
    artOrmArr: { value: ormArr },
    artSplat: { value: options.splatMap },
    artExtent: { value: new THREE.Vector2(options.extent, options.extent) },
    artTile: {
      value: new THREE.Vector4(
        padded[0]!.tileSize,
        padded[1]!.tileSize,
        padded[2]!.tileSize,
        padded[3]!.tileSize,
      ),
    },
    artHeightBias: {
      value: new THREE.Vector4(
        padded[0]!.heightBias ?? 0,
        padded[1]!.heightBias ?? 0,
        padded[2]!.heightBias ?? 0,
        padded[3]!.heightBias ?? 0,
      ),
    },
    artRoughScale: {
      value: new THREE.Vector4(
        padded[0]!.roughnessScale ?? 1,
        padded[1]!.roughnessScale ?? 1,
        padded[2]!.roughnessScale ?? 1,
        padded[3]!.roughnessScale ?? 1,
      ),
    },
    artTint: { value: tintMatrix },
    artBlendDepth: { value: options.blendDepth ?? 0.22 },
    artAoIntensity: { value: options.aoIntensity ?? 1 },
  };

  if (options.slopeLayer) {
    const sl = options.slopeLayer;
    uniforms.artSlopeTile = { value: sl.tileSize };
    uniforms.artSlopeRange = {
      value: new THREE.Vector2(
        options.slopeRange?.[0] ?? 0.18,
        options.slopeRange?.[1] ?? 0.46,
      ),
    };
    uniforms.artSlopeSharp = { value: options.slopeSharpness ?? 1.6 };
    uniforms.artSlopeHeightBias = { value: options.slopeHeightBias ?? 0.5 };
    uniforms.artTriSharp = { value: options.triplanarSharpness ?? 5 };
    uniforms.artSlopeTint = { value: new THREE.Color(sl.tint ?? 0xffffff) };
    uniforms.artSlopeRough = { value: sl.roughnessScale ?? 1 };
  }
  if (macroTex) {
    uniforms.artMacro = { value: macroTex };
    uniforms.artMacroScale = { value: options.macroScale ?? 58 };
    uniforms.artMacroAmount = { value: options.macroAmount ?? 0.5 };
  }
  if (detailArr) {
    const first = sets.find((s) => s.detail);
    uniforms.artDetailArr = { value: detailArr };
    uniforms.artDetailScale = { value: first?.detailScale ?? 8 };
    uniforms.artDetailFade = {
      value: new THREE.Vector2(
        options.detailFade?.[0] ?? first?.detailFade?.[0] ?? 26,
        options.detailFade?.[1] ?? first?.detailFade?.[1] ?? 75,
      ),
    };
    uniforms.artDetailNormal = { value: options.detailNormal ?? 1 };
    uniforms.artDetailAlbedo = { value: options.detailAlbedo ?? 1 };
    uniforms.artDetailRough = { value: options.detailRough ?? 1 };
  }

  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 1,
    envMapIntensity: options.envMapIntensity ?? 1,
  }) as SplatMaterial;

  const defines: string[] = [];
  if (options.slopeLayer) defines.push('#define ART_SLOPE');
  if (macroTex) defines.push('#define ART_MACRO');
  if (detailArr) defines.push('#define ART_DETAIL');
  const defineBlock = defines.join('\n');

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vArtWorld;
varying vec3 vArtNormalW;
varying float vArtDist;`,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 artWorldPos = modelMatrix * vec4( transformed, 1.0 );
  vArtWorld = artWorldPos.xyz;
  vArtNormalW = normalize( mat3( modelMatrix ) * objectNormal );
  #include <project_vertex>
  vArtDist = -mvPosition.z;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `${defineBlock}\n#include <common>\n${SPLAT_COMMON}`)
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n${SPLAT_EVAL}`,
      )
      .replace('#include <map_fragment>', 'diffuseColor.rgb *= artAlbedo;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = artRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = artMetal;')
      .replace(
        '#include <normal_fragment_maps>',
        'normal = normalize( ( viewMatrix * vec4( artWorldN, 0.0 ) ).xyz );',
      )
      .replace(
        '#include <aomap_fragment>',
        `float ambientOcclusion = ( artAO - 1.0 ) * artAoIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif`,
      );
  };

  mat.customProgramCacheKey = () => `art-splat-v1|${defineBlock}`;
  mat.userData = {
    artSplat: {
      uniforms,
      disposeArrays(): void {
        albedoArr.dispose();
        normalArr.dispose();
        ormArr.dispose();
        detailArr?.dispose();
        macroTex?.dispose();
      },
    },
  };
  return mat;
}

/** Bytes uploaded by the array textures a splat material owns. */
export function splatMaterialBytes(
  layerCount: number,
  size: number,
  detailSize = 256,
  withDetail = true,
  withMacro = true,
): number {
  const mip = 1.3334;
  let bytes = 3 * layerCount * size * size * 4 * mip;
  if (withDetail) bytes += layerCount * detailSize * detailSize * 4 * mip;
  if (withMacro) bytes += 256 * 256 * 4 * mip;
  return Math.round(bytes);
}
