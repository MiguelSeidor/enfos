/**
 * Shadow fitting. Owner: RENDER agent.
 *
 * ## Why this is not `three/addons/csm/CSM.js`
 *
 * Cascades exist to solve one problem: a camera whose visible depth range spans
 * several orders of magnitude, so no single shadow projection can serve both the
 * character's feet and the mountain on the horizon. This camera is not that
 * camera. It is a bounded RTS rig — the eye-to-focus distance only ever varies
 * between roughly 17 and 105 world units, a span of about 6x, and it is always
 * looking down at a bowl 240 units across.
 *
 * Fitting one orthographic projection to the visible frustum slice therefore
 * gives, on the actual numbers:
 *
 * | Shot | Eye distance | Fitted radius | Texel @3072 (`high`) |
 * | --- | --- | --- | --- |
 * | hero | 20 u | 36 u | 2.3 cm |
 * | lane | 39 u | 60 u | 3.9 cm |
 * | overview | 96 u | 140 u | 9.1 cm |
 *
 * Sub-centimetre-class density at hero zoom and under a decimetre at full
 * overview, from one shadow pass instead of three — which matters, because the
 * GTX 970 budget is 14 ms of GPU and 300 units would have to be re-rasterised
 * into every cascade.
 *
 * The other reason is ownership. `CSM.setupMaterial()` overwrites
 * `material.onBeforeCompile` on every material in the scene. Those materials
 * belong to the MATERIALS, TERRAIN, CHARACTERS and VFX agents. Reaching across
 * four folders to monkey-patch shader hooks that another agent may legitimately
 * want to use is a coupling this architecture explicitly forbids.
 *
 * ## What makes it stable
 *
 * Two things, and the shadows crawl visibly without either:
 *
 *  1. **The fit is a sphere, not a box.** The bounding sphere of a frustum slice
 *     depends only on near, far, fov and aspect — never on camera orientation. So
 *     rotating the camera cannot change the projection size, and the shadow map
 *     cannot swim while the player rotates.
 *  2. **The centre is snapped to the shadow map's own texel grid.** Without this
 *     the projection slides sub-texel as the camera pans and every shadow edge
 *     shimmers. With it, panning moves the shadow map in whole-texel steps and
 *     the edges are rock solid.
 */

import * as THREE from 'three';
import { clamp } from '@/core/mathx';

export class FittedShadow {
  private readonly viewCenter = new THREE.Vector3();
  private readonly worldCenter = new THREE.Vector3();
  private readonly snapped = new THREE.Vector3();
  private readonly axisX = new THREE.Vector3();
  private readonly axisY = new THREE.Vector3();
  private readonly axisZ = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly viewDir = new THREE.Vector3();

  private mapSize = 2048;
  /** Distance above the fitted volume that still contributes casters. */
  private casterHeadroom = 90;
  /** Upper bound on how far from the camera shadows are still resolved. */
  private rangeCap = 200;
  private lastRadius = 0;
  private lastTexel = 0;

  constructor(private readonly light: THREE.DirectionalLight) {
    light.castShadow = true;
    light.shadow.autoUpdate = true;
  }

  /** Radius of the fitted volume in world units, as of the last update. */
  get radius(): number {
    return this.lastRadius;
  }

  /** Size of one shadow-map texel in world units, as of the last update. */
  get texelWorldSize(): number {
    return this.lastTexel;
  }

  configure(mapSize: number, rangeCap: number, casterHeadroom = 90): void {
    this.rangeCap = rangeCap;
    this.casterHeadroom = casterHeadroom;
    if (mapSize === this.mapSize && this.light.shadow.map !== null) return;
    this.mapSize = mapSize;
    this.light.shadow.mapSize.set(mapSize, mapSize);
    // three only allocates a new render target when the old one is gone, so the
    // map has to be released explicitly or a tier change silently does nothing.
    this.light.shadow.map?.dispose();
    this.light.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    this.light.shadow.needsUpdate = true;
  }

  update(camera: THREE.PerspectiveCamera, sunDirection: THREE.Vector3): void {
    // How far ahead the camera is actually looking: where its forward ray meets
    // the ground plane. Shadow range follows that, so the fit tightens
    // automatically as the player zooms in.
    camera.getWorldDirection(this.viewDir);
    const groundHit =
      this.viewDir.y < -1e-3 ? camera.position.y / -this.viewDir.y : this.rangeCap;
    const far = clamp(groundHit * 1.9, 45, this.rangeCap);
    const near = camera.near;

    // Exact bounding sphere of the frustum slice. Depends only on the projection,
    // never on orientation, which is what keeps the fit stable under rotation.
    const halfV = Math.tan(((camera.fov * 0.5) * Math.PI) / 180);
    const k2 = halfV * halfV * (1 + camera.aspect * camera.aspect);
    let centerZ: number;
    let radius: number;
    if (k2 >= (far - near) / (far + near)) {
      centerZ = -far;
      radius = far * Math.sqrt(k2);
    } else {
      centerZ = -0.5 * (far + near) * (1 + k2);
      radius =
        0.5 *
        Math.sqrt(
          (far - near) * (far - near) +
            2 * (far * far + near * near) * k2 +
            (far + near) * (far + near) * k2 * k2,
        );
    }

    // Quantise the radius so damped zoom does not continuously resize the
    // projection; a resize changes texel size, and a changing texel size defeats
    // the snapping below.
    radius = Math.ceil(radius / 4) * 4;
    const texel = (radius * 2) / this.mapSize;
    this.lastRadius = radius;
    this.lastTexel = texel;

    this.viewCenter.set(0, 0, centerZ);
    this.worldCenter.copy(this.viewCenter).applyMatrix4(camera.matrixWorld);

    // Light view basis, matching what three's lookAt will build for the shadow
    // camera, so snapping happens in the same space the map is rasterised in.
    this.axisZ.copy(sunDirection).normalize();
    this.axisX.crossVectors(this.up, this.axisZ);
    if (this.axisX.lengthSq() < 1e-6) this.axisX.set(1, 0, 0);
    this.axisX.normalize();
    this.axisY.crossVectors(this.axisZ, this.axisX).normalize();

    const cx = this.worldCenter.dot(this.axisX);
    const cy = this.worldCenter.dot(this.axisY);
    const cz = this.worldCenter.dot(this.axisZ);
    const sx = Math.round(cx / texel) * texel;
    const sy = Math.round(cy / texel) * texel;

    this.snapped
      .copy(this.axisX)
      .multiplyScalar(sx)
      .addScaledVector(this.axisY, sy)
      .addScaledVector(this.axisZ, cz);

    const pullBack = radius + this.casterHeadroom;
    this.light.target.position.copy(this.snapped);
    this.light.position.copy(this.snapped).addScaledVector(this.axisZ, pullBack);
    this.light.target.updateMatrixWorld();

    const cam = this.light.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 0.5;
    cam.far = pullBack + radius;
    cam.updateProjectionMatrix();

    // Bias in world units converted to the ortho depth range, so it stays
    // correct as the volume resizes. normalBias slides the sample along the
    // surface normal by a little over one texel, which removes acne without the
    // contact gap that a large constant depth bias produces.
    const depthRange = cam.far - cam.near;
    this.light.shadow.bias = -(texel * 0.55) / depthRange;
    this.light.shadow.normalBias = texel * 1.6;
  }
}
