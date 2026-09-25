/**
 * Terrain-conforming ground effects. Owner: VFX.
 *
 * Every effect that describes an *area* — shockwave rings, telegraphs, scorch
 * marks, frost patches, arcane sigils — is drawn here as an instanced patch that
 * samples a baked terrain height texture in the vertex stage and rides the
 * ground instead of hovering over it.
 *
 * Why conform rather than lift a flat quad: on a top-down camera an area effect
 * *is* the readable statement of "this space is dangerous" (GDD §14, §16), and a
 * flat quad lifted enough to clear a slope reads as a floating sticker, while a
 * quad lifted less slices through the hill. Clipping through terrain is also an
 * automatic rejection in `qa/REVIEW_RUBRIC.md`. Sampling the height field costs
 * one vertex texture fetch per grid vertex and removes the whole problem.
 *
 * Shapes are analytic in the fragment shader rather than textured sprites: a
 * telegraph has to change its fill as the lead time elapses, and an analytic
 * shape can do that from one float per instance. Only the true decals — scorch,
 * frost, sigil — sample the decal array.
 *
 * Two meshes, two draw calls: an additive one for light, and an alpha one for
 * decals, because additive cannot darken and a burn mark that does not darken
 * the ground is not a burn mark.
 */

import * as THREE from 'three';
import type { HeightFieldTexture } from './sprites';

/** Fragment shape selector. Parameter meanings are per-shape; see the shader. */
export const GSHAPE = {
  /** p0 radius fraction, p1 half width, p2 angular reveal. */
  ring: 0,
  /** p0 fill opacity, p1 radial sweep. */
  disc: 1,
  /** p0 half angle (rad), p1 radial sweep, p2 fill opacity. */
  cone: 2,
  /** p1 length sweep, p2 fill opacity. Width comes from the instance size. */
  line: 3,
  /** p0 half width fraction, p1 sweep, p2 fill opacity. */
  cross: 4,
  /** p0 arms, p1 twist, p2 opacity. */
  spiral: 5,
  /** p0 spokes, p1 sharpness, p2 core size. */
  starburst: 6,
  /** p0 falloff power. */
  glow: 7,
  /** p0 radius fraction, p1 half width, p2 streak strength. */
  shock: 8,
  /** Textured decal; layer comes from `iExtra.y`. p0 edge softness. */
  decal: 9,
  /** p0 radius fraction, p1 half width, p2 spike length scale. */
  crystal: 10,
} as const;

const GRID = 16;

