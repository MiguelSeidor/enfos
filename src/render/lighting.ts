/**
 * Lighting rig. Owner: RENDER agent.
 *
 * ## The mood, chosen and committed to
 *
 * **Mid-afternoon, a storm front building on the far side of the valley.** Amber
 * key, teal shadow. This is the one decision everything else in this file serves:
 *
 *  - The sun sits at **36°** elevation. This is the number that moved most, and
 *    it moved for a measured reason. The map was rebuilt as a lane corridor
 *    between highland plateaus roughly 10 m tall. A 27° sun throws a shadow
 *    `10 / tan 27° = 19.6 m` long — wider than the corridors themselves — so the
 *    lanes were not lit by a low sun, they were *roofed* by it. The `junction`
 *    capture came back with 85% of frame inside one cast shadow, a mean
 *    luminance of 0.20, and no pixel anywhere above 0.78. At 36° the same
 *    shadow is 13.8 m and the corridor floor gets sun, while a caster still
 *    throws about 1.4x its own height — plenty of shadow to read form and
 *    elevation from. Ground facing the sky also gains 30% irradiance
 *    (`sin 36° / sin 27°`), which is what finally gives lit stone the range to
 *    reach the top of the histogram.
 *
 *    Do not push this lower again without re-running `junction` and `overview`.
 *    The romance of a low sun is real, and on this map it costs the frame its
 *    entire highlight range.
 *  - The key is **amber** (~3400K). The fill is **teal-blue** (~9000K). That
 *    ~5600K spread between lit and shadowed surfaces is the single largest
 *    contributor to a frame reading as art-directed rather than as a default
 *    three.js scene, and it costs nothing at runtime.
 *  - Turbidity is pushed high (9.5) for a thick, saturated horizon. The storm is
 *    coming; the air is heavy. The atmosphere pass reads that same warmth back
 *    into the haze toward the sun.
 *
 * ## Why four sources and not two
 *
 * | Source | Role |
 * | --- | --- |
 * | `key` (directional, shadow-casting) | Form, direction, and every shadow in frame. |
 * | `rim` (directional, no shadow) | Fires from behind and low. Catches the top-back edge of every unit so silhouettes separate from the ground they stand on. Non-negotiable for a top-down camera, where units otherwise sit *in* the floor rather than *on* it. |
 * | `fill` (hemisphere) | Sky-blue from above, warm bounce from below. Keeps shadow interiors coloured instead of dead flat, which is what the rubric asks for under "bounce/GI feel". |
 * | `environment` (PMREM of the sky) | Specular only, in effect. Kept deliberately low — a strong sky IBL is exactly what flattened the v0 baseline into grey-green mush, because it lights every surface from every direction at once. |
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { DEG } from '@/core/mathx';
import type { AtmosphereSettings } from './effects/atmosphere';
import type { GradePreset } from './effects/grade';

export interface MoodPreset {
  readonly id: string;
  /** Sun elevation above the horizon, degrees. */
  sunElevation: number;
  /**
   * Sun azimuth, degrees. 0 looks down -Z. The default camera sits on +Z looking
   * toward -Z, so an azimuth near 320 puts the key up and to the front-left of
   * the player's view: faces and front surfaces stay lit, shadows fall away from
   * camera instead of toward it.
   */
  sunAzimuth: number;
  sky: { turbidity: number; rayleigh: number; mieCoefficient: number; mieDirectionalG: number };
  key: { color: number; intensity: number };
  /** Fired from behind the subject, low, cool. Separates silhouettes. */
  rim: { color: number; intensity: number; elevation: number; azimuthOffset: number };
  fill: { sky: number; ground: number; intensity: number };
  environmentIntensity: number;
  atmosphere: AtmosphereSettings;
  grade: GradePreset;
}

