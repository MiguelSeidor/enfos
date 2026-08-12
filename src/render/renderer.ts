/**
 * Render pipeline. Owner: RENDER agent.
 *
 * Pipeline stages, in order:
 *   scene → RenderPass → N8AO (GTAO) → SelectiveBloom → ToneMapping(ACES) → SMAA
 *
 * Lighting is physically based and driven by a procedurally generated sky IBL,
 * so materials sit in a consistent light rig without shipping any HDR asset.
 */

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
  BlendFunction,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import type { GameContext, GameModule, Vec2 } from '@/core/contracts';
import { RenderKey, type RenderService } from '@/core/services';
import { clamp, damp } from '@/core/mathx';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

interface QualitySettings {
  shadowMapSize: number;
  shadowDistance: number;
  pixelRatioCap: number;
  ao: boolean;
  aoQuality: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra';
  bloom: boolean;
  smaa: SMAAPreset;
  anisotropy: number;
}

const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    shadowMapSize: 1024,
    shadowDistance: 60,
    pixelRatioCap: 1,
    ao: false,
    aoQuality: 'Performance',
    bloom: true,
    smaa: SMAAPreset.LOW,
    anisotropy: 2,
  },
  medium: {
    shadowMapSize: 2048,
    shadowDistance: 90,
    pixelRatioCap: 1.25,
    ao: true,
    aoQuality: 'Low',
    bloom: true,
    smaa: SMAAPreset.MEDIUM,
    anisotropy: 4,
  },
  high: {
    shadowMapSize: 3072,
    shadowDistance: 120,
    pixelRatioCap: 1.5,
    ao: true,
    aoQuality: 'Medium',
    bloom: true,
    smaa: SMAAPreset.HIGH,
    anisotropy: 8,
  },
  ultra: {
    shadowMapSize: 4096,
    shadowDistance: 160,
    pixelRatioCap: 2,
    ao: true,
    aoQuality: 'High',
    bloom: true,
    smaa: SMAAPreset.ULTRA,
    anisotropy: 16,
  },
};

export class RenderModule implements GameModule {
  readonly id = 'render';
  readonly order = 900;

