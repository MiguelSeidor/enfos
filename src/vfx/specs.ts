/**
 * Effect authoring. Owner: VFX.
 *
 * One table, three layers per effect: ground shapes (the area statement),
 * particle bursts (the volume), and residue (the decal that outlives the cast).
 * `index.ts` only knows how to play these; what an effect *is* lives here, so
 * retuning a spell is a data edit rather than a code edit.
 *
 * The design rule this table exists to enforce: **no two schools may be the same
 * ring in a different colour.** Colour is the weakest identity cue there is — it
 * dies under bloom, under a red health bar, and under a colour-blind player. So
 * each school gets its own *shape language* first and its palette second:
 *
 * | School   | Ground shape      | Volume            | Residue |
 * | -------- | ----------------- | ----------------- | ------- |
 * | physical | shredded dust ring| soft dust + debris| —       |
 * | holy     | spoked starburst  | rising light      | scorch  |
 * | arcane   | rotating spiral   | runes and shards  | sigil   |
 * | frost    | crystalline ring  | hard ice shards   | frost   |
 *
 * ## The bloom budget
 *
 * The post chain thresholds bloom at luminance 1.05 (`render/renderer.ts`), and
 * the sprite/ground batches blend additively, so overlapping quads *sum*. Ten
 * particles at 1.0 do not read as ten particles — they read as a white hole with
 * no shape at all, and the rubric caps that at 3/10.
 *
 * The rule this table follows, learned the expensive way from a first pass that
 * blew out every frame:
 *
 * - Anything with area — dust, smoke, a glow pool, a ring body — stays at or
 *   below **1.0** intensity and well below full alpha. It reads as lit matter.
 * - Only features smaller than roughly half a metre — spark cores, the filament
 *   of a beam, a shock ring's leading edge — are allowed above **1.4**. Those
 *   are the things that should bloom, and because they are small the bloom stays
 *   an accent instead of a smear.
 * - Telegraphs stay entirely under the threshold. A danger marker that glows
 *   hides the units standing in it, which is the opposite of its job.
 */

import { GSHAPE } from './ground';
import { BLEND_SOFT, type BurstSpec } from './quads';
import { DECAL, SPRITE } from './sprites';

/** A parameter that animates over the shape's own normalised lifetime. */
export type Curve = number | ((t: number) => number);

export const curveAt = (c: Curve | undefined, t: number, fallback = 0): number =>
  c === undefined ? fallback : typeof c === 'number' ? c : c(t);

// ── Curve helpers ────────────────────────────────────────────────────────────

/** Linear a→b. */
export const lin =
  (a: number, b: number) =>
  (t: number): number =>
    a + (b - a) * t;

/** Ease-out a→b: fast leading edge, settling tail. This is what makes a
 *  shockwave read as a shockwave rather than a growing circle. */
export const out =
  (a: number, b: number, power = 2.2) =>
  (t: number): number =>
    a + (b - a) * (1 - Math.pow(1 - t, power));

/** Rise to `peak` over `attack`, then decay. `power` shapes the tail. */
export const pop =
  (attack: number, power = 1.6, peak = 1) =>
  (t: number): number =>
    peak * (t < attack ? t / attack : Math.pow(1 - (t - attack) / (1 - attack), power));

// ── Ground shapes ────────────────────────────────────────────────────────────

export interface GroundShapeSpec {
  shape: number;
  color: number;
  /** Above ~1.05 the shape crosses the bloom threshold. Keep area shapes under it. */
  intensity?: number;
  life: number;
  /** Fraction of `life` to wait before starting — used to stagger double rings. */
  delay?: number;
  /** Half extent as a multiple of the effect scale. */
  size?: number | ((t: number) => number);
  alpha: Curve;
  p0?: Curve;
  p1?: Curve;
  p2?: Curve;
  /** Radians per second. A rotating sigil reads as *powered*; a static one reads as a texture. */
  spin?: number;
  /** Fixed orientation in radians. Omitted means "randomise once at spawn". */
  yaw?: number;
  /** Draw into the alpha batch instead of the additive one (darkens the ground). */
  soft?: boolean;
  decalLayer?: number;
}

export interface EffectSpec {
  ground?: GroundShapeSpec[];
  bursts?: BurstSpec[];
  /** Residue: an alpha-blended decal that outlives the cast. */
  residue?: { layer: number; color: number; size: number; life: number; alpha: number };
  /** Camera shake, only where the effect is the whole event. */
  shake?: [number, number];
}

// ── Shared building blocks ───────────────────────────────────────────────────

