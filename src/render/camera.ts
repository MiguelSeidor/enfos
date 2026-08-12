/**
 * Top-down / isometric RTS camera (GDD §17). Owner: RENDER agent.
 *
 * Edge-scroll + WASD pan, wheel zoom on a curve that also pitches the camera,
 * middle-drag rotate, smooth follow, and a screen-shake channel driven by VFX.
 * All motion is exponentially damped so it stays smooth at any frame rate.
 *
 * ## The zoom curve
 *
 * Distance is **geometric**, not linear: `d = near * (far/near)^t`. A linear
 * distance ramp is the classic RTS camera mistake — every wheel notch moves the
 * camera the same number of world units, so near the ground a notch is a violent
 * lurch and up at overview height the same notch does almost nothing. Geometric
 * spacing makes every notch the same *proportional* change (~18% here), which is
 * what the eye actually reads as a uniform zoom step.
 *
 * Pitch and focal length ride along with it:
 *
 * | | close (t=0) | far (t=1) |
 * | --- | --- | --- |
 * | distance | 17 u | 105 u |
 * | pitch | 33° | 56° |
 * | fov | 36° | 46° |
 *
 * Pitching up as you zoom out is what separates a tactical overview from a
 * cinematic hero shot. The focal length moves the opposite way to the pitch: a
 * longer lens (narrower fov) at hero distance compresses depth and flatters
 * character silhouettes, a wider one at overview restores peripheral awareness.
 * Pitch is eased with a smoothstep so it settles gently at both extremes while
 * distance keeps its uniform notch feel.
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
  private readonly target = new THREE.Vector3();
  private limits: CameraLimits = { minX: -120, maxX: 120, minZ: -120, maxZ: 120 };
  private heightSampler: ((x: number, z: number) => number) | null = null;

  // Zoom curve endpoints. See the class comment for why distance is geometric.
  private readonly nearDistance = 17;
  private readonly farDistance = 105;
  private readonly nearPitch = 33 * (Math.PI / 180);
  private readonly farPitch = 56 * (Math.PI / 180);
  private readonly nearFov = 36;
  private readonly farFov = 46;
  private readonly distanceRatio = this.farDistance / this.nearDistance;
  /** Minimum height the eye keeps above whatever terrain is under it. */
  private readonly clearance = 4;

  panSpeed = 0.85;
  edgeScrollEnabled = true;

  constructor(aspect: number) {
    // near/far are tight around the actual play volume. The v0 range of
    // 0.5..2200 spent depth precision on space nothing occupies, which shows up
    // as noise in the AO and the depth-reconstructed fog. Sky.js forces its own
    // fragments to the far plane, so it is unaffected by the shorter far.
    this.camera = new THREE.PerspectiveCamera(this.nearFov, aspect, 1, 1400);
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
    // Pan in camera space so movement matches what the player sees when rotated,
    // and scale by eye distance so the on-screen pan rate is constant regardless
    // of zoom.
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const speed = this.panSpeed * this.distanceAt(this.zoom) * dt;
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

  private distanceAt(t: number): number {
    return this.nearDistance * Math.pow(this.distanceRatio, t);
  }

  update(dt: number, followPos?: Vec2): void {
    if (this.followId !== null && followPos) {
      this.desiredFocus.set(followPos.x, 0, followPos.z);
      this.clampFocus();
    }

    this.focus.x = damp(this.focus.x, this.desiredFocus.x, 9, dt);
    this.focus.z = damp(this.focus.z, this.desiredFocus.z, 9, dt);
    // Zoom settles faster than it pans; a sluggish wheel is the most common
    // complaint about a damped RTS camera.
    this.zoom = damp(this.zoom, this.desiredZoom, 12, dt);
    this.yaw = damp(this.yaw, this.desiredYaw, 10, dt);

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
    const t = this.zoom;
    const distance = this.distanceAt(t);
    const pitch = lerp(this.nearPitch, this.farPitch, smoothstep(t));

    const groundY = this.heightSampler?.(this.focus.x, this.focus.z) ?? 0;
    this.target.set(
      this.focus.x + this.shakeOffset.x * 0.35,
      groundY + this.shakeOffset.y * 0.35,
      this.focus.z + this.shakeOffset.z * 0.35,
    );

    const horizontal = Math.cos(pitch) * distance;
    const vertical = Math.sin(pitch) * distance;
    const px = this.target.x + Math.sin(this.yaw) * horizontal + this.shakeOffset.x;
    const pz = this.target.z + Math.cos(this.yaw) * horizontal + this.shakeOffset.z;
    let py = this.target.y + vertical + this.shakeOffset.y;

    // Never let the eye sink into a cliff behind the focus point. Raising it
    // steepens the shot slightly, which is the correct failure mode — the
    // alternative is a frame of solid rock.
    const under = this.heightSampler?.(px, pz);
    if (under !== undefined && py < under + this.clearance) py = under + this.clearance;

    this.camera.position.set(px, py, pz);
    this.camera.lookAt(this.target);

    const fov = lerp(this.nearFov, this.farFov, t);
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

  /** Eye-to-focus distance in world units. Used by the shadow fit and by VFX LOD. */
  get eyeDistance(): number {
    return this.distanceAt(this.zoom);
  }
}
