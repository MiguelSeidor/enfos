/**
 * Environment props. Owner: TERRAIN agent.
 *
 * The bar (GDD §16, qa/REVIEW_RUBRIC.md §5): no empty ground inside the play
 * space. Everything here must be instanced and frustum-culled — this module is
 * allowed to add thousands of objects but only a handful of draw calls.
 *
 * ## Placement is authored, never derived
 *
 * An earlier pass placed braziers by walking the lane polyline and offsetting
 * perpendicular to it. The arithmetic was sound and the result was nonsense —
 * torches in the middle of the road and inside cliff faces — because the lane
 * polyline says where the route *passes*, not where its shoulders are, and no
 * offset recovers that.
 *
 * Every prop here comes from `MapOverlay.props`, placed by hand in the editor
 * (`?edit=1`). This module only draws what it is told to.
 *
 * ## Budget
 *
 * Two draw calls regardless of prop count: all lit geometry is merged into one
 * mesh and all additive flame geometry into another. No real lights — one point
 * light per torch would be dozens of shadow casters, and the renderer's shadow
 * setup is fitted to a single key light. The flames sit above the composer's
 * bloom threshold, so their glow is free.
 */

import * as THREE from 'three';
import type { GameContext, GameModule } from '@/core/contracts';
import { TerrainKey, type TerrainService } from '@/core/services';
import { PROP_GEOMETRY } from './propGeometry';
import { loadOverlay, type MapOverlay } from './overlay';

export class PropsModule implements GameModule {
  readonly id = 'props';
  readonly order = 110;

  private readonly root = new THREE.Group();
  private terrain!: TerrainService;
  private solidMesh: THREE.Mesh | null = null;
  private flameMesh: THREE.Mesh | null = null;
  private flameMaterial: THREE.MeshBasicMaterial | null = null;
  private time = 0;

  init(ctx: GameContext): void {
    this.root.name = 'props';
    ctx.scene.add(this.root);
    // Terrain must exist first; props sit on its height field.
    this.terrain = ctx.services.get(TerrainKey);
    // Loaded here as well as in the terrain module. The fetch is cached, and
    // the alternative — waiting to be told — would couple this module to the
    // terrain's load order for no benefit. In edit mode the editor calls
    // `rebuild` again on every change, so this only matters for normal play.
    void loadOverlay().then((overlay) => this.rebuild(overlay));
  }

