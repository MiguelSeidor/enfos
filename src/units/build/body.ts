/**
 * Shared humanoid assembly. Owner: CHARACTERS agent.
 *
 * Every archetype builds its torso, limbs and head through here so proportions
 * stay consistent with the rig that deforms them, and so silhouette work in the
 * catalog is spent on what actually differentiates a character — armour masses,
 * weapons, horns, capes — rather than on re-authoring another pair of arms.
 *
 * Everything is deliberately over-scaled relative to a real human: hands about
 * 1.6x, boots 1.8x, skull 1.4x. At 40+ units of camera distance a correctly
 * proportioned figure reads as a smudge.
 */

import * as THREE from 'three';
import { loft, plate, prism, shell, type Ring } from './shapes';
import type { CharacterBuilder, SlotName } from './character';
import type { Rig } from '../rig/rig';
import { B } from '../rig/rig';

/** Rest position of a bone in character space. */
export function rw(rig: Rig, name: string): [number, number, number] {
  const i = rig.index[name];
  if (i === undefined) throw new Error(`body: unknown bone ${name}`);
  return [rig.restWorld[i * 3]!, rig.restWorld[i * 3 + 1]!, rig.restWorld[i * 3 + 2]!];
}

export function boneDistance(rig: Rig, a: string, b: string): number {
  const pa = rw(rig, a);
  const pb = rw(rig, b);
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
}

/**
 * A limb segment hanging downward from its anchor: rings ascend from -len to 0
 * so triangle winding stays outward without a mirroring transform.
 */
export function limbGeo(opts: {
  len: number;
  topW: number;
  topD: number;
  botW: number;
  botD: number;
  round?: number;
  segments?: number;
  /** Muscle bulge, as a multiplier at `bulgeAt` along the segment. */
  bulge?: number;
  bulgeAt?: number;
  /** Lateral drift of the bottom ring. */
  shiftX?: number;
  shiftZ?: number;
}): THREE.BufferGeometry {
  const round = opts.round ?? 4;
  const rings: Ring[] = [];
  const push = (t: number, w: number, d: number): void => {
    rings.push({
      y: -opts.len * (1 - t),
      x: (opts.shiftX ?? 0) * (1 - t),
      z: (opts.shiftZ ?? 0) * (1 - t),
      w,
      d,
      round,
    });
  };
  push(0, opts.botW, opts.botD);
  if (opts.bulge !== undefined) {
    const t = opts.bulgeAt ?? 0.62;
    push(t, (opts.botW + (opts.topW - opts.botW) * t) * opts.bulge, (opts.botD + (opts.topD - opts.botD) * t) * opts.bulge);
  }
  push(1, opts.topW, opts.topD);
  return loft(rings, { segments: opts.segments ?? 10, smoothAngle: 58 });
}

export interface BodyOptions {
  torsoSlot: SlotName;
  limbSlot: SlotName;
  handSlot?: SlotName;
  headSlot?: SlotName;
  bootSlot?: SlotName;
  /** Boxiness of the body forms. 3 = organic, 6 = armoured slab. */
  round?: number;
  /** Multipliers on the generated masses. */
  chestScale?: number;
  waistScale?: number;
  armScale?: number;
  legScale?: number;
  handScale?: number;
  bootScale?: number;
  headScale?: number;
  /** Chest depth relative to width; deep chests read as heavy. */
  depthRatio?: number;
  /** Adds a visible neck column. Brutes should not have one. */
  neck?: boolean;
  /** Emits the torso mass. Off when a recipe needs a non-upright body. */
  torso?: boolean;
  /** Emits the arm segments and hands. Off for winged and armless plans. */
  arms?: boolean;
  /**
   * Emits the leg segments and boots.
   *
   * Off when a recipe supplies authored legs. Separate from `robe`, which also
   * removes the legs but puts a cone in their place; this leaves the space
   * empty for something else to fill.
   */
  legs?: boolean;
  /** Skips legs and emits a conical robe from the pelvis instead. */
  robe?: {
    slot: SlotName;
    flare: number;
    /** Number of vertical tatters cut into the hem; 0 = smooth. */
    hemNoise?: number;
  };
  /** Digitigrade legs need a longer, angled foot mass. */
  digitigrade?: boolean;
  /** Emits the head sphere. Off when the recipe supplies its own skull. */
  head?: boolean;
  /**
   * Face relief. At play zoom a head is about 15 px across and no texture
   * survives the mip chain at that size, so the three things that still read
   * have to be geometry: a brow that catches the key light, a band under it
   * held back in shadow, and a hair or hood mass in a DIFFERENT material slot
   * from the skin, so the two take different tints and the head is never one
   * flat colour. Without this a head is a smooth oval at any distance.
   */
  face?: {
    /** Slot for the recessed eye band. Wants the recipe's darkest material. */
    eyeSlot: SlotName;
    /** Slot for the hair/hood mass. Omitted means no hair. */
    hairSlot?: SlotName;
    /** Hair length past the jaw, in head sizes. */
    hair?: number;
    /** Brow slot; defaults to the head's own slot. */
    browSlot?: SlotName;
  };
}

