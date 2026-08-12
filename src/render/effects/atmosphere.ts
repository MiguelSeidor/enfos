/**
 * Atmospheric perspective. Owner: RENDER agent.
 *
 * Replaces `scene.fog`. A per-material FogExp2 cannot do any of the three things
 * that make distance read at RTS gameplay ranges:
 *
 *  1. **Height falloff.** Haze pools in the low ground and thins over the raised
 *     rim, so elevation reads as elevation instead of as a flat tint.
 *  2. **Directional inscattering.** Looking toward the sun the haze goes warm and
 *     bright; looking away it goes cool. That single cue is most of what makes a
 *     frame feel lit by a real sky rather than tinted by a constant.
 *  3. **Highlight preservation.** Emissives punch through haze instead of being
 *     dissolved by it, so VFX at range stay legible.
 *
 * Runs in scene-linear HDR immediately after AO and before tone mapping, which is
 * where scattering physically belongs.
 */

import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

const FRAGMENT = /* glsl */ `
uniform mat4 uInvProjection;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uHazeAway;
uniform vec3 uHazeSun;
uniform vec4 uFogParams;   // x density, y 1/heightFalloff, z baseY, w startDistance
uniform vec4 uSkyParams;   // x horizon width, y horizon strength, z sun anisotropy, w highlight punch

float heightIntegral(float y0, float y1, float k, float segment) {
  // Analytic integral of exp(-k*y) along a straight segment. Falls back to the
  // constant-height case when the ray is near horizontal, where the general form
  // divides by ~0.
  float dy = y1 - y0;
  float e0 = exp(-k * clamp(y0, -40.0, 400.0));
  if (abs(dy) < 0.05) return e0 * segment;
  float e1 = exp(-k * clamp(y1, -40.0, 400.0));
  return ((e0 - e1) / (k * dy)) * segment;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 viewPos = uInvProjection * clip;
  viewPos /= viewPos.w;
  vec3 worldPos = (uCamWorld * viewPos).xyz;

  vec3 toFrag = worldPos - uCamPos;
  float dist = length(toFrag);
  vec3 rayDir = toFrag / max(dist, 1e-4);

  // Inscattering colour: warm toward the sun, cool away from it.
  float sunAmount = max(dot(rayDir, uSunDir), 0.0);
  vec3 haze = mix(uHazeAway, uHazeSun, pow(sunAmount, uSkyParams.z));

  float fog;
  if (depth >= 0.9999) {
    // Nothing was drawn here, so this is sky. Ground it into the haze near the
    // horizon so the two never meet on a hard line.
    fog = uSkyParams.y * (1.0 - smoothstep(0.0, uSkyParams.x, rayDir.y));
  } else {
    float segment = max(dist - uFogParams.w, 0.0);
    float y0 = uCamPos.y - uFogParams.z;
    float y1 = worldPos.y - uFogParams.z;
    // Only the fogged part of the ray contributes, but the height range is still
    // sampled end to end; the error is well under a pixel of tint at these scales.
    float od = heightIntegral(y0, y1, uFogParams.y, segment);
    fog = 1.0 - exp(-uFogParams.x * max(od, 0.0));
  }

  // Anything already brighter than white is a light source, not a lit surface.
  // Let it burn through the haze so distant VFX stay readable.
  float over = clamp(max(max(inputColor.r, inputColor.g), inputColor.b) - 1.0, 0.0, 1.0);
  fog *= 1.0 - over * uSkyParams.w;

  outputColor = vec4(mix(inputColor.rgb, haze, clamp(fog, 0.0, 1.0)), inputColor.a);
}
`;

export interface AtmosphereSettings {
  /** Overall optical density. Higher = thicker haze. */
  density: number;
  /** Height over which density falls by 1/e, in world units. */
  heightFalloff: number;
  /** World Y at which density is at its maximum. */
  baseHeight: number;
  /** Distance before any haze accumulates; keeps the hero zoom clean. */
  startDistance: number;
  /** Haze colour looking away from the sun. */
  hazeAway: number;
  /** Haze colour looking into the sun. */
  hazeSun: number;
  /** Exponent on the sun lobe. Higher = tighter, more directional glow. */
  sunAnisotropy: number;
  /** How far above the horizon the sky blends into haze, in ray-Y units. */
  horizonWidth: number;
  /** Maximum haze blended into the sky at the horizon. */
  horizonStrength: number;
  /** How much emissives (>1.0) resist the haze. 0 = none, 1 = fully. */
  highlightPunch: number;
}

export class AtmosphereEffect extends Effect {
  private readonly camera: THREE.PerspectiveCamera;
  private readonly camPos = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, settings: AtmosphereSettings) {
    super('AtmosphereEffect', FRAGMENT, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uInvProjection', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamPos', new THREE.Uniform(new THREE.Vector3())],
        ['uSunDir', new THREE.Uniform(new THREE.Vector3(0, 1, 0))],
        ['uHazeAway', new THREE.Uniform(new THREE.Color())],
        ['uHazeSun', new THREE.Uniform(new THREE.Color())],
        ['uFogParams', new THREE.Uniform(new THREE.Vector4())],
        ['uSkyParams', new THREE.Uniform(new THREE.Vector4())],
      ]),
    });
    this.camera = camera;
    this.apply(settings);
  }

  apply(s: AtmosphereSettings): void {
    (this.uniforms.get('uHazeAway')!.value as THREE.Color).setHex(s.hazeAway, THREE.SRGBColorSpace);
    (this.uniforms.get('uHazeSun')!.value as THREE.Color).setHex(s.hazeSun, THREE.SRGBColorSpace);
    (this.uniforms.get('uFogParams')!.value as THREE.Vector4).set(
      s.density,
      1 / Math.max(s.heightFalloff, 0.1),
      s.baseHeight,
      s.startDistance,
    );
    (this.uniforms.get('uSkyParams')!.value as THREE.Vector4).set(
      s.horizonWidth,
      s.horizonStrength,
      s.sunAnisotropy,
      s.highlightPunch,
    );
  }

  setSunDirection(dir: THREE.Vector3): void {
    (this.uniforms.get('uSunDir')!.value as THREE.Vector3).copy(dir).normalize();
  }

  override update(): void {
    const cam = this.camera;
    (this.uniforms.get('uInvProjection')!.value as THREE.Matrix4).copy(
      cam.projectionMatrixInverse,
    );
    (this.uniforms.get('uCamWorld')!.value as THREE.Matrix4).copy(cam.matrixWorld);
    cam.getWorldPosition(this.camPos);
    (this.uniforms.get('uCamPos')!.value as THREE.Vector3).copy(this.camPos);
  }
}