export const MOOD_AMBER_STORM: MoodPreset = {
  id: 'amber-storm',
  sunElevation: 36,
  sunAzimuth: 320,
  sky: { turbidity: 9.5, rayleigh: 2.6, mieCoefficient: 0.005, mieDirectionalG: 0.87 },
  key: { color: 0xffcb92, intensity: 8.2 },
  // Raised from 1.5. The rim is the only source that reaches a surface the key
  // cannot see, so in a backlit shot — `junction` looks straight into the sun —
  // it is carrying every camera-facing face in frame on its own. At 1.5 those
  // faces were a single flat navy value; this is what gives them shape.
  rim: { color: 0xa8c2ea, intensity: 2.4, elevation: 16, azimuthOffset: 172 },
  // Key:fill lands near 8.6:1. Anything flatter and shadowed faces never reach
  // the bottom decile of the histogram; anything steeper and they go dead
  // black, which reads as a hole rather than as shade.
  // The sky colour is low-chroma for a reason that is easy to underrate: a
  // shadowed surface sees this light almost unopposed, so the fill does not
  // tint the shadows, it *is* their colour. At 0x86a4cd, green grass under a
  // wall came out dark teal and stopped reading as the same grass that was lit
  // two metres away. The ground term warms for the same reason: what bounces
  // up onto a shadowed face here is earth, not sky.
  fill: { sky: 0x9aa8ba, ground: 0x453524, intensity: 0.95 },
  // Raised from 0.2. This is the pipeline's only source of specular that is not
  // a single directional lobe, so at 0.2 a metal surface had almost nothing to
  // reflect and read as flat paint. The v0 failure this number was set low to
  // avoid — a strong sky IBL lighting every surface from every direction and
  // flattening the frame to grey-green — is a real failure, but it starts well
  // above this: the key-to-ambient ratio here is still better than 8:1.
  environmentIntensity: 0.34,
  atmosphere: {
    // Density is deliberately low. The first pass at 0.055 put ~84% haze on the
    // far side of an overview shot, which lifted the whole midground off the
    // black point and cost the frame its darks — the exact failure the brief
    // warned about. 0.016 still left a milky veil pooling in the ravines (they
    // are the low ground, so height falloff concentrates haze exactly where the
    // frame's darkest pixels live); 0.011 keeps the far rim separation without
    // lifting the ravine floor off the black point.
    density: 0.0135,
    heightFalloff: 30,
    baseHeight: -6,
    startDistance: 28,
    hazeAway: 0x54687f,
    hazeSun: 0xffc386,
    sunAnisotropy: 5,
    horizonWidth: 0.24,
    horizonStrength: 0.85,
    highlightPunch: 0.9,
  },
  // Saturation discipline: ACES filmic already adds chroma, so neither grade
  // stage boosts it meaningfully — the warm/cool story is carried by white
  // balance, split toning and the light rig, not by a saturation slider. The
  // previous values (1.12 pre + 1.14 post) compounded into candy.
  grade: {
    // 2.3 left every shot's histogram empty above 0.85 — lit stone never
    // reached the ACES shoulder, which read as underexposed sparkle-less mush.
    // Pulled back from 2.75 to pay for the brighter key and the higher sun.
    // Exposure sets where the *midtones* land; the top of the range is bought by
    // the shoulder below, which is why this can come down while highlights go up.
    exposure: 1.64,
    // Raised with exposure lowered to match. This pair is the one that widens
    // both tails at once: the power curve is pivoted on 18% grey, so a steeper
    // exponent pushes everything under the pivot down and everything over it up
    // while the pivot itself does not move. Exposure alone can only slide the
    // whole histogram, which trades one end of the rubric for the other.
    sceneContrast: 1.46,
    sceneSaturation: 0.98,
    whiteBalance: [1.04, 1.0, 0.96],
    // Returns separation to the shadow mass the contrast curve collapses. See
    // the long note in effects/grade.ts — it multiplies, so black stays black.
    toeAmount: 0.28,
    toeRange: 0.06,
    // The frame's only source of real highlights. Everything below the knee is
    // untouched, so this buys top-end range without moving the midtones or the
    // mean. Sits after bloom so the 1.05 threshold structures.ts is tuned
    // against never sees the expansion.
    // The knee is in post-exposure scene-linear units, so it has to track
    // exposure: when exposure came down from 2.75 to 2.05 a fixed knee stopped
    // catching the same surfaces and the highlights went with it.
    shoulder: { knee: 0.28, width: 0.85, gain: 1.9, rolloff: 1.9 },
    // The previous lift of -0.022/-0.017/-0.008 was a per-channel black clip:
    // with gain applied first it drove red to zero below 0.021 and green below
    // 0.017 while blue survived to 0.008, so every cool shadow lost two channels
    // before it lost the third and the shadow mass went to a flat hue with no
    // detail in it. Shallower, and closer to matched across channels, keeps a
    // true black without eating the last stop above it.
    lift: [-0.009, -0.008, -0.005],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.06, 1.03, 1.0],
    shadowTint: [-0.028, 0.004, 0.052],
    highlightTint: [0.05, 0.02, -0.045],
    toneBalance: 0.55,
    shadowRange: 0.34,
    saturation: 0.98,
    // Firms both ends: keeps the toe anchored under the exposure lift and
    // pushes lit stone caps over the 90% line the rubric requires.
    sCurve: 0.38,
  },
};