export function addBody(b: CharacterBuilder, rig: Rig, o: BodyOptions): void {
  const p = rig.proportions;
  const round = o.round ?? 4;
  const depth = o.depthRatio ?? 0.72;
  const chestScale = o.chestScale ?? 1;
  const waistScale = o.waistScale ?? 1;

  const pelvis = rw(rig, B.pelvis);
  const spineP = rw(rig, B.spine);
  const chest = rw(rig, B.chest);
  const neckP = rw(rig, B.neck);
  const pelvisY = pelvis[1];
  const chestY = chest[1];
  const neckY = neckP[1];
  const torsoLen = chestY - pelvisY;

  /**
   * Where the spine actually is at a given height. `stoop` translates the spine
   * bones forward but the torso mass used to be emitted as a straight vertical
   * column, so a hunched creature's mesh stayed upright and the bones deformed
   * out of it. Following the bones means the hunch is in the silhouette, which
   * is the whole point of the parameter.
   */
  const knots: [number, number][] = [
    [pelvisY, pelvis[2]],
    [spineP[1], spineP[2]],
    [chestY, chest[2]],
    [neckY, neckP[2]],
  ];
  const spineZ = (y: number): number => {
    if (y <= knots[0]![0]) return knots[0]![1] + (y - knots[0]![0]) * slopeAt(knots, 0);
    for (let i = 1; i < knots.length; i++) {
      const a = knots[i - 1]!;
      const c = knots[i]!;
      if (y <= c[0]) {
        const span = c[0] - a[0];
        return span <= 1e-5 ? c[1] : a[1] + (c[1] - a[1]) * ((y - a[0]) / span);
      }
    }
    const last = knots.length - 1;
    return knots[last]![1] + (y - knots[last]![0]) * slopeAt(knots, last);
  };
  // Sections stay perpendicular to the spine, so a steep back does not shear.
  const tiltAt = (y: number): number => {
    const d = Math.max(1e-3, torsoLen * 0.12);
    return Math.atan2(spineZ(y + d) - spineZ(y - d), 2 * d);
  };
  const ring = (y: number, w: number, d: number, r: number): Ring => ({
    y,
    z: spineZ(y),
    w,
    d,
    round: r,
    tiltX: tiltAt(y),
  });

  // ── Torso: wide at the shoulders, pinched at the waist, flared at the hips.
  const shoulderW = p.shoulderHalfWidth * 1.02 * chestScale;
  const waistW = p.hipHalfWidth * 1.15 * waistScale;
  const hipW = p.hipHalfWidth * 1.5;
  if (o.torso !== false) {
    const torso = loft(
      [
        ring(pelvisY - torsoLen * 0.34, hipW * 0.86, hipW * depth * 1.05, round + 1),
        ring(pelvisY - torsoLen * 0.05, hipW, hipW * depth * 1.1, round + 1),
        ring(pelvisY + torsoLen * 0.26, waistW, waistW * depth * 1.25, round),
        ring(pelvisY + torsoLen * 0.62, shoulderW * 0.82, shoulderW * depth * 0.95, round),
        ring(chestY + torsoLen * 0.06, shoulderW, shoulderW * depth, round),
        ring(neckY + (p.neckLength ?? 0.05) * 0.2, shoulderW * 0.66, shoulderW * depth * 0.8, round),
      ],
      { segments: 14, smoothAngle: 52 },
    );
    b.add(torso, {
      slot: o.torsoSlot,
      bind: { bones: [B.chest, B.spine, B.pelvis], falloff: p.height * 0.13, bias: 1.15 },
      uvScale: 1.6,
    });
  }

  if (o.neck !== false) {
    const neckLen = Math.max(0.03, neckY - (chestY + torsoLen * 0.02));
    b.add(
      prism({
        h: neckLen + p.headSize * 0.35,
        w0: p.headSize * 0.42,
        d0: p.headSize * 0.42,
        w1: p.headSize * 0.34,
        d1: p.headSize * 0.36,
        round: 3,
        segments: 8,
      }),
      {
        slot: o.limbSlot,
        bone: B.neck,
        at: [0, -neckLen * 0.5, 0],
        bind: { bones: [B.neck, B.head, B.chest], falloff: p.headSize * 0.7 },
        uvScale: 0.8,
      },
    );
  }

  // ── Head: oversized skull, flattened at the back, jaw pushed forward.
  if (o.head !== false) {
    const hs = p.headSize * (o.headScale ?? 1);
    b.add(
      loft(
        [
          { y: -hs * 0.95, w: hs * 0.52, d: hs * 0.6, z: hs * 0.1, round: 3 },
          { y: -hs * 0.5, w: hs * 0.8, d: hs * 0.9, z: hs * 0.12, round: 3 },
          { y: 0, w: hs * 0.98, d: hs * 1.05, z: 0, round: 3.4 },
          { y: hs * 0.62, w: hs * 0.9, d: hs * 0.95, z: -hs * 0.05, round: 3.4 },
          { y: hs * 1.05, w: hs * 0.5, d: hs * 0.55, z: -hs * 0.1, round: 3 },
        ],
        { segments: 12, smoothAngle: 58 },
      ),
      {
        slot: o.headSlot ?? o.limbSlot,
        bone: B.head,
        at: [0, p.headSize * 0.35, 0],
        bind: { bones: [B.head], rigid: true },
        uvScale: 1.1,
      },
    );
    if (o.face) addFace(b, o, hs, p.headSize * 0.35);
  }

  // ── Arms.
  if (o.arms !== false) addArms(b, rig, o, round);

  // ── Legs, or a robe in their place.
  if (o.robe) {
    addRobe(b, rig, o.robe);
  } else if (o.legs !== false && rig.index[B.hipL] !== undefined) {
    addLegs(b, rig, o, round);
  }
}

