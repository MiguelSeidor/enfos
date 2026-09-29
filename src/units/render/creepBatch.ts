/**
 * Instanced creep rendering. Owner: CHARACTERS agent.
 *
 * One `InstancedMesh` per creep definition, carrying the definition's material
 * array and geometry groups, so a whole species costs (number of material slots)
 * draw calls no matter how many of them are alive. Animation comes from the
 * vertex-animation textures baked in `anim/vat.ts`; the only per-instance data
 * is a static vec4, so a 300-unit wave costs one uniform update per frame rather
 * than 300 skeleton evaluations.
 */

import * as THREE from 'three';
import type { VatBake } from '../anim/vat';
import type { ClipId } from '../anim/clips';

const VAT_PRELUDE = /* glsl */ `
attribute float aVertexId;
attribute vec4 aAnim;            // x: clip row, y: frame count, z: start time, w: rate (<0 = one-shot)
uniform sampler2D vatPosition;
uniform sampler2D vatNormal;
uniform vec2 vatSize;
uniform float vatTime;

vec3 vatFetch(sampler2D tex, float row) {
  return texture2D(tex, vec2((aVertexId + 0.5) / vatSize.x, (row + 0.5) / vatSize.y)).xyz;
}
`;

const VAT_SAMPLE = /* glsl */ `
  float vatRate = abs(aAnim.w);
  float vatLast = aAnim.y - 1.0;
  float vatCursor = (vatTime - aAnim.z) * vatRate;
  float vatF0;
  float vatF1;
  float vatMix;
  if (aAnim.w < 0.0) {
    float c = clamp(vatCursor, 0.0, vatLast);
    vatF0 = floor(c);
    vatF1 = min(vatF0 + 1.0, vatLast);
    vatMix = c - vatF0;
  } else {
    float c = mod(vatCursor, aAnim.y);
    vatF0 = floor(c);
    vatF1 = mod(vatF0 + 1.0, aAnim.y);
    vatMix = c - vatF0;
  }
  vec3 vatP = mix(vatFetch(vatPosition, aAnim.x + vatF0), vatFetch(vatPosition, aAnim.x + vatF1), vatMix);
  vec3 vatN = normalize(mix(vatFetch(vatNormal, aAnim.x + vatF0), vatFetch(vatNormal, aAnim.x + vatF1), vatMix));
`;

interface PatchedUniforms {
  vatTime: { value: number };
}

/**
 * Builds a render-only geometry for the batch: the same position/normal/uv
 * buffers as the hero geometry (shared on the GPU) minus the skinning
 * attributes, plus the vertex id the VAT lookup needs.
 */
export function makeVatGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', source.getAttribute('position'));
  geo.setAttribute('normal', source.getAttribute('normal'));
  geo.setAttribute('uv', source.getAttribute('uv'));
  if (source.index) geo.setIndex(source.index);
  for (const g of source.groups) geo.addGroup(g.start, g.count, g.materialIndex);

  const count = source.getAttribute('position').count;
  const ids = new Float32Array(count);
  for (let i = 0; i < count; i++) ids[i] = i;
  geo.setAttribute('aVertexId', new THREE.BufferAttribute(ids, 1));
  return geo;
}

