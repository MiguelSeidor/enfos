/**
 * Character catalog. Owner: CHARACTERS agent.
 *
 * Four heroes, the five enemy roles the GDD §13 bestiary requires, and one
 * boss. Every mass here exists to serve the outline, because the real viewing
 * condition is 41.5 screen pixels per world metre: a 1.9 m creature is 79 px
 * tall, in motion, in a crowd. At that size identity lives in the SILHOUETTE
 * and in gross proportion. Surface detail does not survive the trip.
 *
 * The enemies are cast as familiar fantasy creatures rather than abstract
 * archetypes, because a shared cultural shape is the only thing that reads in
 * one glance: an orc is tusks and a hunch, a dragon is a wing span. An abstract
 * name produces an abstract shape and a new player learns nothing from it.
 *
 *   bulwark    hero   wide trapezoid, slab shield left, hammer right
 *   oracle     hero   tall cone, fan collar, big ring on a staff
 *   talon      hero   narrow vertical, hood, tall recurve bow
 *   vesper     hero   robe bell, halo over the head, swinging lantern
 *   cleaver    orc    hunched back, tusks breaking the head outline, cleaver
 *   spinebolt  goblin small, ears wider than the shoulders, crossbow
 *   duskrunner wolf   QUADRUPED — the only body longer than it is tall
 *   bastion    ogre   gut wider than the shoulders, tiny head, club diagonal
 *   hexwright  mage   brimmed pointed hat, floor-length robe, tall staff
 *   titan      dragon WINGED FLYER — 4 m span, off the ground, long tail
 *
 * The roster deliberately spans six body plans (hunched brute, small biped,
 * quadruped, mass biped, robed biped, flyer) rather than six dressings of one
 * biped, since at 79 px skeleton layout is the only variation that survives.
 *
 * Nothing here is derived from any existing game's art: creature types like
 * "orc" or "dragon" are generic, and every shape is generated from parameters
 * authored in this file.
 */

import * as THREE from 'three';
import type { VisualDescriptor } from '@/core/contracts';
import type { MaterialId } from '@/art/materials';
import { CharacterBuilder, type Palette, type SlotConfig, type SlotName } from './build/character';
import { addBody, boneDistance, limbGeo, rw } from './build/body';
import { hasPart } from './build/parts';
import {
  blade,
  gem,
  lathe,
  loft,
  plate,
  prism,
  roughen,
  shell,
  spike,
  sphereish,
  torus,
  wing,
  type Ring,
} from './build/shapes';
import { B, buildRig, DEFAULT_PROPORTIONS, type Proportions, type Rig } from './rig/rig';
import { DEFAULT_PROFILE, type AnimProfile } from './anim/clips';

export interface CharacterDef {
  id: string;
  name: string;
  kind: 'hero' | 'creep' | 'boss';
  archetype: string;
  proportions: Proportions;
  profile: AnimProfile;
  slots: Partial<Record<SlotName, SlotConfig>>;
  palette: Palette;
  visual: VisualDescriptor;
  build(b: CharacterBuilder, rig: Rig): void;
}

const prop = (o: Partial<Proportions>): Proportions => ({ ...DEFAULT_PROPORTIONS, ...o });
const profile = (o: Partial<AnimProfile>): AnimProfile => ({ ...DEFAULT_PROFILE, ...o });

const slot = (material: MaterialId, o: Partial<SlotConfig> = {}): SlotConfig => ({ material, ...o });