/**
 * Band half-width for an expanding ring, as a function of its own lifetime.
 *
 * This is not cosmetic. The obvious authoring — a width that starts wide and
 * closes — makes the first frames a *filled disc*, because a band of half-width
 * 0.28 around a radius of 0.04 covers everything inside 0.32. Stack two of those
 * with a glow and a starburst and the result is the white hole that ate the first
 * three passes of the nova. Tying the width to the radius keeps it an annulus
 * from the first frame: thin at birth, fattest mid-flight, thin again as it dies.
 */
const ringBand =
  (max = 0.26, min = 0.028) =>
  (t: number): number =>
    min + max * (1 - Math.pow(1 - t, 2.2)) * (1 - t);

/**
 * Expanding shock ring. The radius animates *inside a fixed quad* rather than by
 * scaling the instance, so the turbulence the shader samples does not swim as
 * the ring grows and the instance never has to be resized.
 */
const shockRing = (
  color: number,
  life: number,
  intensity = 1.05,
  delay = 0,
  shape = GSHAPE.ring,
): GroundShapeSpec => ({
  shape,
  color,
  intensity,
  life,
  delay,
  alpha: pop(0.14, 1.5, 0.6),
  p0: out(0.04, 0.96),
  p1: ringBand(0.24),
  p2: 1,
});

const dustPuffs = (color: number, count: number): BurstSpec => ({
  count,
  layer: SPRITE.dust,
  blend: BLEND_SOFT,
  ring: 0.45,
  ringJitter: 0.35,
  y: 0.15,
  yJitter: 0.5,
  speed: [2.5, 6.5],
  rise: [0.4, 1.6],
  size: [1.0, 2.2],
  sizeEnd: 2.0,
  life: [0.55, 1.05],
  color,
  colorEnd: color,
  intensity: 0.66,
  intensityEnd: 0.34,
  drag: 2.1,
  gravity: -0.9,
  spin: [-0.7, 0.7],
  alpha: 0.6,
  fadeIn: 0.16,
});



/**
 * The single hot frame at the origin of an impact. Small and short: this is the
 * one part of an effect deliberately pushed over the bloom threshold, and it
 * works precisely because nothing around it is.
 */
const coreFlash = (color: number, size: number, life = 0.18, intensity = 1.7): BurstSpec => ({
  count: 1,
  layer: SPRITE.flare,
  y: 0.7,
  size: [size, size],
  sizeEnd: 1.4,
  life: [life, life],
  color,
  intensity,
  intensityEnd: 0,
  fadeIn: 0.1,
});

// Written as constants rather than inline so the debris and the puffs of one
// effect cannot drift apart under tuning.
const EARTH = 0xb49a7c;
const EMBER = 0xffbe6a;

export const EFFECTS: Record<string, EffectSpec> = {};

// Physical: a dust shock. No ring of light — the statement is displaced earth.
EFFECTS['impact.slam'] = {
  ground: [
    {
      shape: GSHAPE.shock,
      color: 0xd9a771,
      intensity: 0.95,
      life: 0.5,
      alpha: pop(0.1, 1.4, 0.6),
      p0: out(0.06, 0.9),
      p1: ringBand(0.26, 0.04),
      p2: out(1, 0.25),
    },
    {
      shape: GSHAPE.glow,
      color: 0xffc87a,
      intensity: 0.7,
      life: 0.26,
      size: 0.45,
      alpha: pop(0.08, 2.4, 0.4),
      p0: 3.2,
    },
  ],
  bursts: [
    dustPuffs(EARTH, 16),
    {
      // Debris: thrown up, pulled down, and it lands. Gravity is what separates
      // a physical hit from a magical one before any colour is read.
      count: 12,
      layer: SPRITE.ember,
      ring: 0.15,
      ringJitter: 0.3,
      y: 0.3,
      speed: [4, 10],
      rise: [3.5, 7.5],
      size: [0.14, 0.3],
      sizeEnd: 0.7,
      life: [0.45, 0.85],
      color: EMBER,
      colorEnd: 0x6b3a1c,
      intensity: 1.5,
      intensityEnd: 0.15,
      gravity: -15,
      drag: 0.5,
      stretch: 0.6,
    },
    coreFlash(0xffe3b0, 1.1, 0.16),
  ],
  shake: [0.4, 0.2],
};