/**
 * Lighting settings that belong to characters and to nothing else.
 *
 * ## Why this is a settings block and not a fifth light
 *
 * The obvious way to lift units off the ground is a rim or back light that only
 * they receive, and three.js layers look like the tool for it. They are not: in
 * r180 the renderer collects lights per *scene*, filtered once by
 * `light.layers.test( camera.layers )` (`WebGLRenderer.projectObject`). There is
 * no per-object light filtering left in the engine, so any directional light
 * added here lands on the terrain too — and the terrain grade in this file was
 * just tuned and must not move. Confirmed by reading the renderer source, not
 * assumed.
 *
 * So the character-only part of the rig lives on the character *materials*
 * instead, and these are its numbers. They sit here, next to the rig they
 * complement, because they are lighting decisions: `units/build/character.ts`
 * only applies them.
 *
 * A second constraint shaped the choice. `render/creepBatch.ts` clones each
 * material and overwrites `onBeforeCompile` for its vertex-animation patch, so
 * any shader injection made here would silently apply to heroes and vanish on
 * creeps. Everything below is therefore expressed in plain material properties,
 * which survive `Material.clone()`.
 */
export const CHARACTER_SHADING = {
  /**
   * Units see less of the sky IBL than the world does. The environment is the
   * pipeline's only wide specular source, and on a metal at low roughness it is
   * what turns a pauldron into a white cut-out. The world keeps 1.0.
   */
  envMapIntensity: 0.6,
  /**
   * Self-lit floor, as a fraction of the surface's own apparent albedo, added as
   * emissive. It is the "character never dissolves into the ground" term: it
   * ignores shadow and AO, so a unit standing in a 13 m cast shadow still has a
   * value of its own to separate from the shadowed grass behind it.
   *
   * Kept different per faction on purpose — heroes should sit above the terrain
   * value and creeps below it (see the faction colour law in
   * `units/build/character.ts`), and this is the term that holds that apart in
   * shade, where the key cannot.
   */
  ambientLift: { hero: 0.26, creep: 0.17, boss: 0.2 },
  /**
   * Emissive on the `glow` slot, clamped. The catalog asks for 3.2–4.6, which
   * against a 1.05 bloom threshold produced a bloom disc wider than the head it
   * was attached to: the Hexwright's skull and the Oracle's face were erased by
   * their own eyes. A glint should read as a glint.
   */
  glowIntensityMax: 1.7,
  /**
   * Effective roughness floors by material slot — the roughness a surface has
   * after the slot multiplier is applied to the map. Physical, not arbitrary: a
   * face is ~0.7, waxed leather ~0.55, battle plate ~0.5. Polished trim is the
   * only thing on a character allowed a tight highlight, and even that is far
   * from a mirror.
   */
  roughnessFloor: {
    flesh: 0.62,
    cloth: 0.72,
    leather: 0.55,
    armor: 0.5,
    metal: 0.38,
    glow: 0.5,
  } as Record<string, number>,
  /**
   * Metalness ceiling. A full metal has no diffuse term at all, so its entire
   * appearance is a reflection of the sky and one directional lobe — which is
   * why armour read as either white or black and never as its palette colour.
   * Leaving a little diffuse in is what lets a faction colour survive on plate.
   */
  metalnessMax: 0.62,
} as const;

