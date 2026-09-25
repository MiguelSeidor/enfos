/**
 * Ground and cliff surface shading. Owner: TERRAIN agent.
 *
 * Two materials, both built on `MeshStandardMaterial` + `onBeforeCompile` so we
 * keep three's shadows, IBL, fog and the composer's tone mapping:
 *
 *  - GROUND: four layers (grass / dirt / rock / worn path) blended by a baked
 *    control map, world-space projected so tiling never follows the mesh, with
 *    a high-frequency detail layer that fades in under the hero camera and a
 *    macro tint map that breaks up repetition and de-clones the two halves.
 *  - CLIFF: single rock layer with true triplanar projection plus a grass cap
 *    on upward faces, so a vertical face never shows stretched texels.
 *
 * If the MATERIALS agent publishes a splat/triplanar API these two builders are
 * the only things that need to change; nothing else in `world/` knows how the
 * ground is shaded.
 */

import * as THREE from 'three';
import { materials } from '@/art/materials';
import { MAP_HALF, MAP_SIZE, WATER_LEVEL } from './layout';
import { splatAt, type TerrainFieldData } from './field';

const CONTROL_RES = 640;
const TINT_RES = 256;

/** Shared GLSL: cheap value noise used to break up splat edges and tiling. */
const NOISE_GLSL = /* glsl */ `
float wHash21(vec2 p){
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y * 95.4307);
}
float wNoise(vec2 p){
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = wHash21(i);
  float b = wHash21(i + vec2(1.0, 0.0));
  float c = wHash21(i + vec2(0.0, 1.0));
  float d = wHash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float wFbm(vec2 p){
  return wNoise(p) * 0.6 + wNoise(p * 2.13 + 7.3) * 0.3 + wNoise(p * 4.7 + 1.9) * 0.1;
}
`;