// Holy shout: gold rings and a rising column of light.
EFFECTS['aura.shout'] = {
  ground: [
    shockRing(0xffd24a, 0.72, 1.05),
    { ...shockRing(0xffb43c, 0.85, 0.8, 0.18), p1: ringBand(0.14) },
    {
      shape: GSHAPE.starburst,
      color: 0xffcf62,
      intensity: 0.9,
      life: 0.55,
      size: 0.42,
      alpha: pop(0.1, 2, 0.45),
      p0: 12,
      p1: 5,
      p2: 0.6,
      spin: 1.1,
    },
  ],
  bursts: [
    {
      count: 12,
      layer: SPRITE.streak,
      ring: 0.12,
      ringJitter: 0.2,
      y: 0.2,
      speed: [1.2, 3],
      rise: [7, 13],
      size: [0.32, 0.66],
      sizeEnd: 0.5,
      life: [0.4, 0.75],
      color: 0xffd469,
      colorEnd: 0xff9c2e,
      intensity: 1.35,
      intensityEnd: 0.1,
      drag: 1.4,
      stretch: 1.4,
    },
    {
      count: 8,
      layer: SPRITE.rune,
      ring: 0.85,
      ringJitter: 0.25,
      y: 0.5,
      yJitter: 1.2,
      rise: [1.2, 2.4],
      swirl: [1.5, 2.6],
      size: [0.44, 0.72],
      sizeEnd: 1.15,
      life: [0.55, 0.9],
      color: 0xffca55,
      intensity: 0.9,
      intensityEnd: 0,
      spin: [-1.2, 1.2],
    },
    coreFlash(0xffe9b0, 1.3, 0.22),
  ],
};

// Holy ward: a spoked bloom under the caster and runes lifting off it.
EFFECTS['aura.guard'] = {
  ground: [
    {
      shape: GSHAPE.starburst,
      color: 0x8fd0ff,
      intensity: 1.0,
      life: 1.0,
      size: 1.0,
      alpha: pop(0.16, 1.3, 0.5),
      p0: 14,
      p1: 7,
      p2: 0.55,
      spin: -0.8,
    },
    {
      shape: GSHAPE.ring,
      color: 0xcfeaff,
      intensity: 1.0,
      life: 1.0,
      alpha: pop(0.2, 1.2, 0.55),
      p0: out(0.55, 0.98),
      p1: 0.045,
      p2: 1,
    },
  ],
  bursts: [
    {
      count: 12,
      layer: SPRITE.rune,
      ring: 0.9,
      ringJitter: 0.2,
      y: 0.15,
      yJitter: 0.4,
      rise: [1.6, 3.2],
      swirl: [2.2, 3.4],
      speed: [-0.6, 0.4],
      size: [0.38, 0.62],
      sizeEnd: 0.75,
      life: [0.8, 1.25],
      color: 0xbfe6ff,
      colorEnd: 0x6fb8ff,
      intensity: 0.95,
      intensityEnd: 0.08,
      spin: [-1.6, 1.6],
      fadeIn: 0.2,
    },
    {
      count: 10,
      layer: SPRITE.spark,
      ring: 0.5,
      ringJitter: 0.6,
      y: 0.4,
      yJitter: 1.6,
      rise: [0.8, 2],
      size: [0.13, 0.26],
      sizeEnd: 0.3,
      life: [0.6, 1.1],
      color: 0xeaf7ff,
      intensity: 1.7,
      intensityEnd: 0,
      drag: 1.2,
    },
  ],
};

// Holy detonation. The one effect allowed to own the frame for a moment — but it
// owns it through *shape*: flash, shock, column, embers, scorch. The glow pool
// under it is deliberately weak, because a big additive disc is how the first
// pass turned this spell into a white hole.
EFFECTS['impact.nova'] = {
  ground: [
    {
      shape: GSHAPE.glow,
      color: 0xfff0c4,
      intensity: 0.5,
      life: 0.32,
      size: 0.4,
      alpha: pop(0.06, 2.6, 0.34),
      p0: 4.0,
    },
    shockRing(0xffe9a8, 0.9, 1.15),
    { ...shockRing(0xffc45e, 1.1, 0.85, 0.16), p1: ringBand(0.13) },
    {
      shape: GSHAPE.starburst,
      color: 0xffd88a,
      intensity: 1.0,
      life: 0.75,
      size: 0.5,
      alpha: pop(0.08, 1.8, 0.4),
      p0: 16,
      p1: 4,
      p2: 0.3,
      spin: 0.7,
    },
  ],
  bursts: [
    {
      count: 14,
      layer: SPRITE.streak,
      ring: 0.1,
      ringJitter: 0.25,
      y: 0.2,
      speed: [1, 4],
      rise: [10, 20],
      size: [0.4, 0.85],
      sizeEnd: 0.4,
      life: [0.5, 0.95],
      color: 0xfff0c0,
      colorEnd: 0xff9b30,
      intensity: 1.5,
      intensityEnd: 0.08,
      drag: 1.1,
      stretch: 1.6,
    },
    {
      count: 20,
      layer: SPRITE.ember,
      ring: 0.3,
      ringJitter: 0.5,
      y: 0.4,
      speed: [6, 16],
      rise: [4, 11],
      size: [0.16, 0.34],
      sizeEnd: 0.5,
      life: [0.6, 1.2],
      color: 0xffd07a,
      colorEnd: 0x8a3410,
      intensity: 1.6,
      intensityEnd: 0.12,
      gravity: -12,
      drag: 0.4,
      stretch: 0.8,
    },
    dustPuffs(0xa2937f, 16),
    coreFlash(0xfff4d2, 1.2, 0.26, 1.2),
  ],
  residue: { layer: DECAL.scorch, color: 0xffffff, size: 0.5, life: 9, alpha: 0.78 },
  shake: [0.45, 0.3],
};

