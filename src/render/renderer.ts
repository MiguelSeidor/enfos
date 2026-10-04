/**
 * Render pipeline. Owner: RENDER agent.
 *
 * ## Pass order, and why it is this order
 *
 * ```
 *  0  RenderPass          scene -> linear HDR (half float)
 *  1  N8AOPostPass        GTAO, multiplied into the beauty buffer
 *  2  EffectPass          AtmosphereEffect -> SceneGradeEffect        (still linear HDR)
 *  3  EffectPass          Bloom -> HighlightShoulder -> ToneMapping(ACES)
 *                                -> FilmGrade -> Vignette              (-> LDR)
 *  4  EffectPass          SMAA
 *  5  EffectPass          Sharpen
 * ```
 *
 * The splits are not arbitrary. `postprocessing` merges the effects inside one
 * `EffectPass` into a single shader, chaining each effect's output into the next
 * — but only for effects that read the running colour. Bloom, SMAA and Sharpen
 * each sample `inputBuffer` themselves, so they see the pass *input*, not the
 * running colour. Putting all six effects in one pass, as the v0 baseline did,
 * meant SMAA was blending raw pre-tone-map HDR texels back over the graded
 * image along every edge, and bloom was thresholding un-exposed values. Each of
 * those three effects therefore gets a pass boundary in front of it.
 *
 * Scene-linear grading happens in pass 2 so that pass 3's bloom threshold is
 * expressed in the same exposed units the tone curve will see.
 *
 * `HighlightShoulder` is inside pass 3 rather than pass 2 for the same reason in
 * reverse: it expands the top of the range so lit metal and emitters climb the
 * ACES shoulder, and doing that upstream of the bloom threshold would push the
 * building emissives — which `world/structures.ts` parks just under 1.05 on
 * purpose — over the line and smear them. After bloom, the threshold still sees
 * the un-expanded value. See effects/shoulder.ts.
 *
 * ## Budget
 *
 * Target is a GTX 970 at 1920x1080: <= 14 ms GPU, <= 700 draw calls. Four
 * fullscreen effect passes cost roughly 1.2 ms of that at native resolution,
 * which is the price of getting the colour pipeline correct.
 */

import * as THREE from 'three';
import {
  BloomEffect,
  BlendFunction,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { GameContext, GameModule, Vec2 } from '@/core/contracts';
import { RenderKey, type RenderService } from '@/core/services';
import { clamp, damp } from '@/core/mathx';
import { LightRig, MOOD_AMBER_STORM, type MoodPreset } from './lighting';
import { FittedShadow } from './shadows';
import { AtmosphereEffect } from './effects/atmosphere';
import { FilmGradeEffect, SceneGradeEffect } from './effects/grade';
import { HighlightShoulderEffect } from './effects/shoulder';
import { SharpenEffect } from './effects/sharpen';
import { OpaqueOutputEffect } from './effects/opaque';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

interface QualitySettings {
  shadowMapSize: number;
  /** Furthest distance from the camera at which shadows are still resolved. */
  shadowRange: number;
  pixelRatioCap: number;
  ao: boolean;
  aoQuality: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra';
  aoHalfRes: boolean;
  bloom: boolean;
  smaa: SMAAPreset;
  /** 0 disables the sharpen pass entirely. */
  sharpen: number;
  anisotropy: number;
}

const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    shadowMapSize: 1024,
    shadowRange: 90,
    pixelRatioCap: 1,
    ao: false,
    aoQuality: 'Performance',
    aoHalfRes: true,
    bloom: false,
    smaa: SMAAPreset.LOW,
    sharpen: 0,
    anisotropy: 1,
  },
  medium: {
    shadowMapSize: 2048,
    shadowRange: 130,
    pixelRatioCap: 1,
    ao: true,
    aoQuality: 'Low',
    aoHalfRes: true,
    bloom: true,
    smaa: SMAAPreset.MEDIUM,
    sharpen: 0.35,
    anisotropy: 4,
  },
  high: {
    shadowMapSize: 3072,
    shadowRange: 160,
    pixelRatioCap: 1.25,
    ao: true,
    aoQuality: 'Medium',
    aoHalfRes: false,
    bloom: true,
    smaa: SMAAPreset.HIGH,
    sharpen: 0.5,
    anisotropy: 8,
  },
  ultra: {
    shadowMapSize: 4096,
    shadowRange: 200,
    pixelRatioCap: 1.5,
    ao: true,
    aoQuality: 'High',
    aoHalfRes: false,
    bloom: true,
    smaa: SMAAPreset.ULTRA,
    sharpen: 0.55,
    anisotropy: 16,
  },
};

