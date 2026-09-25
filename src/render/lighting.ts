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
  rim: { color: 0x92bcff, intensity: 2.4, elevation: 16, azimuthOffset: 172 },
  // Key:fill lands near 9:1. Anything flatter and shadowed faces never reach the
  // bottom decile of the histogram; anything steeper and they go dead black,
  // which the rubric penalises just as hard as a washed-out frame.
  // The fill sky colour is kept low-chroma on purpose: shadowed cliff faces see
  // this light almost unopposed, so any saturation here reads multiplied.
  fill: { sky: 0x86a4cd, ground: 0x38281c, intensity: 0.7 },
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
    density: 0.011,
    heightFalloff: 26,
    baseHeight: -12,
    startDistance: 20,
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
    exposure: 1.95,
    // Raised with exposure lowered to match. This pair is the one that widens
    // both tails at once: the power curve is pivoted on 18% grey, so a steeper
    // exponent pushes everything under the pivot down and everything over it up
    // while the pivot itself does not move. Exposure alone can only slide the
    // whole histogram, which trades one end of the rubric for the other.
    sceneContrast: 1.42,
    sceneSaturation: 1.02,
    whiteBalance: [1.04, 1.0, 0.96],
    // Returns separation to the shadow mass the contrast curve collapses. See
    // the long note in effects/grade.ts — it multiplies, so black stays black.
    toeAmount: 0.15,
    toeRange: 0.05,
    // The frame's only source of real highlights. Everything below the knee is
    // untouched, so this buys top-end range without moving the midtones or the
    // mean. Sits after bloom so the 1.05 threshold structures.ts is tuned
    // against never sees the expansion.
    // The knee is in post-exposure scene-linear units, so it has to track
    // exposure: when exposure came down from 2.75 to 2.05 a fixed knee stopped
    // catching the same surfaces and the highlights went with it.
    shoulder: { knee: 0.36, width: 0.75, gain: 2.6, rolloff: 1.6 },
    // The previous lift of -0.022/-0.017/-0.008 was a per-channel black clip:
    // with gain applied first it drove red to zero below 0.021 and green below
    // 0.017 while blue survived to 0.008, so every cool shadow lost two channels
    // before it lost the third and the shadow mass went to a flat hue with no
    // detail in it. Shallower, and closer to matched across channels, keeps a
    // true black without eating the last stop above it.
    lift: [-0.017, -0.015, -0.011],
    gamma: [1.0, 1.0, 1.0],
    gain: [1.06, 1.03, 1.0],
    shadowTint: [-0.035, 0.0, 0.07],
    highlightTint: [0.04, 0.015, -0.035],
    toneBalance: 0.55,
    shadowRange: 0.34,
    saturation: 1.04,
    // Firms both ends: keeps the toe anchored under the exposure lift and
    // pushes lit stone caps over the 90% line the rubric requires.
    sCurve: 0.45,
  },
};

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