// Meteor: fire, not light. Where the holy nova is a clean golden shock, this is
// orange heat, a column of flame, embers thrown wide and a dark smoke skirt —
// then a scorch that stays long after, marking the ground that still burns.
EFFECTS['impact.meteor'] = {
  ground: [
    {
      shape: GSHAPE.glow,
      color: 0xff7a2e,
      intensity: 0.6,
      life: 0.55,
      size: 0.45,
      alpha: pop(0.05, 2.4, 0.45),
      p0: 3.6,
    },
    shockRing(0xffb070, 1.0, 1.1),
    { ...shockRing(0xff5a1e, 1.25, 0.9, 0.18), p1: ringBand(0.16) },
    {
      shape: GSHAPE.starburst,
      color: 0xff9a40,
      intensity: 0.95,
      life: 0.9,
      size: 0.55,
      alpha: pop(0.08, 1.7, 0.45),
      p0: 20,
      p1: 5,
      p2: 0.35,
      spin: 0.4,
    },
  ],
  bursts: [
    {
      count: 18,
      layer: SPRITE.streak,
      ring: 0.12,
      ringJitter: 0.3,
      y: 0.2,
      speed: [1, 5],
      rise: [12, 24],
      size: [0.5, 1.0],
      sizeEnd: 0.4,
      life: [0.55, 1.0],
      color: 0xffd08a,
      colorEnd: 0xff4a12,
      intensity: 1.5,
      intensityEnd: 0.06,
      drag: 1.0,
      stretch: 1.8,
    },
    {
      count: 36,
      layer: SPRITE.ember,
      ring: 0.25,
      ringJitter: 0.6,
      y: 0.4,
      speed: [8, 20],
      rise: [5, 13],
      size: [0.16, 0.38],
      sizeEnd: 0.5,
      life: [0.7, 1.4],
      color: 0xffc070,
      colorEnd: 0x7a2208,
      intensity: 1.6,
      intensityEnd: 0.1,
      gravity: -12,
      drag: 0.35,
      stretch: 0.8,
    },
    dustPuffs(0x4a3a30, 26),
    coreFlash(0xffd6a8, 1.5, 0.32, 1.5),
  ],
  residue: { layer: DECAL.scorch, color: 0xffffff, size: 0.75, life: 14, alpha: 0.9 },
  shake: [0.8, 0.5],
};

// A lick of flame from burning ground: small, low and brief, fired over and over.
EFFECTS['burn.tick'] = {
  ground: [
    {
      shape: GSHAPE.glow,
      color: 0xff6a22,
      intensity: 0.45,
      life: 0.6,
      size: 0.35,
      alpha: pop(0.12, 1.5, 0.5),
      p0: 3,
    },
  ],
  bursts: [
    {
      count: 8,
      layer: SPRITE.ember,
      ring: 0.35,
      ringJitter: 0.6,
      y: 0.1,
      speed: [0.5, 2.2],
      rise: [2.5, 6],
      size: [0.12, 0.28],
      sizeEnd: 0.4,
      life: [0.5, 0.95],
      color: EMBER,
      colorEnd: 0x802010,
      intensity: 1.3,
      intensityEnd: 0.05,
      drag: 0.8,
    },
  ],
};

// Arcane: a spiral, not a ring. Counter-rotation and a sigil that lingers.
EFFECTS['bolt.arcane'] = {
  ground: [
    {
      shape: GSHAPE.spiral,
      color: 0xff7fe0,
      intensity: 1.05,
      life: 0.6,
      size: 1.5,
      alpha: pop(0.12, 1.5, 0.55),
      p0: 3,
      p1: 5.5,
      p2: 1,
      spin: 2.4,
    },
    {
      shape: GSHAPE.ring,
      color: 0xd9a6ff,
      intensity: 1.0,
      life: 0.4,
      size: 1.6,
      alpha: pop(0.1, 1.8, 0.6),
      p0: out(0.2, 0.95),
      p1: ringBand(0.16),
      p2: 1,
    },
  ],
  bursts: [
    {
      count: 10,
      layer: SPRITE.shard,
      ring: 0.2,
      ringJitter: 0.4,
      y: 0.6,
      yJitter: 0.8,
      speed: [3, 8],
      rise: [1.5, 4.5],
      size: [0.24, 0.48],
      sizeEnd: 0.3,
      life: [0.35, 0.65],
      color: 0xff9cf0,
      colorEnd: 0x8a3bd0,
      intensity: 1.5,
      intensityEnd: 0.08,
      drag: 3.2,
      spin: [-3, 3],
    },
    {
      count: 6,
      layer: SPRITE.rune,
      ring: 0.5,
      ringJitter: 0.5,
      y: 0.9,
      yJitter: 0.9,
      rise: [1.5, 3],
      swirl: [2, 3.5],
      size: [0.34, 0.58],
      life: [0.4, 0.75],
      color: 0xffb0f0,
      intensity: 1.0,
      intensityEnd: 0,
      spin: [-2, 2],
    },
    coreFlash(0xffd6f7, 0.9, 0.15),
  ],
  residue: { layer: DECAL.sigil, color: 0xff9ce8, size: 1.15, life: 2.2, alpha: 0.24 },
};

