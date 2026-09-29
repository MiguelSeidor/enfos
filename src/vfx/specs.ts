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
 *
 * ## The three beats
 *
 * Colour and shape tell you *which* spell. They do not tell you that a spell is
 * expensive. What does that is structure in time, and every effect in this table
 * that matters is authored as three beats, scheduled with `at` in seconds:
 *
 * 1. **Anticipation.** Something the eye catches *before* the event: a ring that
 *    closes instead of opening, motes flying inward (`converge`), a low glow
 *    swelling under the caster. Without it an effect simply appears, and
 *    appearing is what reads as cheap no matter how bright the appearance is.
 *    For an instant ability the whole wind-up has to fit in 0.08–0.14 s, because
 *    gameplay has already applied the damage — six to eight frames, which is
 *    exactly what hand animation has always used for an anticipation.
 * 2. **Impact.** Much shorter and much brighter than the wind-up: one hot core,
 *    one needle-thin shock ring that outruns everything else, debris thrown on
 *    real gravity, and the camera hit landing on the same frame (`at` on the
 *    shake, not at cast time).
 * 3. **Residue.** The part that says it *happened*: a decal that outlives the
 *    cast, plus motes and smoke that decay over a second or two. An effect that
 *    ends when its rings end reads as a cutscene that was switched off.
 *
 * The ratio matters more than any individual number. Wind-up long and dim,
 * impact short and hot, residue long and faint.
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
  /**
   * Seconds to wait before the shape is armed at all, counted from the moment
   * the effect was played. Unlike `delay`, which only stretches one shape's own
   * curve, this is real scheduling: it is what lets one effect id be a wind-up
   * followed by a detonation.
   */
  at?: number;
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

/** Residue: an alpha-blended decal that outlives the cast. */
export interface ResidueSpec {
  layer: number;
  color: number;
  size: number;
  life: number;
  alpha: number;
  /** Seconds after the effect was played. Scorch should arrive *with* the heat. */
  at?: number;
}

/**
 * Camera shake. `at` is what makes it a reaction rather than an announcement:
 * a shake fired at cast time lands before the thing that caused it.
 */
export interface ShakeSpec {
  intensity: number;
  duration: number;
  at?: number;
}