const VERTEX_HEAD = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vWorldNrm;
varying float vTerrainAo;
attribute float aAo;
`;

const VERTEX_BODY = /* glsl */ `
vec4 wPos_ = modelMatrix * vec4( transformed, 1.0 );
vWorldPos = wPos_.xyz;
vWorldNrm = normalize( mat3( modelMatrix ) * objectNormal );
vTerrainAo = aAo;
`;

function injectVaryings(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_HEAD}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);
}

export interface GroundMaterialResult {
  material: THREE.MeshStandardMaterial;
  /**
   * Re-bakes the splat control map from an edited field.
   *
   * The control map is baked on the CPU from levels and masks, so an authored
   * terrain edit leaves it describing the map as it used to be — grass where
   * the author just dug a channel. Only the control map is re-baked: the tint
   * map is seeded noise and does not depend on the field.
   */
  refresh(field: TerrainFieldData): void;
  dispose(): void;
}

/**
 * The cliff material has no baked control map — it shades from world position
 * and normal alone — so it has nothing to re-bake when the field changes.
 */
export interface CliffMaterialResult {
  material: THREE.MeshStandardMaterial;
  dispose(): void;
}

/**
 * Bakes the splat control map. R/G/B/A = grass / dirt / rock / path weight.
 * Baking on the CPU (rather than deriving it in the shader) is what lets the
 * lane, the shorelines and the landmark plazas be authored precisely instead of
 * falling out of whatever the slope happens to be.
 */
function bakeControlMap(field: TerrainFieldData): THREE.DataTexture {
  const size = CONTROL_RES;
  const data = new Uint8Array(size * size * 4);
  const w = new Float32Array(4);
  for (let j = 0; j < size; j++) {
    const z = -MAP_HALF + ((j + 0.5) / size) * MAP_SIZE;
    for (let i = 0; i < size; i++) {
      const x = -MAP_HALF + ((i + 0.5) / size) * MAP_SIZE;
      splatAt(field, x, z, w);
      const o = (j * size + i) * 4;
      data[o] = Math.round(w[0] * 255);
      data[o + 1] = Math.round(w[1] * 255);
      data[o + 2] = Math.round(w[2] * 255);
      data[o + 3] = Math.round(w[3] * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Macro tint. Deliberately NOT mirrored: the geometry has to be symmetric for
 * fairness, but colour does not, and an unmirrored tint is what stops the two
 * halves of the arena from reading as a copy-paste.
 */
function bakeTintMap(seed: number): THREE.DataTexture {
  const size = TINT_RES;
  const data = new Uint8Array(size * size * 4);
  const rand = (i: number, j: number, s: number): number => {
    let h = Math.imul(i * 374761393 + j * 668265263 + s * 2246822519, 3266489917);
    h = (h ^ (h >>> 15)) >>> 0;
    return h / 4294967296;
  };
  const smooth = (x: number, y: number, s: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = rand(xi, yi, s);
    const b = rand(xi + 1, yi, s);
    const c = rand(xi, yi + 1, s);
    const d = rand(xi + 1, yi + 1, s);
    return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
  };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i / size) * 7;
      const v = (j / size) * 7;
      const n1 = smooth(u, v, seed) * 0.6 + smooth(u * 2.7, v * 2.7, seed + 91) * 0.4;
      const n2 = smooth(u * 1.6 + 12, v * 1.6 + 5, seed + 41);
      const n3 = smooth(u * 0.8 + 3, v * 0.8 + 21, seed + 77);
      const o = (j * size + i) * 4;
      // Around 0.5 = neutral. Slight green/ochre drift plus a dryness channel.
      data[o] = Math.round(THREE.MathUtils.clamp(0.5 + (n2 - 0.5) * 0.34, 0, 1) * 255);
      data[o + 1] = Math.round(THREE.MathUtils.clamp(0.5 + (n1 - 0.5) * 0.3, 0, 1) * 255);
      data[o + 2] = Math.round(THREE.MathUtils.clamp(0.5 + (n3 - 0.5) * 0.36, 0, 1) * 255);
      data[o + 3] = Math.round(THREE.MathUtils.clamp(n1 * 0.7 + n3 * 0.3, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function createGroundMaterial(
  field: TerrainFieldData,
  seed: number,
): GroundMaterialResult {
  const grass = materials.textures('ground.grass');
  const dirt = materials.textures('ground.dirt');
  const rock = materials.textures('ground.rock');
  const path = materials.textures('ground.path');
  const control = bakeControlMap(field);
  const tint = bakeTintMap(seed);

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
  });
  material.name = 'terrain.ground';

  material.onBeforeCompile = (shader) => {
    injectVaryings(shader);

    shader.uniforms.uControl = { value: control };
    shader.uniforms.uTint = { value: tint };
    shader.uniforms.uAlb0 = { value: grass.albedo };
    shader.uniforms.uAlb1 = { value: dirt.albedo };
    shader.uniforms.uAlb2 = { value: rock.albedo };
    shader.uniforms.uAlb3 = { value: path.albedo };
    shader.uniforms.uNrm0 = { value: grass.normal };
    shader.uniforms.uNrm1 = { value: dirt.normal };
    shader.uniforms.uNrm2 = { value: rock.normal };
    shader.uniforms.uNrm3 = { value: path.normal };
    // World units per texture tile, per layer.
    // World metres per texture tile, per layer: grass / dirt / rock / path.
    //
    // Grass, dirt and rock roughly halved from 9 / 12.5 / 15. Their recipes
    // carry real structure — three scales of grass tuft, gravel, strata — and
    // at the old tiling none of it survived: a 45 cm tuft is a twentieth of a
    // 9 m tile, which from the RTS camera is about three screen pixels. What
    // reached the eye was the low-frequency value drift underneath and nothing
    // else, which is exactly the flat green mottle the ground read as. The path
    // keeps its 8.5 because its features are 1.4 m slabs and already resolve.
    shader.uniforms.uLayerScale = { value: new THREE.Vector4(4.5, 6.5, 9.0, 8.5) };
    shader.uniforms.uLayerRough = { value: new THREE.Vector4(0.95, 0.98, 0.8, 0.92) };
    // The four source textures are all mid-tone browns straight from the
    // library. Separating them in hue and value is what makes the lane read as
    // a lane from RTS height instead of dissolving into the dirt around it.
    shader.uniforms.uTint0 = { value: new THREE.Color(0.86, 1.0, 0.74) };
    shader.uniforms.uTint1 = { value: new THREE.Color(0.9, 0.84, 0.72) };
    shader.uniforms.uTint2 = { value: new THREE.Color(1.06, 1.0, 0.9) };
    // Cooled from (1.06, 1.0, 0.88). That warm cast suited the old compacted
    // dirt trail; over the paved recipe it turned grey granite into sandstone
    // and the road blended back into the ground it is meant to stand out from.
    shader.uniforms.uTint3 = { value: new THREE.Color(0.92, 0.95, 1.0) };
    shader.uniforms.uDetailScale = { value: 0.62 };
    shader.uniforms.uWaterLevel = { value: WATER_LEVEL };

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vWorldPos;
        varying vec3 vWorldNrm;
        varying float vTerrainAo;
        uniform sampler2D uControl;
        uniform sampler2D uTint;
        uniform sampler2D uAlb0; uniform sampler2D uAlb1; uniform sampler2D uAlb2; uniform sampler2D uAlb3;
        uniform sampler2D uNrm0; uniform sampler2D uNrm1; uniform sampler2D uNrm2; uniform sampler2D uNrm3;
        uniform vec4 uLayerScale;
        uniform vec4 uLayerRough;
        uniform vec3 uTint0; uniform vec3 uTint1; uniform vec3 uTint2; uniform vec3 uTint3;
        uniform float uDetailScale;
        uniform float uWaterLevel;
        ${NOISE_GLSL}
        vec3 gAlbedo; vec3 gNrmTS; float gRough;
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec2 mapUv_ = (vWorldPos.xz + ${MAP_HALF.toFixed(1)}) / ${MAP_SIZE.toFixed(1)};
        vec4 ctrl_ = texture2D(uControl, mapUv_);

        // Perturb each weight with its own noise field so the linear boundary
        // between two layers dissolves into an organic, eroded edge.
        vec2 np_ = vWorldPos.xz * 0.42;
        vec4 n4_ = vec4(wNoise(np_), wNoise(np_ * 1.9 + 13.7),
                        wNoise(np_ * 0.7 + 41.2), wNoise(np_ * 2.6 + 5.4));
        vec4 w_ = max(ctrl_ + (n4_ - 0.5) * 0.42, 0.0);
        w_ *= w_;
        w_ /= (w_.x + w_.y + w_.z + w_.w + 1e-4);

        vec2 p0_ = vWorldPos.xz / uLayerScale.x;
        vec2 p1_ = vWorldPos.xz / uLayerScale.y;
        vec2 p2_ = vWorldPos.xz / uLayerScale.z;
        vec2 p3_ = vWorldPos.xz / uLayerScale.w;

        gAlbedo = texture2D(uAlb0, p0_).rgb * uTint0 * w_.x
                + texture2D(uAlb1, p1_).rgb * uTint1 * w_.y
                + texture2D(uAlb2, p2_).rgb * uTint2 * w_.z
                + texture2D(uAlb3, p3_).rgb * uTint3 * w_.w;

        gNrmTS = (texture2D(uNrm0, p0_).xyz * 2.0 - 1.0) * w_.x
               + (texture2D(uNrm1, p1_).xyz * 2.0 - 1.0) * w_.y
               + (texture2D(uNrm2, p2_).xyz * 2.0 - 1.0) * w_.z
               + (texture2D(uNrm3, p3_).xyz * 2.0 - 1.0) * w_.w;

        gRough = dot(w_, uLayerRough);

        // Close-range detail: a second, much higher frequency octave that
        // fades out before it can alias at RTS distance.
        float camD_ = distance(cameraPosition, vWorldPos);
        float det_ = 1.0 - smoothstep(16.0, 46.0, camD_);
        if (det_ > 0.001) {
          vec2 dp_ = vWorldPos.xz / uDetailScale;
          vec3 dCol_ = texture2D(uAlb1, dp_).rgb;
          vec3 dNrm_ = texture2D(uNrm2, dp_ * 0.5).xyz * 2.0 - 1.0;
          float dLum_ = dot(dCol_, vec3(0.33));
          gAlbedo *= 1.0 + (dLum_ - 0.42) * 1.05 * det_;
          gNrmTS.xy += dNrm_.xy * 0.85 * det_;
          gRough *= 1.0 - 0.12 * det_ * (dLum_ - 0.5);
        }

        // Macro variation: unmirrored tint plus a very low frequency wash, so
        // no two areas of the map read as the same texture.
        vec4 tint_ = texture2D(uTint, mapUv_);
        gAlbedo *= vec3(0.72) + tint_.rgb * 0.62;
        float macro_ = wFbm(vWorldPos.xz * 0.017);
        gAlbedo *= 0.80 + macro_ * 0.42;

        // Gentle grade only. The library textures carry a lot of high-frequency
        // speckle; pushing saturation hard turns that speckle into confetti.
        float lum_ = dot(gAlbedo, vec3(0.2126, 0.7152, 0.0722));
        gAlbedo = mix(vec3(lum_), gAlbedo, 0.86);
        gAlbedo = clamp(gAlbedo, 0.0, 0.85);

        // Wet, darker ground where the river reaches the bank.
        float wet_ = 1.0 - smoothstep(0.0, 2.6, vWorldPos.y - uWaterLevel);
        gAlbedo *= mix(1.0, 0.52, wet_);
        gRough = mix(gRough, 0.22, wet_ * 0.85);

        diffuseColor.rgb = gAlbedo;
        `,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(gRough, 0.05, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        vec3 wn_ = normalize(vWorldNrm);
        vec3 tg_ = normalize(vec3(1.0, 0.0, 0.0) - wn_ * wn_.x);
        vec3 bt_ = normalize(cross(tg_, wn_));
        vec3 pn_ = normalize(tg_ * gNrmTS.x + bt_ * gNrmTS.y + wn_ * max(gNrmTS.z, 0.15));
        normal = normalize((viewMatrix * vec4(pn_, 0.0)).xyz);
        `,
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `
        float ao_ = clamp(vTerrainAo, 0.0, 1.0);
        reflectedLight.indirectDiffuse *= ao_;
        reflectedLight.indirectSpecular *= mix(1.0, ao_, 0.6);
        `,
      );
  };
  material.customProgramCacheKey = () => 'terrain.ground.v1';

  return {
    material,
    refresh(next: TerrainFieldData): void {
      // Re-bake into the existing texture's image and flag it, rather than
      // swapping the texture object: the uniform was captured by
      // `onBeforeCompile` and replacing the object would leave the compiled
      // program pointing at the old one.
      const rebaked = bakeControlMap(next);
      control.image = rebaked.image;
      control.needsUpdate = true;
      rebaked.dispose();
    },
    dispose(): void {
      control.dispose();
      tint.dispose();
      material.dispose();
    },
  };
}

/**
 * Cliff faces. Triplanar so a vertical wall shows the same texel density as the
 * plateau above it, with horizontal strata bands and a grass cap that ties the
 * face back into the ground on the upper lip.
 */
export function createCliffMaterial(): CliffMaterialResult {
  const stone = materials.textures('cliff.stone');
  const rock = materials.textures('ground.rock');
  const grass = materials.textures('ground.grass');

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
  });
  material.name = 'terrain.cliff';

  material.onBeforeCompile = (shader) => {
    injectVaryings(shader);

    shader.uniforms.uStone = { value: stone.albedo };
    shader.uniforms.uStoneN = { value: stone.normal };
    shader.uniforms.uRock = { value: rock.albedo };
    shader.uniforms.uGrass = { value: grass.albedo };
    shader.uniforms.uScale = { value: 15.0 };

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vWorldPos;
        varying vec3 vWorldNrm;
        varying float vTerrainAo;
        uniform sampler2D uStone;
        uniform sampler2D uStoneN;
        uniform sampler2D uRock;
        uniform sampler2D uGrass;
        uniform float uScale;
        ${NOISE_GLSL}
        vec3 cAlbedo; vec3 cWorldN; float cRough;
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec3 wn_ = normalize(vWorldNrm);
        vec3 bw_ = pow(abs(wn_), vec3(4.0));
        bw_ /= (bw_.x + bw_.y + bw_.z);
        vec3 p_ = vWorldPos / uScale;

        vec3 ax_ = texture2D(uStone, p_.zy).rgb;
        vec3 ay_ = texture2D(uStone, p_.xz).rgb;
        vec3 az_ = texture2D(uStone, p_.xy).rgb;
        cAlbedo = ax_ * bw_.x + ay_ * bw_.y + az_ * bw_.z;

        // Second, much coarser rock octave. Its period is incommensurate with
        // the first, which is what stops the crack network from reading as a
        // repeating stamp across a long cliff run.
        vec3 q_ = p_ * 0.237;
        vec3 bx_ = texture2D(uRock, q_.zy).rgb;
        vec3 by_ = texture2D(uRock, q_.xz).rgb;
        vec3 bz_ = texture2D(uRock, q_.xy).rgb;
        cAlbedo = mix(cAlbedo, (bx_ * bw_.x + by_ * bw_.y + bz_ * bw_.z), 0.42);

        // Sedimentary strata: horizontal banding warped by noise, which is what
        // makes a generated cliff read as rock rather than as a displaced plane.
        float band_ = sin(vWorldPos.y * 1.35 + wFbm(vWorldPos.xz * 0.09) * 4.2);
        cAlbedo *= 0.86 + 0.24 * band_ * band_;
        cAlbedo *= 0.82 + wFbm(vWorldPos.xz * 0.05 + vWorldPos.y * 0.02) * 0.5;

        vec3 nx_ = texture2D(uStoneN, p_.zy).xyz * 2.0 - 1.0;
        vec3 ny_ = texture2D(uStoneN, p_.xz).xyz * 2.0 - 1.0;
        vec3 nz_ = texture2D(uStoneN, p_.xy).xyz * 2.0 - 1.0;
        vec3 tnx_ = vec3(nx_.xy + wn_.zy, abs(nx_.z) * wn_.x);
        vec3 tny_ = vec3(ny_.xy + wn_.xz, abs(ny_.z) * wn_.y);
        vec3 tnz_ = vec3(nz_.xy + wn_.xy, abs(nz_.z) * wn_.z);
        cWorldN = normalize(tnx_.zyx * bw_.x + tny_.xzy * bw_.y + tnz_.xyz * bw_.z);

        cRough = 0.78;

        // Grass and moss creep over anything approaching horizontal.
        float cap_ = smoothstep(0.55, 0.9, wn_.y);
        cap_ *= 0.35 + 0.65 * smoothstep(0.35, 0.7, wFbm(vWorldPos.xz * 0.28));
        // The library stone ramp is a cold blue-grey; warm and desaturate it so
        // rock reads as stone under a late-afternoon key rather than as ice.
        float sl_ = dot(cAlbedo, vec3(0.2126, 0.7152, 0.0722));
        cAlbedo = mix(vec3(sl_), cAlbedo, 0.45) * vec3(1.16, 1.04, 0.88);

        vec3 capCol_ = texture2D(uGrass, vWorldPos.xz / 9.0).rgb;
        cAlbedo = mix(cAlbedo, capCol_ * vec3(0.9, 0.98, 0.78), cap_);
        cWorldN = normalize(mix(cWorldN, wn_, cap_ * 0.7));
        cRough = mix(cRough, 0.96, cap_);

        diffuseColor.rgb = cAlbedo;
        `,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = cRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace(
        '#include <normal_fragment_maps>',
        'normal = normalize((viewMatrix * vec4(cWorldN, 0.0)).xyz);',
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `
        float ao_ = clamp(vTerrainAo, 0.0, 1.0);
        reflectedLight.indirectDiffuse *= ao_;
        reflectedLight.indirectSpecular *= mix(1.0, ao_, 0.6);
        `,
      );
  };
  material.customProgramCacheKey = () => 'terrain.cliff.v1';

  return {
    material,
    dispose(): void {
      material.dispose();
    },
  };
}