// Frost: crystalline. Hard-edged shards, a slow mist, and a patch that stays
// frozen long after the cast — the residue is half the identity here.
EFFECTS['aura.frost'] = {
  ground: [
    {
      // Crystalline, not circular. Frost was the last school still leading with
      // the same smooth ring as holy and arcane, which made it "the blue one"
      // rather than its own shape language — the exact failure the table at the
      // top of this file exists to prevent. The facets grow their needles as the
      // front advances, so the spell reads as ice spreading rather than a wave.
      shape: GSHAPE.crystal,
      // Saturated rather than pale: additive over bright ground eats the low
      // channels first, so a pale ice blue arrives as white.
      color: 0x5fc6ff,
      intensity: 0.95,
      life: 0.85,
      alpha: pop(0.12, 1.3, 0.55),
      p0: out(0.05, 0.95),
      p1: ringBand(0.2),
      p2: lin(0.5, 1),
    },
    {
      shape: GSHAPE.starburst,
      color: 0xd6f2ff,
      intensity: 0.95,
      life: 0.9,
      size: 0.85,
      alpha: pop(0.2, 1.4, 0.6),
      p0: 22,
      p1: 9,
      p2: 0.3,
      spin: 0.18,
      soft: true,
    },
  ],
  bursts: [
    {
      count: 16,
      layer: SPRITE.shard,
      ring: 0.35,
      ringJitter: 0.7,
      y: 0.1,
      yJitter: 0.5,
      speed: [2, 7],
      rise: [3, 7],
      size: [0.28, 0.58],
      sizeEnd: 0.85,
      life: [0.55, 1.0],
      color: 0xd8f2ff,
      colorEnd: 0x4f9fd8,
      intensity: 1.35,
      intensityEnd: 0.15,
      gravity: -9,
      drag: 0.9,
      spin: [-1.4, 1.4],
    },
    {
      count: 10,
      layer: SPRITE.smoke,
      blend: BLEND_SOFT,
      ring: 0.55,
      ringJitter: 0.5,
      y: 0.1,
      yJitter: 0.35,
      speed: [1.2, 3.4],
      rise: [0.2, 0.8],
      size: [1.2, 2.4],
      sizeEnd: 1.8,
      life: [0.9, 1.6],
      color: 0xc9e8ff,
      colorEnd: 0x9dc4e0,
      intensity: 0.62,
      intensityEnd: 0.3,
      drag: 1.6,
      alpha: 0.45,
      fadeIn: 0.22,
      spin: [-0.4, 0.4],
    },
    {
      count: 12,
      layer: SPRITE.spark,
      ring: 0.7,
      ringJitter: 0.7,
      y: 0.3,
      yJitter: 1,
      rise: [1, 2.4],
      size: [0.1, 0.22],
      life: [0.5, 0.95],
      color: 0xf0fbff,
      intensity: 1.7,
      intensityEnd: 0,
      drag: 1.5,
    },
  ],
  residue: { layer: DECAL.frost, color: 0xb6e2ff, size: 0.8, life: 7.5, alpha: 0.38 },
};

// ── Hit feedback ─────────────────────────────────────────────────────────────
// Fired on every landed attack, so these are the cheapest specs in the table:
// under a dozen particles and no ground shape unless the hit was a crit.

