/**
 * Colour grading. Owner: RENDER agent.
 *
 * Split into the two stages a film pipeline uses, because they are not
 * interchangeable:
 *
 *  - `SceneGradeEffect` runs in **scene-linear HDR, before the tone map**. This
 *    is where exposure, white balance and contrast belong: contrast applied here
 *    is a real change in the scene's dynamic range, so the tone curve's toe and
 *    shoulder do the work of rolling it off. Applying contrast after the tone map
 *    instead just clips, which is what produced the flat baseline.
 *  - `FilmGradeEffect` runs in **display-referred 0..1, after the tone map**.
 *    Lift/gamma/gain, split toning and final saturation live here.
 *
 * The whole art direction is one exported `GradePreset` object. Changing the mood
 * of the game is editing that object, not chasing material tweaks across folders.
 */

import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

// ── Stage 1: scene-linear ────────────────────────────────────────────────────

const SCENE_FRAGMENT = /* glsl */ `
uniform float uExposure;
uniform float uContrast;
uniform float uPreSaturation;
uniform vec3 uWhiteBalance;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0) * uExposure * uWhiteBalance;

  // Contrast as a power curve pivoted on 18% grey. Keeps middle grey fixed while
  // pushing the toe down and the shoulder up in scene-linear space, so the tone
  // map still has real highlight range to roll off.
  const float pivot = 0.18;
  c = pow(c / pivot, vec3(uContrast)) * pivot;

  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uPreSaturation);

  outputColor = vec4(c, inputColor.a);
}
`;

export class SceneGradeEffect extends Effect {
  constructor() {
    super('SceneGradeEffect', SCENE_FRAGMENT, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uExposure', new THREE.Uniform(1)],
        ['uContrast', new THREE.Uniform(1)],
        ['uPreSaturation', new THREE.Uniform(1)],
        ['uWhiteBalance', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
      ]),
    });
  }

  set exposure(v: number) {
    this.uniforms.get('uExposure')!.value = v;
  }

  get exposure(): number {
    return this.uniforms.get('uExposure')!.value as number;
  }

  apply(p: GradePreset): void {
    this.uniforms.get('uExposure')!.value = p.exposure;
    this.uniforms.get('uContrast')!.value = p.sceneContrast;
    this.uniforms.get('uPreSaturation')!.value = p.sceneSaturation;
    (this.uniforms.get('uWhiteBalance')!.value as THREE.Vector3).set(
      p.whiteBalance[0],
      p.whiteBalance[1],
      p.whiteBalance[2],
    );
  }
}

// ── Stage 2: display-referred ────────────────────────────────────────────────

const FILM_FRAGMENT = /* glsl */ `
uniform vec3 uLift;
uniform vec3 uInvGamma;
uniform vec3 uGain;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform vec4 uCurve;   // x toneBalance, y shadowRange, z saturation, w sCurve

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = clamp(inputColor.rgb, 0.0, 1.0);

  // ASC-CDL style lift / gamma / gain.
  c = clamp(c * uGain + uLift, 0.0, 1.0);
  c = pow(c, uInvGamma);

  // Split toning: the single strongest cue that a frame was art-directed rather
  // than rendered. Shadows drift one way on the colour wheel, highlights the
  // other, so lit and unlit read as different times of day.
  float l = luma(c);
  float shadowW = 1.0 - smoothstep(0.0, uCurve.y, l);
  float highW = smoothstep(uCurve.x, 1.0, l);
  c *= 1.0 + uShadowTint * shadowW + uHighlightTint * highW;

  c = mix(vec3(luma(c)), c, uCurve.z);
  c = clamp(c, 0.0, 1.0);

  // A touch of smoothstep blended in deepens the toe and firms the shoulder.
  // This is what puts pixels below 10% and above 90% on the histogram.
  vec3 s = c * c * (3.0 - 2.0 * c);
  c = mix(c, s, uCurve.w);

  outputColor = vec4(c, inputColor.a);
}
`;

export class FilmGradeEffect extends Effect {
  constructor() {
    super('FilmGradeEffect', FILM_FRAGMENT, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uLift', new THREE.Uniform(new THREE.Vector3())],
        ['uInvGamma', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['uGain', new THREE.Uniform(new THREE.Vector3(1, 1, 1))],
        ['uShadowTint', new THREE.Uniform(new THREE.Vector3())],
        ['uHighlightTint', new THREE.Uniform(new THREE.Vector3())],
        ['uCurve', new THREE.Uniform(new THREE.Vector4(0.5, 0.35, 1, 0))],
      ]),
    });
  }

  apply(p: GradePreset): void {
    (this.uniforms.get('uLift')!.value as THREE.Vector3).fromArray(p.lift);
    (this.uniforms.get('uInvGamma')!.value as THREE.Vector3).set(
      1 / p.gamma[0],
      1 / p.gamma[1],
      1 / p.gamma[2],
    );
    (this.uniforms.get('uGain')!.value as THREE.Vector3).fromArray(p.gain);
    (this.uniforms.get('uShadowTint')!.value as THREE.Vector3).fromArray(p.shadowTint);
    (this.uniforms.get('uHighlightTint')!.value as THREE.Vector3).fromArray(p.highlightTint);
    (this.uniforms.get('uCurve')!.value as THREE.Vector4).set(
      p.toneBalance,
      p.shadowRange,
      p.saturation,
      p.sCurve,
    );
  }
}

// ── The dial ─────────────────────────────────────────────────────────────────

export interface GradePreset {
  /** Scene-linear multiplier applied before the tone curve. */
  exposure: number;
  /** Power curve about 18% grey. >1 adds contrast. */
  sceneContrast: number;
  /** Saturation in scene-linear, before the tone map desaturates highlights. */
  sceneSaturation: number;
  /** Per-channel scene-linear multiplier. Warmer key: r>1, b<1. */
  whiteBalance: [number, number, number];
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  /** Multiplicative tint pushed into the shadows. */
  shadowTint: [number, number, number];
  /** Multiplicative tint pushed into the highlights. */
  highlightTint: [number, number, number];
  /** Luma above which highlight toning starts. */
  toneBalance: number;
  /** Luma below which shadow toning is at full strength. */
  shadowRange: number;
  saturation: number;
  /** Blend toward a smoothstep response. 0 = linear, 1 = full S. */
  sCurve: number;
}
