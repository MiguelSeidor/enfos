/**
 * Top-down / isometric RTS camera (GDD §17).
 *
 * Edge-scroll + WASD pan, wheel zoom on a curve that also pitches the camera,
 * middle-drag rotate, smooth follow, and a screen-shake channel driven by VFX.
 * All motion is exponentially damped so it stays smooth at any frame rate.
 */

import * as THREE from 'three';
import type { Vec2 } from '@/core/contracts';
import { clamp, damp, lerp, smoothstep, TAU } from '@/core/mathx';

export interface CameraLimits {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export class RtsCamera {
  readonly camera: THREE.PerspectiveCamera;
  /** Point on the ground plane the camera orbits. */
  readonly focus = new THREE.Vector3(0, 0, 0);

  private desiredFocus = new THREE.Vector3(0, 0, 0);
  private zoom = 0.55; // 0 = closest, 1 = farthest
  private desiredZoom = 0.55;
  private yaw = 0;
  private desiredYaw = 0;
  private shakeAmp = 0;
  private shakeTime = 0;
  private shakeDuration = 0;
  private followId: number | null = null;
  private readonly shakeOffset = new THREE.Vector3();
  private limits: CameraLimits = { minX: -120, maxX: 120, minZ: -120, maxZ: 120 };
  private heightSampler: ((x: number, z: number) => number) | null = null;

  // Zoom curve endpoints. Distance and pitch move together so the far view reads
  // as a classic RTS overview and the near view as a cinematic hero shot.
  private readonly nearDistance = 22;
  private readonly farDistance = 78;
  private readonly nearPitch = 38 * (Math.PI / 180);
  private readonly farPitch = 62 * (Math.PI / 180);

  panSpeed = 34;
  edgeScrollEnabled = true;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(48, aspect, 0.5, 2200);
    this.apply(0);
  }

  setLimits(limits: CameraLimits): void {
    this.limits = limits;
  }

  setHeightSampler(fn: (x: number, z: number) => number): void {
    this.heightSampler = fn;
  }

  setFocus(pos: Vec2, immediate = false): void {
    this.desiredFocus.set(pos.x, 0, pos.z);
    if (immediate) {
      this.focus.copy(this.desiredFocus);
      this.apply(0);
    }
  }

  pan(dx: number, dz: number, dt: number): void {
    // Pan in camera space so movement matches what the player sees when rotated.
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const speed = this.panSpeed * lerp(0.55, 1.7, this.zoom) * dt;
    this.desiredFocus.x += (dx * cos - dz * sin) * speed;
    this.desiredFocus.z += (dx * sin + dz * cos) * speed;
    this.clampFocus();
    this.followId = null;
  }

  zoomBy(delta: number): void {
    this.desiredZoom = clamp(this.desiredZoom + delta * 0.09, 0, 1);
  }

  rotateBy(delta: number): void {
    this.desiredYaw += delta;
  }

  follow(entityId: number | null): void {
    this.followId = entityId;
  }

  get following(): number | null {
    return this.followId;
  }

  /**
   * Snaps to an exact pose with no damping. Used by the headless capture
   * harness so successive review iterations differ only by the change under
   * review, never by where the smoothing happened to land.
   */
  poseImmediate(focus: Vec2, zoom: number, yaw: number): void {
    this.followId = null;
    this.desiredFocus.set(focus.x, 0, focus.z);
    this.focus.copy(this.desiredFocus);
    this.zoom = this.desiredZoom = clamp(zoom, 0, 1);
    this.yaw = this.desiredYaw = yaw;
    this.shakeAmp = 0;
    this.shakeDuration = 0;
    this.shakeOffset.set(0, 0, 0);
    this.apply(0);
  }

  shake(intensity: number, duration: number): void {
    // Take the stronger of the current and incoming shake so overlapping hits
    // do not stack into nausea.
    this.shakeAmp = Math.max(this.shakeAmp, intensity);
    this.shakeDuration = Math.max(this.shakeDuration, duration);
    this.shakeTime = 0;
  }

  private clampFocus(): void {
    this.desiredFocus.x = clamp(this.desiredFocus.x, this.limits.minX, this.limits.maxX);
    this.desiredFocus.z = clamp(this.desiredFocus.z, this.limits.minZ, this.limits.maxZ);
  }

  update(dt: number, followPos?: Vec2): void {
    if (this.followId !== null && followPos) {
      this.desiredFocus.set(followPos.x, 0, followPos.z);
      this.clampFocus();
    }

    this.focus.x = damp(this.focus.x, this.desiredFocus.x, 9, dt);
    this.focus.z = damp(this.focus.z, this.desiredFocus.z, 9, dt);
    this.zoom = damp(this.zoom, this.desiredZoom, 8, dt);
    this.yaw = damp(this.yaw, this.desiredYaw, 8, dt);

    if (this.shakeDuration > 0) {
      this.shakeTime += dt;
      const t = clamp(this.shakeTime / this.shakeDuration, 0, 1);
      const falloff = 1 - smoothstep(t);
      const amp = this.shakeAmp * falloff;
      // Two out-of-phase sinusoids read as an impact rather than a jitter.
      const f = this.shakeTime * 46;
      this.shakeOffset.set(
        Math.sin(f) * Math.sin(f * 0.37) * amp,
        Math.sin(f * 1.7) * amp * 0.6,
        Math.cos(f * 0.83) * amp,
      );
      if (t >= 1) {
        this.shakeDuration = 0;
        this.shakeAmp = 0;
        this.shakeOffset.set(0, 0, 0);
      }
    }

    this.apply(dt);
  }

  private apply(_dt: number): void {
    const t = smoothstep(this.zoom);
    const distance = lerp(this.nearDistance, this.farDistance, t);
    const pitch = lerp(this.nearPitch, this.farPitch, t);

    const groundY = this.heightSampler?.(this.focus.x, this.focus.z) ?? 0;
    const target = new THREE.Vector3(
      this.focus.x + this.shakeOffset.x * 0.35,
      groundY + this.shakeOffset.y * 0.35,
      this.focus.z + this.shakeOffset.z * 0.35,
    );

    const horizontal = Math.cos(pitch) * distance;
    const vertical = Math.sin(pitch) * distance;
    this.camera.position.set(
      target.x + Math.sin(this.yaw) * horizontal + this.shakeOffset.x,
      target.y + vertical + this.shakeOffset.y,
      target.z + Math.cos(this.yaw) * horizontal + this.shakeOffset.z,
    );
    this.camera.lookAt(target);
    // Zoom-dependent FOV adds a subtle sense of scale at max zoom-out.
    const fov = lerp(44, 50, t);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  get zoomLevel(): number {
    return this.zoom;
  }

  get yawAngle(): number {
    return ((this.yaw % TAU) + TAU) % TAU;
  }
}
