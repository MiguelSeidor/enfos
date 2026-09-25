/**
 * Aiming overlay. Owner: UI.
 *
 * While an aimed ability is armed, two shapes are drawn on the ground:
 *
 * - the **area** it will hit, following the cursor (point-targeted only), and
 * - the **cast range**, a thin ring around the hero.
 *
 * The area turns amber when the cursor is outside the range ring. Casting is
 * still allowed there — the hero walks into range first — but the player should
 * know a click will send the hero forward rather than fire on the spot.
 *
 * Both shapes are rebuilt every frame with their vertices dropped onto the
 * heightfield, so they hug terraces and ramps instead of floating as flat discs
 * that sink into a slope. Drawn without depth test and last, so a hill or a
 * unit can never hide where the spell will land.
 */

import * as THREE from 'three';
import type { Vec2 } from '@/core/contracts';

const SEGMENTS = 72;
const LIFT = 0.12;
const IN_RANGE = 0x9fd8ff;
const OUT_OF_RANGE = 0xffb35c;

type HeightAt = (x: number, z: number) => number;

/** A ring (and optionally a filled disc) whose vertices follow the ground. */
class GroundCircle {
  readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly fill: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null;

  constructor(
    private readonly width: number,
    fillOpacity: number,
    ringOpacity: number,
  ) {
    const material = (opacity: number): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        color: IN_RANGE,
        transparent: true,
        opacity,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });

    // Ring: a strip of quads between an inner and an outer radius.
    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * 2 * 3), 3));
    const ringIndex: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const a = i * 2;
      ringIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    ringGeo.setIndex(ringIndex);
    this.ring = new THREE.Mesh(ringGeo, material(ringOpacity));
    this.ring.renderOrder = 1001;
    this.ring.frustumCulled = false;
    this.group.add(this.ring);

    if (fillOpacity > 0) {
      // Fill: a fan from the centre.
      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEGMENTS + 2) * 3), 3));
      const fillIndex: number[] = [];
      for (let i = 0; i < SEGMENTS; i++) fillIndex.push(0, i + 1, i + 2);
      fillGeo.setIndex(fillIndex);
      this.fill = new THREE.Mesh(fillGeo, material(fillOpacity));
      this.fill.renderOrder = 1000;
      this.fill.frustumCulled = false;
      this.group.add(this.fill);
    } else {
      this.fill = null;
    }
    this.group.visible = false;
  }

  place(center: Vec2, radius: number, color: number, heightAt: HeightAt): void {
    this.ring.material.color.setHex(color);
    const ring = this.ring.geometry.getAttribute('position') as THREE.BufferAttribute;
    const inner = Math.max(0, radius - this.width);
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const ox = center.x + c * radius;
      const oz = center.z + s * radius;
      const ix = center.x + c * inner;
      const iz = center.z + s * inner;
      ring.setXYZ(i * 2, ix, heightAt(ix, iz) + LIFT, iz);
      ring.setXYZ(i * 2 + 1, ox, heightAt(ox, oz) + LIFT, oz);
    }
    ring.needsUpdate = true;
    this.ring.geometry.computeBoundingSphere();

    if (this.fill) {
      this.fill.material.color.setHex(color);
      const fill = this.fill.geometry.getAttribute('position') as THREE.BufferAttribute;
      fill.setXYZ(0, center.x, heightAt(center.x, center.z) + LIFT, center.z);
      for (let i = 0; i <= SEGMENTS; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2;
        const x = center.x + Math.cos(a) * radius;
        const z = center.z + Math.sin(a) * radius;
        fill.setXYZ(i + 1, x, heightAt(x, z) + LIFT, z);
      }
      fill.needsUpdate = true;
      this.fill.geometry.computeBoundingSphere();
    }
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }
}

export class TargetingOverlay {
  private readonly area = new GroundCircle(0.22, 0.09, 0.75);
  private readonly range = new GroundCircle(0.12, 0, 0.28);
  private radius = 0;
  private reach = 0;
  private active = false;

  constructor(scene: THREE.Scene, private readonly heightAt: HeightAt) {
    this.area.group.name = 'targeting.area';
    this.range.group.name = 'targeting.range';
    scene.add(this.area.group, this.range.group);
  }

  /** `radius` 0 draws no area — a unit-targeted spell only shows its range. */
  show(radius: number, range: number): void {
    this.radius = radius;
    this.reach = range;
    this.active = true;
  }

  hide(): void {
    this.active = false;
    this.area.hide();
    this.range.hide();
  }

  /** Once per frame while aiming. `cursor` is null when it is off the map. */
  update(hero: Vec2 | null, cursor: Vec2 | null): void {
    if (!this.active || !hero) {
      this.area.hide();
      this.range.hide();
      return;
    }
    const inRange = cursor !== null && Math.hypot(cursor.x - hero.x, cursor.z - hero.z) <= this.reach;
    this.range.place(hero, this.reach, 0xffffff, this.heightAt);
    if (this.radius > 0 && cursor) {
      this.area.place(cursor, this.radius, inRange ? IN_RANGE : OUT_OF_RANGE, this.heightAt);
    } else {
      this.area.hide();
    }
  }
}
