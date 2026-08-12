/**
 * Shader patches for the material library. Owner: MATERIALS agent.
 *
 * These are `onBeforeCompile` injections against `MeshStandardMaterial`, so
 * every surface keeps three's PBR lighting, shadows, fog and tone mapping while
 * gaining detail that the stock material cannot express.
 *
 * Anchors used (verified against three r180 `meshphysical.glsl.js`):
 *   vertex   `#include <project_vertex>`         — mvPosition is in scope
 *   fragment `#include <clipping_planes_fragment>` — first statement of main()
 *            `#include <map_fragment>`            — diffuseColor is in scope
 *            `#include <roughnessmap_fragment>`   — declares roughnessFactor
 *            `#include <normal_fragment_maps>`    — tbn / normal are in scope
 *
 * Replacement is textual on the *unresolved* source, so a chunk can be replaced
 * even when its feature define is off. That is how the splat material overrides
 * `map_fragment` without setting a `map`.
 */

import * as THREE from 'three';

/** GLSL helpers shared by the detail patch and the splat material. */
export const ART_GLSL_BLEND = /* glsl */ `
// UDN normal blend: keep the base normal's z, add the detail's xy.
// A naive lerp would average z as well, which shrinks the perturbation exactly
// where the two maps disagree — i.e. it flattens the surface at the moment the
// detail is supposed to be doing its job.
vec3 artBlendUDN( vec3 base, vec3 detail, float w ) {
  return normalize( vec3( base.xy + detail.xy * w, base.z ) );
}

// Reoriented normal mapping (Barre-Brisebois & Hill). Used where a tangent-space
// normal has to be re-seated onto a non-flat basis normal without losing its
// relief; more accurate than UDN, slightly more ALU.
vec3 artBlendRNM( vec3 base, vec3 detail ) {
  vec3 t = base + vec3( 0.0, 0.0, 1.0 );
  vec3 u = detail * vec3( -1.0, -1.0, 1.0 );
  return normalize( t * dot( t, u ) - u * t.z );
}
`;

export interface DetailPatchOptions {
  map: THREE.Texture;
  /** Repeats of the detail map per repeat of the base map. */
  scale: number;
  /** Detail normal contribution, 0..1. */
  normalStrength?: number;
  /** Albedo modulation, 0..1. */
  albedo?: number;
  /** Roughness modulation, 0..1. */
  rough?: number;
  /** View distance in world units over which the detail fades out. */
  fade?: [number, number];
}

export interface DetailUniforms {
  artDetailMap: { value: THREE.Texture };
  artDetailScale: { value: number };
  artDetailNormal: { value: number };
  artDetailAlbedo: { value: number };
  artDetailRough: { value: number };
  artDetailFade: { value: THREE.Vector2 };
}

/**
 * Adds a close-range detail layer to a standard material.
 *
 * The base map is sized for the object as a whole; at hero zoom the camera gets
 * close enough that one base texel covers several pixels and the surface goes
 * flat. The detail map is sampled at `scale` times the base UV rate, so it
 * supplies signal precisely in the band where the base map has none, and it is
 * faded out with distance so it never contributes aliasing at gameplay zoom.
 *
 * Requires `material.map` to be set — the patch reuses `vMapUv`, which three only
 * declares when `USE_MAP` is defined.
 */
export function applyDetailLayer(
  mat: THREE.MeshStandardMaterial,
  opts: DetailPatchOptions,
): DetailUniforms {
  const uniforms: DetailUniforms = {
    artDetailMap: { value: opts.map },
    artDetailScale: { value: opts.scale },
    artDetailNormal: { value: opts.normalStrength ?? 1 },
    artDetailAlbedo: { value: opts.albedo ?? 1 },
    artDetailRough: { value: opts.rough ?? 1 },
    artDetailFade: {
      value: new THREE.Vector2(opts.fade?.[0] ?? 26, opts.fade?.[1] ?? 70),
    },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vArtDist;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n\tvArtDist = -mvPosition.z;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vArtDist;
uniform sampler2D artDetailMap;
uniform float artDetailScale;
uniform float artDetailNormal;
uniform float artDetailAlbedo;
uniform float artDetailRough;
uniform vec2 artDetailFade;
${ART_GLSL_BLEND}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
  float artFade = 1.0 - smoothstep( artDetailFade.x, artDetailFade.y, vArtDist );
  vec4 artDetailTx = texture2D( artDetailMap, vMapUv * artDetailScale );`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  diffuseColor.rgb *= 1.0 + ( artDetailTx.a * 2.0 - 1.0 ) * artFade * artDetailAlbedo;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = clamp( roughnessFactor + ( artDetailTx.b * 2.0 - 1.0 ) * artFade * artDetailRough, 0.04, 1.0 );`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
  vec3 artDetailN = vec3( artDetailTx.rg * 2.0 - 1.0, 1.0 );
  mapN = artBlendUDN( normalize( mapN ), artDetailN, artFade * artDetailNormal );
  normal = normalize( tbn * mapN );
#endif`,
      );
  };

  // Without a distinct cache key three would reuse the unpatched program for the
  // next material that happens to share the same feature set.
  mat.customProgramCacheKey = () => 'art-detail-v1';
  mat.userData.artDetail = uniforms;
  mat.needsUpdate = true;
  return uniforms;
}