EFFECTS['hit.physical'] = {
  bursts: [
    {
      count: 7,
      layer: SPRITE.spark,
      ring: 0.1,
      y: 1.0,
      yJitter: 0.5,
      speed: [3, 8],
      rise: [1.5, 5],
      size: [0.13, 0.28],
      sizeEnd: 0.4,
      life: [0.18, 0.34],
      color: 0xffe2b0,
      colorEnd: 0xff9040,
      intensity: 1.7,
      intensityEnd: 0.08,
      gravity: -12,
      stretch: 0.7,
    },
    {
      count: 3,
      layer: SPRITE.dust,
      blend: BLEND_SOFT,
      ring: 0.2,
      y: 0.8,
      yJitter: 0.6,
      speed: [1, 2.6],
      size: [0.6, 1.1],
      sizeEnd: 1.8,
      life: [0.3, 0.5],
      color: 0x9c8c78,
      intensity: 0.42,
      intensityEnd: 0.2,
      drag: 2.4,
      alpha: 0.34,
    },
  ],
};

EFFECTS['hit.crit'] = {
  ground: [
    {
      shape: GSHAPE.shock,
      color: 0xffc98a,
      intensity: 0.9,
      life: 0.3,
      size: 1.6,
      alpha: pop(0.1, 1.6, 0.5),
      p0: out(0.1, 0.9),
      p1: ringBand(0.22),
      p2: 0.6,
    },
  ],
  bursts: [
    {
      count: 12,
      layer: SPRITE.spark,
      ring: 0.1,
      y: 1.0,
      yJitter: 0.6,
      speed: [5, 13],
      rise: [2, 7],
      size: [0.16, 0.34],
      sizeEnd: 0.35,
      life: [0.24, 0.45],
      color: 0xfff0c8,
      colorEnd: 0xff7020,
      intensity: 1.9,
      intensityEnd: 0.08,
      gravity: -14,
      stretch: 0.9,
    },
    coreFlash(0xffe6bc, 0.8, 0.13),
  ],
};

EFFECTS['hit.arcane'] = {
  bursts: [
    {
      count: 8,
      layer: SPRITE.shard,
      ring: 0.1,
      y: 1.0,
      yJitter: 0.5,
      speed: [2.5, 6],
      rise: [1, 3.5],
      size: [0.18, 0.38],
      sizeEnd: 0.25,
      life: [0.2, 0.4],
      color: 0xffa0ee,
      colorEnd: 0x7c34c0,
      intensity: 1.6,
      intensityEnd: 0.08,
      drag: 3,
      spin: [-4, 4],
    },
  ],
};

EFFECTS['hit.frost'] = {
  bursts: [
    {
      count: 8,
      layer: SPRITE.shard,
      ring: 0.12,
      y: 0.9,
      yJitter: 0.5,
      speed: [2, 5.5],
      rise: [1.5, 4],
      size: [0.2, 0.42],
      sizeEnd: 0.5,
      life: [0.28, 0.5],
      color: 0xdcf5ff,
      colorEnd: 0x4d9ad4,
      intensity: 1.5,
      intensityEnd: 0.12,
      gravity: -8,
      spin: [-2, 2],
    },
  ],
};

EFFECTS['hit.holy'] = {
  bursts: [
    {
      count: 9,
      layer: SPRITE.spark,
      ring: 0.1,
      y: 1.0,
      yJitter: 0.6,
      speed: [2, 6],
      rise: [3, 7],
      size: [0.14, 0.3],
      life: [0.25, 0.45],
      color: 0xfff2cc,
      colorEnd: 0xffb040,
      intensity: 1.8,
      intensityEnd: 0.08,
      drag: 1.6,
      stretch: 0.5,
    },
  ],
};

EFFECTS['hit.hex'] = {
  bursts: [
    {
      count: 9,
      layer: SPRITE.spark,
      ring: 0.1,
      y: 0.9,
      yJitter: 0.5,
      speed: [2.5, 6.5],
      rise: [1, 3.5],
      size: [0.16, 0.34],
      sizeEnd: 0.5,
      life: [0.22, 0.44],
      color: 0xaaff90,
      colorEnd: 0x2f7a3a,
      intensity: 1.6,
      intensityEnd: 0.08,
      drag: 2.6,
    },
    {
      count: 4,
      layer: SPRITE.smoke,
      blend: BLEND_SOFT,
      ring: 0.15,
      y: 0.8,
      yJitter: 0.5,
      speed: [0.8, 2.2],
      rise: [0.6, 1.6],
      size: [0.7, 1.3],
      sizeEnd: 2,
      life: [0.4, 0.75],
      color: 0x74a86a,
      intensity: 0.4,
      intensityEnd: 0.16,
      drag: 2,
      alpha: 0.34,
    },
  ],
};

// ── Projectiles ──────────────────────────────────────────────────────────────

