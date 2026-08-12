/**
 * Contrast-clamped unsharp mask. Owner: RENDER agent.
 *
 * Runs after SMAA. SMAA is a morphological filter: it reconstructs edges by
 * blending along them, which softens real texture detail as a side effect. At
 * 1080p on a 27" panel that softness reads as "low resolution" even though the
 * buffer is native. A small sharpen pass afterwards recovers the perceived
 * detail.
 *
 * The result is clamped to the 3x3 neighbourhood min/max, which is what stops it
 * from producing the bright halos that make naive unsharp masking look cheap.
 */

import * as THREE from 'three';
import { BlendFunction, Effect } from 'postprocessing';

const FRAGMENT = /* glsl */ `
uniform vec2 uTexel;
uniform float uAmount;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  vec3 n = texture2D(inputBuffer, uv + vec2(0.0, uTexel.y)).rgb;
  vec3 s = texture2D(inputBuffer, uv - vec2(0.0, uTexel.y)).rgb;
  vec3 e = texture2D(inputBuffer, uv + vec2(uTexel.x, 0.0)).rgb;
  vec3 w = texture2D(inputBuffer, uv - vec2(uTexel.x, 0.0)).rgb;

  vec3 lo = min(c, min(min(n, s), min(e, w)));
  vec3 hi = max(c, max(max(n, s), max(e, w)));

  vec3 sharpened = c + (c - (n + s + e + w) * 0.25) * uAmount;
  outputColor = vec4(clamp(sharpened, lo, hi), inputColor.a);
}
`;

export class SharpenEffect extends Effect {
  constructor(amount = 0.5) {
    super('SharpenEffect', FRAGMENT, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, THREE.Uniform>([
        ['uTexel', new THREE.Uniform(new THREE.Vector2(1 / 1920, 1 / 1080))],
        ['uAmount', new THREE.Uniform(amount)],
      ]),
    });
  }

  set amount(v: number) {
    this.uniforms.get('uAmount')!.value = v;
  }

  override setSize(width: number, height: number): void {
    (this.uniforms.get('uTexel')!.value as THREE.Vector2).set(1 / width, 1 / height);
  }
}