  /**
   * Rebuilds every prop from the overlay.
   *
   * Full rebuild rather than incremental: props are merged into two meshes, so
   * adding one means re-merging anyway, and an author places tens of props, not
   * thousands.
   */
  rebuild(overlay: MapOverlay): void {
    this.clear();
    if (overlay.props.length === 0) return;

    const solid: THREE.BufferGeometry[] = [];
    const emissive: THREE.BufferGeometry[] = [];

    for (const placement of overlay.props) {
      const build = PROP_GEOMETRY[placement.kind];
      if (!build) continue;
      const parts = build();
      const y = this.terrain.heightAt(placement.x, placement.z);

      const place = (geo: THREE.BufferGeometry, into: THREE.BufferGeometry[]): void => {
        geo.scale(placement.scale, placement.scale, placement.scale);
        geo.rotateY(placement.rot);
        geo.translate(placement.x, y, placement.z);
        into.push(geo);
      };
      for (const g of parts.solid) place(g, solid);
      for (const g of parts.emissive) place(g, emissive);
    }

    if (solid.length > 0) {
      const merged = mergeGeometries(solid);
      this.solidMesh = new THREE.Mesh(
        merged,
        new THREE.MeshStandardMaterial({ color: 0x5f574c, roughness: 0.9, metalness: 0.05 }),
      );
      this.solidMesh.castShadow = true;
      this.solidMesh.receiveShadow = true;
      this.root.add(this.solidMesh);
    }

    if (emissive.length > 0) {
      const merged = mergeGeometries(emissive);
      this.flameMaterial = new THREE.MeshBasicMaterial({
        map: flameTexture(),
        // Past white on purpose: additive blending multiplies by this, and it
        // is what carries the core over the composer's 1.05 bloom threshold. A
        // colour clamped to 0xff… renders as a flat orange decal with no glow.
        color: new THREE.Color(2.1, 1.35, 0.62),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      this.flameMesh = new THREE.Mesh(merged, this.flameMaterial);
      // Flames are light, not matter: they neither occlude nor cast.
      this.flameMesh.castShadow = false;
      this.flameMesh.receiveShadow = false;
      this.root.add(this.flameMesh);
    }
  }

  update(dt: number): void {
    this.time += dt;
    if (!this.flameMaterial) return;
    // Three summed sines: one shared material means every flame flickers
    // together, so it is deliberately fast and shallow, where the eye reads it
    // as fire rather than as a synchronised pulse. Per-prop phase would need a
    // vertex attribute and a shader, and this is decoration.
    const f =
      Math.sin(this.time * 11.3) * 0.5 +
      Math.sin(this.time * 17.9) * 0.3 +
      Math.sin(this.time * 29.1) * 0.2;
    this.flameMaterial.opacity = 0.9 + f * 0.1;
  }

  private clear(): void {
    for (const mesh of [this.solidMesh, this.flameMesh]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
    (this.solidMesh?.material as THREE.Material | undefined)?.dispose();
    this.flameMaterial?.dispose();
    this.solidMesh = null;
    this.flameMesh = null;
    this.flameMaterial = null;
  }

  dispose(): void {
    this.clear();
    this.root.removeFromParent();
  }
}

/**
 * Concatenates geometries sharing an attribute layout.
 *
 * Expands to non-indexed *first*, then sizes the buffers. The counts differ
 * between indexed and expanded forms, and sizing from the indexed count
 * silently drops the tail — writes past the end of a `Float32Array` do not
 * throw. That bug once cost the portal its lintel.
 */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const expanded = parts.map((p) => {
    const src = p.toNonIndexed();
    if (src !== p) p.dispose();
    return src;
  });

  let count = 0;
  for (const p of expanded) count += p.attributes.position.count;

  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o = 0;

  for (const src of expanded) {
    const p = src.attributes.position as THREE.BufferAttribute;
    const n = src.attributes.normal as THREE.BufferAttribute | undefined;
    const t = src.attributes.uv as THREE.BufferAttribute | undefined;
    for (let i = 0; i < p.count; i++) {
      position[(o + i) * 3] = p.getX(i);
      position[(o + i) * 3 + 1] = p.getY(i);
      position[(o + i) * 3 + 2] = p.getZ(i);
      normal[(o + i) * 3] = n ? n.getX(i) : 0;
      normal[(o + i) * 3 + 1] = n ? n.getY(i) : 1;
      normal[(o + i) * 3 + 2] = n ? n.getZ(i) : 0;
      uv[(o + i) * 2] = t ? t.getX(i) : 0;
      uv[(o + i) * 2 + 1] = t ? t.getY(i) : 0;
    }
    o += p.count;
    src.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/**
 * A teardrop flame with a hot core, drawn once and shared.
 *
 * Canvas rather than the material pipeline: this is a single sprite with an
 * alpha falloff, not a tiling surface, so toroidal noise and Sobel normals
 * would be paying for properties it has none of.
 */
let flameTex: THREE.CanvasTexture | null = null;

function flameTexture(): THREE.CanvasTexture {
  if (flameTex) return flameTex;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, size, size);

  g.beginPath();
  g.moveTo(size / 2, 6);
  g.bezierCurveTo(size * 0.86, size * 0.42, size * 0.8, size * 0.92, size / 2, size * 0.96);
  g.bezierCurveTo(size * 0.2, size * 0.92, size * 0.14, size * 0.42, size / 2, 6);
  const body = g.createLinearGradient(0, size, 0, 0);
  body.addColorStop(0, 'rgba(255, 96, 16, 0.05)');
  body.addColorStop(0.25, 'rgba(255, 128, 26, 0.85)');
  body.addColorStop(0.7, 'rgba(255, 190, 80, 0.95)');
  body.addColorStop(1, 'rgba(255, 244, 210, 0.6)');
  g.fillStyle = body;
  g.fill();

  const core = g.createRadialGradient(size / 2, size * 0.66, 2, size / 2, size * 0.66, size * 0.26);
  core.addColorStop(0, 'rgba(255, 250, 226, 0.95)');
  core.addColorStop(1, 'rgba(255, 200, 90, 0)');
  g.fillStyle = core;
  g.beginPath();
  g.ellipse(size / 2, size * 0.66, size * 0.2, size * 0.3, 0, 0, Math.PI * 2);
  g.fill();

  flameTex = new THREE.CanvasTexture(canvas);
  flameTex.colorSpace = THREE.SRGBColorSpace;
  return flameTex;
}
