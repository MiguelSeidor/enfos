/**
 * Forces the final composited image to be fully opaque.
 *
 * ## Why this exists
 *
 * The post-processing chain runs through `HalfFloatType` render targets that
 * carry an alpha channel. Nothing in the chain has a reason to write alpha — the
 * effects care about colour — so alpha arrives at the default framebuffer as 0
 * while RGB is fully lit. Sampling the drawing buffer on the affected machine
 * returned `RGBA = [255, 255, 251, 0]`: the image was rendered correctly and then
 * composited away.
 *
 * With `premultipliedAlpha: true` (three's default) an RGB of 255 paired with an
 * alpha of 0 is not a valid premultiplied colour, and browsers disagree about
 * what to draw for it. Chromium's headless compositor happened to show the
 * colour — which is why every capture in this project looked correct — while the
 * same page in a normal window showed a white sheet. That divergence is what
 * made the bug invisible to the review loop for so long.
 *
 * Requesting `alpha: false` on the context is not sufficient: the reported
 * context attributes come back with `alpha: true` regardless, because the canvas
 * context is created before the renderer's preferences are applied. Writing
 * alpha explicitly at the end of the chain is the only fix that does not depend
 * on context negotiation.
 *
 * Keep this as the last effect in the last pass.
 */

import { Effect } from 'postprocessing';

const FRAGMENT = /* glsl */ `
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  outputColor = vec4(inputColor.rgb, 1.0);
}
`;

export class OpaqueOutputEffect extends Effect {
  constructor() {
    super('OpaqueOutputEffect', FRAGMENT);
  }
}