const VERT = /* glsl */ `
attribute vec3 iCenter;    // x, lift above ground, z
attribute vec3 iSize;      // half extent x, half extent z, yaw
attribute vec3 iColor;
attribute vec4 iParams;    // alpha, shape, p0, p1
attribute vec2 iExtra;     // p2, decal layer

uniform sampler2D uHeight;
uniform vec2 uHeightMin;
uniform vec2 uHeightSize;
uniform vec2 uHeightRange;

varying vec2 vLocal;
varying vec3 vColor;
varying vec4 vParams;
varying vec2 vExtra;
varying float vSlope;

float heightAt(vec2 world) {
  vec2 huv = clamp((world - uHeightMin) / uHeightSize, 0.0, 1.0);
  vec4 hs = texture2D(uHeight, huv);
  // 16-bit height split across R (coarse) and G (fine); see makeHeightField.
  return uHeightRange.x + (hs.r + hs.g / 255.0) * uHeightRange.y;
}

void main() {
  // Local coordinates in [-1,1], before yaw, so the fragment shader can reason
  // about a cone pointing along +z regardless of how the instance is oriented.
  vec2 lp = vec2(position.x, position.z) * 2.0;
  vLocal = lp;
  vColor = iColor;
  vParams = iParams;
  vExtra = iExtra;

  vec2 scaled = vec2(lp.x * iSize.x, lp.y * iSize.y);
  float c = cos(iSize.z);
  float s = sin(iSize.z);
  vec2 rotated = vec2(scaled.x * c - scaled.y * s, scaled.x * s + scaled.y * c);
  vec3 world = vec3(iCenter.x + rotated.x, 0.0, iCenter.z + rotated.y);

  float h = heightAt(world.xz);
  world.y = h + iCenter.y;

  // Local ground slope, from the same height field. Conforming to a cliff face
  // is still wrong even though it is not clipping: a scorch mark that runs up a
  // vertical wall reads as wallpaper. The fragment stage fades it out instead.
  float e = 1.2;
  float hx = heightAt(world.xz + vec2(e, 0.0)) - heightAt(world.xz - vec2(e, 0.0));
  float hz = heightAt(world.xz + vec2(0.0, e)) - heightAt(world.xz - vec2(0.0, e));
  vSlope = length(vec2(hx, hz)) / (2.0 * e);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray uDecals;
uniform float uTime;

varying vec2 vLocal;
varying vec3 vColor;
varying vec4 vParams;
varying vec2 vExtra;
varying float vSlope;

const float PI = 3.141592653589793;

float band(float value, float centre, float width) {
  return smoothstep(width, 0.0, abs(value - centre));
}

void main() {
  vec2 p = vLocal;
  float r = length(p);
  float ang = atan(p.x, p.y);
  int shape = int(vParams.y + 0.5);
  float p0 = vParams.z;
  float p1 = vParams.w;
  float p2 = vExtra.x;

  vec3 col = vColor;
  float a = 0.0;

  // Turbulence sampled in polar space: it rides the shape rather than the quad,
  // so a ring breaks up along its circumference instead of showing a square grain.
  float grain = texture(uDecals, vec3(fract(vec2(ang / (2.0 * PI) + 0.5, r * 0.55 - uTime * 0.05)), 3.0)).r;

  if (shape == 0) {
    // Ring: soft body plus a tight bright edge, so it survives both bloom and
    // distance without becoming a smear.
    //
    // The band half-width is clamped against the ring's own radius. An annulus
    // is only an annulus while its width is smaller than its radius: a band of
    // half-width 0.28 around a radius of 0.04 covers everything inside 0.32,
    // which is a *filled disc*, and stacking a few of those additively is the
    // white blob this shader shipped with. The authored curves already taper
    // width with life (see ringBand in specs.ts); clamping here as well means no
    // caller — including a telegraph or future gameplay code — can reintroduce
    // it by passing a width that outruns the radius.
    float w = clamp(min(p1, p0 * 0.55), 0.006, 1.0);
    float reveal = step(abs(ang) / PI, p2);
    a = (band(r, p0, w) * (0.55 + 0.75 * grain) + band(r, p0, w * 0.3) * 0.75) * reveal;
  } else if (shape == 1) {
    float outline = band(r, 1.0, 0.045);
    float fill = smoothstep(p1 + 0.06, p1 - 0.02, r) * step(r, 1.0);
    float lead = band(r, p1, 0.04) * step(p1, 0.995);
    a = outline * 0.95 + fill * p0 * (0.45 + 0.55 * grain) + lead * 0.9;
  } else if (shape == 2) {
    float inCone = step(abs(ang), p0) * step(r, 1.0);
    float sides = smoothstep(0.06, 0.0, abs(abs(ang) - p0)) * step(r, 1.0) * smoothstep(0.0, 0.12, r);
    float arc = band(r, 1.0, 0.05) * step(abs(ang), p0);
    float fill = inCone * smoothstep(p1 + 0.07, p1 - 0.02, r);
    float lead = band(r, p1, 0.045) * step(abs(ang), p0) * step(p1, 0.995);
    a = (sides + arc) * 0.95 + fill * p2 * (0.45 + 0.55 * grain) + lead * 0.9;
  } else if (shape == 3) {
    float t = (p.y + 1.0) * 0.5;
    float inside = step(abs(p.x), 1.0) * step(abs(p.y), 1.0);
    float edge = (smoothstep(0.14, 0.0, 1.0 - abs(p.x)) + smoothstep(0.05, 0.0, 1.0 - abs(p.y))) * inside;
    float fill = inside * step(t, p1);
    float lead = smoothstep(0.05, 0.0, abs(t - p1)) * inside * step(p1, 0.995);
    a = edge * 0.9 + fill * p2 * (0.45 + 0.55 * grain) + lead * 0.95;
  } else if (shape == 4) {
    float m = max(abs(p.x), abs(p.y));
    float arm = min(abs(p.x), abs(p.y));
    float inside = step(arm, p0) * step(m, 1.0);
    float edge = smoothstep(0.06, 0.0, abs(arm - p0)) * step(m, 1.0) + band(m, 1.0, 0.05) * step(arm, p0);
    float fill = inside * step(m, p1);
    a = edge * 0.9 + fill * p2 * (0.45 + 0.55 * grain);
  } else if (shape == 5) {
    // Arcane spiral: counter-rotating arms plus a boundary ring.
    float s = sin(ang * p0 - r * p1 + uTime * 2.6);
    float arms = smoothstep(0.45, 0.98, s);
    float radial = smoothstep(1.0, 0.12, r) * smoothstep(0.0, 0.14, r);
    a = arms * radial * (0.55 + 0.7 * grain) + band(r, 0.95, 0.035) * 0.8;
    a *= p2;
  } else if (shape == 6) {
    // Holy starburst: hard radial spokes over a soft pool of light.
    float spokes = pow(abs(cos(ang * p0 * 0.5)), p1);
    float radial = smoothstep(1.0, 0.04, r);
    a = spokes * radial * 0.85 + exp(-r * r * 11.0) * p2;
  } else if (shape == 7) {
    a = pow(max(0.0, 1.0 - r), p0);
  } else if (shape == 8) {
    // Dust shock: a broad ring shredded into radial streaks. Same width clamp as
    // the ring above — this shape fails into a filled disc the same way.
    float w = clamp(min(p1, p0 * 0.55), 0.006, 1.0);
    float ring = band(r, p0, w) * (0.4 + 0.9 * grain);
    float streaks = pow(abs(sin(ang * 15.0 + grain * 5.0)), 5.0)
      * smoothstep(p0 + w, p0 - w * 2.5, r) * smoothstep(0.0, 0.25, r);
    a = ring + streaks * p2;
  } else if (shape == 10) {
    // Crystalline ring: the frost dialect of a shockwave, and the reason frost
    // is not "the blue one". The advancing front is stepped into angular facets
    // with a per-sector radius, so it grows as a polygon of ice rather than a
    // smooth circle, and each facet throws a needle outward along its own
    // normal. Same width clamp as the other rings.
    float w = clamp(min(p1, p0 * 0.55), 0.006, 1.0);
    float sectors = 13.0;
    float turn = (ang + PI) / (2.0 * PI) * sectors;
    float si = floor(turn);
    // Cheap per-sector hash: the facets must be uneven or the shape reads as a
    // machined cog instead of fractured ice.
    float rnd = fract(sin(si * 12.9898) * 43758.5453);
    float rr = p0 * (0.86 + 0.26 * rnd);
    float facet = band(r, rr, w) * (0.7 + 0.55 * grain);
    // Needle at the centre of each facet, just outside the front.
    float phase = fract(turn);
    float needle = pow(max(0.0, 1.0 - abs(phase * 2.0 - 1.0)), 9.0);
    float len = w * (2.2 + 3.4 * rnd) * max(0.35, p2);
    float spike = needle * band(r, rr + len * 0.5, len * 0.55);
    // Held below 1.0: these needles sit on sunlit ground, and an additive shape
    // that reaches full alpha there clips to white and takes the ice colour with
    // it — the shape survives, the school does not.
    a = facet * 0.78 + spike * 0.62;
  } else {
    vec4 d = texture(uDecals, vec3(p * 0.5 + 0.5, vExtra.y));
    col *= d.rgb;
    a = d.a * smoothstep(1.0, 1.0 - p0, r);
  }

  a *= vParams.x;

  // Slope fade. Textured decals go first — they are the ones that read as
  // wallpaper on a cliff — while analytic shapes keep more of their alpha,
  // because a telegraph that vanishes on a ramp is a lie about where the danger
  // is. Neither is allowed to paint a vertical face at full strength.
  // (Do not name this variable "flat" — that is a reserved interpolation
  // qualifier in GLSL ES 3.0 and the shader will not compile.)
  float level = 1.0 - smoothstep(0.45, 1.15, vSlope);
  a *= shape == 9 ? level : mix(1.0, level, 0.55);

  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}
`;

