/**
 * Highlight shoulder. Owner: RENDER agent.
 *
 * ## The problem this solves
 *
 * ACES filmic is a *display* transform with a very long shoulder. Feeding it the
 * scene-linear values this pipeline produces, the numbers work out like this:
 *
 * | scene-linear in | ACES out (linear) | after sRGB encode |
 * | --- | --- | --- |
 * | 0.42 | 0.32 | 0.60 |
 * | 1.00 | 0.62 | 0.83 |
 * | 1.85 | 0.79 | 0.90 |
 * | 4.30 | 0.92 | 0.96 |
 * | 25.7 | 1.00 | 1.00 |
 *
 * So a pixel has to reach **1.85 scene-linear** before it counts as a highlight
 * at all, and 25.7 before it is white. Sunlit stone in this scene tops out near
 * 1.7 and the building emissives are deliberately parked just under 1.05 so they
 * stay below the bloom threshold — which means, before this pass existed, the
 * frame's own light sources landed at 0.83 display and *nothing* in a shot
 * without VFX ever crossed 0.90. That is the "no specular life" failure: a frame
 * whose brightest pixel is a middling grey reads flat no matter how good the
 * materials are.
 *
 * Raising exposure to fix it is the wrong trade — it drags the midtones and the
 * shadow mass up with everything else and buys a washed-out frame instead of a
 * dark one. What is actually wanted is more *range*, not more *light*.
 *
 * ## What it does
 *
 * A soft knee on luminance. Below the knee nothing changes at all, so lit ground
 * and every midtone stay exactly where exposure put them. Above it, values ramp
 * into a multiplier that lifts specular tips, lit metal, sky-facing stone caps
 * and emitters up the ACES shoulder where they separate from the diffuse mass.
 *
 * The gain multiplies all three channels equally, so hue and saturation are
 * untouched in linear space; ACES does the highlight desaturation on its own,
 * which is what makes a bright surface bleach toward its light colour instead of
 * clipping to a hard primary.
 *
 * ## Why it sits where it sits (between bloom and the tone map)
 *
 * `structures.ts` is tuned against `luminanceThreshold: 1.05` — its emissives run
 * at 0.22–0.85 intensity specifically so they land just under it and glow without
 * smearing. Bloom samples the *pass input*, so any expansion applied earlier (in
 * `SceneGradeEffect`, one pass upstream) would push those emitters over the
 * threshold and break that tuning.
 *
 * Placed here, inside pass 3 and after bloom in the merged shader, it reads the
 * running colour that bloom has already blended into. The threshold sees the
 * un-expanded value, structures.ts keeps its calibration, and the emissives still
 * gain the top of the display range. Do not move this above the bloom effect.
 */

import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

const FRAGMENT = /* glsl */ `
uniform vec4 uShoulder;   // x knee, y width, z gain, w 1/rolloff

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = max(inputColor.rgb, 0.0);

  // Smoothstep rather than a hard knee: a linear ramp would put a visible
  // Mach band along every gradient that crosses the threshold, which on a
  // sunlit curved surface is exactly where the eye is already looking.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float t = smoothstep(uShoulder.x, uShoulder.x + uShoulder.y, l);

  // The gain decays as the input climbs, and this is the difference between a
  // shoulder and a blowtorch. A flat multiplier above the knee applies its full
  // strength to a surface that is already at the top of the range, which buys
  // nothing — ACES maps 5.0 and 14.5 to 0.970 and 0.994, visually the same
  // white — while guaranteeing that anything bright loses its last stop of
  // shading and goes featureless. The hero's helmet did exactly that.
  //
  // Dividing the gain by (1 + l/rolloff) puts the expansion where it is
  // actually needed: on the band between "lit" and "highlight", which is the
  // range that has to cross 90% for the frame to read as having specular life.
  // Surfaces already past that keep their shading instead of being flattened.
  float boost = 1.0 + uShoulder.z * t / (1.0 + l * uShoulder.w);

  outputColor = vec4(c * boost, inputColor.a);
}
`;

export interface ShoulderSettings {
  /** Scene-linear luminance at which highlight expansion begins. */
  knee: number;
  /** Width of the ramp above the knee, in the same units. */
  width: number;
  /** Peak multiplier added at the top of the ramp. 0 disables the effect. */
  gain: number;
  /** Scene-linear luminance at which the gain has decayed to half strength. */
  rolloff: number;
}

export class HighlightShoulderEffect extends Effect {
  constructor(settings: ShoulderSettings) {
    super('HighlightShoulderEffect', FRAGMENT, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uShoulder', new THREE.Uniform(new THREE.Vector4(1, 1, 0, 0))],
      ]),
    });
    this.apply(settings);
  }

  apply(s: ShoulderSettings): void {
    (this.uniforms.get('uShoulder')!.value as THREE.Vector4).set(
      s.knee,
      Math.max(s.width, 1e-3),
      s.gain,
      1 / Math.max(s.rolloff, 1e-3),
    );
  }
}