/**
 * Hard ceiling on the render scale, whatever tier is selected.
 *
 * A phone reports `devicePixelRatio` 3 or 4, and this pipeline runs five
 * fullscreen passes: at native density that is four times the fill cost of a
 * desktop frame on a tenth of the hardware, which is a slideshow. Two is the
 * point past which no one can see the difference at arm's length anyway, so it
 * is the ceiling here and every tier cap is read through it.
 */
const MAX_PIXEL_RATIO = 2;

/**
 * True where the primary pointer cannot hover: phones, tablets, anything driven
 * by fingers. Used for defaults only - nothing about input behaviour is decided
 * from it, since a laptop with a touchscreen has both.
 */
export function isCoarsePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/**
 * Quality tier to boot with on this device.
 *
 * Desktop keeps `high`, unchanged. A touch device starts lower because the
 * expensive parts of the frame are the ones it can least afford and least
 * shows off: AO and bloom are fill-rate bound, and at phone size the frame is
 * too small for either to read. The options screen overrides this and the
 * override is what persists, so this is only the first-run guess.
 */
export function defaultQualityTier(): QualityTier {
  if (!isCoarsePointer()) return 'high';
  // Tablets have the screen area and usually the thermal headroom for the
  // middle tier; a phone-sized viewport gets the cheap one.
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  return shortSide < 600 ? 'low' : 'medium';
}

/** Material texture slots worth an anisotropic sampler. */
const ANISOTROPIC_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'bumpMap',
  'alphaMap',
  'displacementMap',
] as const;

export class RenderModule implements GameModule {
  readonly id = 'render';
  readonly order = 900;

  private composer!: EffectComposer;
  private aoPass?: N8AOPostPass;
  private bloom!: BloomEffect;
  private smaa!: SMAAEffect;
  private sharpen!: SharpenEffect;
  private sharpenPass!: EffectPass;
  private atmosphere!: AtmosphereEffect;
  private sceneGrade!: SceneGradeEffect;
  private shoulder!: HighlightShoulderEffect;
  private filmGrade!: FilmGradeEffect;
  private lights!: LightRig;
  private shadow!: FittedShadow;

  private tier: QualityTier = defaultQualityTier();
  private mood: MoodPreset = MOOD_AMBER_STORM;
  private readonly projVec = new THREE.Vector3();
  private width = 1920;
  private height = 1080;
  /** Exposure is eased so wave transitions and ability flashes do not pop. */
  private targetExposure = MOOD_AMBER_STORM.grade.exposure;
  private currentExposure = MOOD_AMBER_STORM.grade.exposure;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {
    // Set before any other module's init() runs, so every procedurally generated
    // texture is created with the tier's anisotropy already applied. This is the
    // only hook that reaches textures owned by other folders without touching
    // their code.
    THREE.Texture.DEFAULT_ANISOTROPY = Math.min(
      QUALITY[this.tier].anisotropy,
      renderer.capabilities.getMaxAnisotropy(),
    );
  }

  init(ctx: GameContext): void {
    this.width = Math.max(1, this.renderer.domElement.width);
    this.height = Math.max(1, this.renderer.domElement.height);

    this.setupRenderer();
    this.lights = new LightRig(this.scene, this.renderer, this.mood);
    this.shadow = new FittedShadow(this.lights.key);
    this.setupComposer();
    this.applyQuality(this.tier);

    const self = this;
    const service: RenderService = {
      scene: this.scene,
      camera: this.camera,
      setQuality: (tier) => this.applyQuality(tier),
      get quality(): QualityTier {
        return self.tier;
      },
      resize: (w, h) => this.resize(w, h),
      render: (alpha, dt) => this.render(alpha, dt),
      project: (pos, height, out) => this.project(pos, height, out),
    };
    ctx.services.register(RenderKey, service);
  }

  private setupRenderer(): void {
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping; // handled in the composer for HDR fidelity
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setClearColor(0x0a0f16, 1);
    // The composer runs several passes per frame and each would clear the
    // counters, leaving only the final fullscreen triangle. The engine resets
    // once per frame instead, so the numbers cover the whole pipeline.
    r.info.autoReset = false;

    // Aerial perspective is a post-process now: it needs depth, height and a view
    // direction, none of which FogExp2 has. Leaving scene.fog set would tint
    // everything a second time.
    this.scene.fog = null;
  }