export class CreepBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly capacity: number;

  private readonly anim: THREE.InstancedBufferAttribute;
  private readonly free: number[] = [];
  private readonly live = new Set<number>();
  private readonly patched: PatchedUniforms[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly materials: THREE.MeshStandardMaterial[];
  private highWater = 0;

  constructor(
    readonly defId: string,
    geometry: THREE.BufferGeometry,
    sourceMaterials: readonly THREE.MeshStandardMaterial[],
    private readonly bake: VatBake,
    capacity: number,
  ) {
    this.capacity = capacity;

    const anim = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    anim.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aAnim', anim);
    this.anim = anim;

    // Materials must be cloned: the library caches and shares them with terrain
    // and props, and the VAT patch must not leak onto anything else.
    //
    // Known and deliberate: the clone does NOT carry the library's close-range
    // detail injection, so creeps render without it while heroes built from the
    // same materials get it. `onBeforeCompile` is a prototype no-op that
    // `art/shading.ts` overwrites per instance, and `Material.copy` does not
    // carry instance-assigned methods, so it is lost here and nothing errors.
    //
    // Restoring it was tried on 2026-09-29 and reverted. It composes correctly
    // (detail takes `project_vertex` and the fragment stage, VAT takes
    // `begin_vertex`; chaining compiles and both sets of uniforms arrive), but
    // the detail layer brightens albedo around a 0.42 reference that assumed
    // the old dark unit maps. Against the near-neutral mid-value maps the unit
    // recipes use now, it washes every creep out to pale grey. Anyone retrying
    // this needs to retune the detail albedo strength for units in the same
    // pass, and to check it against a creep pack rather than a single figure.
    this.materials = sourceMaterials.map((m) => {
      const clone = m.clone();
      this.patch(clone);
      return clone;
    });

    this.mesh = new THREE.InstancedMesh(geometry, this.materials, capacity);
    this.mesh.name = `creeps:${defId}`;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // instances span the map; per-batch culling would pop
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Shadows need the same displacement or the silhouette on the ground is the
    // rest pose. A patched depth material supplies it.
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.patch(depth, true);
    this.mesh.customDepthMaterial = depth;

    geometry.boundingSphere = bake.boundingSphere.clone();
    geometry.boundingBox = new THREE.Box3().setFromCenterAndSize(
      bake.boundingSphere.center,
      new THREE.Vector3().setScalar(bake.boundingSphere.radius * 2),
    );

    for (let i = capacity - 1; i >= 0; i--) this.free.push(i);
    // Park every instance at zero scale so unused slots draw nothing.
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, zero);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private patch(material: THREE.Material, depthOnly = false): void {
    const bake = this.bake;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.vatPosition = { value: bake.position };
      shader.uniforms.vatNormal = { value: bake.normal };
      shader.uniforms.vatSize = { value: new THREE.Vector2(bake.width, bake.height) };
      shader.uniforms.vatTime = { value: 0 };
      shader.vertexShader = VAT_PRELUDE + shader.vertexShader;

      if (depthOnly) {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          `${VAT_SAMPLE}\n  vec3 transformed = vatP;`,
        );
      } else {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <beginnormal_vertex>',
          `${VAT_SAMPLE}\n  vec3 objectNormal = vatN;\n#ifdef USE_TANGENT\n  vec3 objectTangent = vec3( tangent.xyz );\n#endif`,
        );
        shader.vertexShader = shader.vertexShader.replace(
          '#include <begin_vertex>',
          '  vec3 transformed = vatP;',
        );
      }
      this.patched.push(shader.uniforms as unknown as PatchedUniforms);
    };
    // Distinct cache key or three reuses the unpatched program.
    material.customProgramCacheKey = () => `vat:${this.defId}:${depthOnly ? 'depth' : 'lit'}`;
  }

  get count(): number {
    return this.live.size;
  }

  alloc(): number | null {
    const slot = this.free.pop();
    if (slot === undefined) return null;
    this.live.add(slot);
    if (slot + 1 > this.highWater) this.highWater = slot + 1;
    this.mesh.count = this.capacity;
    return slot;
  }

  release(slot: number): void {
    if (!this.live.delete(slot)) return;
    this.matrix.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(slot, this.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.free.push(slot);
  }

  setTransform(slot: number, x: number, y: number, z: number, yaw: number, scale: number): void {
    this.pos.set(x, y, z);
    this.quat.setFromAxisAngle(UP, yaw);
    this.scale.setScalar(scale);
    this.matrix.compose(this.pos, this.quat, this.scale);
    this.mesh.setMatrixAt(slot, this.matrix);
  }

  markTransformsDirty(): void {
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** `startTime` is engine time; for loops it doubles as the phase offset. */
  setClip(slot: number, clip: ClipId, startTime: number): void {
    const r = this.bake.ranges[clip];
    const o = slot * 4;
    this.anim.array[o] = r.row;
    this.anim.array[o + 1] = r.frames;
    this.anim.array[o + 2] = startTime;
    this.anim.array[o + 3] = r.rate;
    this.anim.needsUpdate = true;
  }

  clipDuration(clip: ClipId): number {
    return this.bake.ranges[clip].duration;
  }

  update(time: number): void {
    for (const u of this.patched) u.vatTime.value = time;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    for (const m of this.materials) m.dispose();
    (this.mesh.customDepthMaterial as THREE.Material | undefined)?.dispose();
    this.bake.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