const visual = (id: string, silhouette: string, pal: Palette, scale: number, tags: string[]): VisualDescriptor => ({
  silhouette,
  palette: pal,
  scale,
  rigId: `rig.${id}`,
  materialTags: tags,
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared kit helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Chunky angular shoulder mass. Solid, not a thin curved plate — reads at range. */
function pauldron(
  b: CharacterBuilder,
  rig: Rig,
  side: 'L' | 'R' | 'both',
  o: { size: number; slot: SlotName; lames?: number; tiltOut?: number; spike?: number; spikeSlot?: SlotName },
): void {
  const p = rig.proportions;
  const s = o.size;
  const bone = side === 'R' ? 'shoulder.R' : 'shoulder.L';
  const mirror = side === 'both';
  const tilt = o.tiltOut ?? 0.35;

  b.add(
    loft(
      [
        { y: -s * 0.72, w: s * 1.06, d: s * 0.98, round: 5 },
        { y: -s * 0.2, w: s * 1.14, d: s * 1.08, round: 5.5 },
        { y: s * 0.24, w: s * 0.94, d: s * 0.9, round: 5 },
        { y: s * 0.56, w: s * 0.48, d: s * 0.46, round: 4 },
      ],
      { segments: 10, smoothAngle: 42 },
    ),
    {
      slot: o.slot,
      bone,
      at: [s * 0.42, s * 0.34, 0],
      rot: [0, 0, -tilt],
      mirror,
      bind: { bones: [bone], rigid: true },
      uvScale: 1.3,
    },
  );

  for (let i = 0; i < (o.lames ?? 2); i++) {
    const t = i + 1;
    b.add(
      loft(
        [
          { y: -s * 0.16, w: s * (1.05 - t * 0.12), d: s * (0.98 - t * 0.1), round: 6 },
          { y: s * 0.08, w: s * (1.12 - t * 0.12), d: s * (1.04 - t * 0.1), round: 6 },
        ],
        { segments: 10, smoothAngle: 34 },
      ),
      {
        slot: o.slot,
        bone,
        at: [s * (0.42 - t * 0.05), s * (0.34 - t * 0.42), 0],
        rot: [0, 0, -tilt],
        mirror,
        bind: { bones: [bone], rigid: true },
        uvScale: 1.1,
      },
    );
  }

  if (o.spike) {
    b.add(spike({ length: s * o.spike, baseW: s * 0.28, curve: -0.5, taper: 1.9 }), {
      slot: o.spikeSlot ?? o.slot,
      bone,
      at: [s * 0.62, s * 0.5, 0],
      rot: [-0.5, 0, -0.75],
      mirror,
      bind: { bones: [bone], rigid: true },
      uvScale: 0.8,
    });
  }

  void p;
}

/** A row of spikes along a bone, growing then shrinking. Backs and crowns. */
function spikeRow(
  b: CharacterBuilder,
  rig: Rig,
  o: {
    bone: string;
    count: number;
    from: [number, number, number];
    to: [number, number, number];
    length: number;
    baseW: number;
    slot: SlotName;
    curve?: number;
    tilt?: number;
    bind?: string[];
  },
): void {
  for (let i = 0; i < o.count; i++) {
    const t = o.count === 1 ? 0.5 : i / (o.count - 1);
    const bell = 0.45 + 0.55 * Math.sin(Math.PI * (0.18 + t * 0.64));
    b.add(
      spike({
        length: o.length * bell,
        baseW: o.baseW * bell,
        curve: o.curve ?? -0.45,
        taper: 2.1,
        segments: 6,
      }),
      {
        slot: o.slot,
        bone: o.bone,
        at: [
          o.from[0]! + (o.to[0]! - o.from[0]!) * t,
          o.from[1]! + (o.to[1]! - o.from[1]!) * t,
          o.from[2]! + (o.to[2]! - o.from[2]!) * t,
        ],
        rot: [o.tilt ?? -0.5, 0, 0],
        bind: { bones: o.bind ?? [o.bone], rigid: true },
        uvScale: 0.7,
      },
    );
  }
  void rig;
}

/** Cloth panel hanging from the torso: tabard, loincloth, banner. */
function clothPanel(
  b: CharacterBuilder,
  rig: Rig,
  o: {
    slot: SlotName;
    bones: string[];
    topY: number;
    bottomY: number;
    topW: number;
    bottomW: number;
    z: number;
    sway?: number;
    thickness?: number;
    /** Cuts the hem into a V or a point. */
    hemPoint?: number;
  },
): void {
  const span = o.topY - o.bottomY;
  b.add(
    shell({
      nu: 5,
      nv: 8,
      surface: (u, v, out) => {
        const w = o.bottomW + (o.topW - o.bottomW) * v;
        const hem = (o.hemPoint ?? 0) * (1 - Math.abs(u - 0.5) * 2);
        out.set(
          (u - 0.5) * w,
          o.bottomY + span * v - (1 - v) * hem * span,
          o.z + Math.sin((1 - v) * 2.4) * (o.sway ?? 0.02) + Math.cos((u - 0.5) * 3.1) * 0.012,
        );
      },
      thickness: () => o.thickness ?? 0.012,
      uvScale: 1.4,
      smoothAngle: 46,
    }),
    {
      slot: o.slot,
      bind: { bones: o.bones, falloff: span * 0.42, bias: 1.05 },
      uvScale: 1,
    },
  );
  void rig;
}

/** Skinned cape hanging from the cape bone chain. */
function cape(
  b: CharacterBuilder,
  rig: Rig,
  o: { slot: SlotName; width: number; length: number; flare: number; z?: number; thickness?: number },
): void {
  const p = rig.proportions;
  const bones: string[] = [];
  for (let i = 0; i < p.capeSegments; i++) bones.push(`cape${i}`);
  if (bones.length === 0) return;
  const top = rw(rig, 'cape0');
  const topY = top[1];
  const bottomY = topY - o.length;

  b.add(
    shell({
      nu: 7,
      nv: 9,
      surface: (u, v, out) => {
        const w = o.width * (1 + o.flare * (1 - v));
        const k = (u - 0.5) * 2;
        out.set(
          k * w * 0.5,
          bottomY + (topY - bottomY) * v,
          (o.z ?? -0.06) - (1 - v) * 0.09 - k * k * w * 0.28 + Math.sin((1 - v) * 3.2 + k) * 0.02,
        );
      },
      thickness: () => o.thickness ?? 0.014,
      uvScale: 1.8,
      smoothAngle: 50,
    }),
    {
      slot: o.slot,
      bind: { bones: [...bones].reverse(), falloff: o.length * 0.28, bias: 1.0 },
      uvScale: 1,
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Warden of the Iron Vow — heavy tank hero
// ─────────────────────────────────────────────────────────────────────────────

const BULWARK_PALETTE: Palette = {
  primary: 0x5c6a7c,
  secondary: 0x7a1f28,
  accent: 0xc08a2e,
  emissive: 0xffb347,
};

const bulwark: CharacterDef = {
  id: 'hero.bulwark',
  name: 'Warden of the Iron Vow',
  kind: 'hero',
  archetype: 'Tank',
  proportions: prop({
    height: 2.62,
    legFraction: 0.43,
    hipHalfWidth: 0.21,
    shoulderHalfWidth: 0.44,
    torsoFraction: 0.31,
    neckLength: 0.045,
    headSize: 0.25,
    armFraction: 0.4,
    stoop: 0.1,
    capeSegments: 4,
    footLength: 0.32,
  }),
  profile: profile({
    idlePeriod: 5.1,
    breath: 1.35,
    stanceWidth: 1.55,
    crouch: 0.55,
    armSplay: 0.4,
    walkSpeed: 2.6,
    runSpeed: 4.2,
    stride: 1.05,
    stanceFraction: 0.66,
    bob: 0.075,
    lean: 0.07,
    armSwing: 0.34,
    footLift: 0.13,
    attackDuration: 1.35,
    attackStyle: 'overhead',
    castDuration: 1.9,
    castStyle: 'summon',
    weight: 1,
    capeSegments: 4,
  }),
  slots: {
    armor: slot('unit.steel', { tint: 'primary', roughness: 0.42, metalness: 1 }),
    cloth: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'none', metalness: 0 }),
    metal: slot('structure.gold', { tint: 'accent', roughness: 0.3, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'none', metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 3.2 }),
  },
  palette: BULWARK_PALETTE,
  visual: visual('hero.bulwark', 'wide-trapezoid-shield-slab', BULWARK_PALETTE, 1, ['steel', 'cloth', 'gold']),
  build(b, rig) {
    const p = rig.proportions;
    addBody(b, rig, {
      torsoSlot: 'armor',
      limbSlot: 'armor',
      handSlot: 'leather',
      headSlot: 'flesh',
      bootSlot: 'armor',
      round: 5.2,
      chestScale: 1.06,
      waistScale: 0.9,
      armScale: 1.15,
      legScale: 1.2,
      handScale: 1.5,
      bootScale: 1.5,
      depthRatio: 0.8,
      head: true,
    });

    const chest = rw(rig, B.chest);
    const pelvis = rw(rig, B.pelvis);
    const head = rw(rig, B.head);

    // Breastplate with a raised central ridge.
    b.add(plate({ width: p.shoulderHalfWidth * 1.72, height: 0.46, thickness: 0.036, bow: 0.34, topScale: 1.02, bottomScale: 0.68, droop: 0.06 }), {
      slot: 'armor',
      at: [0, chest[1] - 0.3, chest[2] + 0.03],
      bind: { bones: [B.chest, B.spine], falloff: 0.2, bias: 1.5 },
      uvScale: 1.4,
    });
    b.add(prism({ h: 0.4, w0: 0.05, d0: 0.06, w1: 0.028, d1: 0.05, round: 3, segments: 6 }), {
      slot: 'metal',
      at: [0, chest[1] - 0.26, chest[2] + p.shoulderHalfWidth * 0.62],
      bind: { bones: [B.chest], rigid: true },
      uvScale: 0.6,
    });

    // Gorget.
    b.add(torus(p.headSize * 0.62, p.headSize * 0.19, 6, 14), {
      slot: 'armor',
      bone: B.neck,
      at: [0, -0.01, 0],
      rot: [Math.PI / 2, 0, 0],
      bind: { bones: [B.neck, B.chest], rigid: true },
      uvScale: 1.2,
    });

    pauldron(b, rig, 'both', { size: 0.3, slot: 'armor', lames: 3, tiltOut: 0.42, spike: 1.5, spikeSlot: 'metal' });

    // Tassets and tabard.
    clothPanel(b, rig, {
      slot: 'cloth',
      bones: [B.pelvis, B.spine],
      topY: chest[1] - 0.12,
      bottomY: pelvis[1] - 0.44,
      topW: 0.32,
      bottomW: 0.26,
      z: p.hipHalfWidth * 0.95,
      hemPoint: 0.22,
      thickness: 0.014,
    });
    for (const sx of [-1, 1]) {
      b.add(plate({ width: 0.2, height: 0.28, thickness: 0.03, bow: 0.16, bottomScale: 0.8, topScale: 1 }), {
        slot: 'armor',
        at: [sx * p.hipHalfWidth * 1.35, pelvis[1] - 0.32, p.hipHalfWidth * 0.55],
        rot: [0.1, sx * 0.35, 0],
        bind: { bones: [B.pelvis], rigid: true },
        uvScale: 1.1,
      });
    }

    cape(b, rig, { slot: 'cloth', width: 0.62, length: p.height * 0.66, flare: 0.5, z: -0.08 });

    // Helm: closed visor, brow ridge, two big back-swept horns.
    b.add(
      loft(
        [
          { y: -p.headSize * 0.5, w: p.headSize * 0.9, d: p.headSize * 1.0, round: 4 },
          { y: -p.headSize * 0.1, w: p.headSize * 1.08, d: p.headSize * 1.14, z: p.headSize * 0.04, round: 4.2 },
          { y: p.headSize * 0.5, w: p.headSize * 1.02, d: p.headSize * 1.05, round: 4.2 },
          { y: p.headSize * 0.95, w: p.headSize * 0.62, d: p.headSize * 0.66, round: 4 },
        ],
        { segments: 12, smoothAngle: 44 },
      ),
      {
        slot: 'armor',
        bone: B.head,
        at: [0, p.headSize * 0.36, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1.2,
      },
    );
    b.add(prism({ h: 0.05, w0: 0.028, d0: p.headSize * 0.55, w1: 0.02, d1: p.headSize * 0.5, round: 4, segments: 6 }), {
      slot: 'glow',
      bone: B.head,
      at: [0, p.headSize * 0.34, p.headSize * 0.92],
      rot: [Math.PI / 2, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.5,
    });
    b.add(spike({ length: p.headSize * 2.3, baseW: p.headSize * 0.24, curve: -0.62, taper: 1.7 }), {
      slot: 'metal',
      bone: B.head,
      at: [p.headSize * 0.72, p.headSize * 0.72, -p.headSize * 0.1],
      rot: [-0.45, 0, -0.62],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.7,
    });

    // Vambraces and knee cops.
    b.add(prism({ h: 0.2, w0: 0.1, d0: 0.11, w1: 0.085, d1: 0.09, round: 5, segments: 8 }), {
      slot: 'armor',
      bone: 'elbow.L',
      at: [0, -0.19, 0],
      mirror: true,
      bind: { bones: ['elbow.L', 'wrist.L'], rigid: true },
      uvScale: 1.1,
    });
    b.add(sphereish(0.1, 8, 6, 0.85), {
      slot: 'armor',
      bone: 'knee.L',
      at: [0, 0, 0.03],
      mirror: true,
      bind: { bones: ['knee.L'], rigid: true },
      uvScale: 1,
    });

    // ── Tower shield, left hand. The single largest silhouette element.
    const shieldH = p.height * 0.62;
    const shieldW = 0.66;
    b.add(
      shell({
        nu: 9,
        nv: 12,
        surface: (u, v, out) => {
          const k = (u - 0.5) * 2;
          // Tapers to a point at the bottom; flat top with a slight crown.
          const taper = v < 0.22 ? 0.35 + 0.65 * (v / 0.22) : 1;
          const crown = v > 0.9 ? 1 - (v - 0.9) * 1.4 : 1;
          out.set(k * shieldW * 0.5 * taper * crown, shieldH * v, -0.22 * (1 - k * k) - 0.1 * (1 - Math.pow(2 * v - 1, 2)));
        },
        thickness: () => 0.03,
        uvScale: 2.1,
        smoothAngle: 42,
      }),
      {
        slot: 'armor',
        bone: 'hand.L',
        at: [-0.16, -shieldH * 0.42, 0.16],
        rot: [0.06, 0.16, 0.1],
        bind: { bones: ['hand.L'], rigid: true },
        uvScale: 1,
      },
    );
    b.add(lathe([[0, 0], [0.1, 0.02], [0.13, 0.06], [0.09, 0.12], [0, 0.15]], 12), {
      slot: 'metal',
      bone: 'hand.L',
      at: [-0.16, shieldH * 0.08, 0.02],
      rot: [-Math.PI / 2, 0, 0],
      bind: { bones: ['hand.L'], rigid: true },
      uvScale: 1,
    });
    b.add(gem(0.062, 1), {
      slot: 'glow',
      bone: 'hand.L',
      at: [-0.16, shieldH * 0.08, -0.1],
      bind: { bones: ['hand.L'], rigid: true },
      uvScale: 1,
    });

    // ── War maul, right hand.
    b.add(prism({ h: 0.94, w0: 0.038, d0: 0.038, w1: 0.032, d1: 0.032, round: 6, segments: 8 }), {
      slot: 'leather',
      bone: 'hand.R',
      at: [0, -0.3, 0.02],
      rot: [0.22, 0, 0.1],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1.4,
    });
    b.add(
      loft(
        [
          { y: 0, w: 0.13, d: 0.15, round: 6 },
          { y: 0.09, w: 0.16, d: 0.19, round: 7 },
          { y: 0.25, w: 0.16, d: 0.19, round: 7 },
          { y: 0.34, w: 0.12, d: 0.14, round: 6 },
        ],
        { segments: 10, smoothAngle: 36 },
      ),
      {
        slot: 'armor',
        bone: 'hand.R',
        at: [-0.06, 0.32, 0.15],
        rot: [0.22, 0, 0.1],
        bind: { bones: ['hand.R'], rigid: true },
        uvScale: 1.3,
      },
    );
    for (const sz of [-1, 1]) {
      b.add(spike({ length: 0.19, baseW: 0.06, curve: 0, taper: 1.6, segments: 6 }), {
        slot: 'metal',
        bone: 'hand.R',
        at: [-0.06, 0.47, 0.15 + sz * 0.18],
        rot: [sz > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0.1],
        bind: { bones: ['hand.R'], rigid: true },
        uvScale: 0.6,
      });
    }
    void head;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. Oracle of the Ember Vigil — ranged caster hero
// ─────────────────────────────────────────────────────────────────────────────

const ORACLE_PALETTE: Palette = {
  primary: 0x453466,
  secondary: 0xc4621e,
  accent: 0xd9b45c,
  emissive: 0xff8a2b,
};

const oracle: CharacterDef = {
  id: 'hero.oracle',
  name: 'Oracle of the Ember Vigil',
  kind: 'hero',
  archetype: 'AoECaster',
  proportions: prop({
    height: 2.78,
    legType: 'robe',
    legFraction: 0.5,
    hipHalfWidth: 0.15,
    shoulderHalfWidth: 0.26,
    torsoFraction: 0.3,
    neckLength: 0.08,
    headSize: 0.2,
    armFraction: 0.46,
    stoop: -0.04,
    capeSegments: 5,
    orbitCount: 3,
  }),
  profile: profile({
    idlePeriod: 4.2,
    breath: 0.85,
    stanceWidth: 1,
    crouch: 0,
    armSplay: 0.24,
    walkSpeed: 3.0,
    runSpeed: 4.6,
    stride: 1.0,
    bob: 0.02,
    lean: 0.05,
    armSwing: 0.22,
    attackDuration: 1.15,
    attackStyle: 'thrust',
    castDuration: 2.0,
    castStyle: 'channel',
    weight: 0.25,
    hover: true,
    capeSegments: 5,
    orbitCount: 3,
    orbitRadius: 0.52,
  }),
  slots: {
    armor: slot('unit.steel', { tint: 'accent', roughness: 0.34, metalness: 1 }),
    cloth: slot('unit.cloth', { tint: 'primary', metalness: 0 }),
    leather: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    metal: slot('structure.gold', { tint: 'accent', roughness: 0.26, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'none', metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 4.2 }),
  },
  palette: ORACLE_PALETTE,
  visual: visual('hero.oracle', 'tall-cone-fan-collar-ring-staff', ORACLE_PALETTE, 1, ['cloth', 'gold']),
  build(b, rig) {
    const p = rig.proportions;
    addBody(b, rig, {
      torsoSlot: 'cloth',
      limbSlot: 'cloth',
      handSlot: 'flesh',
      headSlot: 'flesh',
      round: 3.4,
      chestScale: 0.94,
      waistScale: 1.0,
      armScale: 0.72,
      handScale: 1.0,
      depthRatio: 0.82,
      robe: { slot: 'cloth', flare: 0.46 },
      // Robe-violet hair and eye band against skin: the head carries two
      // values of its own instead of relying on the crown alone.
      face: { eyeSlot: 'cloth', hairSlot: 'cloth', hair: 0.34 },
    });

    const chest = rw(rig, B.chest);
    const neck = rw(rig, B.neck);
    const headP = rw(rig, B.head);

    // ── Fan collar: the hero's signature. A tall shell standing behind the head.
    b.add(
      shell({
        nu: 13,
        nv: 7,
        surface: (u, v, out) => {
          const k = (u - 0.5) * 2;
          const spread = 0.5 + 0.5 * v;
          // Scalloped upper edge so the fan reads as ribbed cloth, not a disc.
          const scallop = 1 - 0.12 * Math.abs(Math.sin(k * Math.PI * 3));
          out.set(
            k * 0.52 * spread,
            neck[1] - 0.08 + v * 0.62 * scallop - k * k * 0.14,
            -0.06 - v * 0.2 - k * k * 0.16,
          );
        },
        thickness: (_u, v) => 0.016 + 0.014 * (1 - v),
        uvScale: 2.2,
        smoothAngle: 44,
      }),
      {
        slot: 'cloth',
        bind: { bones: [B.chest, B.neck], falloff: 0.34, bias: 1.4 },
        uvScale: 1,
      },
    );
    for (let i = 0; i < 5; i++) {
      const t = (i / 4 - 0.5) * 2;
      b.add(prism({ h: 0.56, w0: 0.014, d0: 0.02, w1: 0.008, d1: 0.014, round: 4, segments: 5 }), {
        slot: 'metal',
        at: [t * 0.42, neck[1] - 0.06 - t * t * 0.12, -0.09 - t * t * 0.14],
        rot: [-0.32, 0, -t * 0.24],
        bind: { bones: [B.chest, B.neck], falloff: 0.34, bias: 1.4 },
        uvScale: 0.5,
      });
    }

    // Shoulder mantle, layered.
    for (let i = 0; i < 2; i++) {
      b.add(
        plate({
          width: 0.22 - i * 0.03,
          height: 0.2 - i * 0.03,
          thickness: 0.014,
          bow: 0.2,
          droop: 0.16,
          bottomScale: 1.1,
          topScale: 0.7,
        }),
        {
          slot: 'leather',
          bone: 'shoulder.L',
          at: [0.03, 0.02 - i * 0.11, 0],
          rot: [0.1, 0, -0.5],
          mirror: true,
          bind: { bones: ['shoulder.L'], rigid: true },
          uvScale: 1.2,
        },
      );
    }

    // Sash and hem trim.
    clothPanel(b, rig, {
      slot: 'leather',
      bones: [B.chest, B.spine, B.pelvis],
      topY: chest[1] + 0.04,
      bottomY: chest[1] - 0.62,
      topW: 0.15,
      bottomW: 0.2,
      z: p.hipHalfWidth * 1.15,
      hemPoint: 0.3,
      thickness: 0.011,
    });

    cape(b, rig, { slot: 'cloth', width: 0.4, length: p.height * 0.72, flare: 0.9, z: -0.05 });

    // ── Crown: a low band with a tall crescent behind it.
    b.add(torus(p.headSize * 0.86, p.headSize * 0.1, 5, 14), {
      slot: 'metal',
      bone: B.head,
      at: [0, p.headSize * 0.62, 0],
      rot: [Math.PI / 2, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1.2,
    });
    b.add(
      shell({
        nu: 9,
        nv: 5,
        surface: (u, v, out) => {
          const k = (u - 0.5) * 2;
          const r = 0.3 + v * 0.16;
          const a = k * 1.15;
          out.set(Math.sin(a) * r, headP[1] + p.headSize * 0.8 + Math.cos(a) * r * 0.62 + v * 0.05, -0.04 - v * 0.03);
        },
        thickness: () => 0.014,
        uvScale: 1.6,
        smoothAngle: 40,
      }),
      {
        slot: 'metal',
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    b.add(gem(0.05, 1), {
      slot: 'glow',
      bone: B.head,
      at: [0, p.headSize * 0.72, p.headSize * 0.82],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // ── Staff: haft well above the head, topped with a large open ring.
    const staffLen = p.height * 0.98;
    b.add(prism({ h: staffLen, w0: 0.026, d0: 0.026, w1: 0.021, d1: 0.021, round: 8, segments: 7 }), {
      slot: 'leather',
      bone: 'hand.R',
      at: [0.02, -staffLen * 0.42, 0.05],
      rot: [0.08, 0, -0.06],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 2.2,
    });
    const ringY = staffLen * 0.58 + 0.24;
    b.add(torus(0.235, 0.031, 6, 22), {
      slot: 'metal',
      bone: 'hand.R',
      at: [0.02 + 0.02, ringY, 0.05 + 0.05],
      rot: [0.08, 0, -0.06],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 2,
    });
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.5;
      b.add(spike({ length: 0.16, baseW: 0.028, curve: 0, taper: 1.8, segments: 5 }), {
        slot: 'metal',
        bone: 'hand.R',
        at: [0.04 + Math.sin(a) * 0.235, ringY + Math.cos(a) * 0.235, 0.1],
        rot: [0, 0, -a],
        bind: { bones: ['hand.R'], rigid: true },
        uvScale: 0.6,
      });
    }
    b.add(gem(0.085, 1), {
      slot: 'glow',
      bone: 'hand.R',
      at: [0.04, ringY, 0.1],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1,
    });

    // Orbiting embers.
    for (let i = 0; i < p.orbitCount; i++) {
      b.add(gem(0.052, 0), {
        slot: 'glow',
        bone: `orbit${i}`,
        bind: { bones: [`orbit${i}`], rigid: true },
        uvScale: 1,
      });
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Talon of the Silent Grove — ranged marksman hero
//
// Reads as a vertical line broken by one shape: the tall recurve bow held at
// her side. Everything else is kept tight — hood, short cloak, no pauldron on
// the draw arm — so the bow is the only thing the silhouette says.
// ─────────────────────────────────────────────────────────────────────────────

const TALON_PALETTE: Palette = {
  primary: 0x2f4a33,
  secondary: 0x6b4a2c,
  accent: 0xc9b06a,
  emissive: 0x8ff0a8,
};

const talon: CharacterDef = {
  id: 'hero.talon',
  name: 'Talon of the Silent Grove',
  kind: 'hero',
  archetype: 'Marksman',
  proportions: prop({
    height: 2.66,
    legFraction: 0.5,
    hipHalfWidth: 0.15,
    shoulderHalfWidth: 0.26,
    torsoFraction: 0.28,
    neckLength: 0.06,
    headSize: 0.21,
    armFraction: 0.47,
    stoop: -0.02,
    capeSegments: 3,
    footLength: 0.26,
  }),
  profile: profile({
    idlePeriod: 3.6,
    breath: 0.9,
    stanceWidth: 1,
    crouch: 0.3,
    armSplay: 0.16,
    walkSpeed: 3.6,
    runSpeed: 7.2,
    stride: 1.2,
    stanceFraction: 0.54,
    bob: 0.045,
    lean: 0.16,
    armSwing: 0.5,
    footLift: 0.2,
    attackDuration: 0.75,
    attackStyle: 'shoot',
    castDuration: 1.2,
    castStyle: 'hurl',
    weight: 0.3,
    mainHand: 'R',
    capeSegments: 3,
  }),
  slots: {
    armor: slot('unit.steel', { tint: 'accent', roughness: 0.45, metalness: 0.9 }),
    cloth: slot('unit.cloth', { tint: 'primary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'secondary', metalness: 0 }),
    metal: slot('structure.gold', { tint: 'accent', roughness: 0.34, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'none', metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 3.6 }),
  },
  palette: TALON_PALETTE,
  visual: visual('hero.talon', 'narrow-hood-vertical-longbow', TALON_PALETTE, 1, ['leather', 'cloth', 'gold']),
  build(b, rig) {
    const p = rig.proportions;
    addBody(b, rig, {
      torsoSlot: 'leather',
      limbSlot: 'cloth',
      handSlot: 'leather',
      headSlot: 'flesh',
      bootSlot: 'leather',
      round: 4.4,
      chestScale: 0.94,
      waistScale: 0.84,
      armScale: 0.92,
      legScale: 1,
      handScale: 1,
      bootScale: 1.1,
      depthRatio: 0.62,
      head: true,
      // No hair: the hood owns the back of the skull. The band under the brow
      // is what stops the face reading as a blank oval inside it.
      face: { eyeSlot: 'cloth' },
    });

    const chest = rw(rig, B.chest);
    const pelvis = rw(rig, B.pelvis);
    const head = rw(rig, B.head);

    // ── Hood: a cone that swallows the skull and points back, so the head
    // reads as a beak from any angle. Open at the front, where the face is.
    b.add(
      loft(
        [
          { y: head[1] - p.headSize * 1.15, w: p.headSize * 0.98, d: p.headSize * 1.05, round: 5 },
          { y: head[1] - p.headSize * 0.2, w: p.headSize * 0.92, d: p.headSize * 1.02, round: 5 },
          { y: head[1] + p.headSize * 0.62, w: p.headSize * 0.5, d: p.headSize * 0.66, round: 4 },
          { y: head[1] + p.headSize * 0.95, w: p.headSize * 0.12, d: p.headSize * 0.3, round: 3 },
        ],
        { segments: 12, smoothAngle: 44 },
      ),
      {
        slot: 'cloth',
        bind: { bones: [B.head, B.neck], falloff: p.headSize * 0.8, bias: 1.2 },
        uvScale: 1.3,
      },
    );
    // Brim, angled down over the eyes.
    b.add(plate({ width: p.headSize * 1.05, height: p.headSize * 0.46, thickness: 0.02, bow: 0.32, topScale: 1, bottomScale: 0.72, droop: 0.2 }), {
      slot: 'cloth',
      bone: B.head,
      at: [0, p.headSize * 0.26, p.headSize * 0.62],
      rot: [1.15, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1.1,
    });

    // ── Short cloak, cut away at the front: it must never cross the bow arm.
    cape(b, rig, { slot: 'cloth', width: 0.48, length: 0.8, flare: 0.55, z: -0.05, thickness: 0.012 });

    // ── Chest harness: two straps crossing, one gem where they meet.
    for (const sz of [-1, 1]) {
      b.add(plate({ width: 0.075, height: 0.52, thickness: 0.016, bow: 0.28, topScale: 0.9, bottomScale: 0.9 }), {
        slot: 'leather',
        at: [sz * 0.05, chest[1] - 0.08, p.shoulderHalfWidth * 0.52],
        rot: [0.06, 0, sz * 0.42],
        bind: { bones: [B.chest, B.spine], falloff: 0.3, bias: 1.1 },
        uvScale: 1.2,
      });
    }
    b.add(gem(0.042, 0), {
      slot: 'glow',
      at: [0, chest[1] - 0.06, p.shoulderHalfWidth * 0.6],
      bind: { bones: [B.chest], rigid: true },
      uvScale: 1,
    });

    // ── Bracers: the draw arm gets the heavier one, which is the arm the
    // player watches during the shoot clip.
    for (const side of ['L', 'R'] as const) {
      b.add(
        loft(
          [
            { y: 0, w: 0.075, d: 0.075, round: 5 },
            { y: 0.1, w: 0.085, d: 0.085, round: 5 },
            { y: 0.26, w: 0.07, d: 0.07, round: 5 },
          ],
          { segments: 8, smoothAngle: 40 },
        ),
        {
          slot: side === 'R' ? 'armor' : 'leather',
          bone: `elbow.${side}`,
          at: [0, -0.16, 0],
          bind: { bones: [`elbow.${side}`, `wrist.${side}`], rigid: true },
          uvScale: 1.2,
        },
      );
    }
    // One light shoulder cap, on the bow arm only: asymmetry at the top.
    pauldron(b, rig, 'L', { size: 0.12, slot: 'armor', lames: 1, tiltOut: 0.26 });

    // ── Quiver slung across the back, arrows fanning over the right shoulder.
    b.add(prism({ h: 0.52, w0: 0.075, d0: 0.075, w1: 0.09, d1: 0.09, round: 7, segments: 8 }), {
      slot: 'leather',
      at: [0.13, chest[1] - 0.16, -p.shoulderHalfWidth * 0.62],
      rot: [-0.22, 0, -0.34],
      bind: { bones: [B.chest], rigid: true },
      uvScale: 1.2,
    });
    spikeRow(b, rig, {
      bone: B.chest,
      count: 5,
      from: [0.06, chest[1] + 0.16, -p.shoulderHalfWidth * 0.66],
      to: [0.26, chest[1] + 0.2, -p.shoulderHalfWidth * 0.5],
      length: 0.42,
      baseW: 0.022,
      slot: 'metal',
      curve: 0,
      tilt: -0.3,
      bind: [B.chest],
    });

    // ── The longbow: held upright in the left hand. Vertical where the
    // spinebolt's is horizontal, so the two ranged silhouettes never trade.
    const span = 1.95;
    b.add(
      shell({
        nu: 5,
        nv: 18,
        surface: (u, v, out) => {
          const k = (v - 0.5) * 2;
          const w = 0.05 * (1 - 0.7 * Math.abs(k));
          // Recurve: the limbs sweep forward, then flick back at the tips.
          const sweep = 0.26 * (1 - k * k) - 0.22 * Math.pow(Math.abs(k), 5);
          out.set((u - 0.5) * w * 2, k * span * 0.5, sweep);
        },
        thickness: (_u, v) => 0.03 * (1 - 0.55 * Math.abs((v - 0.5) * 2)) + 0.006,
        uvScale: 2.6,
        smoothAngle: 44,
      }),
      {
        slot: 'metal',
        bone: 'hand.L',
        at: [0.04, 0.02, 0.1],
        rot: [0.12, 0, 0.08],
        bind: { bones: ['hand.L'], rigid: true },
        uvScale: 1,
      },
    );
    // String: a thin taut line between the tips, and a leather grip.
    b.add(prism({ h: span * 0.98, w0: 0.008, d0: 0.008, w1: 0.008, d1: 0.008, round: 3, segments: 2 }), {
      slot: 'glow',
      bone: 'hand.L',
      at: [0.04, 0.02, 0.1 - 0.14],
      rot: [0.12, 0, 0.08],
      bind: { bones: ['hand.L'], rigid: true },
      uvScale: 1,
    });
    b.add(prism({ h: 0.2, w0: 0.045, d0: 0.06, w1: 0.045, d1: 0.06, round: 5, segments: 6 }), {
      slot: 'leather',
      bone: 'hand.L',
      at: [0.04, 0.02, 0.1],
      rot: [0.12, 0, 0.08],
      bind: { bones: ['hand.L'], rigid: true },
      uvScale: 1,
    });

    // ── A single nocked arrow, so the hero reads as ready rather than idle.
    b.add(spike({ length: 0.6, baseW: 0.018, curve: 0, taper: 2.4, segments: 6 }), {
      slot: 'metal',
      bone: 'hand.L',
      at: [0.04, 0.02, 0.02],
      rot: [Math.PI / 2 + 0.12, 0, 0.08],
      bind: { bones: ['hand.L'], rigid: true },
      uvScale: 0.7,
    });

    // Hip pouch, to break the long vertical of the legs.
    b.add(loft(
      [
        { y: 0, w: 0.09, d: 0.07, round: 5 },
        { y: 0.12, w: 0.11, d: 0.085, round: 5 },
        { y: 0.2, w: 0.08, d: 0.06, round: 5 },
      ],
      { segments: 8, smoothAngle: 42 },
    ), {
      slot: 'leather',
      at: [-p.hipHalfWidth * 1.25, pelvis[1] - 0.06, 0.02],
      rot: [0, 0, -0.16],
      bind: { bones: [B.pelvis], rigid: true },
      uvScale: 1.2,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. Vesper of the First Light — healer hero
//
// A bell: wide robe, no legs to read, and two things above the waist that
// nothing else in the cast has — a ring of light floating over the head and a
// lantern swinging from a crook. Where the Oracle is a tall cone that ends in a
// point, Vesper is a cone that ends in a halo.
// ─────────────────────────────────────────────────────────────────────────────

const VESPER_PALETTE: Palette = {
  primary: 0xd6cdb8,
  secondary: 0x7c5a2e,
  accent: 0xe6c469,
  emissive: 0xffe6a8,
};

const vesper: CharacterDef = {
  id: 'hero.vesper',
  name: 'Vesper of the First Light',
  kind: 'hero',
  archetype: 'Healer',
  proportions: prop({
    height: 2.58,
    legType: 'robe',
    legFraction: 0.46,
    hipHalfWidth: 0.18,
    shoulderHalfWidth: 0.3,
    torsoFraction: 0.31,
    neckLength: 0.07,
    headSize: 0.22,
    armFraction: 0.44,
    stoop: 0.04,
    capeSegments: 4,
    orbitCount: 2,
  }),
  profile: profile({
    idlePeriod: 4.6,
    breath: 1,
    stanceWidth: 1,
    crouch: 0.1,
    armSplay: 0.22,
    walkSpeed: 3.1,
    runSpeed: 4.8,
    stride: 1,
    bob: 0.03,
    lean: 0.06,
    armSwing: 0.26,
    attackDuration: 1.1,
    attackStyle: 'thrust',
    castDuration: 1.7,
    castStyle: 'channel',
    weight: 0.35,
    capeSegments: 4,
    orbitCount: 2,
    orbitRadius: 0.44,
  }),
  slots: {
    armor: slot('unit.steel', { tint: 'accent', roughness: 0.32, metalness: 1 }),
    cloth: slot('unit.cloth', { tint: 'primary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'secondary', metalness: 0 }),
    metal: slot('structure.gold', { tint: 'accent', roughness: 0.24, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'none', metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 4.6 }),
  },
  palette: VESPER_PALETTE,
  visual: visual('hero.vesper', 'robe-bell-halo-lantern', VESPER_PALETTE, 1, ['cloth', 'gold']),
  build(b, rig) {
    const p = rig.proportions;
    addBody(b, rig, {
      torsoSlot: 'cloth',
      limbSlot: 'cloth',
      handSlot: 'flesh',
      headSlot: 'flesh',
      round: 5,
      chestScale: 0.98,
      waistScale: 0.92,
      armScale: 0.95,
      handScale: 1,
      depthRatio: 0.7,
      robe: { slot: 'cloth', flare: 0.62, hemNoise: 5 },
      head: true,
      // Brown hair against a cream robe and pale skin: the only dark shape
      // above her shoulders apart from the eye band.
      face: { eyeSlot: 'leather', hairSlot: 'leather', hair: 0.44 },
    });

    const chest = rw(rig, B.chest);
    const pelvis = rw(rig, B.pelvis);
    const head = rw(rig, B.head);

    // ── Halo: a ring of light that hangs above and slightly behind the head.
    // The one shape in the cast that is pure emissive, so it survives at the
    // zoom the game is actually played at.
    b.add(torus(p.headSize * 0.92, 0.022, 8, 28), {
      slot: 'glow',
      bone: B.head,
      at: [0, p.headSize * 1.25, -p.headSize * 0.1],
      rot: [0.34, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });
    b.add(torus(p.headSize * 0.62, 0.014, 6, 22), {
      slot: 'metal',
      bone: B.head,
      at: [0, p.headSize * 1.22, -p.headSize * 0.1],
      rot: [0.34, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // ── Mantle: a wide, soft shoulder piece that makes the bell read from the
    // top down rather than only from the hem up.
    b.add(
      loft(
        [
          { y: chest[1] - 0.02, w: p.shoulderHalfWidth * 1.52, d: p.shoulderHalfWidth * 1.3, round: 6 },
          { y: chest[1] + 0.16, w: p.shoulderHalfWidth * 1.24, d: p.shoulderHalfWidth * 1.06, round: 6 },
          { y: chest[1] + 0.28, w: p.shoulderHalfWidth * 0.7, d: p.shoulderHalfWidth * 0.62, round: 5 },
        ],
        { segments: 14, smoothAngle: 46 },
      ),
      {
        slot: 'cloth',
        bind: { bones: [B.chest, B.neck], falloff: 0.34, bias: 1.2 },
        uvScale: 1.4,
      },
    );
    // Gold trim along the mantle's edge.
    b.add(torus(p.shoulderHalfWidth * 1.5, 0.018, 6, 26), {
      slot: 'metal',
      at: [0, chest[1] - 0.03, 0],
      rot: [Math.PI / 2, 0, 0],
      bind: { bones: [B.chest], rigid: true },
      uvScale: 1,
    });

    // ── Stole down the front, with a gem at the throat.
    clothPanel(b, rig, {
      slot: 'leather',
      bones: [B.chest, B.spine, B.pelvis],
      topY: chest[1] + 0.1,
      bottomY: pelvis[1] - 0.5,
      topW: 0.2,
      bottomW: 0.26,
      z: p.shoulderHalfWidth * 0.62,
      hemPoint: 0.3,
      thickness: 0.014,
    });
    b.add(gem(0.05, 0), {
      slot: 'glow',
      at: [0, chest[1] + 0.12, p.shoulderHalfWidth * 0.66],
      bind: { bones: [B.chest], rigid: true },
      uvScale: 1,
    });

    // ── Crook staff with a lantern: the healer's silhouette hook, held high in
    // the right hand so it clears the mantle.
    b.add(prism({ h: 1.9, w0: 0.032, d0: 0.032, w1: 0.028, d1: 0.028, round: 6, segments: 8 }), {
      slot: 'leather',
      bone: 'hand.R',
      at: [0.02, 0.32, 0.12],
      rot: [0.1, 0, 0.06],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1.4,
    });
    // The crook itself: a half ring at the top of the shaft.
    b.add(torus(0.17, 0.026, 7, 18), {
      slot: 'metal',
      bone: 'hand.R',
      at: [0.02, 1.18, 0.12],
      rot: [0, 0, Math.PI / 2],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1,
    });
    // Lantern hanging inside the crook: cage, glass, light.
    b.add(
      loft(
        [
          { y: 0, w: 0.055, d: 0.055, round: 4 },
          { y: 0.05, w: 0.085, d: 0.085, round: 4 },
          { y: 0.2, w: 0.085, d: 0.085, round: 4 },
          { y: 0.26, w: 0.05, d: 0.05, round: 4 },
        ],
        { segments: 8, smoothAngle: 40 },
      ),
      {
        slot: 'metal',
        bone: 'hand.R',
        at: [0.02, 0.86, 0.12],
        bind: { bones: ['hand.R'], rigid: true },
        uvScale: 1.2,
      },
    );
    b.add(sphereish(0.062, 10, 8, 1.1), {
      slot: 'glow',
      bone: 'hand.R',
      at: [0.02, 0.99, 0.12],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1,
    });

    // ── Two motes orbiting the lantern hand, echoing the halo.
    for (const sz of [-1, 1]) {
      b.add(gem(0.03, 0), {
        slot: 'glow',
        bone: 'hand.L',
        at: [sz * 0.12, 0.1, 0.06],
        bind: { bones: ['hand.L'], rigid: true },
        uvScale: 1,
      });
    }

    void head;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. Orco carnicero — melee creep
//
// SILHOUETTE HOOK: a pair of tusks that break the head outline sideways, on a
// back hunched far enough that the skull hangs in FRONT of the shoulder line,
// and a cleaver as wide as his own chest.
//
// At 79 px the head is about 9 px tall, so the tusks are authored at a third of
// the skull's height each — absurd on a model sheet, legible in a crowd. The
// hunch does the rest of the work: he is the only figure whose head is not the
// highest point of his own outline.
// ─────────────────────────────────────────────────────────────────────────────

const ORC_PALETTE: Palette = {
  primary: 0x53703c,
  secondary: 0x59371f,
  accent: 0x9a8f74,
  emissive: 0x9fe86a,
};

const cleaver: CharacterDef = {
  id: 'creep.cleaver',
  name: 'Orco carnicero',
  kind: 'creep',
  archetype: 'melee',
  proportions: prop({
    height: 2.05,
    legFraction: 0.4,
    hipHalfWidth: 0.19,
    shoulderHalfWidth: 0.4,
    torsoFraction: 0.3,
    neckLength: 0.02,
    headSize: 0.24,
    armFraction: 0.56,
    stoop: 0.95,
    footLength: 0.3,
  }),
  profile: profile({
    idlePeriod: 3.0,
    breath: 1.5,
    stanceWidth: 1.35,
    crouch: 0.5,
    armSplay: 0.34,
    walkSpeed: 3.1,
    runSpeed: 5.4,
    stride: 0.95,
    bob: 0.06,
    lean: 0.16,
    armSwing: 0.6,
    attackDuration: 0.95,
    attackStyle: 'cleave',
    castDuration: 1.4,
    castStyle: 'summon',
    weight: 0.68,
  }),
  slots: {
    armor: slot('unit.steel', { tint: 'accent', roughness: 0.6, metalness: 0.9 }),
    cloth: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'none', metalness: 0 }),
    metal: slot('unit.steel', { tint: 'none', roughness: 0.5, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'primary', shade: 0.95, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 3.5 }),
  },
  palette: ORC_PALETTE,
  visual: visual('creep.cleaver', 'hunched-orc-tusks-cleaver', ORC_PALETTE, 1, ['skin', 'leather']),
  build(b, rig) {
    const p = rig.proportions;
    const hs = p.headSize;
    addBody(b, rig, {
      torsoSlot: 'flesh',
      limbSlot: 'flesh',
      handSlot: 'flesh',
      bootSlot: 'leather',
      // An authored torso, when one exists, takes over both the chest mass
      // emitted here and the hunch added below, so neither is built.
      //
      // A torso can be a rigid part for the same reason a head can: what
      // deforms in this rig is the joints, not the masses between them.
      // Binding the chest rigid costs a little spine flex, and at 79 px that
      // is nothing against what a sculpted mass buys. Limbs stay procedural on
      // purpose: at this size an arm is a six pixel column whose silhouette
      // matters and whose surface does not.
      torso: !hasPart('creep.cleaver.torso'),
      round: 3.6,
      chestScale: 1.2,
      waistScale: 0.84,
      // Thinner arms once the torso is authored. The 1.3 was carrying the
      // shoulder bulk that made this thing read as a brute, and an authored
      // torso already has that mass sculpted into it. Leaving both made the
      // silhouette two rectangular slabs with a small body between them.
      armScale: hasPart('creep.cleaver.torso') ? 0.95 : 1.3,
      arms: !hasPart('creep.cleaver.arm'),
      legs: !hasPart('creep.cleaver.thigh'),
      legScale: 1.2,
      handScale: 1.7,
      bootScale: 1.3,
      depthRatio: 0.82,
      neck: false,
      head: false,
    });

    const chest = rw(rig, B.chest);
    const pelvis = rw(rig, B.pelvis);

    // ── The torso. An authored mass if one exists, otherwise the procedural
    // hunch below.
    //
    // Placed at the chest bone and pushed back, because an authored orc torso
    // is modelled with the hunch already in it: the shoulder slab piled behind
    // the neck is the whole point of the silhouette and is not something to
    // bolt on afterwards.
    // Numbers, not guesses. The part is centred on its own bounding box and is
    // 1.0 wide across the arm stubs; shoulder half width here is 0.4, so 0.85
    // lands the shoulders where the rig puts them. The vertical centre sits
    // between chest (1.435) and pelvis (0.82) rather than on the chest bone,
    // because an authored orc torso includes the gut: at this scale the top
    // reaches 1.59, which is the head bone, and the belt lands just above the
    // pelvis.
    const importedTorso = b.addImported('creep.cleaver.torso', {
      slot: 'flesh',
      at: [0, 1.24, chest[2] - 0.03],
      scale: 0.85,
      bind: { bones: [B.chest], rigid: true },
      uvScale: 1.4,
    });

    // ── Limbs. One arm and one leg were authored and both are mirrored, so a
    // creature costs one generation per limb rather than two.
    //
    // Each is bound rigid to the joint ABOVE it: the arm to the shoulder, the
    // thigh to the hip, the shin to the knee. That is the whole trick, and it
    // is why a limb can be authored at all. What bends is the joint between two
    // segments, and a segment itself never deforms.
    //
    // The arm is scaled unevenly on purpose. A naturally drawn arm is 0.6 long
    // and 0.23 thick; this orc's shoulder sits at 1.442 and its hand at 0.294,
    // so the arm has to span 1.148. Scaled uniformly it would be 0.45 thick,
    // wider than the shoulder it hangs from. Stretched lengthwise instead it
    // reads as the long, knuckle-dragging arm the silhouette was designed
    // around.
    b.addImported('creep.cleaver.arm', {
      slot: 'flesh',
      bone: B.shoulderR,
      at: [0, -0.574, 0],
      scale: [1.15, 1.9, 1.15],
      mirror: true,
      bind: { bones: [B.shoulderR], rigid: true },
      uvScale: 1.1,
    });
    b.addImported('creep.cleaver.thigh', {
      slot: 'flesh',
      bone: B.hipR,
      at: [0, -0.205, 0],
      scale: 1.15,
      mirror: true,
      bind: { bones: [B.hipR], rigid: true },
      uvScale: 1.1,
    });
    b.addImported('creep.cleaver.shin', {
      slot: 'flesh',
      bone: B.kneeR,
      at: [0, -0.18, 0],
      scale: 1.1,
      mirror: true,
      bind: { bones: [B.kneeR], rigid: true },
      uvScale: 1.1,
    });
    // Hips and the ragged skirt, as one piece on the pelvis. It also replaces
    // the procedural loincloth, which rendered as a black void between the
    // legs rather than as cloth.
    const importedHips = b.addImported('creep.cleaver.hips', {
      slot: 'leather',
      bone: B.pelvis,
      at: [0, 0.03, 0],
      scale: 1.2,
      bind: { bones: [B.pelvis], rigid: true },
      uvScale: 1.2,
    });

    if (!importedTorso) {
    // ── The hunch, as mass rather than as a lean: a slab of shoulder piled
    // behind the neck. It is what pushes the skull out in front of the chest.
    b.add(
      roughen(
        loft(
          [
            { y: -0.22, w: p.shoulderHalfWidth * 0.8, d: 0.17, round: 4 },
            { y: 0.0, w: p.shoulderHalfWidth * 1.0, d: 0.24, round: 4.6 },
            { y: 0.18, w: p.shoulderHalfWidth * 0.62, d: 0.17, round: 4 },
          ],
          { segments: 12, smoothAngle: 46 },
        ),
        0.016,
        7,
        2,
      ),
      {
        slot: 'flesh',
        at: [0, chest[1] + 0.06, chest[2] - p.shoulderHalfWidth * 0.42],
        bind: { bones: [B.chest], rigid: true },
        uvScale: 1.6,
      },
    );
    }

    // ── Skull: low forehead, no neck, jaw pushed forward under a heavy brow.
    // Every feature below is placed relative to the skull's own offset, not to
    // the head bone: the skull sits well forward of the bone, so anything
    // placed at the bone's origin would be buried inside it.
    const skullY = hs * 0.16;
    const skullZ = hs * 0.3;
    // An authored head, when one exists, replaces the entire procedural skull
    // group below -- skull, brow, jaw, tusks, fangs, top-knot -- because it
    // already carries every one of them and two sets would interpenetrate. The
    // eye glow is kept either way: it is a `glow` slot the mesh has no
    // equivalent for, and it is what makes a head read as alive at 15 px.
    //
    // No yaw correction. The "-Z forward" convention in `assets/models.ts`
    // governs whole imported characters; a part is placed in BONE space, and
    // every procedural part here is authored with +Z as the face direction,
    // which is also how the generator reconstructs a head facing its camera.
    // Turning it half a round, as the whole-character rule would suggest, puts
    // the face out the back of the skull.
    // Placed by its own centre, because the prepare tool centres a part on its
    // bounding box, and pushed forward rather than sat on top of the neck: this
    // orc's whole silhouette idea is a skull carried out in front of a hunched
    // shoulder line, and a head parked above the hunch reads as a small lump on
    // a big green slab.
    const importedHead = b.addImported('creep.cleaver.head', {
      slot: 'flesh',
      bone: B.head,
      at: [0, skullY - hs * 0.1, skullZ + hs * 0.55],
      scale: hs * 2.5,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });
    if (!importedHead) {
    b.add(
      loft(
        [
          { y: -hs * 0.55, w: hs * 0.66, d: hs * 0.78, z: hs * 0.24, round: 3 },
          { y: -hs * 0.18, w: hs * 0.96, d: hs * 1.0, z: hs * 0.12, round: 3.2 },
          { y: hs * 0.26, w: hs * 1.0, d: hs * 0.94, z: 0, round: 3.4 },
          { y: hs * 0.58, w: hs * 0.6, d: hs * 0.58, z: -hs * 0.12, round: 3 },
        ],
        { segments: 10, smoothAngle: 52 },
      ),
      {
        slot: 'flesh',
        bone: B.head,
        at: [0, skullY, skullZ],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    // Brow, proud of the face, and a band under it held back in its shadow and
    // cut from a darker material. That step is the whole face at 15 px.
    b.add(plate({ width: hs * 1.14, height: hs * 0.26, thickness: hs * 0.1, bow: 0.3, droop: 0.1, bottomScale: 0.88 }), {
      slot: 'flesh',
      bone: B.head,
      at: [0, skullY + hs * 0.28, skullZ + hs * 0.62],
      rot: [0.42, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1.1,
    });
    b.add(plate({ width: hs * 1.04, height: hs * 0.32, thickness: hs * 0.05, bow: 0.26, bottomScale: 0.8 }), {
      slot: 'leather',
      bone: B.head,
      at: [0, skullY - hs * 0.04, skullZ + hs * 0.62],
      rot: [0.1, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1.2,
    });

    // ── TUSKS. Up and out of the lower jaw, past the cheekbone, so the head
    // outline is notched on both sides. Nothing else in the cast is notched.
    b.add(spike({ length: hs * 2.3, baseW: hs * 0.26, curve: 0.4, taper: 1.7, segments: 6 }), {
      slot: 'armor',
      bone: B.head,
      at: [hs * 0.46, skullY - hs * 0.4, skullZ + hs * 0.56],
      // Tipped forward as well as out: a tusk that only goes up is hidden by
      // the brow from a camera that is already looking down on it. The Warden's
      // helm horns are the proof that this angle is what reads at play zoom.
      rot: [0.5, 0, -0.95],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.7,
    });
    // Two smaller lower fangs, to thicken the jaw line between the tusks.
    b.add(spike({ length: hs * 0.55, baseW: hs * 0.13, curve: 0.2, taper: 1.8, segments: 5 }), {
      slot: 'armor',
      bone: B.head,
      at: [hs * 0.2, skullY - hs * 0.42, skullZ + hs * 0.72],
      rot: [0.1, 0, -0.2],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.6,
    });
    // Braided top-knot: a second vertical accent on an otherwise round skull.
    b.add(spike({ length: hs * 1.2, baseW: hs * 0.17, curve: -0.6, taper: 1.4, segments: 6 }), {
      slot: 'leather',
      bone: B.head,
      at: [0, skullY + hs * 0.6, skullZ - hs * 0.1],
      rot: [-0.35, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.7,
    });
    }

    // Outside the branch on purpose: an authored head brings its own sockets
    // but nothing that emits, and at 15 px a lit eye is most of what says the
    // thing is alive rather than a rock.
    b.add(gem(0.024, 0), {
      slot: 'glow',
      bone: B.head,
      at: importedHead
        ? [hs * 0.34, skullY + hs * 0.14, skullZ + hs * 1.5]
        : [hs * 0.32, skullY + hs * 0.04, skullZ + hs * 0.96],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // Asymmetry is the second read: one plated shoulder, one bare arm.
    //
    // Skipped when the torso is authored, because a generated orc torso already
    // carries its pauldron, modelled in with the shoulder mass. Leaving both in
    // put a flat quad the size of half the body over a sculpted one, and the
    // quad won.
    if (!importedTorso) {
      pauldron(b, rig, 'R', { size: 0.33, slot: 'armor', lames: 2, tiltOut: 0.55, spike: 1.9, spikeSlot: 'metal' });
    }
    b.add(prism({ h: 0.19, w0: 0.1, d0: 0.11, w1: 0.082, d1: 0.092, round: 5, segments: 8 }), {
      slot: 'leather',
      bone: 'elbow.L',
      at: [0, -0.18, 0],
      bind: { bones: ['elbow.L', 'wrist.L'], rigid: true },
      uvScale: 1.2,
    });

    // Chest strapping and a hanging loincloth. The strap goes the same way as
    // the pauldron: an authored torso has its own crossed straps and belt, and
    // a second band laid over them only reads as a seam.
    if (!importedTorso) {
      b.add(plate({ width: 0.42, height: 0.12, thickness: 0.022, bow: 0.3, topScale: 0.9, bottomScale: 0.9 }), {
        slot: 'leather',
        at: [0.02, chest[1] - 0.26, chest[2] + 0.04],
        rot: [0, 0, 0.42],
        bind: { bones: [B.chest, B.spine], falloff: 0.2, bias: 1.4 },
        uvScale: 1.2,
      });
    }
    if (!importedHips) {
      clothPanel(b, rig, {
        slot: 'cloth',
        bones: [B.pelvis],
        topY: pelvis[1] + 0.04,
        bottomY: pelvis[1] - 0.46,
        topW: 0.34,
        bottomW: 0.28,
        z: p.hipHalfWidth * 1.05,
        hemPoint: 0.35,
      });
    }

    // ── Cleaver: a slab as wide as his chest, held low in the right hand.
    //
    // An authored weapon replaces haft, blade and spine together: a generated
    // cleaver arrives as one mesh, and three procedural pieces inside it would
    // only poke through. `rot` matches the procedural grip so the swing reads
    // the same either way.
    // This orc's hand sits at y 0.294, nearly shin height, because the arms are
    // long and the stoop drops the shoulder. So the cleaver hangs low by design,
    // exactly where the procedural one hung. What it needs is to hang CLEAR:
    // pushed out from the hip and tilted away from the body, or a 1 m blade
    // standing up from a hand that low runs straight through the thigh.
    const importedWeapon = b.addImported('creep.cleaver.weapon', {
      slot: 'metal',
      bone: 'hand.R',
      at: [-0.13, 0.26, 0.16],
      rot: [0.26, 0, 0.2],
      scale: 1,
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1.2,
    });

    if (!importedWeapon) {
    b.add(prism({ h: 0.4, w0: 0.042, d0: 0.042, w1: 0.036, d1: 0.036, round: 6, segments: 6 }), {
      slot: 'leather',
      bone: 'hand.R',
      at: [0, -0.16, 0.02],
      rot: [0.3, 0, 0.12],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1.2,
    });
    b.add(blade({ length: 0.98, width: 0.56, thickness: 0.06, curve: 0.4, belly: 0.66, tip: 0.46, heel: 0.78 }), {
      slot: 'metal',
      bone: 'hand.R',
      at: [0.02, 0.16, 0.06],
      rot: [0.3, 0, 0.12],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1.4,
    });
    // Spine of the cleaver, so the slab keeps an edge-lit line when it swings.
    b.add(prism({ h: 0.86, w0: 0.03, d0: 0.05, w1: 0.02, d1: 0.035, round: 4, segments: 5 }), {
      slot: 'armor',
      bone: 'hand.R',
      at: [0.28, 0.2, 0.06],
      rot: [0.3, 0, 0.12],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 0.8,
    });
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. Goblin ballestero — ranged creep
//
// SILHOUETTE HOOK: ears longer than its own head, held out sideways past the
// shoulders, on a body two thirds the height of the orc's.
//
// The ear span is 1.15 m — about 48 px — on a figure only 62 px tall, so the
// widest part of this creature is its head. That is the whole identification:
// small, wide-headed and hunched reads as "goblin" before any detail resolves,
// and the size difference alone separates it from the orc it fights beside.
// ─────────────────────────────────────────────────────────────────────────────

const GOBLIN_PALETTE: Palette = {
  primary: 0x6d8438,
  secondary: 0x4a3524,
  accent: 0xb9ad90,
  emissive: 0xffc24a,
};

const spinebolt: CharacterDef = {
  id: 'creep.spinebolt',
  name: 'Goblin ballestero',
  kind: 'creep',
  archetype: 'ranged',
  proportions: prop({
    // Finished height lands near 1.55 m once the skull is on: two thirds of
    // the orc it marches beside, which is half of how it is identified.
    height: 1.45,
    legFraction: 0.44,
    hipHalfWidth: 0.12,
    shoulderHalfWidth: 0.2,
    torsoFraction: 0.26,
    neckLength: 0.02,
    headSize: 0.235,
    armFraction: 0.5,
    stoop: 0.7,
    footLength: 0.22,
  }),
  profile: profile({
    idlePeriod: 2.4,
    breath: 0.8,
    stanceWidth: 1.15,
    crouch: 0.45,
    armSplay: 0.2,
    walkSpeed: 3.4,
    runSpeed: 6.0,
    // Short legs: a long stride here would visibly skate, since the foot
    // cycle rate is derived from stride over ground speed.
    stride: 0.82,
    bob: 0.05,
    lean: 0.12,
    armSwing: 0.4,
    footLift: 0.14,
    attackDuration: 1.25,
    attackStyle: 'shoot',
    castDuration: 1.4,
    castStyle: 'hurl',
    weight: 0.3,
    mainHand: 'R',
  }),
  slots: {
    armor: slot('unit.leather', { tint: 'secondary', roughness: 0.7, metalness: 0 }),
    cloth: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'none', metalness: 0 }),
    metal: slot('unit.steel', { tint: 'none', roughness: 0.5, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'primary', shade: 1.1, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 3.8 }),
  },
  palette: GOBLIN_PALETTE,
  visual: visual('creep.spinebolt', 'small-wide-eared-goblin-crossbow', GOBLIN_PALETTE, 1, ['skin', 'leather']),
  build(b, rig) {
    const p = rig.proportions;
    const hs = p.headSize;
    addBody(b, rig, {
      torsoSlot: 'flesh',
      limbSlot: 'flesh',
      handSlot: 'flesh',
      bootSlot: 'flesh',
      round: 3.2,
      chestScale: 0.95,
      waistScale: 0.78,
      armScale: 0.85,
      legScale: 0.85,
      handScale: 1.35,
      bootScale: 1.05,
      depthRatio: 0.6,
      neck: false,
      head: false,
    });

    const chest = rw(rig, B.chest);
    const pelvis = rw(rig, B.pelvis);

    // ── Skull: a cranium far too big for the body, a receding chin and a long
    // hooked nose. Round on top, pointed at the front: a wedge seen from above.
    b.add(
      loft(
        [
          { y: -hs * 0.52, w: hs * 0.46, d: hs * 0.6, z: hs * 0.26, round: 3 },
          { y: -hs * 0.16, w: hs * 0.86, d: hs * 0.98, z: hs * 0.1, round: 3.2 },
          { y: hs * 0.22, w: hs * 0.98, d: hs * 1.0, z: -hs * 0.04, round: 3.4 },
          { y: hs * 0.56, w: hs * 0.54, d: hs * 0.58, z: -hs * 0.14, round: 3 },
        ],
        { segments: 10, smoothAngle: 52 },
      ),
      {
        slot: 'flesh',
        bone: B.head,
        at: [0, hs * 0.12, hs * 0.12],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    // Hooked nose, the front point of the wedge.
    b.add(spike({ length: hs * 1.15, baseW: hs * 0.26, curve: 0.55, taper: 1.5, segments: 6 }), {
      slot: 'flesh',
      bone: B.head,
      at: [0, hs * 0.1, hs * 0.55],
      rot: [Math.PI / 2 - 0.25, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.8,
    });
    // Heavy brow over a dark band: the same two-value face as the orc's, and
    // the reason the eyes do not vanish under a wide skull at distance.
    b.add(plate({ width: hs * 1.0, height: hs * 0.22, thickness: hs * 0.09, bow: 0.3, droop: 0.12, bottomScale: 0.9 }), {
      slot: 'flesh',
      bone: B.head,
      at: [0, hs * 0.34, hs * 0.5],
      rot: [0.45, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1.1,
    });
    b.add(plate({ width: hs * 0.92, height: hs * 0.26, thickness: hs * 0.05, bow: 0.26, bottomScale: 0.82 }), {
      slot: 'armor',
      bone: B.head,
      at: [0, hs * 0.1, hs * 0.5],
      rot: [0.12, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1.2,
    });
    b.add(gem(0.022, 0), {
      slot: 'glow',
      bone: B.head,
      at: [hs * 0.3, hs * 0.2, hs * 0.86],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // ── EARS. The hook: each one longer than the skull is tall, canted so it
    // presents its full width to a camera looking down at 50 degrees.
    const ear = hs * 1.95;
    for (const sx of [-1, 1]) {
      b.add(
        shell({
          nu: 4,
          nv: 9,
          surface: (u, v, out) => {
            const w = hs * 0.95 * Math.sin(Math.PI * Math.min(1, 0.22 + v * 0.7)) * (1 - v * 0.5);
            const k = u - 0.5;
            out.set(
              sx * (hs * 0.48 + v * ear * 0.92),
              hs * 0.08 + v * ear * 0.34 + k * w * 0.78,
              -v * ear * 0.4 + k * w * 0.6,
            );
          },
          thickness: (_u, v) => 0.015 * (1 - v * 0.55) + 0.004,
          uvScale: 1.6,
          smoothAngle: 44,
        }),
        {
          slot: 'flesh',
          bone: B.head,
          at: [0, hs * 0.12, 0],
          bind: { bones: [B.head], rigid: true },
          uvScale: 1,
        },
      );
    }

    // Scrap armour: one strap, one shoulder plate, nothing that widens him.
    b.add(plate({ width: 0.24, height: 0.1, thickness: 0.018, bow: 0.28, topScale: 0.9, bottomScale: 0.9 }), {
      slot: 'leather',
      at: [0.01, chest[1] - 0.14, chest[2] + 0.04],
      rot: [0, 0, -0.5],
      bind: { bones: [B.chest, B.spine], falloff: 0.16, bias: 1.4 },
      uvScale: 1.2,
    });
    pauldron(b, rig, 'L', { size: 0.1, slot: 'armor', lames: 1, tiltOut: 0.28 });
    clothPanel(b, rig, {
      slot: 'cloth',
      bones: [B.pelvis],
      topY: pelvis[1] + 0.03,
      bottomY: pelvis[1] - 0.24,
      topW: 0.22,
      bottomW: 0.18,
      z: p.hipHalfWidth * 1.05,
      hemPoint: 0.45,
      thickness: 0.009,
    });

    // ── Bolt case on the hip: a short cylinder with three bolts fanning out.
    b.add(prism({ h: 0.24, w0: 0.05, d0: 0.05, w1: 0.056, d1: 0.056, round: 7, segments: 7 }), {
      slot: 'leather',
      at: [-p.hipHalfWidth * 1.5, pelvis[1] - 0.02, -0.04],
      rot: [-0.3, 0, -0.35],
      bind: { bones: [B.pelvis], rigid: true },
      uvScale: 1.2,
    });
    spikeRow(b, rig, {
      bone: B.pelvis,
      count: 3,
      from: [-p.hipHalfWidth * 1.7, pelvis[1] + 0.12, -0.06],
      to: [-p.hipHalfWidth * 1.3, pelvis[1] + 0.12, -0.02],
      length: 0.22,
      baseW: 0.016,
      slot: 'metal',
      curve: 0,
      tilt: -0.35,
      bind: [B.pelvis],
    });

    // ── Crossbow: a short bow across a heavy stock, carried level in both
    // hands. Horizontal where every hero weapon is vertical.
    const span = 0.82;
    b.add(
      shell({
        nu: 5,
        nv: 14,
        surface: (u, v, out) => {
          const k = (v - 0.5) * 2;
          const w = 0.04 * (1 - 0.7 * Math.abs(k));
          out.set(k * span * 0.5, (u - 0.5) * w * 2, 0.19 * k * k + 0.1 * Math.pow(Math.abs(k), 4));
        },
        thickness: (_u, v) => 0.024 * (1 - 0.55 * Math.abs((v - 0.5) * 2)) + 0.006,
        uvScale: 2.4,
        smoothAngle: 44,
      }),
      {
        slot: 'metal',
        bone: 'hand.L',
        at: [0.02, 0.0, 0.2],
        rot: [0.16, 0, 0.1],
        bind: { bones: ['hand.L'], rigid: true },
        uvScale: 1,
      },
    );
    // Stock, running back from the bow toward the shoulder.
    b.add(prism({ h: 0.46, w0: 0.05, d0: 0.045, w1: 0.036, d1: 0.06, round: 4, segments: 6 }), {
      slot: 'leather',
      bone: 'hand.L',
      at: [0.02, -0.02, 0.2],
      rot: [Math.PI / 2 + 0.16, 0, 0.1],
      bind: { bones: ['hand.L'], rigid: true },
      uvScale: 1.3,
    });
    b.add(spike({ length: 0.34, baseW: 0.016, curve: 0, taper: 2.4, segments: 5 }), {
      slot: 'metal',
      bone: 'hand.L',
      at: [0.02, 0.035, 0.16],
      rot: [Math.PI / 2 + 0.16, 0, 0.1],
      bind: { bones: ['hand.L'], rigid: true },
      uvScale: 0.6,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. Huargo — fast creep (QUADRUPED)
//
// SILHOUETTE HOOK: the only body in the game that is longer than it is tall.
// Two metres of back from tail tip to muzzle, carried at 1.2 m, with the head
// out in FRONT of the forelegs and the tail streaming behind.
//
// Shape variety at 79 px comes from skeleton layout, not decoration, and this
// is the one that buys it: every other figure is a vertical stack, so the wolf
// is identifiable before a single feature resolves.
//
// HOW IT USES A BIPED RIG (no new bones): a large `stoop` throws the chest
// 0.77 m forward of the pelvis, which turns the spine chain into a horizontal
// backbone; the arm chain then hangs off the forward chest as the forelegs, and
// the leg chain stays under the pelvis as the hind legs. The animator swings
// the arms about the shoulder during locomotion, which is exactly what a
// foreleg does. The costs are stated in the report: the forelegs are swung, not
// IK-planted, so they slide a little at walk speed, and `lean` is kept small
// because pitching this spine lifts the whole chest rather than the chin.
// ─────────────────────────────────────────────────────────────────────────────

const WOLF_PALETTE: Palette = {
  primary: 0x4c4740,
  secondary: 0x2b2722,
  accent: 0xbfae8e,
  emissive: 0xffb03a,
};

const duskrunner: CharacterDef = {
  id: 'creep.duskrunner',
  name: 'Huargo',
  kind: 'creep',
  archetype: 'fast',
  proportions: prop({
    height: 1.9,
    legType: 'digitigrade',
    legFraction: 0.55,
    hipHalfWidth: 0.155,
    shoulderHalfWidth: 0.19,
    // Short vertical torso, extreme stoop: together these lay the spine down.
    torsoFraction: 0.105,
    neckLength: 0.05,
    headSize: 0.19,
    // Forelegs must reach the ground from a chest carried at 1.24 m.
    armFraction: 0.72,
    stoop: 8,
    hockOffset: 0.2,
    footLength: 0.3,
    tailSegments: 5,
  }),
  profile: profile({
    idlePeriod: 2.1,
    breath: 0.8,
    stanceWidth: 0.95,
    crouch: 0.2,
    // Forelegs hang, they do not splay: a splayed foreleg reads as an arm.
    armSplay: 0.06,
    walkSpeed: 4.6,
    runSpeed: 8.4,
    stride: 1.35,
    stanceFraction: 0.4,
    bob: 0.045,
    lean: 0.07,
    armSwing: 0.34,
    footLift: 0.2,
    attackDuration: 0.62,
    attackStyle: 'claw',
    castDuration: 1.0,
    castStyle: 'hurl',
    weight: 0.14,
    tailSegments: 5,
  }),
  slots: {
    armor: slot('unit.leather', { tint: 'primary', roughness: 0.75, metalness: 0 }),
    cloth: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'secondary', metalness: 0 }),
    metal: slot('unit.bone', { tint: 'accent', roughness: 0.55, metalness: 0 }),
    flesh: slot('unit.skin', { tint: 'primary', shade: 1.05, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 4 }),
  },
  palette: WOLF_PALETTE,
  visual: visual('creep.duskrunner', 'quadruped-long-back-tail', WOLF_PALETTE, 1, ['leather', 'skin']),
  build(b, rig) {
    const p = rig.proportions;
    const hs = p.headSize;
    // No torso and no head from the shared assembly: an upright column is the
    // one thing this body plan must not have. Arms and legs still come from it,
    // because fore and hind legs are exactly the segments it already builds.
    addBody(b, rig, {
      torsoSlot: 'flesh',
      limbSlot: 'flesh',
      handSlot: 'flesh',
      bootSlot: 'flesh',
      round: 3,
      armScale: 0.74,
      legScale: 0.74,
      handScale: 0.95,
      bootScale: 0.85,
      digitigrade: true,
      torso: false,
      neck: false,
      head: false,
    });

    const pelvis = rw(rig, B.pelvis);
    const chest = rw(rig, B.chest);

    // ── Backbone: the body is a barrel swept along the pelvis→chest line, with
    // its sections held perpendicular to that line so the back reads as one
    // continuous horizontal mass rather than a stack of discs.
    const dy = chest[1] - pelvis[1];
    const dz = chest[2] - pelvis[2];
    const tilt = Math.atan2(dz, dy);
    const spineRing = (t: number, w: number, d: number, round = 3.2): Ring => ({
      y: pelvis[1] + dy * t,
      z: pelvis[2] + dz * t,
      w,
      d,
      round,
      tiltX: tilt,
    });
    b.add(
      roughen(
        loft(
          [
            spineRing(-0.52, 0.12, 0.125),
            spineRing(-0.22, 0.215, 0.205),
            spineRing(0.16, 0.2, 0.19),
            spineRing(0.52, 0.185, 0.19),
            spineRing(0.86, 0.23, 0.225),
            spineRing(1.14, 0.215, 0.21),
            spineRing(1.38, 0.135, 0.14),
          ],
          { segments: 12, smoothAngle: 50 },
        ),
        0.012,
        6,
        4,
      ),
      {
        slot: 'flesh',
        bind: { bones: [B.chest, B.spine, B.pelvis], falloff: 0.34, bias: 1.1 },
        uvScale: 1.7,
      },
    );

    // ── Neck: thick, short and carried a little below the shoulder line, the
    // way a running wolf's is. Low enough to read as a separate shape from the
    // back, high enough that the back does not hide it from a camera looking
    // down at 50 degrees.
    const headP = rw(rig, B.head);
    const skullDrop = 0.22;
    const skullPush = 0.42;
    b.add(
      loft(
        [
          { y: chest[1] + 0.04, z: chest[2] + 0.04, w: 0.19, d: 0.2, round: 3.2, tiltX: 1.05 },
          { y: chest[1] - 0.02, z: chest[2] + 0.22, w: 0.155, d: 0.165, round: 3.2, tiltX: 1.3 },
          { y: headP[1] - skullDrop + 0.02, z: chest[2] + skullPush * 0.82, w: 0.125, d: 0.13, round: 3.2, tiltX: 1.4 },
        ],
        { segments: 10, smoothAngle: 52 },
      ),
      {
        slot: 'flesh',
        bind: { bones: [B.neck, B.chest, B.head], falloff: 0.26, bias: 1.3 },
        uvScale: 1.3,
      },
    );

    // ── Skull: a wedge with a long muzzle, built pointing along +Y and laid
    // forward by the placement rotation, so the whole head is one horizontal
    // shape. Two upright ears keep the top outline from reading as a lizard.
    b.add(
      loft(
        [
          { y: 0, w: hs * 0.46, d: hs * 0.48, round: 3 },
          { y: hs * 0.5, w: hs * 0.62, d: hs * 0.56, round: 3.4 },
          { y: hs * 1.0, w: hs * 0.44, d: hs * 0.48, round: 3.2 },
          { y: hs * 1.8, w: hs * 0.3, d: hs * 0.34, round: 3.2 },
          { y: hs * 2.4, w: hs * 0.24, d: hs * 0.27, round: 3 },
        ],
        { segments: 10, smoothAngle: 54 },
      ),
      {
        slot: 'flesh',
        bone: B.head,
        at: [0, -skullDrop, skullPush],
        rot: [Math.PI / 2 - 0.1, 0, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1.1,
      },
    );
    // Lower jaw, hung open a crack: two dark lines under the muzzle.
    b.add(
      loft(
        [
          { y: 0, w: hs * 0.36, d: hs * 0.21, round: 3 },
          { y: hs * 1.0, w: hs * 0.28, d: hs * 0.18, round: 3 },
          { y: hs * 2.15, w: hs * 0.18, d: hs * 0.13, round: 3 },
        ],
        { segments: 8, smoothAngle: 54 },
      ),
      {
        slot: 'flesh',
        bone: B.head,
        at: [0, -skullDrop - 0.1, skullPush + 0.03],
        rot: [Math.PI / 2 + 0.07, 0, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    for (const sz of [0, 1]) {
      b.add(spike({ length: hs * 0.34, baseW: hs * 0.08, curve: 0.1, taper: 1.6, segments: 5 }), {
        slot: 'metal',
        bone: B.head,
        at: [
          hs * 0.24,
          -skullDrop - 0.05 + (sz === 0 ? -0.01 : 0.01),
          skullPush + hs * (sz === 0 ? 1.15 : 1.6),
        ],
        rot: [Math.PI, 0, 0],
        mirror: true,
        bind: { bones: [B.head], rigid: true },
        uvScale: 0.5,
      });
    }
    // Ears: upright and splayed wide. Seen from above they are the only part
    // of this animal that is not a smooth tube, so they are oversized.
    b.add(spike({ length: hs * 1.25, baseW: hs * 0.3, curve: -0.35, taper: 1.5, segments: 5 }), {
      slot: 'flesh',
      bone: B.head,
      at: [hs * 0.32, -skullDrop + 0.06, skullPush + 0.02],
      rot: [-0.3, 0, -0.55],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.6,
    });
    b.add(gem(0.024, 0), {
      slot: 'glow',
      bone: B.head,
      at: [hs * 0.3, -skullDrop + 0.03, skullPush + hs * 0.85],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // ── Ruff: a collar of raised fur over the shoulders. It thickens the front
    // of the animal so the profile is heavy at the chest and light at the hips,
    // which is the proportion that separates a wolf from a big cat.
    for (let i = 0; i < 9; i++) {
      const a = -1.5 + (i / 8) * 3.0;
      b.add(spike({ length: 0.2 + Math.cos(a) * 0.1, baseW: 0.062, curve: -0.5, taper: 1.9, segments: 5 }), {
        slot: 'armor',
        at: [
          Math.sin(a) * 0.21,
          chest[1] + 0.09 + Math.cos(a) * 0.05,
          chest[2] - 0.02 - Math.cos(a) * 0.04,
        ],
        rot: [-1.0, 0, -a * 0.75],
        bind: { bones: [B.chest], rigid: true },
        uvScale: 0.8,
      });
    }

    // ── Tail: five segments streaming off the back of the pelvis. The one
    // element that continues the horizontal line past the hind legs.
    const segs = p.tailSegments;
    for (let i = 0; i < segs; i++) {
      const t = i / segs;
      const len = boneDistance(rig, `tail${i}`, i + 1 < segs ? `tail${i + 1}` : `tail${i}`) || 0.14;
      b.add(
        limbGeo({
          len: Math.max(0.1, len) * 1.1,
          topW: 0.085 * (1 - t * 0.55),
          topD: 0.095 * (1 - t * 0.55),
          botW: 0.08 * (1 - (t + 0.2) * 0.62),
          botD: 0.088 * (1 - (t + 0.2) * 0.62),
          round: 3,
          segments: 8,
        }),
        {
          slot: 'flesh',
          // +PI/2, not -PI/2: `limbGeo` grows along -Y, so the negative angle
          // laid every segment FORWARD over the body and bound it to the bone
          // behind the one it covered. The whole tail was a segment out of step.
          bone: `tail${i}`,
          rot: [Math.PI / 2, 0, 0],
          bind: { bones: [`tail${i}`, i + 1 < segs ? `tail${i + 1}` : `tail${i}`], falloff: 0.11, bias: 1.4 },
          uvScale: 1.1,
        },
      );
    }

    // Haunch mass over the hind legs, so the rear is not a bare stick joint.
    b.add(sphereish(0.155, 10, 8, 0.92), {
      slot: 'flesh',
      at: [p.hipHalfWidth * 0.85, pelvis[1] - 0.06, pelvis[2] - 0.03],
      bind: { bones: [B.pelvis, 'hip.L'], falloff: 0.14, bias: 1.5 },
      mirror: true,
      uvScale: 1.2,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 8. Ogro — tank creep
//
// SILHOUETTE HOOK: a gut wider than his own shoulders, a head far too small for
// it, and a tree-trunk club laid over one shoulder as a hard diagonal.
//
// He fights beside the orc and must never be mistaken for one, so the contrast
// is built from three independent axes: he is a third taller, his widest point
// is at the waist instead of the shoulders, and his weapon goes UP from the
// hand while the orc's hangs down. Round, tall and top-heavy against angular,
// short and bottom-heavy.
// ─────────────────────────────────────────────────────────────────────────────

const OGRE_PALETTE: Palette = {
  primary: 0x8a7550,
  secondary: 0x3d3529,
  accent: 0x9a4c1e,
  emissive: 0xff6a1f,
};

const bastion: CharacterDef = {
  id: 'creep.bastion',
  name: 'Ogro',
  kind: 'creep',
  archetype: 'tank',
  proportions: prop({
    height: 2.35,
    legFraction: 0.34,
    hipHalfWidth: 0.3,
    shoulderHalfWidth: 0.5,
    torsoFraction: 0.4,
    // Not zero: a head this small, sunk level with shoulders this wide, is
    // simply not on screen from a camera above it. It has to clear them.
    neckLength: 0.13,
    headSize: 0.2,
    armFraction: 0.58,
    stoop: 0.6,
    footLength: 0.36,
  }),
  profile: profile({
    idlePeriod: 5.6,
    breath: 1.8,
    stanceWidth: 1.7,
    crouch: 0.6,
    armSplay: 0.55,
    walkSpeed: 2.1,
    runSpeed: 3.3,
    stride: 1.0,
    stanceFraction: 0.7,
    bob: 0.09,
    lean: 0.05,
    armSwing: 0.26,
    footLift: 0.1,
    attackDuration: 1.55,
    attackStyle: 'slam',
    castDuration: 2.1,
    castStyle: 'summon',
    weight: 1,
  }),
  slots: {
    armor: slot('unit.leather', { tint: 'secondary', roughness: 0.75, metalness: 0 }),
    cloth: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'secondary', shade: 1.3, metalness: 0 }),
    metal: slot('unit.steel', { tint: 'accent', roughness: 0.55, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'primary', shade: 0.95, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 3.6 }),
  },
  palette: OGRE_PALETTE,
  visual: visual('creep.bastion', 'pot-bellied-ogre-club', OGRE_PALETTE, 1, ['skin', 'leather']),
  build(b, rig) {
    const p = rig.proportions;
    const hs = p.headSize;
    addBody(b, rig, {
      torsoSlot: 'flesh',
      limbSlot: 'flesh',
      handSlot: 'flesh',
      bootSlot: 'leather',
      round: 4.2,
      chestScale: 1.02,
      // The gut: the torso's waist ring is the widest section on the body.
      waistScale: 1.5,
      armScale: 1.6,
      legScale: 1.7,
      handScale: 2.3,
      bootScale: 1.5,
      depthRatio: 0.92,
      neck: false,
      head: false,
    });

    const chest = rw(rig, B.chest);
    const pelvis = rw(rig, B.pelvis);
    const bellyY = pelvis[1] + (chest[1] - pelvis[1]) * 0.3;

    // ── Belly overhang: a second mass in front of the torso so the gut hangs
    // over the belt instead of being a wide tube.
    b.add(roughen(sphereish(0.44, 14, 10, 0.82), 0.02, 5.5, 3), {
      slot: 'flesh',
      at: [0, bellyY - 0.04, p.hipHalfWidth * 0.5],
      bind: { bones: [B.spine, B.pelvis, B.chest], falloff: 0.3, bias: 1.2 },
      uvScale: 1.9,
    });

    // Shoulder muscle: two bare domes. No armour anywhere on this creature —
    // plates would read as the orc's pauldron at distance.
    b.add(
      roughen(
        loft(
          [
            { y: -0.2, w: 0.2, d: 0.21, round: 4.5 },
            { y: -0.02, w: 0.26, d: 0.27, round: 5 },
            { y: 0.14, w: 0.19, d: 0.2, round: 4.5 },
          ],
          { segments: 12, smoothAngle: 46 },
        ),
        0.014,
        7,
        5,
      ),
      {
        slot: 'flesh',
        bone: 'shoulder.L',
        at: [0.05, 0.06, 0],
        rot: [0, 0, -0.3],
        mirror: true,
        bind: { bones: ['shoulder.L'], rigid: true },
        uvScale: 1.5,
      },
    );

    // ── Head: small, bald, sunk between the shoulders, with the jaw jutting
    // out under it and one broken lower tusk.
    b.add(
      loft(
        [
          { y: -hs * 0.6, w: hs * 0.78, d: hs * 0.84, z: hs * 0.3, round: 3.4 },
          { y: -hs * 0.2, w: hs * 0.95, d: hs * 1.02, z: hs * 0.14, round: 3.6 },
          { y: hs * 0.3, w: hs * 0.88, d: hs * 0.92, z: 0, round: 3.6 },
          { y: hs * 0.66, w: hs * 0.46, d: hs * 0.5, z: -hs * 0.08, round: 3 },
        ],
        { segments: 10, smoothAngle: 50 },
      ),
      {
        slot: 'flesh',
        bone: B.head,
        at: [0, hs * 0.2, hs * 0.16],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    // Undershot jaw thrown forward: the head is a wedge from above, which is
    // the only angle this creature is ever seen from.
    b.add(
      loft(
        [
          { y: 0, w: hs * 0.7, d: hs * 0.42, round: 3.4 },
          { y: hs * 0.28, w: hs * 0.78, d: hs * 0.46, round: 3.4 },
          { y: hs * 0.5, w: hs * 0.54, d: hs * 0.34, round: 3.2 },
        ],
        { segments: 8, smoothAngle: 50 },
      ),
      {
        slot: 'flesh',
        bone: B.head,
        at: [0, -hs * 0.34, hs * 0.5],
        rot: [Math.PI / 2 - 0.35, 0, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    // Two tusks out of that jaw, one snapped short: the asymmetry is a second
    // read, and swept outward they clear the shoulder domes.
    b.add(spike({ length: hs * 1.25, baseW: hs * 0.2, curve: 0.35, taper: 1.7, segments: 5 }), {
      slot: 'metal',
      bone: B.head,
      at: [hs * 0.34, -hs * 0.36, hs * 0.86],
      rot: [0.35, 0, -0.8],
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.6,
    });
    b.add(spike({ length: hs * 0.5, baseW: hs * 0.2, curve: 0.2, taper: 1.3, segments: 5 }), {
      slot: 'metal',
      bone: B.head,
      at: [-hs * 0.34, -hs * 0.36, hs * 0.86],
      rot: [0.35, 0, 0.8],
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.6,
    });
    b.add(plate({ width: hs * 0.98, height: hs * 0.28, thickness: hs * 0.05, bow: 0.26, bottomScale: 0.82 }), {
      slot: 'armor',
      bone: B.head,
      at: [0, hs * 0.12, hs * 0.6],
      rot: [0.12, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1.2,
    });
    b.add(gem(0.024, 0), {
      slot: 'glow',
      bone: B.head,
      at: [hs * 0.28, hs * 0.2, hs * 0.96],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // Hide kilt, hung low under the gut.
    clothPanel(b, rig, {
      slot: 'armor',
      bones: [B.pelvis, B.spine],
      topY: pelvis[1] + 0.06,
      bottomY: pelvis[1] - 0.44,
      topW: 0.6,
      bottomW: 0.5,
      z: p.hipHalfWidth * 1.35,
      hemPoint: 0.3,
      thickness: 0.018,
    });
    b.add(torus(p.hipHalfWidth * 1.5, 0.05, 6, 18), {
      slot: 'leather',
      at: [0, pelvis[1] + 0.12, 0],
      rot: [Math.PI / 2, 0, 0],
      bind: { bones: [B.pelvis, B.spine], falloff: 0.2, bias: 1.3 },
      uvScale: 1.4,
    });

    // ── Club: a whole tree, gripped low and carried up over the right
    // shoulder. The diagonal is half of this creature's read at distance.
    const clubRot: [number, number, number] = [-0.38, 0, 0.16];
    b.add(
      roughen(
        loft(
          [
            { y: -0.1, w: 0.05, d: 0.05, round: 5 },
            { y: 0.5, w: 0.075, d: 0.075, round: 5 },
            { y: 1.05, w: 0.15, d: 0.16, round: 5 },
            { y: 1.45, w: 0.19, d: 0.2, round: 5.5 },
            { y: 1.62, w: 0.14, d: 0.15, round: 5 },
          ],
          { segments: 10, smoothAngle: 48 },
        ),
        0.02,
        4.5,
        7,
      ),
      {
        slot: 'leather',
        bone: 'hand.R',
        at: [0, -0.12, 0.04],
        rot: clubRot,
        bind: { bones: ['hand.R'], rigid: true },
        uvScale: 1.8,
      },
    );
    // Broken branch stubs, so the club head is not a smooth egg.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      b.add(spike({ length: 0.2, baseW: 0.05, curve: 0.2, taper: 1.9, segments: 5 }), {
        slot: 'leather',
        bone: 'hand.R',
        at: [Math.sin(a) * 0.16, -0.12 + 1.18 + Math.cos(a) * 0.06, 0.04 + Math.cos(a) * 0.16],
        rot: [clubRot[0]! + Math.cos(a) * 1.1, 0, clubRot[2]! - Math.sin(a) * 1.1],
        bind: { bones: ['hand.R'], rigid: true },
        uvScale: 0.7,
      });
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 9. Hechicero — caster creep
//
// SILHOUETTE HOOK: the hat. A brimmed cone two thirds the height of his own
// torso, with a tip that bends forward, over a robe that reaches the ground and
// a staff as tall as the hat.
//
// A pointed hat is the single most-recognised shape in fantasy and no hero
// wears one — the Oracle has a crescent crown and Vesper a halo, both of which
// sit flat on the skull. This one adds 0.68 m of cone above the head, so the
// creature reads as "mago" from the outline of its top third alone.
// ─────────────────────────────────────────────────────────────────────────────

const MAGE_PALETTE: Palette = {
  primary: 0x35275c,
  secondary: 0x4e4560,
  accent: 0xa89c86,
  emissive: 0xb44dff,
};

const hexwright: CharacterDef = {
  id: 'creep.hexwright',
  name: 'Hechicero',
  kind: 'creep',
  archetype: 'caster',
  proportions: prop({
    height: 1.95,
    legType: 'robe',
    legFraction: 0.5,
    hipHalfWidth: 0.17,
    shoulderHalfWidth: 0.24,
    torsoFraction: 0.28,
    neckLength: 0.05,
    headSize: 0.165,
    armFraction: 0.5,
    stoop: 0.45,
    hover: 0,
    capeSegments: 4,
    orbitCount: 3,
  }),
  profile: profile({
    idlePeriod: 3.8,
    breath: 0.6,
    stanceWidth: 1,
    crouch: 0,
    armSplay: 0.26,
    walkSpeed: 2.8,
    runSpeed: 4.4,
    stride: 1,
    bob: 0.03,
    lean: 0.06,
    armSwing: 0.2,
    attackDuration: 1.1,
    attackStyle: 'thrust',
    castDuration: 1.7,
    castStyle: 'hurl',
    weight: 0.3,
    capeSegments: 4,
    orbitCount: 3,
    orbitRadius: 0.46,
  }),
  slots: {
    armor: slot('unit.bone', { tint: 'accent', roughness: 0.68, metalness: 0 }),
    cloth: slot('unit.cloth', { tint: 'primary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'secondary', metalness: 0 }),
    metal: slot('unit.steel', { tint: 'accent', roughness: 0.42, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'none', shade: 0.85, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 4.6 }),
  },
  palette: MAGE_PALETTE,
  visual: visual('creep.hexwright', 'pointed-hat-robe-staff', MAGE_PALETTE, 1, ['cloth', 'bone']),
  build(b, rig) {
    const p = rig.proportions;
    const hs = p.headSize;
    addBody(b, rig, {
      torsoSlot: 'cloth',
      limbSlot: 'cloth',
      handSlot: 'flesh',
      headSlot: 'flesh',
      round: 3.4,
      chestScale: 0.92,
      waistScale: 0.98,
      armScale: 0.6,
      handScale: 1.05,
      depthRatio: 0.78,
      head: true,
      robe: { slot: 'cloth', flare: 0.34, hemNoise: 6 },
    });

    const chest = rw(rig, B.chest);
    const neck = rw(rig, B.neck);

    // ── THE HAT. Brim first: a drooping disc wide enough to throw the face
    // into shadow, which is what makes the beard read as the only light shape
    // on the head.
    b.add(
      shell({
        nu: 18,
        nv: 4,
        surface: (u, v, out) => {
          const a = u * Math.PI * 2;
          const r = 0.135 + v * 0.205;
          out.set(Math.sin(a) * r, -v * v * 0.1 + Math.sin(a * 3) * v * 0.022, Math.cos(a) * r);
        },
        thickness: (_u, v) => 0.016 * (1 - v * 0.45),
        uvScale: 1.8,
        smoothAngle: 42,
      }),
      {
        slot: 'cloth',
        bone: B.head,
        at: [0, hs * 0.62, -hs * 0.05],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    // Crown: a cone that leans forward as it narrows, so the tip overhangs the
    // brim instead of standing to attention.
    b.add(
      loft(
        [
          { y: 0, w: 0.155, d: 0.155, round: 3.6 },
          { y: 0.13, w: 0.145, d: 0.145, round: 3.6 },
          { y: 0.32, w: 0.11, d: 0.11, z: 0.025, round: 3.4 },
          { y: 0.5, w: 0.07, d: 0.07, z: 0.095, round: 3.2 },
          { y: 0.62, w: 0.036, d: 0.036, z: 0.185, round: 3 },
          { y: 0.68, w: 0.012, d: 0.012, z: 0.265, round: 3 },
        ],
        { segments: 10, smoothAngle: 46 },
      ),
      {
        slot: 'cloth',
        bone: B.head,
        at: [0, hs * 0.58, -hs * 0.05],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1.4,
      },
    );
    b.add(torus(0.158, 0.026, 5, 16), {
      slot: 'metal',
      bone: B.head,
      at: [0, hs * 0.62 + 0.05, -hs * 0.05],
      rot: [Math.PI / 2, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1.2,
    });

    // ── Beard: a pale wedge hanging to the chest. Under the brim's shadow it
    // is the brightest thing on the figure, which points at the face.
    b.add(
      loft(
        [
          { y: -0.46, w: hs * 0.14, d: hs * 0.14, z: hs * 0.36, round: 3 },
          { y: -0.3, w: hs * 0.46, d: hs * 0.38, z: hs * 0.5, round: 3.2 },
          { y: -0.12, w: hs * 0.62, d: hs * 0.5, z: hs * 0.56, round: 3.2 },
          { y: 0.02, w: hs * 0.56, d: hs * 0.46, z: hs * 0.5, round: 3.2 },
        ],
        { segments: 10, smoothAngle: 48 },
      ),
      {
        slot: 'armor',
        bone: B.head,
        at: [0, 0, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1.2,
      },
    );
    b.add(gem(0.02, 0), {
      slot: 'glow',
      bone: B.head,
      at: [hs * 0.28, hs * 0.16, hs * 0.66],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // Shoulder shroud, bell sleeves and a back drape: mass at the top of the
    // robe so the figure is a triangle rather than a tube.
    b.add(plate({ width: 0.54, height: 0.3, thickness: 0.016, bow: 0.3, droop: 0.32, topScale: 0.55, bottomScale: 1.25 }), {
      slot: 'cloth',
      at: [0, neck[1] - 0.04, -0.02],
      rot: [0.1, 0, 0],
      bind: { bones: [B.chest, B.neck], falloff: 0.26, bias: 1.4 },
      uvScale: 1.4,
    });
    b.add(
      loft(
        [
          { y: -0.3, w: 0.11, d: 0.11, round: 4 },
          { y: -0.12, w: 0.135, d: 0.135, round: 4 },
          { y: 0.06, w: 0.075, d: 0.075, round: 4 },
        ],
        { segments: 10, smoothAngle: 46 },
      ),
      {
        slot: 'cloth',
        bone: 'elbow.L',
        at: [0, -0.1, 0],
        mirror: true,
        bind: { bones: ['elbow.L', 'wrist.L'], rigid: true },
        uvScale: 1.3,
      },
    );
    cape(b, rig, { slot: 'leather', width: 0.36, length: p.height * 0.52, flare: 0.7, z: -0.04, thickness: 0.011 });

    // ── Staff: gnarled, taller than the hat, with a caged ember on top. Held
    // out from the body so it never merges with the robe's outline.
    const staffLen = 1.72;
    b.add(
      loft(
        [
          { y: 0, w: 0.026, d: 0.026, round: 5 },
          { y: staffLen * 0.3, w: 0.03, d: 0.03, x: 0.018, z: 0.012, round: 5 },
          { y: staffLen * 0.58, w: 0.026, d: 0.026, x: -0.012, z: 0.02, round: 5 },
          { y: staffLen * 0.84, w: 0.031, d: 0.031, x: 0.01, z: 0.004, round: 5 },
          { y: staffLen, w: 0.024, d: 0.024, round: 5 },
        ],
        { segments: 7, smoothAngle: 50 },
      ),
      {
        slot: 'leather',
        bone: 'hand.R',
        at: [0.03, -0.44, 0.08],
        rot: [0.06, 0, -0.06],
        bind: { bones: ['hand.R'], rigid: true },
        uvScale: 2,
      },
    );
    const orbY = -0.44 + staffLen + 0.1;
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      b.add(spike({ length: 0.19, baseW: 0.018, curve: -0.55, taper: 1.5, segments: 5 }), {
        slot: 'metal',
        bone: 'hand.R',
        at: [0.03 + Math.sin(a) * 0.05, orbY - 0.12, 0.08 + Math.cos(a) * 0.05],
        rot: [-Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5],
        bind: { bones: ['hand.R'], rigid: true },
        uvScale: 0.6,
      });
    }
    b.add(gem(0.072, 1), {
      slot: 'glow',
      bone: 'hand.R',
      at: [0.03, orbY, 0.08],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1,
    });

    // Orbiting runes, so a caster is identifiable even from behind.
    for (let i = 0; i < p.orbitCount; i++) {
      b.add(gem(0.058, 0), {
        slot: 'glow',
        bone: `orbit${i}`,
        bind: { bones: [`orbit${i}`], rigid: true },
        uvScale: 1,
      });
    }
    void chest;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 10. Dragón — boss (WINGED FLYER)
//
// SILHOUETTE HOOK: a wing span wider than the body is long, held a metre off
// the ground with the talons hanging free. Nothing else in the game leaves the
// floor, so "the one that flies" is the identification before the horns, the
// tail or the scale of it register at all.
//
// The body is a horizontal barrel like the wolf's, for the same reason and by
// the same trick (chest thrown forward of the pelvis by `stoop`), but read the
// other way: the wolf is low and long, the dragon is high and spread.
//
// WINGS ON A BIPED RIG: each wing is bound rigidly to its shoulder bone, so it
// inherits the shoulder's animation. On the Z axis (the flap axis) the idle's
// breathing term drives a slow symmetric beat; on the X axis the arm-swing term
// twists the angle of attack. `armSwing` is therefore kept very low — a normal
// value would make the wings feather alternately, like rowing. A real flap
// needs two bones per wing; the report states what that would cost.
// ─────────────────────────────────────────────────────────────────────────────

// Primary sits below the chitin map's own mean: a brighter target clamps the
// compensated tint at white and the sun blooms the whole figure out.
const DRAGON_PALETTE: Palette = {
  primary: 0x6d2f2a,
  secondary: 0x2e2622,
  accent: 0xa98c52,
  emissive: 0xff8a1f,
};

const titan: CharacterDef = {
  id: 'boss.marrowTitan',
  name: 'Dragón',
  kind: 'boss',
  archetype: 'boss',
  proportions: prop({
    height: 3.0,
    // Short legs held high: 1.1 m of daylight under the talons is the whole
    // point of the creature, and long legs would turn into stilts that touch
    // down and cancel it.
    legFraction: 0.22,
    hipHalfWidth: 0.28,
    shoulderHalfWidth: 0.46,
    torsoFraction: 0.16,
    neckLength: 0.26,
    headSize: 0.34,
    // Short arm bones: the wings are authored geometry, the chain only orients
    // them. A long chain here would swing the wing roots around.
    armFraction: 0.26,
    stoop: 3.2,
    hover: 1.1,
    tailSegments: 6,
    footLength: 0.3,
  }),
  profile: profile({
    idlePeriod: 4.0,
    // Drives the symmetric wing beat: it is the only term on the flap axis.
    breath: 2.2,
    stanceWidth: 1.4,
    crouch: 0,
    armSplay: 0.08,
    walkSpeed: 2.4,
    runSpeed: 3.6,
    stride: 1.5,
    stanceFraction: 0.68,
    bob: 0.06,
    lean: 0.05,
    // Low on purpose: on a wing this axis is angle of attack, not swing.
    armSwing: 0.1,
    footLift: 0.1,
    attackDuration: 1.7,
    attackStyle: 'claw',
    castDuration: 2.4,
    castStyle: 'summon',
    weight: 1,
    hover: true,
    tailSegments: 6,
  }),
  slots: {
    armor: slot('unit.chitin', { tint: 'primary', roughness: 0.5, metalness: 0.2 }),
    cloth: slot('unit.leather', { tint: 'secondary', shade: 1.2, metalness: 0 }),
    leather: slot('unit.leather', { tint: 'secondary', metalness: 0 }),
    metal: slot('unit.bone', { tint: 'accent', roughness: 0.5, metalness: 0 }),
    flesh: slot('unit.skin', { tint: 'primary', shade: 0.8, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 3.4 }),
  },
  palette: DRAGON_PALETTE,
  visual: visual('boss.marrowTitan', 'winged-flyer-spread-wings', DRAGON_PALETTE, 1, ['chitin', 'bone']),
  build(b, rig) {
    const p = rig.proportions;
    const hs = p.headSize;
    addBody(b, rig, {
      torsoSlot: 'flesh',
      limbSlot: 'flesh',
      bootSlot: 'armor',
      round: 4,
      legScale: 0.78,
      bootScale: 0.85,
      torso: false,
      arms: false,
      neck: false,
      head: false,
    });

    const chest = rw(rig, B.chest);
    const pelvis = rw(rig, B.pelvis);

    // ── Body: one barrel swept along the pelvis→chest line, sections held
    // perpendicular to it. Deep at the wing roots, where the flight muscle is.
    const dy = chest[1] - pelvis[1];
    const dz = chest[2] - pelvis[2];
    const tilt = Math.atan2(dz, dy);
    const spineRing = (t: number, w: number, d: number, round = 3.8): Ring => ({
      y: pelvis[1] + dy * t,
      z: pelvis[2] + dz * t,
      w,
      d,
      round,
      tiltX: tilt,
    });
    b.add(
      roughen(
        loft(
          [
            spineRing(-0.62, 0.17, 0.19),
            spineRing(-0.2, 0.3, 0.33),
            spineRing(0.22, 0.29, 0.34),
            spineRing(0.62, 0.35, 0.42),
            spineRing(0.98, 0.4, 0.44),
            spineRing(1.22, 0.29, 0.32),
            spineRing(1.36, 0.17, 0.19),
          ],
          { segments: 14, smoothAngle: 48 },
        ),
        0.016,
        5,
        9,
      ),
      {
        slot: 'flesh',
        bind: { bones: [B.chest, B.spine, B.pelvis], falloff: 0.45, bias: 1.1 },
        uvScale: 1.8,
      },
    );
    // Scaled back plates over the top of the barrel, belly bands underneath.
    for (let i = 0; i < 4; i++) {
      const t = 0.1 + i * 0.32;
      b.add(plate({ width: 0.5 - i * 0.04, height: 0.26, thickness: 0.032, bow: 0.34, topScale: 0.9, bottomScale: 1 }), {
        slot: 'armor',
        at: [0, pelvis[1] + dy * t + 0.24, pelvis[2] + dz * t - 0.12],
        rot: [1.3, 0, 0],
        bind: { bones: [B.chest, B.spine, B.pelvis], falloff: 0.3, bias: 1.2 },
        uvScale: 1.4,
      });
    }

    // ── Neck: thick at the shoulders, dipping forward and DOWN. A dragon that
    // carries its head level with its own back has no neck at all from a
    // camera 35 degrees above it — the skull just merges into the chest.
    b.add(
      loft(
        [
          // First ring starts INSIDE the barrel, so the join is a seam and not
          // the hole that two nearly-touching capped lofts leave.
          { y: chest[1] - 0.1, z: chest[2] - 0.14, w: 0.35, d: 0.37, round: 3.6, tiltX: 0.5 },
          { y: chest[1] - 0.08, z: chest[2] + 0.22, w: 0.25, d: 0.27, round: 3.4, tiltX: 1.2 },
          { y: chest[1] - 0.2, z: chest[2] + 0.58, w: 0.22, d: 0.23, round: 3.4, tiltX: 1.75 },
        ],
        { segments: 12, smoothAngle: 50 },
      ),
      {
        slot: 'flesh',
        bind: { bones: [B.neck, B.chest, B.head], falloff: 0.3, bias: 1.2 },
        uvScale: 1.4,
      },
    );

    // ── Skull: built pointing along +Y and laid forward. Long muzzle, heavy
    // brow, and two horns that sweep back past the neck.
    // Nose down 12 degrees, not level: a muzzle pointing straight away from a
    // camera that is already above it foreshortens into a disc.
    const skullRot: [number, number, number] = [Math.PI / 2 + 0.2, 0, 0];
    // Pushed forward of the head bone AND dropped below the line of the back,
    // so the skull is its own shape rather than a bump on the shoulders.
    const skullAt: [number, number, number] = [0, -0.58, 0.62];
    b.add(
      loft(
        [
          // Wider than it is deep all the way along: a flat wedge seen from
          // above beats a round tube seen from anywhere.
          { y: -hs * 0.5, w: hs * 0.66, d: hs * 0.56, round: 3.6 },
          { y: 0, w: hs * 0.98, d: hs * 0.7, round: 3.8 },
          { y: hs * 0.5, w: hs * 0.82, d: hs * 0.56, round: 3.6 },
          { y: hs * 1.25, w: hs * 0.52, d: hs * 0.42, round: 3.4 },
          { y: hs * 1.85, w: hs * 0.36, d: hs * 0.3, round: 3.2 },
          { y: hs * 2.1, w: hs * 0.28, d: hs * 0.24, round: 3 },
        ],
        { segments: 12, smoothAngle: 50 },
      ),
      {
        slot: 'flesh',
        bone: B.head,
        at: skullAt,
        rot: skullRot,
        bind: { bones: [B.head], rigid: true },
        uvScale: 1.3,
      },
    );
    b.add(
      loft(
        [
          { y: 0, w: hs * 0.5, d: hs * 0.24, round: 3.4 },
          { y: hs * 1.0, w: hs * 0.36, d: hs * 0.2, round: 3.2 },
          { y: hs * 1.95, w: hs * 0.22, d: hs * 0.14, round: 3 },
        ],
        { segments: 10, smoothAngle: 50 },
      ),
      {
        slot: 'flesh',
        bone: B.head,
        at: [0, skullAt[1] - hs * 0.42, skullAt[2] + 0.02],
        rot: [skullRot[0]! + 0.12, 0, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1.2,
      },
    );
    // Horns: the second-widest thing on the head after the jaw.
    b.add(spike({ length: hs * 2.4, baseW: hs * 0.26, curve: -0.75, taper: 1.6, segments: 7 }), {
      slot: 'metal',
      bone: B.head,
      at: [hs * 0.42, skullAt[1] + hs * 0.36, skullAt[2] + hs * 0.1],
      // Nearly horizontal, swept out and back: from a camera 35 degrees above
      // the head, a horn that stands up is a 3 px stub, and a horn that lies
      // out along the shoulders is a 25 px line. Two of them frame the skull.
      rot: [-1.35, 0, -0.8],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.8,
    });
    b.add(spike({ length: hs * 1.1, baseW: hs * 0.16, curve: -0.5, taper: 1.7, segments: 5 }), {
      slot: 'metal',
      bone: B.head,
      at: [hs * 0.5, skullAt[1] + hs * 0.1, skullAt[2] + hs * 0.55],
      rot: [-0.3, 0, -1.0],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.7,
    });
    // Teeth along the upper jaw.
    for (let i = 0; i < 4; i++) {
      b.add(spike({ length: hs * 0.24, baseW: hs * 0.06, curve: 0, taper: 1.8, segments: 5 }), {
        slot: 'metal',
        bone: B.head,
        at: [hs * 0.34, skullAt[1] - hs * 0.28, skullAt[2] + hs * (0.55 + i * 0.42)],
        rot: [Math.PI, 0, 0],
        mirror: true,
        bind: { bones: [B.head], rigid: true },
        uvScale: 0.5,
      });
    }
    b.add(gem(0.05, 0), {
      slot: 'glow',
      bone: B.head,
      at: [hs * 0.36, skullAt[1] + hs * 0.16, skullAt[2] + hs * 0.42],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });
    // Throat glow: the fire is visible before it is breathed.
    b.add(gem(0.055, 0), {
      slot: 'glow',
      bind: { bones: [B.neck, B.chest], falloff: 0.2, bias: 1.4 },
      at: [0, chest[1] + 0.04, chest[2] + 0.26],
      uvScale: 1,
    });

    // ── WINGS. Bound rigidly to the shoulders, spanning 1.55 m each side, so
    // the figure is 4 m across before the gameplay scale multiplies it.
    b.add(
      wing({
        span: 1.8,
        rootChord: 1.06,
        tipChord: 0.3,
        sweep: 0.95,
        fingers: 4,
        scallop: 0.38,
        droop: 0.24,
        camber: 0.1,
        thickness: 0.013,
        strut: 0.055,
        sag: 0.09,
      }),
      {
        slot: 'cloth',
        bone: 'shoulder.L',
        at: [0.08, 0.3, -0.06],
        rot: [0, 0.1, 0.16],
        mirror: true,
        bind: { bones: ['shoulder.L'], rigid: true },
        uvScale: 1,
      },
    );
    // Leading-edge spar and the wrist claw at its elbow, so the wing has a
    // hard lit edge along the top instead of a soft membrane rim.
    // The loft grows along +Y, so the Z rotation that lays it along the span
    // has to be NEGATIVE: +PI/2 would send the spar out of the far side of the
    // body, away from its own membrane.
    b.add(
      loft(
        [
          { y: 0, w: 0.075, d: 0.095, round: 4 },
          { y: 0.62, x: 0, z: -0.26, w: 0.05, d: 0.062, round: 4 },
          { y: 1.2, x: 0, z: -0.58, w: 0.032, d: 0.04, round: 3.6 },
          { y: 1.74, x: 0, z: -0.86, w: 0.016, d: 0.02, round: 3.4 },
        ],
        { segments: 8, smoothAngle: 50 },
      ),
      {
        slot: 'armor',
        bone: 'shoulder.L',
        at: [0.08, 0.3, 0.32],
        rot: [0, 0.1, -Math.PI / 2 - 0.16],
        mirror: true,
        bind: { bones: ['shoulder.L'], rigid: true },
        uvScale: 1.4,
      },
    );
    b.add(spike({ length: 0.34, baseW: 0.05, curve: 0.4, taper: 1.7, segments: 5 }), {
      slot: 'metal',
      bone: 'shoulder.L',
      at: [0.72, 0.42, 0.06],
      rot: [0.2, 0, -1.1],
      mirror: true,
      bind: { bones: ['shoulder.L'], rigid: true },
      uvScale: 0.7,
    });

    // ── Tail: six segments, ending in a blade. It balances the neck so the
    // creature reads as suspended rather than as standing on nothing.
    const segs = p.tailSegments;
    for (let i = 0; i < segs; i++) {
      const t = i / segs;
      const len = boneDistance(rig, `tail${i}`, i + 1 < segs ? `tail${i + 1}` : `tail${i}`) || 0.18;
      b.add(
        limbGeo({
          len: Math.max(0.1, len) * 1.12,
          topW: 0.155 * (1 - t * 0.72),
          topD: 0.175 * (1 - t * 0.72),
          botW: 0.145 * (1 - (t + 0.18) * 0.76),
          botD: 0.16 * (1 - (t + 0.18) * 0.76),
          round: 3.6,
          segments: 9,
        }),
        {
          slot: 'flesh',
          bone: `tail${i}`,
          // See the wolf: `limbGeo` grows along -Y, so this angle is positive.
          rot: [Math.PI / 2, 0, 0],
          bind: { bones: [`tail${i}`, i + 1 < segs ? `tail${i + 1}` : `tail${i}`], falloff: 0.16, bias: 1.4 },
          uvScale: 1.2,
        },
      );
      if (i % 2 === 0) {
        b.add(spike({ length: 0.2 * (1 - t * 0.5), baseW: 0.045, curve: -0.4, taper: 1.8, segments: 5 }), {
          slot: 'metal',
          bone: `tail${i}`,
          at: [0, 0.06, -0.04],
          rot: [-0.4, 0, 0],
          bind: { bones: [`tail${i}`], rigid: true },
          uvScale: 0.6,
        });
      }
    }
    b.add(blade({ length: 0.46, width: 0.3, thickness: 0.05, curve: 0.2, belly: 0.5, tip: 0.2, heel: 0.35 }), {
      slot: 'metal',
      bone: `tail${segs - 1}`,
      at: [0, 0, -0.06],
      rot: [-Math.PI / 2, 0, 0],
      bind: { bones: [`tail${segs - 1}`], rigid: true },
      uvScale: 1.2,
    });

    // ── Talons on the hanging feet: three claws each, curled forward.
    for (let i = 0; i < 3; i++) {
      b.add(spike({ length: 0.26, baseW: 0.045, curve: 0.55, taper: 1.7, segments: 5 }), {
        slot: 'metal',
        bone: 'ankle.L',
        at: [(i - 1) * 0.07, -rw(rig, 'ankle.L')[1] + p.hover + 0.04, p.footLength * 0.55],
        rot: [Math.PI / 2 + 0.5, 0, (i - 1) * 0.3],
        mirror: true,
        bind: { bones: ['ankle.L'], rigid: true },
        uvScale: 0.6,
      });
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export const CHARACTERS: readonly CharacterDef[] = [
  bulwark,
  oracle,
  talon,
  vesper,
  cleaver,
  spinebolt,
  duskrunner,
  bastion,
  hexwright,
  titan,
];

const BY_ID = new Map<string, CharacterDef>(CHARACTERS.map((c) => [c.id, c]));

export function getCharacter(id: string): CharacterDef | undefined {
  return BY_ID.get(id);
}

export interface BuiltCharacter {
  def: CharacterDef;
  rig: Rig;
  geometry: THREE.BufferGeometry;
  materials: THREE.MeshStandardMaterial[];
}

/** Builds geometry + rig for a definition. Cached: geometry is shared. */
const CACHE = new Map<string, BuiltCharacter>();

/**
 * Imported meshes registered before the first spawn, keyed by character id.
 *
 * `buildCharacter` is synchronous and cached, but loading a glTF is not. Rather
 * than make every caller async — gameplay spawns units mid-tick — an async boot
 * pass loads and binds the models, registers them here, and `buildCharacter`
 * simply prefers them. A character with no override builds procedurally exactly
 * as before, so art can land one piece at a time.
 */
const OVERRIDES = new Map<string, BuiltCharacter>();

export function registerBuiltOverride(id: string, built: BuiltCharacter): void {
  OVERRIDES.set(id, built);
  // Drop any procedural build already cached, so the next spawn picks this up.
  CACHE.delete(id);
}

export function hasBuiltOverride(id: string): boolean {
  return OVERRIDES.has(id);
}

export function buildCharacter(def: CharacterDef): BuiltCharacter {
  const override = OVERRIDES.get(def.id);
  if (override) return override;
  const cached = CACHE.get(def.id);
  if (cached) return cached;
  const rig = buildRig(def.proportions);
  const builder = new CharacterBuilder(rig, def.slots, def.palette, def.id);
  def.build(builder, rig);
  const { geometry, materials: mats } = builder.build();
  const built: BuiltCharacter = { def, rig, geometry, materials: mats };
  CACHE.set(def.id, built);
  return built;
}

export function disposeCharacterCache(): void {
  for (const c of CACHE.values()) c.geometry.dispose();
  CACHE.clear();
}
