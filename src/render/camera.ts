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

/** Scratch vectors for pan basis extraction; reused to keep panning allocation-free. */
const PAN_RIGHT = new THREE.Vector3();
const PAN_FORWARD = new THREE.Vector3();

/**
 * Per-millisecond velocity decay for the flick glide.
 *
 * 0.998 is the constant every touch platform converged on, and the reason is
 * arithmetic rather than taste: the total distance a flick still has left to
 * travel is `v/1000 * d/(1-d)`, which at 0.998 is half a second of the release
 * velocity. Lower and the camera stops dead under the finger, which reads as
 * the view being yanked out of the player's hand; higher and a small flick
 * sails across the whole map.
 */
const GLIDE_DECAY = 0.998;

/** Release velocity below which the glide has visibly stopped (world units/s). */
const GLIDE_EPSILON = 0.05;

/**
 * Window of pointer history the release velocity is measured over.
 *
 * Short enough that only the end of the gesture counts - a player who drags
 * slowly across the map and then flicks expects the flick, not the average.
 */
const VELOCITY_WINDOW_MS = 120;

/**
 * How stale the last movement may be and still count as a throw. Past this the
 * finger was parked, so the player is placing the view rather than throwing it
 * and the camera must stay exactly where they left it.
 */
const VELOCITY_STALE_MS = 70;

/** Resistance constant of the rubber band past the pan limits. */
const RUBBER_BAND = 0.55;

/**
 * Resistance past the pan limits, the same curve scroll views have used since
 * the first iPhone: `overshoot * span * c / (span + c * |overshoot|)`. The
 * further it is pulled the less it gives, and however hard it is pulled it can
 * never travel more than `span` - one screen of give - so the map is always
 * still on screen to spring back from.
 *
 * `span` is the visible ground span rather than the size of the map: the give
 * has to feel like a fraction of what the player can see, and a fixed number of
 * metres would be an imperceptible nudge zoomed out and a lurch zoomed in.
 */
function rubberBand(overshoot: number, span: number): number {
  return (overshoot * span * RUBBER_BAND) / (span + RUBBER_BAND * Math.abs(overshoot));
}