function addArms(b: CharacterBuilder, rig: Rig, o: BodyOptions, round: number): void {
  const p = rig.proportions;
  const upperLen = boneDistance(rig, `shoulder.L`, `elbow.L`);
  const foreLen = boneDistance(rig, `elbow.L`, `wrist.L`);
  const armW = p.height * 0.055 * (o.armScale ?? 1);
  b.add(
    limbGeo({
      len: upperLen * 1.02,
      topW: armW * 1.32,
      topD: armW * 1.32,
      botW: armW * 0.92,
      botD: armW * 0.96,
      round,
      bulge: 1.16,
      bulgeAt: 0.55,
    }),
    {
      slot: o.limbSlot,
      bone: 'shoulder.L',
      at: [0, upperLen * 0.02, 0],
      mirror: true,
      bind: { bones: ['shoulder.L', 'elbow.L'], falloff: armW * 1.5, bias: 1.3 },
      uvScale: 1.2,
    },
  );
  b.add(
    limbGeo({
      len: foreLen * 1.05,
      topW: armW * 1.02,
      topD: armW * 1.06,
      botW: armW * 0.78,
      botD: armW * 0.8,
      round,
      bulge: 1.1,
      bulgeAt: 0.3,
    }),
    {
      slot: o.limbSlot,
      bone: 'elbow.L',
      mirror: true,
      bind: { bones: ['elbow.L', 'wrist.L'], falloff: armW * 1.3, bias: 1.3 },
      uvScale: 1.2,
    },
  );

  // Hands: deliberately huge. They carry the weapon read.
  const hs2 = p.height * 0.048 * (o.handScale ?? 1);
  b.add(
    loft(
      [
        { y: -hs2 * 1.5, w: hs2 * 0.85, d: hs2 * 1.0, z: hs2 * 0.15, round: 3 },
        { y: -hs2 * 0.5, w: hs2 * 1.0, d: hs2 * 1.15, z: hs2 * 0.1, round: 3 },
        { y: hs2 * 0.35, w: hs2 * 0.8, d: hs2 * 0.9, round: 3 },
      ],
      { segments: 8, smoothAngle: 55 },
    ),
    {
      slot: o.handSlot ?? o.limbSlot,
      bone: 'wrist.L',
      at: [0, -hs2 * 0.35, 0],
      mirror: true,
      bind: { bones: ['wrist.L', 'hand.L'], rigid: true },
      uvScale: 0.7,
    },
  );
}

