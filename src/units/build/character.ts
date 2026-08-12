/**
 * Parametric character builder. Owner: CHARACTERS agent.
 *
 * A recipe describes a character as a list of parts — each part a procedural
 * shape, a material slot, a placement relative to a bone, and the set of bones
 * allowed to deform it. This produces one merged `BufferGeometry` carrying
 * position/normal/uv/skinIndex/skinWeight, plus material groups so the whole
 * character costs one draw call per material slot rather than one per part.
 *
 * Placement is bone-relative on purpose: change `Proportions` and every plate,
 * horn and boot follows the skeleton automatically, so an archetype can be
 * re-proportioned without re-authoring its parts.
 */

import * as THREE from 'three';
import { materials, type MaterialId } from '@/art/materials';
import type { Bind, Rig } from '../rig/rig';
import { computeSkinWeights } from '../rig/rig';

export type SlotName = 'armor' | 'cloth' | 'leather' | 'metal' | 'flesh' | 'glow';

export const SLOT_ORDER: readonly SlotName[] = ['armor', 'cloth', 'leather', 'metal', 'flesh', 'glow'];

export type PaletteKey = 'primary' | 'secondary' | 'accent' | 'emissive' | 'none';

export interface SlotConfig {
  material: MaterialId;
  /** Which palette entry tints this slot. */
  tint?: PaletteKey;
  roughness?: number;
  metalness?: number;
  emissiveIntensity?: number;
  /** Multiplies the tint so a slot can read darker than the palette colour. */
  shade?: number;
}

export interface Palette {
  primary: number;
  secondary: number;
  accent: number;
  emissive: number;
}

export interface Placement {
  /** Anchor bone; the part's local origin lands on this bone's rest position. */
  bone?: string;
  /** Offset from the anchor, in character space. */
  at?: [number, number, number];
  /** XYZ Euler, radians. */
  rot?: [number, number, number];
  scale?: number | [number, number, number];
}

export interface PartOptions extends Placement {
  slot: SlotName;
  bind: Bind;
  /** Also emit an X-mirrored copy with `.L`/`.R` bone names swapped. */
  mirror?: boolean;
  /** Multiplies generated UVs; raises texel density on small parts. */
  uvScale?: number;
}

interface SlotAccum {
  position: number[];
  normal: number[];
  uv: number[];
  skinIndex: number[];
  skinWeight: number[];
}

const _m = new THREE.Matrix4();
const _mn = new THREE.Matrix3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

export class CharacterBuilder {
  private readonly slots = new Map<SlotName, SlotAccum>();

  constructor(
    readonly rig: Rig,
    private readonly slotConfig: Partial<Record<SlotName, SlotConfig>>,
    private readonly palette: Palette,
    private readonly defId: string,
  ) {}

  /** Adds one procedural part. The geometry is consumed and disposed. */
  add(geo: THREE.BufferGeometry, opts: PartOptions): this {
    this.addOnce(geo, opts, false);
    if (opts.mirror) this.addOnce(geo, opts, true);
    geo.dispose();
    return this;
  }

  private addOnce(geo: THREE.BufferGeometry, opts: PartOptions, mirrored: boolean): void {
    const src = geo.index ? geo.toNonIndexed() : geo;
    const pos = src.getAttribute('position') as THREE.BufferAttribute;
    const nrm = src.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uv = src.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const count = pos.count;

    this.composeMatrix(opts, mirrored, _m);
    _mn.getNormalMatrix(_m);

    const local = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);

