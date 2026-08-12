/**
 * Character catalog. Owner: CHARACTERS agent.
 *
 * Eight original archetypes: two contrasting heroes, the five enemy roles the
 * GDD §13 bestiary requires, and one boss. Every mass here exists to serve the
 * outline — the review bar is "identifiable from silhouette alone", so each
 * recipe commits to one dominant shape and refuses to share it:
 *
 *   bulwark    wide trapezoid, slab shield left, hammer right
 *   oracle     tall cone, fan collar, big ring on a staff
 *   cleaver    lopsided box, one huge right pauldron, low cleaver
 *   spinebolt  narrow vertical + horizontal bow + fan of back spines
 *   duskrunner low horizontal arrow, digitigrade, long tail
 *   bastion    squat dome, no neck, ground-dragging fists
 *   hexwright  floating spike cluster, nothing touching the ground
 *   titan      asymmetric giant, one fused maul arm, horn crown
 *
 * Nothing here is derived from any existing game's art: shapes are generated
 * from parameters and the names, proportions and kit are original.
 */

import * as THREE from 'three';
import type { VisualDescriptor } from '@/core/contracts';
import type { MaterialId } from '@/art/materials';
import { CharacterBuilder, type Palette, type SlotConfig, type SlotName } from './build/character';
import { addBody, boneDistance, limbGeo, rw } from './build/body';
import { blade, gem, lathe, loft, plate, prism, roughen, shell, spike, sphereish, torus } from './build/shapes';
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
  primary: 0x6e7d90,
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
// 3. Ruin Cleaver — melee creep
// ─────────────────────────────────────────────────────────────────────────────

const CLEAVER_PALETTE: Palette = {
  primary: 0x5b6b4e,
  secondary: 0x5c3a24,
  accent: 0x9a8f74,
  emissive: 0x9fe86a,
};