/** One axis of the banded focus: linear inside the limits, resisted outside. */
function bandAxis(raw: number, min: number, max: number, span: number): number {
  if (raw < min) return min + rubberBand(raw - min, span);
  if (raw > max) return max + rubberBand(raw - max, span);
  return raw;
}

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

  /**
   * Touch drag state.
   *
   * `dragRaw` is where the finger has actually dragged the focus to, limits
   * ignored; `focus` is that value put through the rubber band. Keeping the two
   * apart is what makes the band work at all: clamping in place would lose how
   * far past the edge the player pulled, so there would be nothing to spring
   * back from and the drag would feel like it hit a wall.
   */
  private dragRawX = 0;
  private dragRawZ = 0;
  private dragActive = false;
  private gliding = false;
  private glideVx = 0;
  private glideVz = 0;
  /** Recent focus positions with timestamps; the flick velocity is fitted to these. */
  private readonly dragSamples: { x: number; z: number; t: number }[] = [];

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
    // A seek is an instruction about where to look; a glide still running would
    // carry the view straight off the point that was asked for.
    this.cancelMomentum();
    this.desiredFocus.set(pos.x, 0, pos.z);
    if (immediate) {
      this.focus.copy(this.desiredFocus);
      this.apply(0);
    }
  }

  /**
   * Pans in screen space. `dx` is right on screen; `dz` follows the WASD
   * convention where **negative is up** (W sends -1), i.e. positive `dz` moves
   * the focus toward the viewer.
   *
   * The basis comes from the camera's own world matrix rather than from
   * `this.yaw`. Deriving it from the yaw angle means the pan direction is only
   * correct while that angle agrees with the matrix actually used to render —
   * and any path that moves the camera without going through the yaw (a pose
   * snap, a shake, an interrupted damp) silently rotates the controls away from
   * what the player sees. Reading the matrix cannot drift: it is the same
   * transform the frame was drawn with.
   *
   * Speed scales with eye distance so the on-screen pan rate is constant at
   * every zoom level.
   */
  pan(dx: number, dz: number, dt: number): void {
    // Keyboard or edge scroll takes the camera over from a flick still coasting.
    this.cancelMomentum();
    this.camera.updateMatrixWorld();
    // Column 0 is screen-right. Flatten to the ground plane and renormalise, so
    // the pitch of the camera does not shorten horizontal movement.
    PAN_RIGHT.setFromMatrixColumn(this.camera.matrixWorld, 0);
    PAN_RIGHT.y = 0;
    PAN_RIGHT.normalize();
    // Column 2 is the camera's backward axis, so flattened it is "toward the
    // viewer" on the ground — which is exactly what positive dz means here.
    PAN_FORWARD.setFromMatrixColumn(this.camera.matrixWorld, 2);
    PAN_FORWARD.y = 0;
    PAN_FORWARD.normalize();

    const speed = this.panSpeed * this.distanceAt(this.zoom) * dt;
    this.desiredFocus.x += (PAN_RIGHT.x * dx + PAN_FORWARD.x * dz) * speed;
    this.desiredFocus.z += (PAN_RIGHT.z * dx + PAN_FORWARD.z * dz) * speed;
    this.clampFocus();
    this.followId = null;
  }

  /**
   * Drags the focus by an exact world-space delta, with no damping and with
   * resistance past the limits. This is the touch pan: the caller works out how
   * far the ground under the finger has moved and hands that over, so the point
   * the player grabbed stays under their finger instead of drifting at some
   * speed the camera chose.
   *
   * Damping is deliberately skipped. A damped drag lags the finger by the
   * damping constant, and at 1:1 tracking that lag is the whole difference
   * between moving a map and asking a camera to please follow along.
   */
  dragBy(dx: number, dz: number): void {
    if (!this.dragActive) this.beginDrag();
    this.dragRawX += dx;
    this.dragRawZ += dz;
    this.applyDragFocus();
    this.pushDragSample();
    // The caller raycasts against this pose to work out the next delta, so it
    // has to reflect the move that just happened or the next one double-counts.
    this.syncPose();
  }

  /** Starts a drag from wherever the camera is now, cancelling any glide in flight. */
  beginDrag(): void {
    this.cancelMomentum();
    // A drag is a deliberate look somewhere else, exactly like an edge scroll.
    this.followId = null;
    this.dragActive = true;
    this.dragRawX = this.focus.x;
    this.dragRawZ = this.focus.z;
    this.dragSamples.length = 0;
    this.pushDragSample();
  }

  /**
   * Ends a drag and throws the camera with whatever velocity the finger left.
   *
   * `momentum: false` drops the glide entirely (a pinch ends this way: two
   * fingers lifting at slightly different moments would otherwise fling the
   * view). `instant: true` is the reduced-motion path, where the glide becomes
   * a jump straight to the resting point.
   */
  endDrag(opts: { momentum?: boolean; instant?: boolean } = {}): void {
    if (!this.dragActive) return;
    this.dragActive = false;
    const v = opts.momentum === false ? { x: 0, z: 0 } : this.releaseVelocity();
    this.glideVx = v.x;
    this.glideVz = v.z;
    this.gliding = true;
    if (!opts.instant) return;
    const rest = this.projectedRest();
    this.dragRawX = clamp(rest.x, this.limits.minX, this.limits.maxX);
    this.dragRawZ = clamp(rest.z, this.limits.minZ, this.limits.maxZ);
    this.glideVx = 0;
    this.glideVz = 0;
    this.gliding = false;
    this.applyDragFocus();
    this.syncPose();
  }

  /**
   * Where the current glide comes to rest: `current + (v/1000) * d/(1-d)`, the
   * closed form of the decay in `stepGlide`. Computed rather than simulated so
   * the reduced-motion path can land on the same point the animation would have
   * reached, and so tests can assert the destination without waiting for it.
   */
  projectedRest(): { x: number; z: number } {
    const reach = GLIDE_DECAY / (1 - GLIDE_DECAY) / 1000;
    return { x: this.dragRawX + this.glideVx * reach, z: this.dragRawZ + this.glideVz * reach };
  }

  /** True while a flick is still coasting. Read by tests and by the HUD. */
  get glideActive(): boolean {
    return this.gliding;
  }

  /** Drops any glide in flight, so a keyboard pan or a seek is not fought by it. */
  cancelMomentum(): void {
    this.gliding = false;
    this.glideVx = 0;
    this.glideVz = 0;
  }

  zoomBy(delta: number): void {
    this.cancelMomentum();
    this.desiredZoom = clamp(this.desiredZoom + delta * 0.09, 0, 1);
  }

  /**
   * Pinch zoom, by the factor the gap between the fingers grew by.
   *
   * Distance is geometric (see the class comment), so the zoom parameter has to
   * move by the *log* of that factor: spreading the fingers to twice the gap
   * then halves the eye distance at every zoom level, which is the only
   * behaviour that keeps a pinch feeling like it is holding the ground.
   *
   * Applied to `zoom` as well as `desiredZoom` because a pinch is direct
   * manipulation: the 12/s damp that smooths a wheel notch would read here as
   * the world sliding out from under the fingers.
   */
  zoomByRatio(ratio: number): void {
    if (!(ratio > 0)) return;
    const delta = -Math.log(ratio) / Math.log(this.distanceRatio);
    this.zoom = this.desiredZoom = clamp(this.desiredZoom + delta, 0, 1);
  }

  /**
   * Rotates the camera. `immediate` skips the damp, for a twist gesture where
   * the world has to track the fingers; the mouse path leaves it off and keeps
   * the smoothing.
   */
  rotateBy(delta: number, immediate = false): void {
    this.desiredYaw += delta;
    if (immediate) this.yaw = this.desiredYaw;
  }

  /**
   * Recomputes the pose from the current focus/zoom/yaw without waiting for the
   * next frame, world matrix included. Gesture handling raycasts against the
   * camera between frames, and a stale matrix there means every delta is
   * measured against a pose that is one event out of date.
   */
  syncPose(): void {
    this.apply(0);
    this.camera.updateMatrixWorld();
  }

  follow(entityId: number | null): void {
    if (entityId !== null) this.cancelMomentum();
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
    // An exact pose cannot share the camera with a drag or a glide.
    this.cancelMomentum();
    this.dragActive = false;
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

  /** Visible ground span, which is what the rubber band scales its give to. */
  private bandSpan(): number {
    return 2 * this.distanceAt(this.zoom) * Math.tan((this.camera.fov * Math.PI) / 360);
  }

  /** Writes the banded `dragRaw` into the focus, bypassing the damp entirely. */
  private applyDragFocus(): void {
    const span = this.bandSpan();
    const x = bandAxis(this.dragRawX, this.limits.minX, this.limits.maxX, span);
    const z = bandAxis(this.dragRawZ, this.limits.minZ, this.limits.maxZ, span);
    // Both, so `update`'s damp toward the desired focus is a no-op rather than
    // a second opinion about where the camera should be.
    this.focus.x = this.desiredFocus.x = x;
    this.focus.z = this.desiredFocus.z = z;
  }

  private pushDragSample(): void {
    this.dragSamples.push({ x: this.dragRawX, z: this.dragRawZ, t: performance.now() });
    // Six samples covers the velocity window at any sane event rate; dropping
    // the oldest keeps this allocation-stable during a long drag.
    if (this.dragSamples.length > 6) this.dragSamples.shift();
  }

  /** Focus velocity at release, in world units per second, fitted to the recent history. */
  private releaseVelocity(): { x: number; z: number } {
    const n = this.dragSamples.length;
    const last = this.dragSamples[n - 1];
    if (n < 2 || !last) return { x: 0, z: 0 };
    if (performance.now() - last.t > VELOCITY_STALE_MS) return { x: 0, z: 0 };
    let first = last;
    for (let i = n - 2; i >= 0; i--) {
      const sample = this.dragSamples[i]!;
      if (last.t - sample.t > VELOCITY_WINDOW_MS) break;
      first = sample;
    }
    const seconds = (last.t - first.t) / 1000;
    if (seconds <= 0) return { x: 0, z: 0 };
    return { x: (last.x - first.x) / seconds, z: (last.z - first.z) / seconds };
  }

  /**
   * One frame of the flick glide, plus the spring back into the limits.
   *
   * The travel term is the exact integral of `v * d^t` across the frame rather
   * than `v * dt`, so the same flick covers the same ground at 30 fps and at
   * 144 fps. Crossing a limit kills that axis' velocity instead of letting
   * momentum carry the view further into nothing.
   */
  private stepGlide(dt: number): void {
    const decay = Math.pow(GLIDE_DECAY, dt * 1000);
    const travel = (decay - 1) / (1000 * Math.log(GLIDE_DECAY));
    this.dragRawX += this.glideVx * travel;
    this.dragRawZ += this.glideVz * travel;
    this.glideVx *= decay;
    this.glideVz *= decay;

    const settledX = this.settleAxis('x', this.limits.minX, this.limits.maxX, dt);
    const settledZ = this.settleAxis('z', this.limits.minZ, this.limits.maxZ, dt);
    this.applyDragFocus();

    if (
      settledX &&
      settledZ &&
      Math.abs(this.glideVx) < GLIDE_EPSILON &&
      Math.abs(this.glideVz) < GLIDE_EPSILON
    ) {
      this.cancelMomentum();
    }
  }

  /** Pulls one axis back inside its limits. Returns true once it is at rest there. */
  private settleAxis(axis: 'x' | 'z', min: number, max: number, dt: number): boolean {
    const raw = axis === 'x' ? this.dragRawX : this.dragRawZ;
    const target = clamp(raw, min, max);
    if (target === raw) return true;
    if (axis === 'x') this.glideVx = 0;
    else this.glideVz = 0;
    // Snaps once the remainder is under a centimetre, so the spring actually
    // terminates instead of asymptotically never arriving.
    const next = Math.abs(raw - target) < 0.01 ? target : damp(raw, target, 14, dt);
    if (axis === 'x') this.dragRawX = next;
    else this.dragRawZ = next;
    return next === target;
  }

  private distanceAt(t: number): number {
    return this.nearDistance * Math.pow(this.distanceRatio, t);
  }

  update(dt: number, followPos?: Vec2): void {
    // A finger owning the camera writes the focus itself in `dragBy`; a flick
    // released from one coasts here. Either way the damp below finds the focus
    // already where it wants it and does nothing.
    if (this.gliding && !this.dragActive) this.stepGlide(dt);

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