export interface ProjectileSpec {
  /** Head sprite and its tint. */
  layer: number;
  color: number;
  colorTrail: number;
  intensity: number;
  size: number;
  /** Billboard stretch along the velocity. 0 for orbs, high for bolts. */
  stretch: number;
  /** World units per second. */
  speed: number;
  /** Peak of the ballistic lift, in world units. 0 flies flat. */
  arc: number;
  /** Metres between trail particles. Lower is denser and more expensive. */
  trailStep: number;
  trailLife: [number, number];
  trailSize: [number, number];
  /** Sideways scatter of trail particles, in world units. */
  trailJitter: number;
  trailLayer: number;
  /** Effect id fired where it lands. */
  impact: string;
  /** Extra spin of the head billboard, rad/s. */
  spin?: number;
}

export const PROJECTILES: Record<string, ProjectileSpec> = {
  // Meteor: the only projectile that falls rather than flies. Big, slow enough
  // to be read as a warning, and trailing smoke the whole way down so the eye
  // follows it to the circle already burning on the ground.
  'shot.meteor': {
    layer: SPRITE.flare,
    color: 0xffb060,
    colorTrail: 0xff6a20,
    intensity: 1.9,
    size: 2.6,
    stretch: 0.9,
    speed: 34,
    arc: 0,
    trailStep: 0.22,
    trailLife: [0.45, 0.85],
    trailSize: [0.9, 1.9],
    trailJitter: 0.22,
    trailLayer: SPRITE.smoke,
    impact: 'impact.meteor',
    spin: 2.2,
  },
  // Arrow: the flattest, fastest shot in the game, with a trail thin enough to
  // read as the air closing behind it rather than as a spell.
  'shot.arrow': {
    layer: SPRITE.streak,
    color: 0xfff0cc,
    colorTrail: 0xcbb083,
    intensity: 1.25,
    size: 0.62,
    stretch: 3.4,
    speed: 62,
    arc: 0.25,
    trailStep: 0.45,
    trailLife: [0.1, 0.18],
    trailSize: [0.09, 0.16],
    trailJitter: 0.03,
    trailLayer: SPRITE.spark,
    impact: 'hit.pierce',
  },
  // Bone spike: a fast flat physical bolt with a short hot trail.
  'shot.spine': {
    layer: SPRITE.streak,
    color: 0xffd9a8,
    colorTrail: 0xd8b184,
    intensity: 1.4,
    size: 0.7,
    stretch: 2.6,
    speed: 46,
    arc: 0.6,
    trailStep: 0.35,
    trailLife: [0.14, 0.26],
    trailSize: [0.13, 0.24],
    trailJitter: 0.06,
    trailLayer: SPRITE.spark,
    impact: 'hit.physical',
  },
  // Hex orb: slower, wobbling, sickly green, heavy smoke trail.
  'shot.hex': {
    layer: SPRITE.flare,
    color: 0x9cff8a,
    colorTrail: 0x5fd06a,
    intensity: 1.5,
    size: 0.85,
    stretch: 0.4,
    speed: 26,
    arc: 1.5,
    trailStep: 0.3,
    trailLife: [0.28, 0.5],
    trailSize: [0.22, 0.42],
    trailJitter: 0.16,
    trailLayer: SPRITE.smoke,
    impact: 'hit.hex',
    spin: 3,
  },
  // Arcane bolt: the Oracle's signature. Bright core, dense spark trail.
  'shot.arcane': {
    layer: SPRITE.flare,
    color: 0xffa8f2,
    colorTrail: 0xd070ff,
    intensity: 1.6,
    size: 0.8,
    stretch: 0.8,
    speed: 34,
    arc: 0.9,
    trailStep: 0.24,
    trailLife: [0.22, 0.4],
    trailSize: [0.17, 0.32],
    trailJitter: 0.14,
    trailLayer: SPRITE.spark,
    impact: 'hit.arcane',
    spin: 2,
  },
  'shot.frost': {
    layer: SPRITE.shard,
    color: 0xd8f4ff,
    colorTrail: 0x8fd0ff,
    intensity: 1.45,
    size: 0.7,
    stretch: 1.2,
    speed: 32,
    arc: 0.8,
    trailStep: 0.3,
    trailLife: [0.26, 0.46],
    trailSize: [0.12, 0.26],
    trailJitter: 0.12,
    trailLayer: SPRITE.shard,
    impact: 'hit.frost',
    spin: 4,
  },
  'shot.holy': {
    layer: SPRITE.flare,
    color: 0xffe9b8,
    colorTrail: 0xffc266,
    intensity: 1.55,
    size: 0.75,
    stretch: 1.0,
    speed: 36,
    arc: 0.7,
    trailStep: 0.28,
    trailLife: [0.2, 0.36],
    trailSize: [0.13, 0.28],
    trailJitter: 0.1,
    trailLayer: SPRITE.spark,
    impact: 'hit.holy',
  },
};

// ── Beams ────────────────────────────────────────────────────────────────────