const cleaver: CharacterDef = {
  id: 'creep.cleaver',
  name: 'Ruin Cleaver',
  kind: 'creep',
  archetype: 'melee',
  proportions: prop({
    height: 1.98,
    legFraction: 0.42,
    hipHalfWidth: 0.17,
    shoulderHalfWidth: 0.35,
    torsoFraction: 0.29,
    neckLength: 0.03,
    headSize: 0.19,
    armFraction: 0.5,
    stoop: 0.4,
    footLength: 0.26,
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
    armor: slot('unit.chitin', { tint: 'primary', roughness: 0.55, metalness: 0.2 }),
    cloth: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'none', metalness: 0 }),
    metal: slot('unit.steel', { tint: 'none', roughness: 0.5, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'primary', shade: 0.85, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 3.5 }),
  },
  palette: CLEAVER_PALETTE,
  visual: visual('creep.cleaver', 'lopsided-hunched-box', CLEAVER_PALETTE, 1, ['chitin', 'leather']),
  build(b, rig) {
    const p = rig.proportions;
    addBody(b, rig, {
      torsoSlot: 'flesh',
      limbSlot: 'flesh',
      handSlot: 'flesh',
      headSlot: 'flesh',
      bootSlot: 'leather',
      round: 3.6,
      chestScale: 1.1,
      waistScale: 0.86,
      armScale: 1.12,
      legScale: 1.05,
      handScale: 1.45,
      bootScale: 1.15,
      depthRatio: 0.76,
      neck: false,
    });

    const chest = rw(rig, B.chest);
    const pelvis = rw(rig, B.pelvis);

    // Asymmetry is the whole read: one huge right shoulder, one bare left arm.
    pauldron(b, rig, 'R', { size: 0.31, slot: 'armor', lames: 2, tiltOut: 0.5, spike: 1.8, spikeSlot: 'metal' });
    b.add(prism({ h: 0.17, w0: 0.09, d0: 0.1, w1: 0.075, d1: 0.085, round: 5, segments: 8 }), {
      slot: 'leather',
      bone: 'elbow.L',
      at: [0, -0.16, 0],
      bind: { bones: ['elbow.L', 'wrist.L'], rigid: true },
      uvScale: 1.2,
    });

    // Chest strapping and a hanging loincloth.
    b.add(plate({ width: 0.36, height: 0.1, thickness: 0.02, bow: 0.3, topScale: 0.9, bottomScale: 0.9 }), {
      slot: 'leather',
      at: [0.02, chest[1] - 0.24, chest[2] + 0.02],
      rot: [0, 0, 0.42],
      bind: { bones: [B.chest, B.spine], falloff: 0.2, bias: 1.4 },
      uvScale: 1.2,
    });
    clothPanel(b, rig, {
      slot: 'cloth',
      bones: [B.pelvis],
      topY: pelvis[1] + 0.04,
      bottomY: pelvis[1] - 0.42,
      topW: 0.3,
      bottomW: 0.24,
      z: p.hipHalfWidth * 1.0,
      hemPoint: 0.35,
    });

    // Head: heavy jaw, two short forward horns, single glowing eye slit.
    b.add(
      loft(
        [
          { y: -0.06, w: p.headSize * 0.72, d: p.headSize * 0.94, z: p.headSize * 0.3, round: 3 },
          { y: 0.05, w: p.headSize * 0.92, d: p.headSize * 1.0, z: p.headSize * 0.12, round: 3.2 },
          { y: 0.17, w: p.headSize * 0.8, d: p.headSize * 0.84, z: -p.headSize * 0.06, round: 3.2 },
        ],
        { segments: 10, smoothAngle: 52 },
      ),
      {
        slot: 'flesh',
        bone: B.head,
        at: [0, p.headSize * 0.3, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    b.add(spike({ length: p.headSize * 1.35, baseW: p.headSize * 0.2, curve: 0.5, taper: 1.9, segments: 6 }), {
      slot: 'metal',
      bone: B.head,
      at: [p.headSize * 0.5, p.headSize * 0.55, p.headSize * 0.1],
      rot: [0.3, 0, -0.5],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.7,
    });
    b.add(prism({ h: 0.03, w0: 0.02, d0: p.headSize * 0.34, w1: 0.014, d1: p.headSize * 0.3, round: 4, segments: 5 }), {
      slot: 'glow',
      bone: B.head,
      at: [0, p.headSize * 0.42, p.headSize * 0.78],
      rot: [Math.PI / 2, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.5,
    });

    // ── Cleaver: broad, curved, held low in the right hand.
    b.add(prism({ h: 0.34, w0: 0.034, d0: 0.034, w1: 0.03, d1: 0.03, round: 6, segments: 6 }), {
      slot: 'leather',
      bone: 'hand.R',
      at: [0, -0.14, 0.02],
      rot: [0.3, 0, 0.12],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1.2,
    });
    b.add(blade({ length: 0.78, width: 0.4, thickness: 0.05, curve: 0.42, belly: 0.62, tip: 0.42, heel: 0.72 }), {
      slot: 'metal',
      bone: 'hand.R',
      at: [0.02, 0.14, 0.06],
      rot: [0.3, 0, 0.12],
      bind: { bones: ['hand.R'], rigid: true },
      uvScale: 1.4,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 4. Spinebolt Stalker — ranged creep
// ─────────────────────────────────────────────────────────────────────────────

const SPINEBOLT_PALETTE: Palette = {
  primary: 0x33404f,
  secondary: 0x4a3524,
  accent: 0xb9ad90,
  emissive: 0x66d8ff,
};

const spinebolt: CharacterDef = {
  id: 'creep.spinebolt',
  name: 'Spinebolt Stalker',
  kind: 'creep',
  archetype: 'ranged',
  proportions: prop({
    height: 2.12,
    legFraction: 0.54,
    hipHalfWidth: 0.14,
    shoulderHalfWidth: 0.23,
    torsoFraction: 0.26,
    neckLength: 0.07,
    headSize: 0.155,
    armFraction: 0.46,
    stoop: 0.14,
    footLength: 0.24,
  }),
  profile: profile({
    idlePeriod: 2.8,
    breath: 0.8,
    stanceWidth: 1.1,
    crouch: 0.28,
    armSplay: 0.16,
    walkSpeed: 3.4,
    runSpeed: 6.0,
    stride: 1.3,
    bob: 0.04,
    lean: 0.1,
    armSwing: 0.4,
    footLift: 0.19,
    attackDuration: 1.25,
    attackStyle: 'shoot',
    castDuration: 1.4,
    castStyle: 'hurl',
    weight: 0.3,
    mainHand: 'R',
  }),
  slots: {
    armor: slot('unit.chitin', { tint: 'primary', roughness: 0.45, metalness: 0.25 }),
    cloth: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'none', metalness: 0 }),
    metal: slot('unit.bone', { tint: 'accent', roughness: 0.6, metalness: 0 }),
    flesh: slot('unit.skin', { tint: 'primary', shade: 1.15, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 3.8 }),
  },
  palette: SPINEBOLT_PALETTE,
  visual: visual('creep.spinebolt', 'narrow-vertical-crossed-bow', SPINEBOLT_PALETTE, 1, ['chitin', 'bone']),
  build(b, rig) {
    const p = rig.proportions;
    addBody(b, rig, {
      torsoSlot: 'armor',
      limbSlot: 'flesh',
      handSlot: 'flesh',
      headSlot: 'armor',
      bootSlot: 'leather',
      round: 3.2,
      chestScale: 0.96,
      waistScale: 0.82,
      armScale: 0.72,
      legScale: 0.82,
      handScale: 1.05,
      bootScale: 1.05,
      depthRatio: 0.66,
      head: false,
    });

    const chest = rw(rig, B.chest);

    // Beaked mask instead of a face; the profile is the recognition cue.
    b.add(
      loft(
        [
          { y: -p.headSize * 0.7, w: p.headSize * 0.5, d: p.headSize * 0.55, round: 3 },
          { y: -p.headSize * 0.1, w: p.headSize * 0.92, d: p.headSize * 1.0, round: 3.2 },
          { y: p.headSize * 0.45, w: p.headSize * 0.8, d: p.headSize * 0.88, z: -p.headSize * 0.08, round: 3.2 },
          { y: p.headSize * 0.85, w: p.headSize * 0.4, d: p.headSize * 0.46, z: -p.headSize * 0.16, round: 3 },
        ],
        { segments: 10, smoothAngle: 52 },
      ),
      {
        slot: 'armor',
        bone: B.head,
        at: [0, p.headSize * 0.4, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    b.add(spike({ length: p.headSize * 1.5, baseW: p.headSize * 0.3, curve: 0, taper: 2.2, segments: 6 }), {
      slot: 'metal',
      bone: B.head,
      at: [0, p.headSize * 0.34, p.headSize * 0.5],
      rot: [Math.PI / 2 + 0.25, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.7,
    });
    b.add(gem(0.028, 0), {
      slot: 'glow',
      bone: B.head,
      at: [p.headSize * 0.36, p.headSize * 0.56, p.headSize * 0.42],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // ── Quiver of spines fanning up behind the shoulders.
    spikeRow(b, rig, {
      bone: B.chest,
      count: 7,
      from: [-0.22, chest[1] - 0.02, -0.14],
      to: [0.22, chest[1] - 0.02, -0.14],
      length: 0.78,
      baseW: 0.032,
      slot: 'metal',
      curve: -0.34,
      tilt: -0.42,
      bind: [B.chest],
    });
    b.add(plate({ width: 0.26, height: 0.16, thickness: 0.022, bow: -0.24, topScale: 1.1, bottomScale: 0.7 }), {
      slot: 'leather',
      at: [0, chest[1] - 0.14, -0.13],
      rot: [0.3, 0, 0],
      bind: { bones: [B.chest], rigid: true },
      uvScale: 1.2,
    });

    // Light shoulder caps only — the silhouette must stay narrow.
    pauldron(b, rig, 'both', { size: 0.13, slot: 'armor', lames: 1, tiltOut: 0.3 });

    // ── Bow: held horizontally across the body. The crossbar of the "T".
    const span = 1.5;
    b.add(
      shell({
        nu: 5,
        nv: 16,
        surface: (u, v, out) => {
          const k = (v - 0.5) * 2;
          const w = 0.055 * (1 - 0.75 * Math.abs(k));
          // Recurve: the limbs bend back at the tips.
          const bend = 0.3 * k * k + 0.1 * Math.pow(Math.abs(k), 6) * Math.sign(k) * 0;
          out.set(k * span * 0.5, (u - 0.5) * w * 2, -bend + 0.16 * Math.pow(Math.abs(k), 3.2));
        },
        thickness: (_u, v) => 0.028 * (1 - 0.6 * Math.abs((v - 0.5) * 2)) + 0.006,
        uvScale: 2.4,
        smoothAngle: 44,
      }),
      {
        slot: 'metal',
        bone: 'hand.L',
        at: [0.02, -0.02, 0.13],
        rot: [0.16, 0, 0.14],
        bind: { bones: ['hand.L'], rigid: true },
        uvScale: 1,
      },
    );
    b.add(prism({ h: 0.16, w0: 0.032, d0: 0.05, w1: 0.032, d1: 0.05, round: 5, segments: 6 }), {
      slot: 'leather',
      bone: 'hand.L',
      at: [0.02, -0.1, 0.13],
      rot: [0.16, 0, 0.14],
      bind: { bones: ['hand.L'], rigid: true },
      uvScale: 1,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 5. Duskrunner — fast creep
// ─────────────────────────────────────────────────────────────────────────────

const DUSK_PALETTE: Palette = {
  primary: 0x453a4c,
  secondary: 0x9c3070,
  accent: 0xc9bda2,
  emissive: 0xff4fa3,
};

const duskrunner: CharacterDef = {
  id: 'creep.duskrunner',
  name: 'Duskrunner',
  kind: 'creep',
  archetype: 'fast',
  proportions: prop({
    height: 1.72,
    legType: 'digitigrade',
    legFraction: 0.56,
    hipHalfWidth: 0.13,
    shoulderHalfWidth: 0.21,
    torsoFraction: 0.26,
    neckLength: 0.08,
    headSize: 0.145,
    armFraction: 0.44,
    stoop: 0.68,
    hockOffset: 0.17,
    footLength: 0.3,
    tailSegments: 4,
  }),
  profile: profile({
    idlePeriod: 2.1,
    breath: 0.7,
    stanceWidth: 0.95,
    crouch: 0.62,
    armSplay: 0.2,
    walkSpeed: 4.6,
    runSpeed: 8.4,
    stride: 1.5,
    stanceFraction: 0.42,
    bob: 0.05,
    lean: 0.26,
    armSwing: 0.5,
    footLift: 0.24,
    attackDuration: 0.62,
    attackStyle: 'claw',
    castDuration: 1.0,
    castStyle: 'hurl',
    weight: 0.12,
    tailSegments: 4,
  }),
  slots: {
    armor: slot('unit.leather', { tint: 'primary', roughness: 0.55, metalness: 0 }),
    cloth: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'primary', shade: 0.75, metalness: 0 }),
    metal: slot('unit.steel', { tint: 'none', roughness: 0.3, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'primary', shade: 1.2, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 4 }),
  },
  palette: DUSK_PALETTE,
  visual: visual('creep.duskrunner', 'low-horizontal-arrow-tail', DUSK_PALETTE, 1, ['leather', 'cloth']),
  build(b, rig) {
    const p = rig.proportions;
    addBody(b, rig, {
      torsoSlot: 'armor',
      limbSlot: 'flesh',
      handSlot: 'flesh',
      headSlot: 'flesh',
      bootSlot: 'leather',
      round: 3,
      chestScale: 0.94,
      waistScale: 0.76,
      armScale: 0.66,
      legScale: 0.78,
      handScale: 0.95,
      bootScale: 0.95,
      depthRatio: 0.7,
      digitigrade: true,
      head: false,
    });

    const pelvis = rw(rig, B.pelvis);

    // Narrow wedge skull with a swept-back crest.
    b.add(
      loft(
        [
          { y: -p.headSize * 0.6, w: p.headSize * 0.42, d: p.headSize * 0.5, z: p.headSize * 0.5, round: 3 },
          { y: -p.headSize * 0.1, w: p.headSize * 0.78, d: p.headSize * 0.9, z: p.headSize * 0.28, round: 3 },
          { y: p.headSize * 0.4, w: p.headSize * 0.72, d: p.headSize * 0.86, z: -p.headSize * 0.1, round: 3.2 },
          { y: p.headSize * 0.72, w: p.headSize * 0.34, d: p.headSize * 0.44, z: -p.headSize * 0.28, round: 3 },
        ],
        { segments: 10, smoothAngle: 54 },
      ),
      {
        slot: 'flesh',
        bone: B.head,
        at: [0, p.headSize * 0.35, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    b.add(
      shell({
        nu: 5,
        nv: 7,
        surface: (u, v, out) => {
          out.set((u - 0.5) * 0.03, p.headSize * (0.5 + v * 0.5), -p.headSize * (0.1 + v * 1.7));
        },
        thickness: (_u, v) => 0.016 * (1 - v * 0.7),
        uvScale: 1.4,
        smoothAngle: 40,
      }),
      {
        slot: 'metal',
        bone: B.head,
        at: [0, p.headSize * 0.35, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1,
      },
    );
    b.add(gem(0.022, 0), {
      slot: 'glow',
      bone: B.head,
      at: [p.headSize * 0.34, p.headSize * 0.5, p.headSize * 0.5],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // ── Tail: the long horizontal element nothing else in the line-up has.
    const segs = p.tailSegments;
    for (let i = 0; i < segs; i++) {
      const t = i / segs;
      const len = boneDistance(rig, `tail${i}`, i + 1 < segs ? `tail${i + 1}` : `tail${i}`) || 0.14;
      b.add(
        limbGeo({
          len: Math.max(0.1, len) * 1.05,
          topW: 0.062 * (1 - t * 0.7),
          topD: 0.07 * (1 - t * 0.7),
          botW: 0.05 * (1 - (t + 0.25) * 0.7),
          botD: 0.055 * (1 - (t + 0.25) * 0.7),
          round: 3,
          segments: 8,
        }),
        {
          slot: 'flesh',
          bone: `tail${i}`,
          rot: [-Math.PI / 2, 0, 0],
          bind: { bones: [`tail${i}`, i + 1 < segs ? `tail${i + 1}` : `tail${i}`], falloff: 0.09, bias: 1.4 },
          uvScale: 1.1,
        },
      );
    }
    b.add(spike({ length: 0.24, baseW: 0.035, curve: 0.2, taper: 1.6, segments: 5 }), {
      slot: 'metal',
      bone: `tail${segs - 1}`,
      rot: [-Math.PI / 2, 0, 0],
      bind: { bones: [`tail${segs - 1}`], rigid: true },
      uvScale: 0.7,
    });

    // Hip wrap and trailing ribbons.
    clothPanel(b, rig, {
      slot: 'cloth',
      bones: [B.pelvis],
      topY: pelvis[1] + 0.06,
      bottomY: pelvis[1] - 0.26,
      topW: 0.24,
      bottomW: 0.16,
      z: p.hipHalfWidth * 0.95,
      hemPoint: 0.4,
      thickness: 0.009,
    });
    for (const sx of [-1, 1]) {
      b.add(
        shell({
          nu: 3,
          nv: 8,
          surface: (u, v, out) => {
            out.set((u - 0.5) * 0.05 * (1 - v * 0.5), -v * 0.42, -v * 0.3 - Math.sin(v * 3.4) * 0.05);
          },
          thickness: () => 0.008,
          uvScale: 1.4,
          smoothAngle: 44,
        }),
        {
          slot: 'cloth',
          bone: 'shoulder.L',
          at: [sx * 0.02, 0.02, -0.05],
          rot: [0, 0, 0],
          bind: { bones: ['shoulder.L', B.chest], falloff: 0.16, bias: 1.3 },
          uvScale: 1,
        },
      );
    }

    // ── Twin short blades, one per hand, angled back along the forearms.
    b.add(blade({ length: 0.42, width: 0.11, thickness: 0.026, curve: 0.28, belly: 0.4, tip: 0.14, heel: 0.6 }), {
      slot: 'metal',
      bone: 'hand.L',
      at: [0, -0.05, 0.03],
      rot: [-0.35, 0, 0.2],
      mirror: true,
      bind: { bones: ['hand.L'], rigid: true },
      uvScale: 1.2,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 6. Bastion Hulk — tank creep
// ─────────────────────────────────────────────────────────────────────────────

const BASTION_PALETTE: Palette = {
  primary: 0x5a564d,
  secondary: 0x322e28,
  accent: 0x9a4c1e,
  emissive: 0xff6a1f,
};

const bastion: CharacterDef = {
  id: 'creep.bastion',
  name: 'Bastion Hulk',
  kind: 'creep',
  archetype: 'tank',
  proportions: prop({
    height: 2.0,
    legFraction: 0.33,
    hipHalfWidth: 0.27,
    shoulderHalfWidth: 0.5,
    torsoFraction: 0.36,
    neckLength: 0.015,
    headSize: 0.15,
    armFraction: 0.56,
    stoop: 0.5,
    footLength: 0.3,
  }),
  profile: profile({
    idlePeriod: 5.6,
    breath: 1.8,
    stanceWidth: 1.7,
    crouch: 0.7,
    armSplay: 0.52,
    walkSpeed: 2.1,
    runSpeed: 3.3,
    stride: 0.9,
    stanceFraction: 0.7,
    bob: 0.085,
    lean: 0.05,
    armSwing: 0.28,
    footLift: 0.1,
    attackDuration: 1.55,
    attackStyle: 'slam',
    castDuration: 2.1,
    castStyle: 'summon',
    weight: 1,
  }),
  slots: {
    armor: slot('unit.chitin', { tint: 'primary', roughness: 0.62, metalness: 0.15 }),
    cloth: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'secondary', metalness: 0 }),
    metal: slot('unit.steel', { tint: 'accent', roughness: 0.55, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'primary', shade: 0.9, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 3.6 }),
  },
  palette: BASTION_PALETTE,
  visual: visual('creep.bastion', 'squat-dome-no-neck', BASTION_PALETTE, 1, ['chitin', 'steel']),
  build(b, rig) {
    const p = rig.proportions;
    addBody(b, rig, {
      torsoSlot: 'flesh',
      limbSlot: 'flesh',
      handSlot: 'flesh',
      headSlot: 'flesh',
      bootSlot: 'leather',
      round: 4.4,
      chestScale: 1.12,
      waistScale: 1.15,
      armScale: 1.5,
      legScale: 1.55,
      handScale: 2.5,
      bootScale: 1.5,
      depthRatio: 0.94,
      neck: false,
      headScale: 0.9,
    });

    const chest = rw(rig, B.chest);

    // ── Carapace: a single dome swallowing the shoulders and most of the head.
    const dome = roughen(
      loft(
        [
          { y: -0.26, w: p.shoulderHalfWidth * 1.16, d: p.shoulderHalfWidth * 0.94, z: -0.04, round: 4.6 },
          { y: 0.02, w: p.shoulderHalfWidth * 1.3, d: p.shoulderHalfWidth * 1.05, z: -0.06, round: 5 },
          { y: 0.24, w: p.shoulderHalfWidth * 1.14, d: p.shoulderHalfWidth * 0.94, z: -0.09, round: 5 },
          { y: 0.38, w: p.shoulderHalfWidth * 0.66, d: p.shoulderHalfWidth * 0.58, z: -0.12, round: 4 },
        ],
        { segments: 14, smoothAngle: 44 },
      ),
      0.018,
      6.5,
      3,
    );
    b.add(dome, {
      slot: 'armor',
      at: [0, chest[1] + 0.06, 0],
      bind: { bones: [B.chest], rigid: true },
      uvScale: 1.8,
    });
    spikeRow(b, rig, {
      bone: B.chest,
      count: 5,
      from: [-p.shoulderHalfWidth * 0.9, chest[1] + 0.3, -0.12],
      to: [p.shoulderHalfWidth * 0.9, chest[1] + 0.3, -0.12],
      length: 0.4,
      baseW: 0.062,
      slot: 'metal',
      curve: -0.5,
      tilt: -0.35,
      bind: [B.chest],
    });

    // Overlapping chest bands.
    for (let i = 0; i < 3; i++) {
      b.add(
        plate({
          width: p.shoulderHalfWidth * (1.5 - i * 0.16),
          height: 0.15,
          thickness: 0.028,
          bow: 0.34,
          topScale: 1.05,
          bottomScale: 0.85,
        }),
        {
          slot: 'armor',
          at: [0, chest[1] - 0.18 - i * 0.15, 0.04],
          rot: [0.12, 0, 0],
          bind: { bones: [B.chest, B.spine, B.pelvis], falloff: 0.24, bias: 1.3 },
          uvScale: 1.3,
        },
      );
    }

    // Tiny head, buried; only the jaw and two eye points read.
    b.add(gem(0.026, 0), {
      slot: 'glow',
      bone: B.head,
      at: [p.headSize * 0.42, p.headSize * 0.4, p.headSize * 0.68],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // ── Fists: enormous, knuckle-plated, hanging near the ground.
    b.add(
      loft(
        [
          { y: -0.2, w: 0.17, d: 0.19, round: 5 },
          { y: -0.04, w: 0.21, d: 0.23, round: 5.4 },
          { y: 0.1, w: 0.17, d: 0.19, round: 5 },
        ],
        { segments: 10, smoothAngle: 44 },
      ),
      {
        slot: 'armor',
        bone: 'wrist.L',
        at: [0, -0.14, 0.02],
        mirror: true,
        bind: { bones: ['wrist.L', 'hand.L'], rigid: true },
        uvScale: 1.3,
      },
    );
    for (let i = 0; i < 3; i++) {
      b.add(spike({ length: 0.14, baseW: 0.042, curve: 0, taper: 1.7, segments: 5 }), {
        slot: 'metal',
        bone: 'wrist.L',
        at: [-0.06 + i * 0.06, -0.1, 0.2],
        rot: [Math.PI / 2, 0, 0],
        mirror: true,
        bind: { bones: ['wrist.L'], rigid: true },
        uvScale: 0.6,
      });
    }
    b.add(prism({ h: 0.24, w0: 0.14, d0: 0.15, w1: 0.12, d1: 0.13, round: 5, segments: 8 }), {
      slot: 'armor',
      bone: 'elbow.L',
      at: [0, -0.2, 0],
      mirror: true,
      bind: { bones: ['elbow.L', 'wrist.L'], rigid: true },
      uvScale: 1.2,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 7. Hexwright — caster creep
// ─────────────────────────────────────────────────────────────────────────────

const HEX_PALETTE: Palette = {
  primary: 0x2e2450,
  secondary: 0x6a6278,
  accent: 0xa89c86,
  emissive: 0xb44dff,
};

const hexwright: CharacterDef = {
  id: 'creep.hexwright',
  name: 'Hexwright',
  kind: 'creep',
  archetype: 'caster',
  proportions: prop({
    height: 2.18,
    legType: 'robe',
    legFraction: 0.52,
    hipHalfWidth: 0.16,
    shoulderHalfWidth: 0.22,
    torsoFraction: 0.27,
    neckLength: 0.09,
    headSize: 0.17,
    armFraction: 0.52,
    stoop: 0.16,
    hover: 0.3,
    capeSegments: 4,
    orbitCount: 3,
  }),
  profile: profile({
    idlePeriod: 3.8,
    breath: 0.6,
    stanceWidth: 1,
    crouch: 0,
    armSplay: 0.3,
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
    weight: 0.2,
    hover: true,
    capeSegments: 4,
    orbitCount: 3,
    orbitRadius: 0.46,
  }),
  slots: {
    armor: slot('unit.bone', { tint: 'accent', roughness: 0.6, metalness: 0 }),
    cloth: slot('unit.cloth', { tint: 'primary', metalness: 0 }),
    leather: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    metal: slot('unit.bone', { tint: 'accent', roughness: 0.5, metalness: 0 }),
    flesh: slot('unit.skin', { tint: 'secondary', shade: 0.8, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 4.6 }),
  },
  palette: HEX_PALETTE,
  visual: visual('creep.hexwright', 'floating-spike-cluster', HEX_PALETTE, 1, ['cloth', 'bone']),
  build(b, rig) {
    const p = rig.proportions;
    addBody(b, rig, {
      torsoSlot: 'cloth',
      limbSlot: 'flesh',
      handSlot: 'flesh',
      headSlot: 'flesh',
      round: 3.2,
      chestScale: 0.9,
      waistScale: 0.95,
      armScale: 0.56,
      handScale: 1.1,
      depthRatio: 0.8,
      head: false,
      robe: { slot: 'cloth', flare: 0.3 },
    });

    const chest = rw(rig, B.chest);
    const neck = rw(rig, B.neck);

    // Tattered hem: separate strips below the robe so the outline is ragged and
    // clearly not touching the ground.
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const r = p.hipHalfWidth * 1.42;
      b.add(
        shell({
          nu: 3,
          nv: 6,
          surface: (u, v, out) => {
            out.set((u - 0.5) * 0.09 * (1 - v * 0.6), -v * (0.16 + (i % 3) * 0.07), Math.sin(v * 2.6) * 0.03);
          },
          thickness: () => 0.007,
          uvScale: 1.2,
          smoothAngle: 44,
        }),
        {
          slot: 'leather',
          at: [Math.sin(a) * r, p.hover + 0.02, Math.cos(a) * r],
          rot: [0, a, 0],
          bind: { bones: ['skirt2', 'skirt1'].filter((n) => rig.index[n] !== undefined), falloff: 0.2, bias: 1.2 },
          uvScale: 1,
        },
      );
    }

    // Hooded void where a face should be, with a single glowing slit.
    b.add(
      loft(
        [
          { y: -p.headSize * 0.9, w: p.headSize * 1.1, d: p.headSize * 1.1, round: 3.2 },
          { y: -p.headSize * 0.2, w: p.headSize * 1.22, d: p.headSize * 1.24, z: -p.headSize * 0.08, round: 3.4 },
          { y: p.headSize * 0.5, w: p.headSize * 0.86, d: p.headSize * 0.9, z: -p.headSize * 0.18, round: 3.2 },
          { y: p.headSize * 0.92, w: p.headSize * 0.3, d: p.headSize * 0.34, z: -p.headSize * 0.34, round: 3 },
        ],
        { segments: 12, smoothAngle: 50 },
      ),
      {
        slot: 'cloth',
        bone: B.head,
        at: [0, p.headSize * 0.3, 0],
        bind: { bones: [B.head, B.neck], falloff: 0.16, bias: 1.6 },
        uvScale: 1.4,
      },
    );
    b.add(prism({ h: 0.035, w0: 0.016, d0: p.headSize * 0.28, w1: 0.01, d1: p.headSize * 0.24, round: 4, segments: 5 }), {
      slot: 'glow',
      bone: B.head,
      at: [0, p.headSize * 0.28, p.headSize * 0.86],
      rot: [Math.PI / 2, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 0.5,
    });

    // ── Antler headdress: four crooked, uneven spikes. Asymmetric on purpose.
    const antlers: [number, number, number, number][] = [
      [0.62, 0.9, -0.55, -0.34],
      [-0.5, 0.78, -0.5, 0.28],
      [0.34, 0.62, -0.72, -0.62],
      [-0.26, 0.5, -0.68, 0.66],
    ];
    for (const [ax, len, curve, tilt] of antlers) {
      b.add(spike({ length: p.headSize * 3.1 * len, baseW: p.headSize * 0.16, curve, taper: 1.6, twist: 0.5, segments: 7 }), {
        slot: 'metal',
        bone: B.head,
        at: [p.headSize * ax, p.headSize * 0.6, -p.headSize * 0.2],
        rot: [-0.42, 0, tilt],
        bind: { bones: [B.head], rigid: true },
        uvScale: 0.8,
      });
    }

    // Shoulder shroud and a long back drape.
    b.add(plate({ width: 0.5, height: 0.3, thickness: 0.014, bow: 0.3, droop: 0.3, topScale: 0.6, bottomScale: 1.2 }), {
      slot: 'cloth',
      at: [0, neck[1] - 0.02, -0.02],
      rot: [0.1, 0, 0],
      bind: { bones: [B.chest, B.neck], falloff: 0.26, bias: 1.4 },
      uvScale: 1.4,
    });
    cape(b, rig, { slot: 'leather', width: 0.34, length: p.height * 0.5, flare: 0.7, z: -0.04, thickness: 0.01 });

    // Long thin claw fingers.
    for (let i = 0; i < 3; i++) {
      b.add(spike({ length: 0.15, baseW: 0.016, curve: 0.5, taper: 1.4, segments: 5 }), {
        slot: 'metal',
        bone: 'hand.L',
        at: [(i - 1) * 0.026, -0.05, 0.02],
        rot: [0.2, 0, (i - 1) * 0.3],
        mirror: true,
        bind: { bones: ['hand.L'], rigid: true },
        uvScale: 0.6,
      });
    }

    // Orbiting hex shards.
    for (let i = 0; i < p.orbitCount; i++) {
      b.add(gem(0.062, 0), {
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
// 8. Marrow Titan — boss
// ─────────────────────────────────────────────────────────────────────────────

const TITAN_PALETTE: Palette = {
  primary: 0xbdb49a,
  secondary: 0x3a352d,
  accent: 0x7d2b2b,
  emissive: 0x9cff5e,
};

const titan: CharacterDef = {
  id: 'boss.marrowTitan',
  name: 'Marrow Titan',
  kind: 'boss',
  archetype: 'boss',
  proportions: prop({
    height: 3.7,
    legFraction: 0.45,
    hipHalfWidth: 0.3,
    shoulderHalfWidth: 0.62,
    torsoFraction: 0.32,
    neckLength: 0.04,
    headSize: 0.3,
    armFraction: 0.52,
    stoop: 0.24,
    footLength: 0.44,
  }),
  profile: profile({
    idlePeriod: 6.2,
    breath: 2.0,
    stanceWidth: 1.6,
    crouch: 0.45,
    armSplay: 0.46,
    walkSpeed: 2.4,
    runSpeed: 3.6,
    stride: 1.5,
    stanceFraction: 0.68,
    bob: 0.1,
    lean: 0.08,
    armSwing: 0.4,
    footLift: 0.18,
    attackDuration: 1.7,
    attackStyle: 'slam',
    castDuration: 2.4,
    castStyle: 'summon',
    weight: 1,
    mainHand: 'L',
  }),
  slots: {
    armor: slot('unit.bone', { tint: 'primary', roughness: 0.58, metalness: 0 }),
    cloth: slot('unit.cloth', { tint: 'secondary', metalness: 0 }),
    leather: slot('unit.leather', { tint: 'secondary', metalness: 0 }),
    metal: slot('unit.steel', { tint: 'accent', roughness: 0.5, metalness: 1 }),
    flesh: slot('unit.skin', { tint: 'secondary', shade: 1.1, metalness: 0 }),
    glow: slot('unit.bone', { tint: 'none', metalness: 0, emissiveIntensity: 3.4 }),
  },
  palette: TITAN_PALETTE,
  visual: visual('boss.marrowTitan', 'asymmetric-giant-maul-arm', TITAN_PALETTE, 1, ['bone', 'steel']),
  build(b, rig) {
    const p = rig.proportions;
    addBody(b, rig, {
      torsoSlot: 'flesh',
      limbSlot: 'flesh',
      handSlot: 'flesh',
      headSlot: 'armor',
      bootSlot: 'armor',
      round: 4,
      chestScale: 1.0,
      waistScale: 0.82,
      armScale: 1.1,
      legScale: 1.3,
      handScale: 1.6,
      bootScale: 1.4,
      depthRatio: 0.78,
      neck: false,
      head: false,
    });

    const chest = rw(rig, B.chest);
    const pelvis = rw(rig, B.pelvis);

    // ── Exposed ribcage: arcs wrapping the torso, the boss's signature texture.
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const y = chest[1] - 0.06 - t * 0.62;
      const r = p.shoulderHalfWidth * (0.92 - t * 0.22);
      b.add(
        shell({
          nu: 4,
          nv: 12,
          surface: (u, v, out) => {
            const a = (v - 0.5) * Math.PI * 1.12;
            out.set(Math.sin(a) * r, y + (u - 0.5) * 0.055 - Math.cos(a) * 0.05, Math.cos(a) * r * 0.82);
          },
          thickness: (_u, v) => 0.03 * (1 - 0.5 * Math.abs((v - 0.5) * 2)) + 0.008,
          uvScale: 2,
          smoothAngle: 42,
        }),
        {
          slot: 'armor',
          bind: { bones: [B.chest, B.spine, B.pelvis], falloff: 0.3, bias: 1.2 },
          uvScale: 1,
        },
      );
    }
    spikeRow(b, rig, {
      bone: B.chest,
      count: 6,
      from: [0, chest[1] + 0.16, -p.shoulderHalfWidth * 0.5],
      to: [0, pelvis[1] + 0.1, -p.hipHalfWidth * 1.2],
      length: 0.36,
      baseW: 0.06,
      slot: 'armor',
      curve: -0.5,
      tilt: -0.9,
      bind: [B.chest],
    });

    // ── Skull with a radiating horn crown.
    b.add(
      loft(
        [
          { y: -p.headSize * 0.8, w: p.headSize * 0.6, d: p.headSize * 0.78, z: p.headSize * 0.24, round: 3 },
          { y: -p.headSize * 0.24, w: p.headSize * 0.94, d: p.headSize * 1.08, z: p.headSize * 0.1, round: 3.2 },
          { y: p.headSize * 0.36, w: p.headSize * 1.02, d: p.headSize * 1.06, round: 3.4 },
          { y: p.headSize * 0.86, w: p.headSize * 0.56, d: p.headSize * 0.6, z: -p.headSize * 0.1, round: 3 },
        ],
        { segments: 12, smoothAngle: 50 },
      ),
      {
        slot: 'armor',
        bone: B.head,
        at: [0, p.headSize * 0.3, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1.2,
      },
    );
    for (let i = 0; i < 6; i++) {
      const a = -1.15 + (i / 5) * 2.3;
      b.add(spike({ length: p.headSize * (1.5 + Math.cos(a) * 0.7), baseW: p.headSize * 0.17, curve: -0.5, taper: 1.7, segments: 6 }), {
        slot: 'armor',
        bone: B.head,
        at: [Math.sin(a) * p.headSize * 0.8, p.headSize * 0.75, -p.headSize * 0.15 + Math.cos(a) * p.headSize * 0.2],
        rot: [-0.5, 0, -a * 0.8],
        bind: { bones: [B.head], rigid: true },
        uvScale: 0.8,
      });
    }
    b.add(gem(0.05, 0), {
      slot: 'glow',
      bone: B.head,
      at: [p.headSize * 0.4, p.headSize * 0.42, p.headSize * 0.82],
      mirror: true,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    });

    // ── Asymmetry: the left arm is a fused bone maul, the right stays lean.
    b.add(
      loft(
        [
          { y: -0.62, w: 0.3, d: 0.32, round: 4.6 },
          { y: -0.34, w: 0.38, d: 0.4, round: 5 },
          { y: -0.06, w: 0.32, d: 0.34, round: 4.6 },
          { y: 0.12, w: 0.2, d: 0.22, round: 4 },
        ],
        { segments: 12, smoothAngle: 42 },
      ),
      {
        slot: 'armor',
        bone: 'wrist.L',
        at: [0, -0.2, 0.03],
        bind: { bones: ['wrist.L', 'hand.L'], rigid: true },
        uvScale: 1.6,
      },
    );
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      b.add(spike({ length: 0.3, baseW: 0.07, curve: 0.1, taper: 1.7, segments: 5 }), {
        slot: 'metal',
        bone: 'wrist.L',
        at: [Math.sin(a) * 0.3, -0.5, 0.03 + Math.cos(a) * 0.3],
        rot: [Math.cos(a) * 1.3, 0, -Math.sin(a) * 1.3],
        bind: { bones: ['wrist.L'], rigid: true },
        uvScale: 0.7,
      });
    }
    pauldron(b, rig, 'L', { size: 0.4, slot: 'armor', lames: 3, tiltOut: 0.45, spike: 1.9, spikeSlot: 'metal' });
    pauldron(b, rig, 'R', { size: 0.2, slot: 'armor', lames: 1, tiltOut: 0.3 });

    // Ragged waist wrap.
    clothPanel(b, rig, {
      slot: 'cloth',
      bones: [B.pelvis, B.spine],
      topY: pelvis[1] + 0.1,
      bottomY: pelvis[1] - 0.66,
      topW: 0.52,
      bottomW: 0.4,
      z: p.hipHalfWidth * 1.05,
      hemPoint: 0.42,
      thickness: 0.016,
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────

export const CHARACTERS: readonly CharacterDef[] = [
  bulwark,
  oracle,
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

export function buildCharacter(def: CharacterDef): BuiltCharacter {
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