    for (let i = 0; i < count; i++) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(_m);
      local[i * 3] = _v.x;
      local[i * 3 + 1] = _v.y;
      local[i * 3 + 2] = _v.z;
      if (nrm) {
        _v.fromBufferAttribute(nrm, i).applyMatrix3(_mn).normalize();
        if (mirrored) _v.negate(); // mirroring reverses winding; flip to match
        normals[i * 3] = _v.x;
        normals[i * 3 + 1] = _v.y;
        normals[i * 3 + 2] = _v.z;
      }
      if (uv) {
        const u = opts.uvScale ?? 1;
        uvs[i * 2] = uv.getX(i) * u;
        uvs[i * 2 + 1] = uv.getY(i) * u;
      }
    }

    const bind = mirrored ? mirrorBind(opts.bind) : opts.bind;
    const skin = computeSkinWeights(this.rig, local, count, bind);

    const accum = this.slotOf(opts.slot);
    // Mirroring inverts triangle orientation, so emit the winding reversed.
    if (mirrored) {
      for (let f = 0; f < count; f += 3) {
        for (const k of [0, 2, 1]) pushVertex(accum, local, normals, uvs, skin, f + k);
      }
    } else {
      for (let i = 0; i < count; i++) pushVertex(accum, local, normals, uvs, skin, i);
    }

    if (src !== geo) src.dispose();
  }

  private composeMatrix(opts: PartOptions, mirrored: boolean, out: THREE.Matrix4): THREE.Matrix4 {
    let ax = 0;
    let ay = 0;
    let az = 0;
    if (opts.bone) {
      const name = mirrored ? swapSide(opts.bone) : opts.bone;
      const bi = this.rig.index[name];
      if (bi === undefined) throw new Error(`build: unknown anchor bone ${name}`);
      ax = this.rig.restWorld[bi * 3]!;
      ay = this.rig.restWorld[bi * 3 + 1]!;
      az = this.rig.restWorld[bi * 3 + 2]!;
    }
    const off = opts.at ?? [0, 0, 0];
    const rot = opts.rot ?? [0, 0, 0];
    const sc = opts.scale ?? 1;
    const m = mirrored ? -1 : 1;

    _v.set(ax + off[0]! * m, ay + off[1]!, az + off[2]!);
    _e.set(rot[0]!, rot[1]! * m, rot[2]! * m, 'XYZ');
    _q.setFromEuler(_e);
    if (typeof sc === 'number') _s.set(sc * m, sc, sc);
    else _s.set(sc[0]! * m, sc[1]!, sc[2]!);
    return out.compose(_v, _q, _s);
  }

  private slotOf(slot: SlotName): SlotAccum {
    let a = this.slots.get(slot);
    if (!a) {
      a = { position: [], normal: [], uv: [], skinIndex: [], skinWeight: [] };
      this.slots.set(slot, a);
    }
    return a;
  }

  /** Merges every slot into one geometry with one material group per slot. */
  build(): { geometry: THREE.BufferGeometry; materials: THREE.MeshStandardMaterial[] } {
    const position: number[] = [];
    const normal: number[] = [];
    const uv: number[] = [];
    const skinIndex: number[] = [];
    const skinWeight: number[] = [];
    const mats: THREE.MeshStandardMaterial[] = [];
    const geometry = new THREE.BufferGeometry();

    let start = 0;
    let materialIndex = 0;
    for (const slot of SLOT_ORDER) {
      const a = this.slots.get(slot);
      if (!a || a.position.length === 0) continue;
      const verts = a.position.length / 3;
      pushAll(position, a.position);
      pushAll(normal, a.normal);
      pushAll(uv, a.uv);
      pushAll(skinIndex, a.skinIndex);
      pushAll(skinWeight, a.skinWeight);
      geometry.addGroup(start, verts, materialIndex);
      mats.push(this.materialFor(slot));
      start += verts;
      materialIndex++;
    }

    if (position.length === 0) throw new Error(`build: character ${this.defId} has no parts`);

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { geometry, materials: mats };
  }

  private materialFor(slot: SlotName): THREE.MeshStandardMaterial {
    const cfg = this.slotConfig[slot] ?? { material: 'unit.steel' as MaterialId };
    const tintKey = cfg.tint ?? 'primary';
    const base = tintKey === 'none' ? undefined : this.palette[tintKey];
    const color = base !== undefined ? shadeHex(base, cfg.shade ?? 1) : undefined;
    return materials.get(cfg.material, {
      key: `unit:${this.defId}:${slot}`,
      ...(color !== undefined ? { color } : {}),
      ...(cfg.roughness !== undefined ? { roughness: cfg.roughness } : {}),
      ...(cfg.metalness !== undefined ? { metalness: cfg.metalness } : {}),
      ...(slot === 'glow'
        ? {
            emissive: this.palette.emissive,
            emissiveIntensity: cfg.emissiveIntensity ?? 2.4,
          }
        : {}),
    });
  }
}

function pushVertex(
  a: SlotAccum,
  local: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  skin: { index: Uint16Array; weight: Float32Array },
  i: number,
): void {
  a.position.push(local[i * 3]!, local[i * 3 + 1]!, local[i * 3 + 2]!);
  a.normal.push(normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!);
  a.uv.push(uvs[i * 2]!, uvs[i * 2 + 1]!);
  a.skinIndex.push(skin.index[i * 4]!, skin.index[i * 4 + 1]!, skin.index[i * 4 + 2]!, skin.index[i * 4 + 3]!);
  a.skinWeight.push(
    skin.weight[i * 4]!,
    skin.weight[i * 4 + 1]!,
    skin.weight[i * 4 + 2]!,
    skin.weight[i * 4 + 3]!,
  );
}

function pushAll(dst: number[], src: number[]): void {
  for (let i = 0; i < src.length; i++) dst.push(src[i]!);
}

function swapSide(name: string): string {
  if (name.endsWith('.L')) return `${name.slice(0, -2)}.R`;
  if (name.endsWith('.R')) return `${name.slice(0, -2)}.L`;
  return name;
}

function mirrorBind(bind: Bind): Bind {
  return { ...bind, bones: bind.bones.map(swapSide) };
}

function shadeHex(hex: number, shade: number): number {
  if (shade === 1) return hex;
  const r = Math.min(255, Math.round(((hex >> 16) & 0xff) * shade));
  const g = Math.min(255, Math.round(((hex >> 8) & 0xff) * shade));
  const b = Math.min(255, Math.round((hex & 0xff) * shade));
  return (r << 16) | (g << 8) | b;
}