export interface EffectSpec {
  ground?: GroundShapeSpec[];
  bursts?: BurstSpec[];
  /** One decal, or a stack of them arriving at different times. */
  residue?: ResidueSpec | ResidueSpec[];
  /** Camera shake, only where the effect is the whole event. */
  shake?: [number, number] | ShakeSpec[];
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
  shape: number = GSHAPE.ring,
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

const dustPuffs = (color: number, count: number, at = 0): BurstSpec => ({
  count,
  layer: SPRITE.dust,
  blend: BLEND_SOFT,
  at,
  ring: 0.45,
  ringJitter: 0.35,
  // Dust is thrown up, not laid down. At y 0.15 with a 1 m/s rise it never left
  // the ground and read as a brown stain painted round the impact.
  y: 0.5,
  yJitter: 1.1,
  speed: [2.5, 6.5],
  rise: [2.2, 5.5],
  size: [1.1, 2.4],
  sizeEnd: 2.6,
  life: [0.7, 1.35],
  color,
  colorEnd: color,
  intensity: 1.1,
  intensityEnd: 0.6,
  drag: 2.1,
  gravity: -2.4,
  spin: [-0.7, 0.7],
  alpha: 0.6,
  fadeIn: 0.16,
  // Dust is matter. It has to stay up long enough to be seen settling, which a
  // squared fade never allows.
  decay: 1,
});

/**
 * The single hot frame at the origin of an impact. Small and short: this is the
 * one part of an effect deliberately pushed over the bloom threshold, and it
 * works precisely because nothing around it is.
 */
const coreFlash = (
  color: number,
  size: number,
  life = 0.18,
  intensity = 1.7,
  at = 0,
): BurstSpec => ({
  count: 1,
  layer: SPRITE.flare,
  at,
  y: 0.7,
  size: [size, size],
  sizeEnd: 1.4,
  life: [life, life],
  color,
  intensity,
  intensityEnd: 0,
  fadeIn: 0.08,
});

// ── The three beats ──────────────────────────────────────────────────────────

/**
 * Anticipation, ground half: a ring that *closes* on the point instead of
 * leaving it, brightening as it shrinks.
 *
 * Direction is the entire trick. An expanding ring is a consequence; a
 * contracting one is a cause, and the eye reads the difference long before it
 * reads the colour. `p0` closes on a square curve so the last third of the
 * wind-up accelerates into the beat.
 */
const gatherRing = (color: number, life: number, intensity = 0.8, at = 0): GroundShapeSpec => ({
  shape: GSHAPE.ring,
  color,
  intensity,
  life,
  at,
  // Peaks around half alpha and no higher. The wind-up's job is to be the dim
  // thing the flash is three times brighter than; a gather that already reaches
  // white has spent the contrast the impact needs, and the detonation then
  // reads as the ring merely changing direction.
  alpha: (t) => Math.min(1, t / 0.14) * (0.16 + 0.4 * t * t),
  p0: (t) => 0.98 - 0.84 * t * t,
  p1: (t) => 0.018 + 0.05 * t,
  p2: 1,
});

/**
 * Anticipation, volume half: motes drawn in from the edge of the effect, timed
 * to arrive at the centre exactly when the impact lands.
 */
const gatherMotes = (
  color: number,
  count: number,
  life: number,
  at = 0,
  layer: number = SPRITE.spark,
): BurstSpec => ({
  count,
  layer,
  at,
  ring: 0.95,
  ringJitter: 0.45,
  y: 0.3,
  yJitter: 1.8,
  converge: true,
  rise: [0.3, 1.5],
  swirl: [0.8, 2.2],
  size: [0.2, 0.44],
  sizeEnd: 0.4,
  life: [life, life * 1.1],
  color,
  // Brighter at the end than at the start: the gather should look like it is
  // being pulled faster and hotter the closer it gets.
  intensity: 0.7,
  intensityEnd: 1.9,
  fadeIn: 0.22,
  decay: 0.7,
  spin: [-2, 2],
  // The streak in flight is what makes a gather read as *drawn in* rather than
  // as a ring of dots that happen to be closer each frame.
  stretch: 0.9,
});

/**
 * The impact beat. A needle-thin ring that outruns every other layer and is dead
 * inside a fifth of a second.
 *
 * This is the one ground shape authored deliberately over the bloom threshold.
 * It gets away with it because of the width: at a 13 m effect the band is about
 * 0.3 m of screen, so the bloom is an accent on a line rather than a smear over
 * an area. Widen it and it becomes the white hole this file keeps warning about.
 */
const flashRing = (color: number, life = 0.2, intensity = 1.75, at = 0): GroundShapeSpec => ({
  shape: GSHAPE.ring,
  color,
  intensity,
  life,
  at,
  alpha: pop(0.04, 2.8, 0.95),
  p0: out(0.06, 1.0, 3.2),
  p1: 0.022,
  p2: 1,
});

/**
 * Residue, volume half: embers and motes that hang in the air and decay over a
 * second or two after everything else has gone.
 *
 * Positive gravity, because the integrator adds it to the vertical velocity —
 * these drift *up* off hot ground. This is the cheapest layer in the table and
 * the one that most changes whether a player believes something happened there.
 */
const motes = (color: number, count: number, at = 0, life: [number, number] = [1.1, 2.2]): BurstSpec => ({
  count,
  layer: SPRITE.spark,
  at,
  ring: 0.5,
  ringJitter: 0.9,
  y: 0.2,
  yJitter: 1.4,
  speed: [0.2, 1.1],
  rise: [0.4, 1.5],
  size: [0.09, 0.22],
  sizeEnd: 0.45,
  life,
  color,
  intensity: 1.0,
  intensityEnd: 0,
  drag: 1.7,
  gravity: 1.1,
  fadeIn: 0.28,
  decay: 0.8,
});

/**
 * Residue, volume: smoke rolling off the impact for a couple of seconds after
 * the flash. Alpha-blended, because smoke that glows is steam.
 *
 * The colours here are *mid grey*, not soot. The first pass authored this the
 * way smoke is described rather than the way it is seen — near-black, at half
 * intensity — and alpha-blending a near-black sprite over this map's shadowed
 * grass produces a dark smear that is indistinguishable from a dirty decal. Real
 * smoke is lit: it goes darker than sunlit ground and lighter than shade, and it
 * needs an intensity around 1 to sit in that band at all.
 */
const smoulder = (color: number, count: number, at = 0, intensity = 1.15): BurstSpec => ({
  count,
  layer: SPRITE.smoke,
  blend: BLEND_SOFT,
  at,
  ring: 0.35,
  ringJitter: 0.7,
  // Well off the deck and rising: smoke that hugs the ground is a stain.
  y: 0.8,
  yJitter: 1.6,
  speed: [0.8, 3.2],
  rise: [1.4, 3.6],
  size: [1.8, 3.8],
  sizeEnd: 2.4,
  life: [1.5, 2.7],
  color,
  colorEnd: color,
  intensity,
  intensityEnd: intensity * 0.7,
  drag: 1.3,
  gravity: 0.5,
  spin: [-0.35, 0.35],
  // The smoke sprite's own coverage peaks around 0.6, and a slow fade-in eats
  // most of what is left, so anything under ~0.7 here never arrives as a cloud.
  alpha: 0.78,
  fadeIn: 0.1,
  decay: 0.9,
});

// Written as constants rather than inline so the debris and the puffs of one
// effect cannot drift apart under tuning.
const EARTH = 0xb49a7c;
const EMBER = 0xffbe6a;

export const EFFECTS: Record<string, EffectSpec> = {};

/**
 * Bulwark Q, and the Talon's snare when it closes. A dust shock — no ring of
 * light, because the statement is displaced earth.
 *
 * The wind-up is 0.10 s and it gathers *shadow*, not light. Both decisions are
 * load-bearing. Ten hundredths is all an instant ability can spend: gameplay
 * applied the damage on the cast tick, so a longer anticipation would put the
 * boom after the health bars had already moved. And a shield bash that gathers
 * light is a spell — the physical school's wind-up is the ground darkening and
 * loose grit being pulled in under the brace.
 */
EFFECTS['impact.slam'] = {
  ground: [
    // — anticipation, 0 → 0.10 s
    { ...gatherRing(0x2b2016, 0.1), soft: true, decalLayer: DECAL.grain },
    // — impact, 0.10 s. Short and warm: a shield bash is not a holy ring, so the
    //   bright edge is two or three frames of hot dust and then gone.
    flashRing(0xffd49a, 0.13, 1.2, 0.1),
    {
      shape: GSHAPE.shock,
      color: 0xd9a771,
      intensity: 0.95,
      life: 0.5,
      at: 0.1,
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
      at: 0.1,
      size: 0.45,
      alpha: pop(0.08, 2.4, 0.4),
      p0: 3.2,
    },
  ],
  bursts: [
    // — anticipation: grit lifted off the ground and drawn toward the strike.
    {
      count: 8,
      layer: SPRITE.dust,
      blend: BLEND_SOFT,
      ring: 0.8,
      ringJitter: 0.3,
      y: 0.1,
      yJitter: 0.35,
      converge: true,
      life: [0.1, 0.12],
      size: [0.5, 0.95],
      sizeEnd: 0.55,
      color: 0x8b7757,
      intensity: 0.5,
      intensityEnd: 0.75,
      alpha: 0.5,
      fadeIn: 0.3,
      decay: 0.7,
    },
    // — impact
    dustPuffs(EARTH, 16, 0.1),
    {
      // Debris: thrown up, pulled down, and it lands. Gravity is what separates
      // a physical hit from a magical one before any colour is read.
      count: 14,
      layer: SPRITE.ember,
      at: 0.1,
      ring: 0.15,
      ringJitter: 0.3,
      y: 0.3,
      speed: [4, 11],
      rise: [4, 8.5],
      size: [0.16, 0.34],
      sizeEnd: 0.8,
      life: [0.55, 1.0],
      color: EMBER,
      colorEnd: 0x6b3a1c,
      intensity: 1.5,
      intensityEnd: 0.18,
      gravity: -15,
      drag: 0.5,
      stretch: 0.6,
      decay: 1.2,
    },
    coreFlash(0xffe3b0, 1.2, 0.15, 1.8, 0.1),
    // — residue: the dust that has not settled yet, drifting after the shock has
    //   already gone. Cheap, and the whole difference between a hit that
    //   happened and a hit that is still there a beat later.
    {
      count: 6,
      layer: SPRITE.dust,
      blend: BLEND_SOFT,
      at: 0.34,
      ring: 0.72,
      ringJitter: 0.7,
      y: 0.15,
      yJitter: 0.45,
      speed: [0.4, 1.8],
      rise: [0.2, 0.9],
      size: [1.3, 2.5],
      sizeEnd: 2.4,
      life: [0.9, 1.6],
      color: 0x9c8a6c,
      intensity: 0.5,
      intensityEnd: 0.26,
      drag: 1.8,
      alpha: 0.4,
      fadeIn: 0.25,
      decay: 0.9,
    },
  ],
  residue: { layer: DECAL.scorch, color: 0xc0a078, size: 0.42, life: 3.4, alpha: 0.32, at: 0.1 },
  shake: [{ intensity: 0.45, duration: 0.22, at: 0.1 }],
};

/**
 * Bulwark W. The one ability nobody else in the roster fires, so it is allowed
 * a silhouette of its own: the shout draws light *in* for a tenth of a second
 * and then throws it out as a wall.
 *
 * It is a taunt, not damage, which is why there is no debris and no scorch. What
 * it leaves behind is a ring of runes still turning in the air — the visual
 * claim that the enemies in it are now bound to him.
 */
EFFECTS['aura.shout'] = {
  ground: [
    // — anticipation, 0 → 0.12 s
    gatherRing(0xffd88a, 0.12, 1.0),
    {
      shape: GSHAPE.glow,
      color: 0xffc860,
      intensity: 0.5,
      life: 0.12,
      size: 0.3,
      alpha: (t) => 0.1 + 0.55 * t * t,
      p0: 3.4,
    },
    // — impact, 0.12 s
    flashRing(0xfff0c8, 0.19, 1.7, 0.12),
    { ...shockRing(0xffd24a, 0.72, 1.05), at: 0.12 },
    { ...shockRing(0xffb43c, 0.85, 0.8, 0.18), p1: ringBand(0.14), at: 0.12 },
    {
      shape: GSHAPE.starburst,
      color: 0xffcf62,
      intensity: 0.9,
      life: 0.55,
      at: 0.12,
      size: 0.42,
      alpha: pop(0.1, 2, 0.45),
      p0: 12,
      p1: 5,
      p2: 0.6,
      spin: 1.1,
    },
  ],
  bursts: [
    // — anticipation
    gatherMotes(0xffdd90, 12, 0.12),
    // — impact
    {
      count: 14,
      layer: SPRITE.streak,
      at: 0.12,
      ring: 0.12,
      ringJitter: 0.2,
      y: 0.2,
      speed: [1.2, 3],
      rise: [7, 13],
      size: [0.36, 0.78],
      sizeEnd: 0.5,
      life: [0.5, 0.9],
      color: 0xffd469,
      colorEnd: 0xff9c2e,
      intensity: 1.4,
      intensityEnd: 0.1,
      drag: 1.4,
      stretch: 1.4,
      decay: 1.4,
    },
    {
      count: 8,
      layer: SPRITE.rune,
      at: 0.12,
      ring: 0.85,
      ringJitter: 0.25,
      y: 0.5,
      yJitter: 1.2,
      rise: [1.2, 2.4],
      swirl: [1.5, 2.6],
      size: [0.5, 0.85],
      sizeEnd: 1.15,
      life: [0.7, 1.15],
      color: 0xffca55,
      intensity: 0.95,
      intensityEnd: 0,
      spin: [-1.2, 1.2],
      decay: 1.1,
    },
    coreFlash(0xffe9b0, 1.4, 0.2, 1.8, 0.12),
    // — residue: runes still turning after the wall of sound has passed. The
    //   taunt's only lasting statement, and it has to outlive the rings.
    {
      count: 7,
      layer: SPRITE.rune,
      at: 0.5,
      ring: 0.7,
      ringJitter: 0.5,
      y: 0.6,
      yJitter: 1.4,
      rise: [0.3, 1.1],
      swirl: [0.5, 1.2],
      size: [0.34, 0.6],
      sizeEnd: 1.3,
      life: [1.2, 2.0],
      color: 0xffcf72,
      intensity: 0.75,
      intensityEnd: 0,
      spin: [-0.8, 0.8],
      fadeIn: 0.3,
      decay: 0.85,
    },
    motes(0xffe0a0, 9, 0.42, [0.9, 1.7]),
  ],
  shake: [{ intensity: 0.28, duration: 0.2, at: 0.12 }],
};

/**
 * The ward. The Vesper's heal and her shield, the Bulwark's guard, and the
 * moment the Talon's trap arms — the most-fired non-damage effect in the game.
 *
 * Gold, not ice blue. It was the one holy effect in the table wearing frost's
 * palette, which cost it twice: it read as the Oracle's school on the Vesper's
 * abilities, and it is cast *on allies*, who are blue under the faction colour
 * law, so a pale blue ward on a blue hero had nothing left to separate it from
 * the body it was protecting. Warm on cool is the single strongest contrast
 * available here and it costs nothing.
 *
 * A ward is not a detonation, so the beat is a *snap*, not a blast: light drawn
 * down onto the target, a ring closing, then the ward locking with one thin hot
 * edge — and runes left turning around them afterwards, which is the only part
 * a player still sees three seconds later when the buff is what matters.
 */
EFFECTS['aura.guard'] = {
  ground: [
    // — anticipation, 0 → 0.13 s
    gatherRing(0xffe3a8, 0.13, 0.9),
    // — impact, 0.13 s: the ward locking. Thin and brief; nothing here should
    //   read as damage.
    { ...flashRing(0xfff2d8, 0.16, 1.4, 0.13), p0: out(0.1, 0.86, 2.6) },
    {
      shape: GSHAPE.starburst,
      color: 0xffd98a,
      intensity: 1.0,
      life: 1.0,
      at: 0.13,
      size: 1.0,
      alpha: pop(0.16, 1.3, 0.42),
      p0: 14,
      p1: 7,
      p2: 0.5,
      spin: -0.8,
    },
    {
      shape: GSHAPE.ring,
      color: 0xffeac0,
      intensity: 1.0,
      life: 1.0,
      at: 0.13,
      alpha: pop(0.2, 1.2, 0.5),
      p0: out(0.55, 0.98),
      p1: 0.045,
      p2: 1,
    },
  ],
  bursts: [
    // — anticipation: light pulled down onto whoever is being warded.
    gatherMotes(0xffe0a0, 8, 0.13),
    // — impact
    {
      count: 12,
      layer: SPRITE.rune,
      at: 0.13,
      ring: 0.9,
      ringJitter: 0.2,
      y: 0.15,
      yJitter: 0.4,
      rise: [1.6, 3.2],
      swirl: [2.2, 3.4],
      speed: [-0.6, 0.4],
      size: [0.4, 0.68],
      sizeEnd: 0.75,
      life: [0.95, 1.5],
      color: 0xffe0a0,
      colorEnd: 0xffab45,
      intensity: 0.95,
      intensityEnd: 0.1,
      spin: [-1.6, 1.6],
      fadeIn: 0.2,
      decay: 1.2,
    },
    {
      count: 10,
      layer: SPRITE.spark,
      at: 0.13,
      ring: 0.5,
      ringJitter: 0.6,
      y: 0.4,
      yJitter: 1.6,
      rise: [0.8, 2],
      size: [0.13, 0.26],
      sizeEnd: 0.3,
      life: [0.6, 1.1],
      color: 0xfff4dc,
      intensity: 1.7,
      intensityEnd: 0,
      drag: 1.2,
    },
    // — residue: two runes still orbiting after the bloom has gone. This is the
    //   buff's only presence once the cast is over, so it is the layer that has
    //   to last.
    {
      count: 4,
      layer: SPRITE.rune,
      at: 0.7,
      ring: 0.55,
      ringJitter: 0.3,
      y: 0.9,
      yJitter: 0.8,
      rise: [0.1, 0.6],
      swirl: [1.0, 1.8],
      size: [0.3, 0.5],
      sizeEnd: 1.2,
      life: [1.3, 2.1],
      color: 0xffd98a,
      intensity: 0.7,
      intensityEnd: 0,
      spin: [-0.9, 0.9],
      fadeIn: 0.3,
      decay: 0.85,
    },
  ],
};

/**
 * The holy detonation — the Bulwark's ultimate, and the Vesper's. The one effect
 * allowed to own the frame for a moment, but it owns it through *shape*: gather,
 * flash, shock, column, embers, scorch.
 *
 * The 0.14 s wind-up is the most valuable fourteen hundredths in this file. A
 * ring closing on the caster while motes are pulled off the ground into him is
 * the entire difference between "an ultimate went off" and "he did that". It
 * also gives the release something to be released *from*: the flash reads as
 * three times brighter than it measures, because the eye spent the previous
 * eight frames adapting to a dim gather.
 *
 * The glow pool under it stays deliberately weak. A big additive disc is how the
 * first pass turned this spell into a white hole, and the frame's new highlight
 * headroom (see render/lighting.ts — the grade no longer clips at the top) is
 * there to be spent on the thin things, not on an area.
 */
EFFECTS['impact.nova'] = {
  ground: [
    // — anticipation, 0 → 0.14 s
    gatherRing(0xffe9b0, 0.14, 1.1),
    {
      shape: GSHAPE.glow,
      color: 0xffdc90,
      intensity: 0.55,
      life: 0.14,
      size: 0.34,
      alpha: (t) => 0.08 + 0.6 * t * t,
      p0: 3.2,
    },
    {
      // The spokes fade up under the gather so the burst has a skeleton before
      // it has a body.
      shape: GSHAPE.starburst,
      color: 0xffd88a,
      intensity: 0.8,
      life: 0.14,
      size: 0.28,
      alpha: (t) => 0.5 * t * t,
      p0: 16,
      p1: 6,
      p2: 0.2,
      spin: 2.2,
    },
    // — impact, 0.14 s. Short, hot, and thin.
    flashRing(0xfff6de, 0.22, 1.8, 0.14),
    {
      shape: GSHAPE.glow,
      color: 0xfff0c4,
      intensity: 0.5,
      life: 0.32,
      at: 0.14,
      size: 0.4,
      alpha: pop(0.06, 2.6, 0.34),
      p0: 4.0,
    },
    // Smooth, deliberately. The `shock` dialect breaks a band into radial
    // streaks and is right for the slam, but at thirteen metres its streak
    // frequency beats against the starburst's spokes and the ultimate comes out
    // as a machined cog. What keeps this ring from reading as drawn is the
    // debris crossing it and the second wave behind it, not a texture.
    { ...shockRing(0xffe9a8, 0.9, 1.05), at: 0.14 },
    { ...shockRing(0xffc45e, 1.1, 0.8, 0.16), p1: ringBand(0.13), at: 0.14 },
    {
      // Small and faint. The spokes are a *core*, not the effect: blown up to
      // half the blast radius at full alpha they fill the middle with an even
      // glowing disc, which is the frame where everything glows and nothing
      // reads. Contrast between the quiet centre and the hot ring is the whole
      // trick.
      shape: GSHAPE.starburst,
      color: 0xffd88a,
      intensity: 1.0,
      life: 0.75,
      at: 0.14,
      size: 0.34,
      alpha: pop(0.08, 1.8, 0.28),
      p0: 11,
      p1: 4,
      p2: 0.3,
      spin: 0.7,
    },
    // A second, slower ring arriving a beat late. One ring is an event; two at
    // different speeds is a blast wave with something behind it.
    {
      ...shockRing(0xffdca0, 1.3, 0.62, 0),
      at: 0.3,
      alpha: pop(0.2, 1.4, 0.34),
      p1: ringBand(0.1),
    },
  ],
  bursts: [
    // — anticipation
    gatherMotes(0xffe6b4, 18, 0.14),
    // — impact
    {
      count: 16,
      layer: SPRITE.streak,
      at: 0.14,
      ring: 0.1,
      ringJitter: 0.25,
      y: 0.2,
      speed: [1, 4],
      rise: [10, 20],
      size: [0.5, 1.05],
      sizeEnd: 0.45,
      life: [0.6, 1.1],
      color: 0xfff0c0,
      colorEnd: 0xff9b30,
      intensity: 1.55,
      intensityEnd: 0.08,
      drag: 1.1,
      stretch: 1.6,
      decay: 1.5,
    },
    {
      // Debris has to *outrun* the ring for a moment and then fall behind it.
      // Thrown short it stays inside the shock and reads as sparkle at the
      // centre; this is what puts pieces of the world in the air.
      count: 24,
      layer: SPRITE.ember,
      at: 0.14,
      ring: 0.25,
      ringJitter: 0.5,
      y: 0.4,
      speed: [11, 26],
      rise: [5, 13],
      size: [0.2, 0.42],
      sizeEnd: 0.55,
      life: [0.8, 1.5],
      color: 0xffd07a,
      colorEnd: 0x8a3410,
      intensity: 1.6,
      intensityEnd: 0.16,
      gravity: -13,
      drag: 0.3,
      stretch: 0.9,
      decay: 1.3,
    },
    dustPuffs(0xa2937f, 16, 0.14),
    coreFlash(0xfff4d2, 1.5, 0.2, 1.9, 0.14),
    // — residue
    smoulder(0xaa9e8a, 8, 0.4),
    motes(0xffd89a, 14, 0.5),
  ],
  residue: [
    { layer: DECAL.scorch, color: 0xffffff, size: 0.5, life: 9, alpha: 0.78, at: 0.14 },
  ],
  shake: [{ intensity: 0.55, duration: 0.32, at: 0.14 }],
};

/**
 * The ground reacting to a meteor that has not landed yet.
 *
 * Fired by the projectile itself, three quarters of the way down (see
 * `herald` / `heraldAt` on ProjectileSpec), which is the only place the
 * anticipation for this spell could live: `impact.meteor` plays on the frame
 * the rock arrives, so by then there is nothing left to anticipate.
 *
 * It is heat arriving ahead of mass — the circle already burning under the
 * shadow — and it must stay under the bloom threshold everywhere, because the
 * frame immediately after it belongs to the impact.
 */
EFFECTS['meteor.herald'] = {
  ground: [
    // Pale hot, not orange. The herald fires *inside* the ability's own red
    // telegraph, and an orange ring on a red disc is a ring nobody sees — the
    // one job of this layer is to be the thing that changed. Value separation
    // carries it where hue cannot, which is the same reason the hostiles' red
    // does not swallow the impact beat.
    { ...gatherRing(0xffe8c4, 0.34, 1.05), p1: (t) => 0.02 + 0.08 * t },
    {
      shape: GSHAPE.glow,
      color: 0xff6a22,
      intensity: 0.6,
      life: 0.34,
      size: (t) => 0.2 + 0.5 * t * t,
      alpha: (t) => 0.06 + 0.5 * t * t,
      p0: 2.6,
    },
  ],
  bursts: [
    // Embers lifting off ground that is already too hot, drawn up into the path
    // of the thing coming down.
    {
      count: 14,
      layer: SPRITE.ember,
      ring: 0.85,
      ringJitter: 0.6,
      y: 0.1,
      yJitter: 0.5,
      converge: true,
      rise: [2.5, 6],
      life: [0.3, 0.34],
      size: [0.2, 0.42],
      sizeEnd: 0.5,
      color: 0xffb060,
      colorEnd: 0xff6a20,
      intensity: 1.0,
      intensityEnd: 1.7,
      fadeIn: 0.25,
      decay: 0.8,
      stretch: 1.1,
    },
    {
      count: 6,
      layer: SPRITE.smoke,
      blend: BLEND_SOFT,
      ring: 0.45,
      ringJitter: 0.6,
      y: 0.4,
      yJitter: 0.8,
      speed: [0.3, 1.2],
      rise: [2.0, 4.2],
      size: [1.2, 2.4],
      sizeEnd: 2.4,
      life: [0.5, 0.85],
      color: 0x9c8874,
      intensity: 1.0,
      intensityEnd: 0.6,
      drag: 1.4,
      alpha: 0.5,
      fadeIn: 0.15,
      decay: 1,
    },
  ],
};

/**
 * Meteor impact — fire, not light. Where the holy nova is a clean golden shock,
 * this is orange heat, a column of flame, embers thrown wide, a dark smoke skirt
 * and a scorch that stays long after, marking ground that is still burning.
 *
 * Nothing here waits for a wind-up: the rock is the wind-up, and it has been
 * falling for 1.2 s. What the beats do instead is *cascade* — the white core at
 * 0, the shock at 0.03, the second shock at 0.2 — so the flash reads as the
 * cause of the wave rather than as its twin. Three frames is enough for that.
 */
EFFECTS['impact.meteor'] = {
  ground: [
    flashRing(0xfff0d2, 0.24, 1.9),
    {
      shape: GSHAPE.glow,
      color: 0xff7a2e,
      intensity: 0.6,
      life: 0.55,
      size: 0.45,
      alpha: pop(0.05, 2.4, 0.45),
      p0: 3.6,
    },
    { ...shockRing(0xffb070, 1.0, 1.1), at: 0.03 },
    { ...shockRing(0xff5a1e, 1.25, 0.9, 0.18), p1: ringBand(0.16), at: 0.03 },
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
    // The late ring: the fire front, slower and lower than the shock, arriving
    // once the white has already gone.
    {
      ...shockRing(0xff7b24, 1.5, 0.66),
      at: 0.2,
      alpha: pop(0.22, 1.3, 0.38),
      p1: ringBand(0.12),
    },
  ],
  bursts: [
    {
      // A cone of fire, not a pencil of it. Spawning the whole column inside a
      // metre of the centre made the biggest spell in the game read as a
      // firework; opening the base to the width of the crater is what turns it
      // into something erupting out of a hole.
      count: 22,
      layer: SPRITE.streak,
      ring: 0.3,
      ringJitter: 0.55,
      y: 0.2,
      speed: [2, 9],
      rise: [12, 26],
      size: [0.65, 1.4],
      sizeEnd: 0.45,
      life: [0.7, 1.25],
      color: 0xffd08a,
      colorEnd: 0xff4a12,
      intensity: 1.5,
      intensityEnd: 0.06,
      drag: 1.0,
      stretch: 1.8,
      decay: 1.5,
    },
    {
      count: 36,
      layer: SPRITE.ember,
      ring: 0.25,
      ringJitter: 0.6,
      y: 0.4,
      speed: [8, 20],
      rise: [5, 13],
      size: [0.18, 0.42],
      sizeEnd: 0.55,
      life: [0.9, 1.7],
      color: 0xffc070,
      colorEnd: 0x7a2208,
      intensity: 1.6,
      intensityEnd: 0.14,
      gravity: -12,
      drag: 0.35,
      stretch: 0.8,
      decay: 1.3,
    },
    dustPuffs(0x6e5a48, 26),
    coreFlash(0xffe6c2, 1.9, 0.26, 1.9),
    // — residue. The meteor's whole claim is that this patch of ground is
    //   ruined: heavy smoke rolling out for two and a half seconds, embers
    //   floating off it, and a scorch that is still there half a minute later.
    //   Two smoke passes at different values, because one flat grey cloud is a
    //   sprite and two overlapping ones are weather.
    smoulder(0x8a7a66, 12, 0.3, 1.0),
    smoulder(0x5c5046, 8, 0.72, 1.3),
    motes(0xff9a48, 18, 0.55, [1.3, 2.6]),
    {
      count: 10,
      layer: SPRITE.ember,
      at: 1.0,
      ring: 0.35,
      ringJitter: 0.8,
      y: 0.1,
      yJitter: 0.4,
      speed: [0.2, 1.0],
      rise: [1.2, 3.2],
      size: [0.1, 0.24],
      sizeEnd: 0.4,
      life: [1.0, 1.9],
      color: 0xffa040,
      colorEnd: 0x802010,
      intensity: 1.15,
      intensityEnd: 0,
      drag: 0.9,
      fadeIn: 0.3,
      decay: 0.8,
    },
  ],
  residue: [
    { layer: DECAL.scorch, color: 0xffffff, size: 0.75, life: 14, alpha: 0.9 },
    // A wider, fainter burn outside the crater, arriving a beat later, so the
    // edge of the damage is not a perfect circle drawn in one go.
    { layer: DECAL.scorch, color: 0xa08878, size: 1.05, life: 11, alpha: 0.4, at: 0.22 },
  ],
  shake: [
    { intensity: 0.85, duration: 0.5 },
    // The ground settling. A single shake is a bump; a bump with an aftershock
    // is mass.
    { intensity: 0.22, duration: 0.5, at: 0.34 },
  ],
};

/**
 * A bolt leaving the caster's hands.
 *
 * Fired at the launch point by the projectile system, and it stays there while
 * the shot goes — which is the point. Without it a ranged attack has no author:
 * the bolt materialises a metre in front of the caster and the animation and the
 * spell never visibly connect. Four particles and a flare, because this plays on
 * every single auto-attack.
 */
EFFECTS['muzzle.arcane'] = {
  bursts: [
    {
      count: 1,
      layer: SPRITE.flare,
      y: 1.15,
      size: [0.75, 0.75],
      sizeEnd: 1.6,
      life: [0.11, 0.11],
      color: 0xffb0f0,
      intensity: 1.6,
      intensityEnd: 0,
      fadeIn: 0.1,
    },
    {
      count: 4,
      layer: SPRITE.spark,
      ring: 0.1,
      y: 1.1,
      yJitter: 0.3,
      speed: [1.5, 4],
      rise: [0.5, 2.5],
      size: [0.1, 0.2],
      sizeEnd: 0.3,
      life: [0.12, 0.22],
      color: 0xffc8f8,
      intensity: 1.5,
      intensityEnd: 0,
      drag: 3,
    },
  ],
};

EFFECTS['muzzle.holy'] = {
  bursts: [
    {
      count: 1,
      layer: SPRITE.flare,
      y: 1.15,
      size: [0.7, 0.7],
      sizeEnd: 1.6,
      life: [0.11, 0.11],
      color: 0xffdca0,
      intensity: 1.6,
      intensityEnd: 0,
      fadeIn: 0.1,
    },
    {
      count: 4,
      layer: SPRITE.spark,
      ring: 0.1,
      y: 1.1,
      yJitter: 0.3,
      speed: [1.5, 4],
      rise: [1, 3],
      size: [0.1, 0.2],
      sizeEnd: 0.3,
      life: [0.12, 0.22],
      color: 0xfff0cc,
      intensity: 1.5,
      intensityEnd: 0,
      drag: 3,
    },
  ],
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

/**
 * The Oracle's seal detonating. Arcane means a spiral, not a ring —
 * counter-rotation, hard shards instead of soft sparks, and a sigil that stays
 * burned into the ground afterwards.
 *
 * Gameplay already gives this one 0.6 s of purple telegraph before it fires, so
 * the 0.11 s here is not the anticipation — it is the *snap* just before the
 * detonation, the seal tightening. Two stages of wind-up on the same spell is
 * what makes it feel like a trap closing rather than a bomb going off.
 */
EFFECTS['bolt.arcane'] = {
  ground: [
    // — anticipation, 0 → 0.11 s
    gatherRing(0xe08cff, 0.11, 1.05),
    // — impact, 0.11 s
    flashRing(0xffd8fb, 0.18, 1.7, 0.11),
    {
      shape: GSHAPE.spiral,
      color: 0xff7fe0,
      intensity: 1.05,
      life: 0.6,
      at: 0.11,
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
      at: 0.11,
      size: 1.6,
      alpha: pop(0.1, 1.8, 0.6),
      p0: out(0.2, 0.95),
      p1: ringBand(0.16),
      p2: 1,
    },
  ],
  bursts: [
    // — anticipation: shards drawn in and stood on end over the seal.
    gatherMotes(0xffa8f4, 10, 0.11, 0, SPRITE.shard),
    // — impact
    {
      count: 12,
      layer: SPRITE.shard,
      at: 0.11,
      ring: 0.2,
      ringJitter: 0.4,
      y: 0.6,
      yJitter: 0.8,
      speed: [3, 9],
      rise: [1.5, 4.5],
      size: [0.26, 0.54],
      sizeEnd: 0.32,
      life: [0.45, 0.8],
      color: 0xff9cf0,
      colorEnd: 0x8a3bd0,
      intensity: 1.5,
      intensityEnd: 0.1,
      drag: 3.2,
      spin: [-3, 3],
      decay: 1.4,
    },
    {
      count: 6,
      layer: SPRITE.rune,
      at: 0.11,
      ring: 0.5,
      ringJitter: 0.5,
      y: 0.9,
      yJitter: 0.9,
      rise: [1.5, 3],
      swirl: [2, 3.5],
      size: [0.38, 0.66],
      life: [0.55, 0.95],
      color: 0xffb0f0,
      intensity: 1.05,
      intensityEnd: 0,
      spin: [-2, 2],
      decay: 1.2,
    },
    coreFlash(0xffd6f7, 1.1, 0.14, 1.9, 0.11),
    // — residue: arcane leaves motes, not smoke. Nothing burned here.
    motes(0xf0a0ff, 10, 0.38, [0.9, 1.8]),
  ],
  residue: { layer: DECAL.sigil, color: 0xff9ce8, size: 1.15, life: 2.6, alpha: 0.3, at: 0.11 },
  shake: [{ intensity: 0.26, duration: 0.18, at: 0.11 }],
};

/**
 * The Oracle's frost storm. Crystalline: hard-edged shards, a slow mist, and a
 * patch that stays frozen long after the cast — the residue is half the identity
 * here, and it is the only school whose wind-up is *cold* rather than bright.
 *
 * This one can afford a long anticipation — 0.2 s — because the storm it starts
 * runs for three seconds afterwards; there is no damage number waiting on the
 * flash. The wind-up is the air being pulled in and freezing on the way: mist
 * converging, the ground dimming to blue, the ring closing.
 */
EFFECTS['aura.frost'] = {
  ground: [
    // — anticipation, 0 → 0.2 s
    { ...gatherRing(0x8fe0ff, 0.2, 0.95), p1: (t) => 0.016 + 0.045 * t },
    {
      // Cold settling on the ground ahead of the front. Alpha-blended, because
      // cold darkens; an additive blue wash would read as the spell already
      // having gone off.
      shape: GSHAPE.glow,
      color: 0x27506e,
      intensity: 1.0,
      life: 0.2,
      size: (t) => 0.4 + 0.55 * t,
      alpha: (t) => 0.42 * t * t,
      p0: 1.8,
      soft: true,
      decalLayer: DECAL.grain,
    },
    // — impact, 0.2 s
    flashRing(0xeafaff, 0.2, 1.55, 0.2),
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
      at: 0.2,
      alpha: pop(0.12, 1.3, 0.55),
      p0: out(0.05, 0.95),
      p1: ringBand(0.2),
      p2: lin(0.5, 1),
    },
    {
      // A pale wash of hoarfrost on the ground, not a light source. Held well
      // down so the crystalline front stays the thing the eye reads: at full
      // strength this disc simply painted over the facets it exists to sit
      // behind.
      shape: GSHAPE.starburst,
      color: 0xd6f2ff,
      intensity: 0.95,
      life: 1.1,
      at: 0.2,
      size: 0.85,
      alpha: pop(0.2, 1.2, 0.34),
      p0: 22,
      p1: 9,
      p2: 0.22,
      spin: 0.18,
      soft: true,
    },
    // A second crystal front, slower and wider, still growing after the first
    // has died. The storm is three seconds long; the ground has to keep moving.
    {
      shape: GSHAPE.crystal,
      color: 0x49b4f0,
      intensity: 0.7,
      life: 1.5,
      at: 0.44,
      alpha: pop(0.25, 1.2, 0.34),
      p0: out(0.2, 1.0, 1.5),
      p1: ringBand(0.14),
      p2: lin(0.8, 1),
    },
  ],
  bursts: [
    // — anticipation: mist and frozen air drawn in over 0.2 s.
    {
      count: 9,
      layer: SPRITE.smoke,
      blend: BLEND_SOFT,
      ring: 0.95,
      ringJitter: 0.4,
      y: 0.1,
      yJitter: 0.5,
      converge: true,
      life: [0.2, 0.23],
      size: [0.9, 1.8],
      sizeEnd: 0.7,
      color: 0xbcdcf0,
      intensity: 0.5,
      intensityEnd: 0.75,
      alpha: 0.45,
      fadeIn: 0.3,
      decay: 0.7,
    },
    gatherMotes(0xcdeeff, 12, 0.2, 0, SPRITE.shard),
    // — impact, 0.2 s
    {
      count: 18,
      layer: SPRITE.shard,
      at: 0.2,
      ring: 0.35,
      ringJitter: 0.7,
      y: 0.1,
      yJitter: 0.5,
      speed: [2, 7],
      rise: [3, 7],
      size: [0.3, 0.64],
      sizeEnd: 0.9,
      life: [0.75, 1.3],
      color: 0xd8f2ff,
      colorEnd: 0x4f9fd8,
      intensity: 1.4,
      intensityEnd: 0.18,
      gravity: -9,
      drag: 0.9,
      spin: [-1.4, 1.4],
      decay: 1.3,
    },
    {
      count: 10,
      layer: SPRITE.smoke,
      blend: BLEND_SOFT,
      at: 0.2,
      ring: 0.55,
      ringJitter: 0.5,
      y: 0.1,
      yJitter: 0.35,
      speed: [1.2, 3.4],
      rise: [0.2, 0.8],
      size: [1.4, 2.8],
      sizeEnd: 2.0,
      life: [1.1, 1.9],
      color: 0xc9e8ff,
      colorEnd: 0x9dc4e0,
      intensity: 0.62,
      intensityEnd: 0.32,
      drag: 1.6,
      alpha: 0.45,
      fadeIn: 0.22,
      spin: [-0.4, 0.4],
      decay: 0.9,
    },
    {
      count: 12,
      layer: SPRITE.spark,
      at: 0.2,
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
    // — residue: the storm keeps breathing. Mist rolling low across the patch
    //   and ice crystals catching light for a second and a half.
    {
      count: 8,
      layer: SPRITE.smoke,
      blend: BLEND_SOFT,
      at: 0.8,
      ring: 0.7,
      ringJitter: 0.9,
      y: 0.05,
      yJitter: 0.4,
      speed: [0.4, 1.8],
      rise: [0.1, 0.5],
      size: [1.6, 3.0],
      sizeEnd: 1.9,
      life: [1.4, 2.4],
      color: 0xbcd8ec,
      colorEnd: 0x8fb4cc,
      intensity: 0.5,
      intensityEnd: 0.28,
      drag: 1.3,
      alpha: 0.4,
      fadeIn: 0.25,
      spin: [-0.3, 0.3],
      decay: 0.85,
    },
    motes(0xd8f4ff, 12, 0.75, [1.2, 2.2]),
  ],
  residue: { layer: DECAL.frost, color: 0xb6e2ff, size: 0.8, life: 7.5, alpha: 0.44, at: 0.2 },
};

/**
 * The boss changing phase, and the Núcleo going down.
 *
 * Both sites emit `vfx:request` with the id `impact` (see gameplay/combat.ts and
 * world/structures.ts) — and until now there was no spec under that name, so the
 * single loudest moment in a match resolved to a camera shake over an empty
 * frame. This is that missing effect.
 *
 * It is the only one in the table built out of *two* colours fighting: bone
 * white for the mass, and a sick green for whatever is animating it. The wind-up
 * is 0.16 s, the longest of any instant effect here, because nothing is waiting
 * on it — the phase has already changed and the announcement is on screen, so
 * this is allowed to be theatre.
 */
EFFECTS['impact'] = {
  ground: [
    // — anticipation, 0 → 0.16 s: the ground goes dark and pulls in, then a
    //   sick green ring closes on the titan.
    {
      shape: GSHAPE.glow,
      color: 0x120f14,
      intensity: 1.0,
      life: 0.16,
      size: (t) => 1.4 + 0.9 * t,
      alpha: (t) => 0.62 * t,
      p0: 1.5,
      soft: true,
      decalLayer: DECAL.grain,
    },
    { ...gatherRing(0x9cff9a, 0.16, 1.0), size: 2.4 },
    // — impact, 0.16 s
    { ...flashRing(0xf6ffe8, 0.22, 1.85, 0.16), size: 2.4 },
    {
      shape: GSHAPE.shock,
      color: 0xe8e0c0,
      intensity: 1.0,
      life: 0.85,
      at: 0.16,
      size: 2.6,
      alpha: pop(0.1, 1.5, 0.6),
      p0: out(0.05, 0.95),
      p1: ringBand(0.24, 0.035),
      p2: out(1, 0.3),
    },
    {
      shape: GSHAPE.crystal,
      color: 0x6cd870,
      intensity: 0.85,
      life: 1.1,
      at: 0.24,
      size: 2.2,
      alpha: pop(0.16, 1.3, 0.45),
      p0: out(0.1, 0.98),
      p1: ringBand(0.18),
      p2: lin(0.6, 1),
    },
    {
      shape: GSHAPE.starburst,
      color: 0xbcffb0,
      intensity: 0.85,
      life: 0.9,
      at: 0.16,
      size: 1.1,
      alpha: pop(0.08, 1.8, 0.4),
      p0: 9,
      p1: 3,
      p2: 0.34,
      spin: -0.5,
    },
  ],
  bursts: [
    // — anticipation: marrow-light drawn up out of the ground.
    gatherMotes(0x9cff9a, 16, 0.16),
    // — impact: bone thrown outward on real gravity, and a dark skirt.
    coreFlash(0xeaffd8, 2.6, 0.22, 1.9, 0.16),
    {
      count: 22,
      layer: SPRITE.shard,
      at: 0.16,
      ring: 0.4,
      ringJitter: 0.7,
      y: 0.5,
      yJitter: 0.8,
      speed: [7, 18],
      rise: [5, 13],
      size: [0.34, 0.8],
      sizeEnd: 0.8,
      life: [0.9, 1.6],
      color: 0xf0e8cc,
      colorEnd: 0x6b6450,
      intensity: 1.35,
      intensityEnd: 0.2,
      gravity: -13,
      drag: 0.4,
      spin: [-3, 3],
      decay: 1.3,
    },
    {
      count: 14,
      layer: SPRITE.streak,
      at: 0.16,
      ring: 0.15,
      ringJitter: 0.3,
      y: 0.3,
      speed: [1, 4],
      rise: [9, 18],
      size: [0.5, 1.1],
      sizeEnd: 0.5,
      life: [0.6, 1.1],
      color: 0xd8ffc0,
      colorEnd: 0x2f7a3a,
      intensity: 1.45,
      intensityEnd: 0.08,
      drag: 1.2,
      stretch: 1.6,
      decay: 1.4,
    },
    dustPuffs(0x5c5a4c, 22, 0.16),
    // — residue: the green keeps burning after the bone has landed.
    smoulder(0x6f7a68, 10, 0.45, 1.1),
    motes(0x9cff9a, 16, 0.6, [1.4, 2.8]),
  ],
  residue: [
    { layer: DECAL.scorch, color: 0xcfe8b0, size: 1.5, life: 12, alpha: 0.72, at: 0.16 },
    { layer: DECAL.sigil, color: 0x9cff9a, size: 2.1, life: 4, alpha: 0.2, at: 0.16 },
  ],
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

// A crit is the one piece of hit feedback allowed a ring, so it gets the thin
// bright one too. It fires often enough that this is the whole budget: no
// gather, no residue, one extra ground instance.
EFFECTS['hit.crit'] = {
  ground: [
    { ...flashRing(0xfff2d4, 0.15, 1.6), size: 1.3 },
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
      life: [0.28, 0.5],
      color: 0xfff0c8,
      colorEnd: 0xff7020,
      intensity: 1.9,
      intensityEnd: 0.08,
      gravity: -14,
      stretch: 0.9,
      decay: 1.4,
    },
    coreFlash(0xffe6bc, 0.9, 0.12, 1.9),
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
  /**
   * A second, larger, dimmer sprite drawn behind the head.
   *
   * This is what gives a projectile a *silhouette* instead of a glow. A single
   * additive billboard has no edge — it is brightest in the middle and fades to
   * nothing, so it reads as a light rather than as a thing. A hot core inside a
   * cooler envelope has a boundary the eye can find, and with the head's
   * velocity stretch on top of it the shape acquires a leading edge and a
   * direction. Costs one quad per shot per frame.
   */
  halo?: { size: number; color: number; intensity: number; layer?: number; stretch?: number };
  /** Effect id fired at the launch point the moment the shot leaves. */
  muzzle?: string;
  /**
   * Effect fired at the *landing* point while the shot is still in the air, at
   * `heraldAt` (0..1) of the flight. The anticipation for anything with a long
   * enough flight to have one.
   */
  herald?: string;
  heraldAt?: number;
}

export const PROJECTILES: Record<string, ProjectileSpec> = {
  // Meteor: the only projectile that falls rather than flies. Big, slow enough
  // to be read as a warning, and trailing smoke the whole way down so the eye
  // follows it to the circle already burning on the ground.
  'shot.meteor': {
    layer: SPRITE.flare,
    color: 0xffe0a8,
    colorTrail: 0xff6a20,
    intensity: 1.9,
    size: 1.9,
    stretch: 1.4,
    speed: 34,
    arc: 0,
    trailStep: 0.18,
    trailLife: [0.55, 1.1],
    trailSize: [1.0, 2.2],
    trailJitter: 0.26,
    trailLayer: SPRITE.smoke,
    impact: 'impact.meteor',
    spin: 2.2,
    // The rock: a dark-orange mass around the white-hot leading edge. Without
    // it the meteor is a bright dot with a smoke tail, which reads as a flare
    // rather than as something with weight coming down.
    halo: { size: 3.6, color: 0xff5a18, intensity: 0.95, layer: SPRITE.smoke, stretch: 0.8 },
    herald: 'meteor.herald',
    heraldAt: 0.74,
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
    muzzle: 'muzzle.arcane',
    halo: { size: 1.7, color: 0x8a30c8, intensity: 0.8, layer: SPRITE.smoke, stretch: 0.5 },
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
    muzzle: 'muzzle.holy',
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

/**
 * An arrow arriving. Fired by the Talon's pierce shot and, eight times over, by
 * her ultimate's volley.
 *
 * The anticipation here is the arrow itself: a pair of hard, stretched shafts
 * dropping into the point over the 0.06 s *before* the sparks, so the eye is
 * already on the spot when it lights up. Half a dozen frames of lead is all it
 * takes to turn the volley from sparks appearing on the ground into a rain of
 * arrows landing — and it costs two particles.
 */
EFFECTS['hit.pierce'] = {
  bursts: [
    {
      count: 2,
      layer: SPRITE.streak,
      ring: 0.25,
      ringJitter: 0.5,
      y: 3.4,
      yJitter: 0.6,
      rise: [-30, -26],
      size: [0.3, 0.46],
      sizeEnd: 0.5,
      life: [0.08, 0.1],
      color: 0xfff4d8,
      colorEnd: 0xd8b070,
      intensity: 1.5,
      intensityEnd: 0.5,
      stretch: 3.2,
      fadeIn: 0.12,
      decay: 1,
    },
    {
      count: 6,
      layer: SPRITE.spark,
      at: 0.06,
      ring: 0.08,
      y: 1.05,
      yJitter: 0.35,
      speed: [4, 9],
      rise: [1, 3.5],
      size: [0.1, 0.2],
      sizeEnd: 0.28,
      life: [0.16, 0.3],
      color: 0xfff0cf,
      colorEnd: 0xd8a34a,
      intensity: 1.6,
      intensityEnd: 0.06,
      gravity: -10,
      stretch: 1.3,
    },
    {
      count: 3,
      layer: SPRITE.dust,
      blend: BLEND_SOFT,
      at: 0.06,
      ring: 0.16,
      y: 0.85,
      yJitter: 0.5,
      speed: [0.8, 2.2],
      size: [0.55, 1.0],
      sizeEnd: 1.9,
      life: [0.34, 0.6],
      color: 0x8d8570,
      intensity: 0.4,
      intensityEnd: 0.18,
      drag: 2.6,
      alpha: 0.32,
      decay: 1,
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