  private composer!: EffectComposer;
  private aoPass?: N8AOPostPass;
  private bloom!: BloomEffect;
  private sun!: THREE.DirectionalLight;
  private sky!: Sky;
  private pmrem!: THREE.PMREMGenerator;
  private envRT?: THREE.WebGLRenderTarget;
  private tier: QualityTier = 'high';
  private readonly sunTarget = new THREE.Object3D();
  private readonly projVec = new THREE.Vector3();
  /** Exposure is eased so wave transitions do not pop. */
  private targetExposure = 1;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
  ) {}

  init(ctx: GameContext): void {
    this.setupRenderer();
    this.setupSkyAndEnvironment();
    this.setupLights();
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
    r.setClearColor(0x0b1018, 1);
    // The composer runs several passes per frame and each would clear the
    // counters, leaving only the final fullscreen triangle. The engine resets
    // once per frame instead, so the numbers cover the whole pipeline.
    r.info.autoReset = false;
  }

  private setupSkyAndEnvironment(): void {
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    const u = this.sky.material.uniforms;
    // Late-afternoon fantasy key light: warm, long shadows, saturated horizon.
    u.turbidity.value = 4.2;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.82;

    const elevation = 24 * (Math.PI / 180);
    const azimuth = 128 * (Math.PI / 180);
    const sunDir = new THREE.Vector3(
      Math.cos(elevation) * Math.sin(azimuth),
      Math.sin(elevation),
      Math.cos(elevation) * Math.cos(azimuth),
    );
    u.sunPosition.value.copy(sunDir);
    this.scene.add(this.sky);

    this.refreshEnvironment();

    this.scene.fog = new THREE.FogExp2(0x8ea3bd, 0.0032);
  }

  /** Re-bakes the IBL from the current sky. Call after changing sky uniforms. */
  refreshEnvironment(): void {
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(this.sky as unknown as THREE.Scene, 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.85;
  }

  private setupLights(): void {
    const u = this.sky.material.uniforms;
    const sunDir = u.sunPosition.value as THREE.Vector3;

    this.sun = new THREE.DirectionalLight(0xffe8c4, 3.4);
    this.sun.position.copy(sunDir).multiplyScalar(120);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2.4;
    this.scene.add(this.sun);
    this.scene.add(this.sunTarget);
    this.sun.target = this.sunTarget;

    // Cool bounce from the sky opposite the key, keeps shadows readable.
    const fill = new THREE.HemisphereLight(0xa8c8ff, 0x30302a, 0.55);
    this.scene.add(fill);
  }

  private setupComposer(): void {
    this.composer = new EffectComposer(this.renderer, {
      frameBufferType: THREE.HalfFloatType,
      multisampling: 0,
    });
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.aoPass = new N8AOPostPass(
      this.scene,
      this.camera,
      window.innerWidth,
      window.innerHeight,
    );
    this.aoPass.configuration.aoRadius = 2.6;
    this.aoPass.configuration.distanceFalloff = 1.1;
    this.aoPass.configuration.intensity = 3.0;
    this.aoPass.configuration.color = new THREE.Color(0x0a0d14);
    this.aoPass.configuration.halfRes = true;
    this.composer.addPass(this.aoPass);

    this.bloom = new BloomEffect({
      intensity: 0.85,
      luminanceThreshold: 0.72,
      luminanceSmoothing: 0.28,
      mipmapBlur: true,
      radius: 0.72,
    });

    const tone = new ToneMappingEffect({
      mode: ToneMappingMode.AGX,
      resolution: 256,
      whitePoint: 6.0,
      middleGrey: 0.6,
    });

    const vignette = new VignetteEffect({
      blendFunction: BlendFunction.NORMAL,
      offset: 0.32,
      darkness: 0.42,
    });

    const smaa = new SMAAEffect({ preset: SMAAPreset.HIGH });

    this.composer.addPass(new EffectPass(this.camera, this.bloom, tone, vignette, smaa));
  }

  applyQuality(tier: QualityTier): void {
    this.tier = tier;
    const q = QUALITY[tier];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatioCap));
    this.sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;

    const cam = this.sun.shadow.camera;
    const half = q.shadowDistance * 0.5;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = q.shadowDistance * 3;
    cam.updateProjectionMatrix();

    if (this.aoPass) {
      this.aoPass.enabled = q.ao;
      this.aoPass.setQualityMode(q.aoQuality);
      this.aoPass.configuration.halfRes = tier === 'low' || tier === 'medium';
    }
    this.bloom.intensity = q.bloom ? 0.85 : 0;
  }

  /** Keeps the shadow frustum tight around the camera focus for crisp contact. */
  private followSun(): void {
    const focus = this.camera.position;
    this.sunTarget.position.set(focus.x, 0, focus.z);
    const dir = (this.sky.material.uniforms.sunPosition.value as THREE.Vector3);
    this.sun.position.set(
      focus.x + dir.x * 120,
      dir.y * 120,
      focus.z + dir.z * 120,
    );
  }

  update(dt: number): void {
    this.followSun();
    const exposure = damp(this.composer.getRenderer().toneMappingExposure ?? 1, this.targetExposure, 3, dt);
    this.renderer.toneMappingExposure = exposure;
  }

  setExposure(value: number): void {
    this.targetExposure = clamp(value, 0.2, 3);
  }

  render(_alpha: number, dt: number): void {
    this.composer.render(dt);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.aoPass?.setSize(width, height);
  }

  project(pos: Vec2, height: number, out: { x: number; y: number }): boolean {
    this.projVec.set(pos.x, height, pos.z).project(this.camera);
    out.x = (this.projVec.x * 0.5 + 0.5) * window.innerWidth;
    out.y = (-this.projVec.y * 0.5 + 0.5) * window.innerHeight;
    return this.projVec.z < 1;
  }

  dispose(): void {
    this.composer.dispose();
    this.envRT?.dispose();
    this.pmrem.dispose();
  }
}