function addLegs(b: CharacterBuilder, rig: Rig, o: BodyOptions, round: number): void {
  const p = rig.proportions;
  {
    const thighLen = boneDistance(rig, 'hip.L', 'knee.L');
    const shinLen = boneDistance(rig, 'knee.L', 'ankle.L');
    const legW = p.height * 0.068 * (o.legScale ?? 1);
    b.add(
      limbGeo({
        len: thighLen * 1.04,
        topW: legW * 1.35,
        topD: legW * 1.3,
        botW: legW * 0.92,
        botD: legW * 0.98,
        round,
        bulge: 1.14,
        bulgeAt: 0.6,
      }),
      {
        slot: o.limbSlot,
        bone: 'hip.L',
        at: [0, thighLen * 0.04, 0],
        mirror: true,
        bind: { bones: ['hip.L', 'knee.L'], falloff: legW * 1.6, bias: 1.35 },
        uvScale: 1.3,
      },
    );
    b.add(
      limbGeo({
        len: shinLen * 1.02,
        topW: legW * 1.02,
        topD: legW * 1.08,
        botW: legW * 0.6,
        botD: legW * 0.66,
        round,
        bulge: 1.22,
        bulgeAt: 0.72,
      }),
      {
        slot: o.limbSlot,
        bone: 'knee.L',
        mirror: true,
        bind: { bones: ['knee.L', 'ankle.L'], falloff: legW * 1.4, bias: 1.35 },
        uvScale: 1.3,
      },
    );

    // Boots: the widest, heaviest thing on the character below the waist.
    // Built in ankle-local space, so y = 0 is the ankle and y = -drop the sole.
    //
    // The sole lands on the character's own standing plane, which is `hover`
    // above the ground, not on the ground itself. Without that term a flyer's
    // feet are stretched the whole way down and read as stilts rather than as
    // talons hanging in the air.
    const bs = p.height * 0.062 * (o.bootScale ?? 1);
    const footLen = p.footLength;
    const drop = rw(rig, 'ankle.L')[1] - p.hover;
    const sole = -drop;
    b.add(
      loft(
        [
          { y: sole, z: footLen * (o.digitigrade ? 0.62 : 0.34), w: bs * 1.06, d: footLen * 0.8, round: 5 },
          { y: sole + drop * 0.28, z: footLen * (o.digitigrade ? 0.46 : 0.22), w: bs * 1.22, d: footLen * 0.74, round: 5 },
          { y: sole + drop * 0.72, z: footLen * 0.06, w: bs * 1.3, d: bs * 1.34, round: 5 },
          { y: 0, z: -bs * 0.06, w: bs * 1.12, d: bs * 1.16, round: 4 },
          { y: drop * 0.34, z: -bs * 0.02, w: bs * 0.94, d: bs * 0.98, round: 4 },
        ],
        { segments: 10, smoothAngle: 46 },
      ),
      {
        slot: o.bootSlot ?? o.limbSlot,
        bone: 'ankle.L',
        mirror: true,
        bind: { bones: ['ankle.L', 'toe.L'], rigid: true },
        uvScale: 1.1,
      },
    );
  }
}

