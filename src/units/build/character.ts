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
import { CHARACTER_SHADING } from '@/render/lighting';
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

  /**
   * Merges every slot into one indexed geometry with one material group per
   * slot. Vertices are welded within a slot — identical position, normal, uv and
   * skin binding collapse to one — which typically removes two thirds of the
   * vertices the part builders emit. That matters twice: it shrinks the vertex
   * shader cost for heroes, and it directly divides the memory of the creep
   * vertex-animation textures, which are sized `uniqueVertices × frames`.
   */
  build(): { geometry: THREE.BufferGeometry; materials: THREE.MeshStandardMaterial[] } {
    const position: number[] = [];
    const normal: number[] = [];
    const uv: number[] = [];
    const skinIndex: number[] = [];
    const skinWeight: number[] = [];
    const indices: number[] = [];
    const mats: THREE.MeshStandardMaterial[] = [];
    const geometry = new THREE.BufferGeometry();

    let materialIndex = 0;
    for (const slot of SLOT_ORDER) {
      const a = this.slots.get(slot);
      if (!a || a.position.length === 0) continue;

      const vertexOffset = position.length / 3;
      const indexStart = indices.length;
      const lookup = new Map<string, number>();
      const count = a.position.length / 3;

      for (let i = 0; i < count; i++) {
        const key = weldKey(a, i);
        let local = lookup.get(key);
        if (local === undefined) {
          local = position.length / 3 - vertexOffset;
          lookup.set(key, local);
          position.push(a.position[i * 3]!, a.position[i * 3 + 1]!, a.position[i * 3 + 2]!);
          normal.push(a.normal[i * 3]!, a.normal[i * 3 + 1]!, a.normal[i * 3 + 2]!);
          uv.push(a.uv[i * 2]!, a.uv[i * 2 + 1]!);
          for (let k = 0; k < 4; k++) skinIndex.push(a.skinIndex[i * 4 + k]!);
          for (let k = 0; k < 4; k++) skinWeight.push(a.skinWeight[i * 4 + k]!);
        }
        indices.push(vertexOffset + local);
      }

      geometry.addGroup(indexStart, indices.length - indexStart, materialIndex);
      mats.push(this.materialFor(slot));
      materialIndex++;
    }

    if (position.length === 0) throw new Error(`build: character ${this.defId} has no parts`);

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { geometry, materials: mats };
  }

  private materialFor(slot: SlotName): THREE.MeshStandardMaterial {
    const cfg = this.slotConfig[slot] ?? { material: 'unit.steel' as MaterialId };
    const faction = factionOf(this.defId);
    // Living tissue keeps the colour the catalog authored; everything worn or
    // carried takes the faction's. Without the split the law answers a question
    // nobody asked: an orc pulled into the hostile hue band is a red orc, and
    // the whole point of rebuilding the bestiary as recognisable creatures was
    // that people know what an orc looks like. Skin is species, not allegiance.
    // Allegiance still reads, because it is carried by the armour, the cloth,
    // the accent and the glow, which is every surface a creature chose to put
    // on, plus the value rule that holds whatever the hue does.
    const palette =
      slot === 'flesh' ? this.palette : factionPalette(this.palette, faction);

    const tintKey = cfg.tint ?? 'primary';
    const base = tintKey === 'none' ? undefined : palette[tintKey];
    // What the surface should look like on screen, before the map's own mean is
    // divided out. Untinted slots show the map raw, so their apparent colour is
    // the map's own average.
    const apparent = base !== undefined ? shadeHex(base, cfg.shade ?? 1) : undefined;
    const color = apparent !== undefined ? compensateTint(apparent, cfg.material) : undefined;

    const mat = materials.get(cfg.material, {
      key: `unit:${this.defId}:${slot}`,
      ...(color !== undefined ? { color } : {}),
      roughness: slotRoughness(cfg, slot),
      metalness: Math.min(cfg.metalness ?? 1, CHARACTER_SHADING.metalnessMax),
      ...(slot === 'glow'
        ? {
            emissive: palette.emissive,
            emissiveIntensity: Math.min(
              cfg.emissiveIntensity ?? 2.4,
              CHARACTER_SHADING.glowIntensityMax,
            ),
          }
        : {}),
    });

    // Applied after `get` rather than through `MaterialOverrides`: the cache key
    // above is unique per character and slot, so this material is never shared
    // with terrain, props or another unit, and these two properties survive the
    // `clone()` that CreepBatch does — a shader patch would not.
    if (mat.userData.unitShading !== true) {
      mat.userData.unitShading = true;
      mat.envMapIntensity = CHARACTER_SHADING.envMapIntensity;
      if (slot !== 'glow') {
        const lift = CHARACTER_SHADING.ambientLift[faction];
        const lit = apparent !== undefined ? hexToLinear(apparent) : averageAlbedo(cfg.material);
        mat.emissive.setRGB(lit[0] * lift, lit[1] * lift, lit[2] * lift, THREE.LinearSRGBColorSpace);
        mat.emissiveIntensity = 1;
      }
    }
    return mat;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FACTION COLOUR LAW
//
// At 79 px tall — a 1.9 m hero at default play zoom on a 1600x900 canvas — a
// player cannot read a face, a crest or a weapon. They read a silhouette and a
// colour. So allegiance has to be carried by hue and value, and it has to be
// carried by *every* member of a faction, or it is not a law and it teaches the
// player nothing.
//
//   HEROES  cool, and lighter than the ground.
//           Hue 196°–232° (steel blue through slate), saturation 0.27,
//           lightness 0.30. Warm brass accents, warm amber glow.
//
//   CREEPS  warm, and darker than the ground.
//           Hue 336°–28° (oxblood through rust), saturation 0.29, lightness
//           0.20. Pale ash-bone accents, cold violet glow.
//
//   BOSS    the creep band, raised: hue 350°–22°, saturation 0.34, lightness
//           0.30 — same family, more chroma and more value, because a boss is a
//           landmark and must not read as a creep that happens to be big.
//
// Why this pairing and not the reverse. The map is green grass and amber-lit
// grey stone under a 36° key that throws 13 m shadows, so half of any fight is
// in shade and the shade is teal (the hemisphere fill is the only light a
// shadowed surface sees). A cool hero is lighter than both lit and shaded
// ground, so value carries it; a warm creep is darker than lit ground, and in
// shade its hue is the complement of the teal it stands in. Each faction gets
// one cue that works in sun and a different one that works in shade. The
// reverse assignment — warm heroes, cold creeps — loses the creeps entirely in
// the shadows, which is where they are most dangerous.
//
// This is a *band*, not an override. Each character keeps its relative position
// inside its faction's hue window, derived from the hue the catalog authored, so
// re-authoring a palette in `units/catalog.ts` still moves that character —
// it just cannot leave its faction. Saturation and lightness are clamped into
// the faction's window, which is what kills the muddy purple-brown-grey the
// whole cast used to share.
//
// Keep it here rather than in the catalog: the law must hold for characters
// nobody has authored yet, and a rule that has to be remembered at every new
// palette is a rule that will be broken.
// ─────────────────────────────────────────────────────────────────────────────

type Faction = 'hero' | 'creep' | 'boss';

interface FactionLaw {
  /** Hue window centre and half-width, degrees. */
  hue: [number, number];
  saturation: number;
  lightness: number;
  /**
   * Secondary mass: straps, under-robe, the cloth beneath the plate.
   *
   * Nearly desaturated on purpose. A secondary that is only "the primary, a bit
   * darker" gives a figure one hue over its whole area and it reads as a single
   * moulded shell; a near-neutral dark reads as a second material, and that is
   * what makes the faction hue on the primary look chosen rather than sprayed
   * on.
   */
  secondary: { hueShift: number; saturation: number; lightness: number };
  /** Metal trim and hard accents. */
  accent: [number, number, number];
  /** Glow: hue window centre and half-width, then saturation and lightness. */
  emissive: [number, number, number, number];
}

// Saturation is the number to be most careful with. The first pass ran heroes at
// 0.36 and creeps at 0.42 and the cast came back as cyan and fire-engine red —
// a toy set, not an army. These are the values where the law still reads at
// 79 px and the figures still look like dyed cloth and stained plate.
const LAWS: Record<Faction, FactionLaw> = {
  hero: {
    hue: [214, 18],
    saturation: 0.27,
    lightness: 0.3,
    secondary: { hueShift: 26, saturation: 0.11, lightness: 0.15 },
    accent: [41, 0.44, 0.38],
    emissive: [38, 10, 0.85, 0.58],
  },
  creep: {
    hue: [2, 26],
    saturation: 0.29,
    lightness: 0.2,
    secondary: { hueShift: -20, saturation: 0.13, lightness: 0.11 },
    accent: [38, 0.1, 0.44],
    emissive: [282, 14, 0.7, 0.55],
  },
  boss: {
    hue: [6, 16],
    saturation: 0.34,
    lightness: 0.3,
    secondary: { hueShift: -16, saturation: 0.16, lightness: 0.14 },
    accent: [354, 0.42, 0.32],
    emissive: [288, 10, 0.74, 0.57],
  },
};

/** Character ids are namespaced `hero.` / `creep.` / `boss.` by the catalog. */
function factionOf(defId: string): Faction {
  const kind = defId.slice(0, defId.indexOf('.'));
  return kind === 'hero' || kind === 'boss' ? kind : 'creep';
}

/**
 * Maps an authored palette into its faction's window.
 *
 * The character's own authored hue sets where inside the band it lands, so the
 * cast still spreads across the window instead of collapsing onto one colour.
 */
function factionPalette(src: Palette, faction: Faction): Palette {
  const law = LAWS[faction];
  // Position in the band from the authored hue: a full turn of authored hue
  // sweeps the band once, so two characters the catalog gave different colours
  // stay different here.
  const t = hueOf(src.primary) / 360 - 0.5;
  const hue = law.hue[0] + t * 2 * law.hue[1];
  const sec = law.secondary;

  // A hue band alone collapses a faction onto one colour, which is the failure
  // mode of every "team colour" system: allegiance reads, individuals do not.
  // The authored lightness is kept as a multiplier on the faction's value, so a
  // character the catalog painted pale stays the pale one of its faction. That
  // is what keeps Vesper of the First Light lighter than Talon of the Silent
  // Grove after both have been pulled into the same blue.
  const value = 0.8 + 0.4 * lightnessOf(src.primary);
  const light = law.lightness * value;

  return {
    primary: hsl(hue, law.saturation, light),
    secondary: hsl(hue + sec.hueShift, sec.saturation, sec.lightness * value),
    accent: hsl(law.accent[0], law.accent[1], law.accent[2]),
    emissive: hsl(
      law.emissive[0] + (hueOf(src.emissive) / 360 - 0.5) * 2 * law.emissive[1],
      law.emissive[2],
      law.emissive[3],
    ),
  };
}

/**
 * Slot roughness as a multiplier on the map, raised until the map's glossiest
 * texel still clears the slot's physical floor.
 *
 * The catalog authors these as multipliers, and `MeshStandardMaterial` multiplies
 * them into the roughness map — so a 0.42 "matte-ish plate" against a map whose
 * floor is 0.18 produced an effective 0.08, which is chrome. Solving against the
 * recipe's own minimum keeps the catalog's *relative* intent (a 0.32 slot is
 * still glossier than a 0.55 one) while making the floor absolute.
 */
function slotRoughness(cfg: SlotConfig, slot: SlotName): number {
  const floor = CHARACTER_SHADING.roughnessFloor[slot] ?? 0.5;
  const recipe = materials.recipe(cfg.material);
  const needed = floor / Math.max(recipe.roughness.min, 1e-3);
  // Solved against the recipe's floor, not against its glossiest polished tint:
  // a tint that only touches convex crowns should not drag the whole surface to
  // matte. The 1.8 ceiling is what `structure.gold` needs — the hero trim
  // material, which the catalog asks for at 0.24–0.34 and whose own floor is
  // 0.16, so without this the trim was still a mirror.
  return Math.min(Math.max(cfg.roughness ?? 1, needed), 1.8);
}

// ── Colour helpers ───────────────────────────────────────────────────────────

/** Hue of an sRGB hex, degrees. Returns 0 for greys. */
function hueOf(hex: number): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-6) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** HSL to sRGB hex. Hue in degrees, wrapped. */
function hsl(h: number, s: number, l: number): number {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = l - c / 2;
  let rgb: [number, number, number];
  if (hh < 1) rgb = [c, x, 0];
  else if (hh < 2) rgb = [x, c, 0];
  else if (hh < 3) rgb = [0, c, x];
  else if (hh < 4) rgb = [0, x, c];
  else if (hh < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const to = (v: number) => Math.max(0, Math.min(255, Math.round((v + m) * 255)));
  return (to(rgb[0]) << 16) | (to(rgb[1]) << 8) | to(rgb[2]);
}

/** HSL lightness of an sRGB hex, 0..1. */
function lightnessOf(hex: number): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

function hexToLinear(hex: number): [number, number, number] {
  return [
    srgbToLinear(((hex >> 16) & 0xff) / 255),
    srgbToLinear(((hex >> 8) & 0xff) / 255),
    srgbToLinear((hex & 0xff) / 255),
  ];
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

/** Weld key: position, normal, uv and skin binding must all match to merge. */
function weldKey(a: SlotAccum, i: number): string {
  const p = 1e4;
  const n = 1e3;
  const t = 1e3;
  return (
    `${Math.round(a.position[i * 3]! * p)},${Math.round(a.position[i * 3 + 1]! * p)},${Math.round(a.position[i * 3 + 2]! * p)}|` +
    `${Math.round(a.normal[i * 3]! * n)},${Math.round(a.normal[i * 3 + 1]! * n)},${Math.round(a.normal[i * 3 + 2]! * n)}|` +
    `${Math.round(a.uv[i * 2]! * t)},${Math.round(a.uv[i * 2 + 1]! * t)}|` +
    `${a.skinIndex[i * 4]},${a.skinIndex[i * 4 + 1]},${a.skinIndex[i * 4 + 2]},${a.skinIndex[i * 4 + 3]}|` +
    `${Math.round(a.skinWeight[i * 4]! * 255)},${Math.round(a.skinWeight[i * 4 + 1]! * 255)}`
  );
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

// ─────────────────────────────────────────────────────────────────────────────
// Tint compensation
//
// `MeshStandardMaterial.color` MULTIPLIES the albedo map, and the unit maps are
// authored with their own chroma (cloth is dusty violet, chitin near-black).
// A mid-tone palette colour times a dark map lands near black — the exact
// failure the first showcase capture showed. The fix: treat the palette entry
// as the colour the surface should APPEAR, and solve for the tint that gets
// there — target ÷ map-average, computed in linear space where the GPU does the
// multiply, clamped at white (a tint cannot brighten past the map itself).
// The map's texture detail survives because only the mean is normalised.
// ─────────────────────────────────────────────────────────────────────────────

const AVG_ALBEDO = new Map<MaterialId, [number, number, number]>();

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Mean linear-space albedo of a generated material map, sampled sparsely. */
function averageAlbedo(id: MaterialId): [number, number, number] {
  let avg = AVG_ALBEDO.get(id);
  if (avg) return avg;
  const image = materials.textures(id).albedo.image as {
    data?: Uint8Array | Uint8ClampedArray;
  };
  const data = image?.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  if (data && data.length >= 4) {
    const stride = 4 * 13; // sparse, stride co-prime with row length
    for (let i = 0; i + 2 < data.length; i += stride) {
      r += srgbToLinear(data[i]! / 255);
      g += srgbToLinear(data[i + 1]! / 255);
      b += srgbToLinear(data[i + 2]! / 255);
      n++;
    }
  }
  avg = n > 0 ? [r / n, g / n, b / n] : [0.5, 0.5, 0.5];
  AVG_ALBEDO.set(id, avg);
  return avg;
}

/** Tint that makes `id`'s map average out to the target colour on screen. */
function compensateTint(target: number, id: MaterialId): number {
  const avg = averageAlbedo(id);
  const tr = srgbToLinear(((target >> 16) & 0xff) / 255);
  const tg = srgbToLinear(((target >> 8) & 0xff) / 255);
  const tb = srgbToLinear((target & 0xff) / 255);
  const r = Math.min(1, tr / Math.max(avg[0], 1e-4));
  const g = Math.min(1, tg / Math.max(avg[1], 1e-4));
  const b = Math.min(1, tb / Math.max(avg[2], 1e-4));
  return (
    (Math.round(linearToSrgb(r) * 255) << 16) |
    (Math.round(linearToSrgb(g) * 255) << 8) |
    Math.round(linearToSrgb(b) * 255)
  );
}