export class LightRig {
  readonly key: THREE.DirectionalLight;
  readonly rim: THREE.DirectionalLight;
  readonly fill: THREE.HemisphereLight;
  readonly sky: Sky;
  /** Unit vector pointing from the scene toward the sun. */
  readonly sunDirection = new THREE.Vector3();

  private readonly rimTarget = new THREE.Object3D();
  private readonly rimDirection = new THREE.Vector3();
  private readonly pmrem: THREE.PMREMGenerator;
  private envRT?: THREE.WebGLRenderTarget;
  private mood: MoodPreset;

  constructor(
    private readonly scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    mood: MoodPreset,
  ) {
    this.mood = mood;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    this.sky.name = 'sky';
    scene.add(this.sky);

    this.key = new THREE.DirectionalLight(0xffffff, 1);
    this.key.castShadow = true;
    this.key.name = 'key';
    // The shadow camera is driven entirely by FittedShadow; the light's own
    // target is repositioned every frame, so it must live in the scene graph.
    scene.add(this.key);
    scene.add(this.key.target);

    this.rim = new THREE.DirectionalLight(0xffffff, 1);
    this.rim.castShadow = false;
    this.rim.name = 'rim';
    scene.add(this.rim);
    scene.add(this.rimTarget);
    this.rim.target = this.rimTarget;

    this.fill = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
    this.fill.name = 'fill';
    scene.add(this.fill);

    this.applyMood(mood);
  }

  get preset(): MoodPreset {
    return this.mood;
  }

  applyMood(mood: MoodPreset): void {
    this.mood = mood;

    const el = mood.sunElevation * DEG;
    const az = mood.sunAzimuth * DEG;
    this.sunDirection
      .set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
      .normalize();

    const u = this.sky.material.uniforms;
    u.turbidity.value = mood.sky.turbidity;
    u.rayleigh.value = mood.sky.rayleigh;
    u.mieCoefficient.value = mood.sky.mieCoefficient;
    u.mieDirectionalG.value = mood.sky.mieDirectionalG;
    (u.sunPosition.value as THREE.Vector3).copy(this.sunDirection);

    this.key.color.setHex(mood.key.color, THREE.SRGBColorSpace);
    this.key.intensity = mood.key.intensity;

    const rimEl = mood.rim.elevation * DEG;
    const rimAz = (mood.sunAzimuth + mood.rim.azimuthOffset) * DEG;
    this.rimDirection
      .set(Math.cos(rimEl) * Math.sin(rimAz), Math.sin(rimEl), Math.cos(rimEl) * Math.cos(rimAz))
      .normalize();
    this.rim.position.copy(this.rimDirection).multiplyScalar(200);
    this.rim.color.setHex(mood.rim.color, THREE.SRGBColorSpace);
    this.rim.intensity = mood.rim.intensity;

    this.fill.color.setHex(mood.fill.sky, THREE.SRGBColorSpace);
    this.fill.groundColor.setHex(mood.fill.ground, THREE.SRGBColorSpace);
    this.fill.intensity = mood.fill.intensity;

    this.refreshEnvironment();
  }

  /** Re-bakes the IBL from the current sky. Call after changing sky uniforms. */
  refreshEnvironment(): void {
    this.envRT?.dispose();
    // The sky is briefly detached so PMREMGenerator sees only the sky dome and
    // not whatever terrain and units happen to be in the scene at bake time.
    const parent = this.sky.parent;
    parent?.remove(this.sky);
    const bakeScene = new THREE.Scene();
    bakeScene.add(this.sky);
    this.envRT = this.pmrem.fromScene(bakeScene, 0.03);
    bakeScene.remove(this.sky);
    parent?.add(this.sky);

    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = this.mood.environmentIntensity;
  }

  /**
   * Keeps the rim and the sky dome anchored to the camera. Directional lights do
   * not care where they sit, but the rim target must stay near the view or its
   * shadowless contribution drifts out of the frustum on very large maps.
   */
  followCamera(camera: THREE.Camera): void {
    const p = camera.position;
    this.rimTarget.position.set(p.x, 0, p.z);
    this.rim.position.copy(this.rimTarget.position).addScaledVector(this.rimDirection, 200);
    this.sky.position.set(p.x, 0, p.z);
  }

  dispose(): void {
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
  }
}