/**
 * Brow, eye band and hair. `hs` is the head's half-size and `base` the skull's
 * offset above the head bone, so everything here is placed in the same frame
 * the skull was built in.
 *
 * The brow stands proud of the face and the eye band sits back behind it: the
 * step between them is what turns a lit forehead and a shadowed eye socket into
 * two different values under a single key light, which is the whole read at
 * 15 px. The band is also a different material from the skin, so it survives
 * even when the light is flat.
 */
function addFace(b: CharacterBuilder, o: BodyOptions, hs: number, base: number): void {
  const f = o.face;
  if (!f) return;
  const skin = o.headSlot ?? o.limbSlot;

  b.add(
    plate({
      width: hs * 1.12,
      height: hs * 0.26,
      thickness: hs * 0.1,
      bow: 0.3,
      droop: 0.1,
      topScale: 1,
      bottomScale: 0.88,
    }),
    {
      slot: f.browSlot ?? skin,
      bone: B.head,
      at: [0, base + hs * 0.34, hs * 0.66],
      rot: [0.4, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1.1,
    },
  );

  b.add(
    plate({
      width: hs * 1.04,
      height: hs * 0.34,
      thickness: hs * 0.05,
      bow: 0.26,
      topScale: 1,
      bottomScale: 0.8,
    }),
    {
      slot: f.eyeSlot,
      bone: B.head,
      at: [0, base - hs * 0.02, hs * 0.66],
      rot: [0.12, 0, 0],
      bind: { bones: [B.head], rigid: true },
      uvScale: 1.2,
    },
  );

  if (!f.hairSlot) return;
  const hair = f.hair ?? 0.4;
  b.add(
    shell({
      nu: 10,
      nv: 5,
      // A back arc, open across the front 100 degrees, so the face stays clear
      // while the outline of the skull stops being an egg.
      surface: (u, v, out) => {
        const a = Math.PI * (0.28 + u * 1.44);
        // Height above the skull's centre, in head sizes. The radius has to
        // close in at the crown — a constant radius leaves a disc floating off
        // the top of the head, which is the part a top-down camera sees most.
        const yy = 1.06 - v * (1.5 + hair);
        const r = hs * (1.12 - 0.5 * Math.pow(Math.max(0, yy), 2.2));
        out.set(Math.sin(a) * r, base + hs * yy, Math.cos(a) * r * 1.04 - hs * 0.06);
      },
      thickness: () => hs * 0.075,
      uvScale: 1.6,
      smoothAngle: 44,
    }),
    {
      slot: f.hairSlot,
      bone: B.head,
      bind: { bones: [B.head], rigid: true },
      uvScale: 1,
    },
  );
}

/** Slope of the spine knot list at index `i`, used to extrapolate past the ends. */
function slopeAt(knots: [number, number][], i: number): number {
  const a = knots[Math.max(0, i - 1)]!;
  const c = knots[Math.min(knots.length - 1, i + 1)]!;
  const span = c[0] - a[0];
  return Math.abs(span) < 1e-5 ? 0 : (c[1] - a[1]) / span;
}

/** Conical robe replacing the legs; the hem is the whole lower silhouette. */
export function addRobe(
  b: CharacterBuilder,
  rig: Rig,
  o: { slot: SlotName; flare: number; hemNoise?: number },
): void {
  const p = rig.proportions;
  const pelvisY = rw(rig, B.pelvis)[1];
  const hemY = p.hover;
  const span = pelvisY - hemY;
  const top = p.hipHalfWidth * 1.4;
  const bottom = top + o.flare;
  const rings: Ring[] = [];
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Slight S-curve so the robe swells before it flares — a straight cone
    // reads as a traffic cone, not cloth.
    const shape = Math.pow(t, 1.7);
    const w = bottom + (top - bottom) * (1 - shape);
    rings.push({
      y: hemY + span * t,
      w,
      d: w * 0.92,
      round: 3 + (1 - t) * 1.4,
    });
  }
  rings.reverse();
  const geo = loft(rings, { segments: 16, smoothAngle: 50 });
  const bones = ['skirt2', 'skirt1', 'skirt0', B.pelvis].filter((n) => rig.index[n] !== undefined);
  b.add(geo, {
    slot: o.slot,
    bind: { bones, falloff: span * 0.32, bias: 1.1 },
    uvScale: 1.8,
  });
}