  private setupComposer(): void {
    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.aoPass = new N8AOPostPass(this.scene, this.camera, this.width, this.height);
    this.aoPass.configuration.aoRadius = 3.2;
    this.aoPass.configuration.distanceFalloff = 1.4;
    this.aoPass.configuration.intensity = 2.6;
    this.aoPass.configuration.denoiseSamples = 8;
    this.aoPass.configuration.denoiseRadius = 12;
    // Occlusion tinted toward the shadow colour rather than pure black, so
    // creases pick up the same cool cast as cast shadows do.
    this.aoPass.configuration.color = new THREE.Color(0x0d1420);
    this.composer.addPass(this.aoPass);

    // ── Pass 2: still scene-linear HDR ──
    this.atmosphere = new AtmosphereEffect(this.camera, this.mood.atmosphere);
    this.atmosphere.setSunDirection(this.lights.sunDirection);
    this.sceneGrade = new SceneGradeEffect();
    this.sceneGrade.apply(this.mood.grade);
    this.composer.addPass(new EffectPass(this.camera, this.atmosphere, this.sceneGrade));

    // ── Pass 3: HDR -> display ──
    // The threshold is above 1.0 on purpose. After the scene grade, a lit surface
    // tops out near 1.0; only genuine emitters exceed it. That makes this an
    // emissive-only bloom without needing a selection list of objects owned by
    // other subsystems, and it is why the frame does not smear.
    // Intensity pulled back from 0.85. The threshold is unchanged and must stay
    // unchanged — world/structures.ts tunes its emissives against 1.05 — but at
    // 0.85 anything that did cross it threw a halo wide enough to swallow the
    // hero's helmet, which is bloom being used as a smear rather than as an
    // accent. Lower intensity keeps the emitters reading as emitters and gives
    // the silhouette its edge back.
    this.bloom = new BloomEffect({
      intensity: 0.55,
      luminanceThreshold: 1.05,
      luminanceSmoothing: 0.1,
      mipmapBlur: true,
      radius: 0.55,
      levels: 5,
    });

    // Must stay between bloom and the tone map. See the header and shoulder.ts.
    this.shoulder = new HighlightShoulderEffect(this.mood.grade.shoulder);

    const tone = new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });

    this.filmGrade = new FilmGradeEffect();
    this.filmGrade.apply(this.mood.grade);

    // Reach, not depth, was the problem with the previous 0.32/0.62. The effect
    // multiplies by `smoothstep(0.8, offset * 0.799, d * (darkness + offset))`,
    // which held full brightness only inside d = 0.27 and had already dimmed the
    // frame edges to 0.66x and the corners to 0.15x. On a top-down camera the
    // subject is spread across the whole frame rather than centred, so that was
    // not a vignette, it was a 60% crop with a soft edge — and it was destroying
    // the highlights it happened to land on. The `junction` shot's only sunlit
    // ground sits low-left, and it could not cross 90% luminance because the
    // vignette was taking a third of it back.
    //
    // These numbers hold full brightness out to d = 0.46, leave the frame edges
    // at 0.97x, and still close the true corners down to 0.29x.
    const vignette = new VignetteEffect({
      blendFunction: BlendFunction.NORMAL,
      offset: 0.55,
      darkness: 0.4,
    });

    this.composer.addPass(
      new EffectPass(this.camera, this.bloom, this.shoulder, tone, this.filmGrade, vignette),
    );

    // ── Pass 4: AA on the finished LDR image ──
    // TAA was evaluated and rejected: this camera is damped rather than snapped,
    // so it is in near-continuous sub-pixel motion, and unit meshes are
    // instanced with per-frame transforms and no velocity buffer. Reprojection
    // would ghost every moving unit against a static ground — exactly the case
    // TAA handles worst — to fix shimmer that SMAA plus the fitted shadow snap
    // already remove.
    this.smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });
    this.composer.addPass(new EffectPass(this.camera, this.smaa));

    // ── Pass 5: recover the detail SMAA softened ──
    this.sharpen = new SharpenEffect(QUALITY[this.tier].sharpen);
    this.sharpenPass = new EffectPass(this.camera, this.sharpen);
    this.composer.addPass(this.sharpenPass);

    // ── Pass 6: opaque output ──
    // Must be last and must never be disabled. Two reasons:
    //  1. Nothing upstream writes alpha, so the chain hands the default
    //     framebuffer a fully transparent image (see effects/opaque.ts).
    //  2. EffectComposer marks the *last pass in the list* as renderToScreen
    //     whether or not it is enabled. The sharpen pass above turns itself off
    //     on the low tier, which would leave nothing presenting to the screen.
    // A permanently enabled terminal pass fixes both.
    this.composer.addPass(new EffectPass(this.camera, new OpaqueOutputEffect()));
  }

  applyQuality(tier: QualityTier): void {
    this.tier = tier;
    const q = QUALITY[tier];

    const ratioBefore = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, q.pixelRatioCap, MAX_PIXEL_RATIO),
    );
    // Changing the pixel ratio resizes the canvas drawing buffer, and the
    // composer's buffers do not follow on their own: they were allocated at the
    // drawing buffer size in effect the last time anything called `resize`.
    // Compositing a 2000x1125 buffer onto a 2400x1350 canvas draws the entire
    // scene at the wrong scale, which reads as a second copy of every object
    // offset to one side -- creeps, buildings, the Core, all of it. Only the
    // tier whose cap happens to match the allocation looks correct, so on one
    // machine the clean tier is low and on another it is high, and it got
    // blamed on whichever character was added most recently.
    //
    // Each tier caps the ratio differently, so this fires on every tier change
    // on any display with scaling, and `resize` is where sizing lives.
    if (this.renderer.getPixelRatio() !== ratioBefore) this.resize(this.width, this.height);
    this.shadow.configure(q.shadowMapSize, q.shadowRange);
    this.applyAnisotropy(q.anisotropy);

    if (this.aoPass) {
      this.aoPass.enabled = q.ao;
      this.aoPass.setQualityMode(q.aoQuality);
      this.aoPass.configuration.halfRes = q.aoHalfRes;
    }

    // BlendFunction.DST makes the EffectPass drop the effect from the merged
    // shader entirely rather than run it and discard the result, so disabling
    // bloom actually removes its cost.
    this.bloom.blendMode.blendFunction = q.bloom ? BlendFunction.SCREEN : BlendFunction.DST;

    this.smaa.applyPreset(q.smaa);

    this.sharpen.amount = q.sharpen;
    this.sharpenPass.enabled = q.sharpen > 0;
  }

  private applyAnisotropy(level: number): void {
    const value = Math.min(level, this.renderer.capabilities.getMaxAnisotropy());
    THREE.Texture.DEFAULT_ANISOTROPY = value;
    const seen = new Set<THREE.Texture>();
    this.scene.traverse((obj) => {
      const material = (obj as THREE.Mesh).material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      for (const m of list) {
        const record = m as unknown as Record<string, unknown>;
        for (const slot of ANISOTROPIC_SLOTS) {
          const tex = record[slot];
          if (!(tex instanceof THREE.Texture) || seen.has(tex)) continue;
          seen.add(tex);
          if (tex.anisotropy === value) continue;
          tex.anisotropy = value;
          tex.needsUpdate = true;
        }
      }
    });
  }

  setMood(mood: MoodPreset): void {
    this.mood = mood;
    this.lights.applyMood(mood);
    this.atmosphere.apply(mood.atmosphere);
    this.atmosphere.setSunDirection(this.lights.sunDirection);
    this.sceneGrade.apply(mood.grade);
    this.shoulder.apply(mood.grade.shoulder);
    this.filmGrade.apply(mood.grade);
    this.targetExposure = mood.grade.exposure;
    this.currentExposure = mood.grade.exposure;
  }

  update(dt: number): void {
    this.lights.followCamera(this.camera);
    this.camera.updateMatrixWorld();
    this.shadow.update(this.camera, this.lights.sunDirection);

    this.currentExposure = damp(this.currentExposure, this.targetExposure, 3, dt);
    this.sceneGrade.exposure = this.currentExposure;
  }

  /** Scene-linear exposure multiplier. Eased over ~1/3 s. */
  setExposure(value: number): void {
    this.targetExposure = clamp(value, 0.2, 12);
  }

  render(_alpha: number, dt: number): void {
    // EffectComposer sets `autoClear = false` in its constructor, on the
    // assumption that every pass clears its own output. N8AOPostPass is a
    // third-party pass and does not: it blends into whatever the target already
    // holds, so with clearing disabled the occlusion term re-applies to the
    // previous frame's result and the image saturates to white within a second.
    //
    // This was invisible for a long time because the headless capture harness
    // screenshots after a fixed settle and the bug is frame-order dependent, so
    // captures kept coming back correct while a normal window went white. Forcing
    // the clear back on each frame is safe — every other pass draws a fullscreen
    // triangle that covers the target completely.
    this.renderer.autoClear = true;
    this.composer.render(dt);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.aoPass?.setSize(width, height);
  }

  project(pos: Vec2, height: number, out: { x: number; y: number }): boolean {
    this.projVec.set(pos.x, height, pos.z).project(this.camera);
    out.x = (this.projVec.x * 0.5 + 0.5) * this.width;
    out.y = (-this.projVec.y * 0.5 + 0.5) * this.height;
    return this.projVec.z < 1;
  }

  /** Diagnostics for the QA harness: how fine the shadow map currently is. */
  get shadowTexelSize(): number {
    return this.shadow.texelWorldSize;
  }

  dispose(): void {
    this.composer.dispose();
    this.lights.dispose();
  }
}