/** One instanced draw of ground-conforming patches. */
export class GroundBatch {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly center: Float32Array;
  private readonly size: Float32Array;
  private readonly color: Float32Array;
  private readonly params: Float32Array;
  private readonly extra: Float32Array;
  private readonly attributes: THREE.InstancedBufferAttribute[];
  private readonly material: THREE.ShaderMaterial;
  private cursor = 0;

  constructor(
    readonly capacity: number,
    decals: THREE.DataArrayTexture,
    height: HeightFieldTexture,
    blending: THREE.Blending,
    renderOrder: number,
  ) {
    const base = new THREE.PlaneGeometry(1, 1, GRID, GRID);
    base.rotateX(-Math.PI / 2);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.getAttribute('position'));
    base.dispose();

    this.center = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    this.extra = new Float32Array(capacity * 2);

    const aCenter = new THREE.InstancedBufferAttribute(this.center, 3);
    const aSize = new THREE.InstancedBufferAttribute(this.size, 3);
    const aColor = new THREE.InstancedBufferAttribute(this.color, 3);
    const aParams = new THREE.InstancedBufferAttribute(this.params, 4);
    const aExtra = new THREE.InstancedBufferAttribute(this.extra, 2);
    this.attributes = [aCenter, aSize, aColor, aParams, aExtra];
    for (const a of this.attributes) a.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('iCenter', aCenter);
    geometry.setAttribute('iSize', aSize);
    geometry.setAttribute('iColor', aColor);
    geometry.setAttribute('iParams', aParams);
    geometry.setAttribute('iExtra', aExtra);
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geometry;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uDecals: { value: decals },
        uHeight: { value: height.texture },
        uHeightMin: { value: height.min },
        uHeightSize: { value: height.size },
        uHeightRange: { value: height.range },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      // The patch already rides the height field; the offset only has to beat
      // depth-buffer precision, not terrain relief.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.matrixAutoUpdate = false;
  }

  setTime(t: number): void {
    this.material.uniforms.uTime.value = t;
  }

  begin(): void {
    this.cursor = 0;
  }

  push(
    x: number,
    lift: number,
    z: number,
    halfX: number,
    halfZ: number,
    yaw: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
    shape: number,
    p0: number,
    p1: number,
    p2: number,
    decalLayer: number,
  ): void {
    const i = this.cursor;
    if (i >= this.capacity) return;
    const i3 = i * 3;
    const i4 = i * 4;
    const i2 = i * 2;
    this.center[i3] = x;
    this.center[i3 + 1] = lift;
    this.center[i3 + 2] = z;
    this.size[i3] = halfX;
    this.size[i3 + 1] = halfZ;
    this.size[i3 + 2] = yaw;
    this.color[i3] = r;
    this.color[i3 + 1] = g;
    this.color[i3 + 2] = b;
    this.params[i4] = alpha;
    this.params[i4 + 1] = shape;
    this.params[i4 + 2] = p0;
    this.params[i4 + 3] = p1;
    this.extra[i2] = p2;
    this.extra[i2 + 1] = decalLayer;
    this.cursor = i + 1;
  }

  end(): void {
    this.geometry.instanceCount = this.cursor;
    if (this.cursor === 0) return;
    for (const a of this.attributes) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.cursor * a.itemSize);
      a.needsUpdate = true;
    }
  }

  get drawn(): number {
    return this.cursor;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