export interface BeamSpec {
  color: number;
  coreColor: number;
  intensity: number;
  /** Half width at the source and at the target, in world units. */
  widthFrom: number;
  widthTo: number;
  /** Texture scroll speed along the beam. */
  scroll: number;
  /** Muzzle / impact particle rate, per second. */
  sparkRate: number;
  sparkColor: number;
  /** Height above ground of both endpoints. */
  height: number;
  /** Draw as this many kinked segments instead of one straight beam. */
  jagged?: number;
  /** Kink size as a fraction of the beam's length. */
  jitter?: number;
}

export const BEAMS: Record<string, BeamSpec> = {
  'beam.arcane': {
    color: 0xc060ff,
    coreColor: 0xf0b4ff,
    intensity: 1.15,
    widthFrom: 0.2,
    widthTo: 0.075,
    scroll: 2.4,
    sparkRate: 30,
    sparkColor: 0xffb0f5,
    height: 1.25,
  },
  'beam.holy': {
    color: 0xffc463,
    coreColor: 0xffe8b4,
    intensity: 1.2,
    widthFrom: 0.22,
    widthTo: 0.08,
    scroll: 1.6,
    sparkRate: 26,
    sparkColor: 0xffe0a0,
    height: 1.3,
  },
  'beam.frost': {
    color: 0x6fc8ff,
    coreColor: 0xc8f0ff,
    intensity: 1.1,
    widthFrom: 0.18,
    widthTo: 0.07,
    scroll: 1.1,
    sparkRate: 24,
    sparkColor: 0xcdeeff,
    height: 1.2,
  },
};

// Lightning: thin, white-hot core, cold blue glow, broken into kinks. Short-lived
// by the caller, so the brightness is a flash rather than a standing light.
BEAMS['beam.lightning'] = {
  color: 0x7fbfff,
  coreColor: 0xf2f8ff,
  intensity: 1.6,
  widthFrom: 0.14,
  widthTo: 0.1,
  scroll: 7,
  sparkRate: 40,
  sparkColor: 0xd8ecff,
  height: 1.3,
  jagged: 6,
  jitter: 0.09,
};


// The pierce shot: a taut, pale line with almost no glow. An arrow is not a
// spell, and the beam is only there to say where it went.
BEAMS['beam.arrow'] = {
  color: 0xe8dcae,
  coreColor: 0xfff8e2,
  intensity: 1.1,
  widthFrom: 0.085,
  widthTo: 0.05,
  scroll: 9,
  sparkRate: 14,
  sparkColor: 0xfff0c0,
  height: 1.15,
};

// An arrow going through something: a short spray of sparks along the shot's
// own direction rather than a burst, plus the puff of a body giving way.
EFFECTS['hit.pierce'] = {
  bursts: [
    {
      count: 6,
      layer: SPRITE.spark,
      ring: 0.08,
      y: 1.05,
      yJitter: 0.35,
      speed: [4, 9],
      rise: [1, 3.5],
      size: [0.1, 0.2],
      sizeEnd: 0.28,
      life: [0.14, 0.26],
      color: 0xfff0cf,
      colorEnd: 0xd8a34a,
      intensity: 1.6,
      intensityEnd: 0.06,
      gravity: -10,
      stretch: 1.3,
    },
    {
      count: 2,
      layer: SPRITE.dust,
      blend: BLEND_SOFT,
      ring: 0.16,
      y: 0.85,
      yJitter: 0.5,
      speed: [0.8, 2],
      size: [0.5, 0.9],
      sizeEnd: 1.5,
      life: [0.26, 0.44],
      color: 0x8d8570,
      intensity: 0.38,
      intensityEnd: 0.16,
      drag: 2.6,
      alpha: 0.3,
    },
  ],
};

// The archer's sidestep: a low ring of dust where she left, nothing bright —
// the step should read as air, not as magic.
EFFECTS['impact.dash'] = {
  ground: [
    {
      shape: GSHAPE.shock,
      color: 0xbfe6c4,
      intensity: 0.5,
      life: 0.28,
      size: 2.2,
      alpha: pop(0.08, 1.4, 0.55),
      p0: out(0.12, 0.85),
      p1: ringBand(0.26),
      p2: 0.5,
    },
  ],
  bursts: [
    {
      count: 5,
      layer: SPRITE.dust,
      blend: BLEND_SOFT,
      ring: 0.35,
      y: 0.3,
      yJitter: 0.35,
      speed: [1.4, 3.2],
      size: [0.55, 1],
      sizeEnd: 1.9,
      life: [0.3, 0.52],
      color: 0x9fb597,
      intensity: 0.44,
      intensityEnd: 0.14,
      drag: 3,
      alpha: 0.32,
    },
  ],
};

/** Beam fallback, so an unknown id still draws something rather than nothing. */
export const DEFAULT_BEAM = 'beam.arcane';
