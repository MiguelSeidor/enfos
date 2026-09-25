/**
 * Sound recipes. Owner: Audio.
 *
 * Each recipe writes one sound into a `Voice` as a short score of layers. Most
 * physical sounds here follow the same anatomy, because that is what the ear
 * uses to judge them: a *transient* (filtered noise, a few milliseconds — the
 * crack that says "contact"), a *body* (a sine dropping in pitch — the weight),
 * and a *tail* (partials or rumble — what it was made of). Change the tail and
 * a sword hit becomes a shield bash.
 *
 * Nearly everything is jittered a little on every play (`vary`, `rand`): a hit
 * heard forty times in a fight must not be forty copies of one waveform.
 *
 * The `gain` trims in `SOUNDS` were set by rendering each recipe offline
 * (OfflineAudioContext, five renders each to average out the jitter) and
 * measuring K-weighted loudness over a 400 ms window — the weighting loudness
 * meters use, which counts a 3 kHz coin as louder than a 60 Hz boom of the same
 * energy, as the ear does. Each sound was then moved to a target for its role:
 * auto-attacks and deaths sit low because they repeat, abilities and alarms sit
 * high because they must cut through. Re-measure after changing a recipe.
 */

import { bell, rand, vary, type Voice } from './synth';

export type Recipe = (v: Voice) => void;

// ── Shared layers ────────────────────────────────────────────────────────────

/** A body hitting the ground. `weight` 0..1, from a skeleton to a titan. */
function bodyFall(v: Voice, at: number, weight: number): void {
  v.tone({ freq: 95 - weight * 35, to: 38, gain: 0.55 + weight * 0.35, dur: 0.16 + weight * 0.3, at });
  v.noise({
    gain: 0.35 + weight * 0.45,
    dur: 0.14 + weight * 0.4,
    at,
    brown: true,
    filter: { type: 'lowpass', freq: 700, to: 110 },
  });
}

/**
 * A voiced grunt: a buzzing sawtooth through vowel formants. Three resonances
 * at roughly the positions of an open "ah" are what turn a synth buzz into
 * something that sounds like it came out of a throat.
 */
function grunt(v: Voice, pitch: number, length: number, gain: number): void {
  const f = vary(pitch, 90);
  const shift = rand(0.9, 1.12);
  for (const [formant, g, q] of [
    [620, 1, 6],
    [1050, 0.6, 7],
    [2450, 0.22, 8],
  ] as const) {
    v.tone({
      type: 'sawtooth',
      freq: f,
      to: f * 0.58,
      gain: gain * g,
      attack: 0.018,
      dur: length,
      vibrato: { rate: rand(18, 26), depth: 35 },
      filter: { type: 'bandpass', freq: formant * shift, q },
    });
  }
  v.noise({ gain: gain * 0.12, attack: 0.01, dur: length * 0.7, filter: { type: 'bandpass', freq: 1300, q: 1.4 } });
}

/** A low, fast-decaying boom with a noise skin. The base of every drum here. */
export function drum(v: Voice, at: number, gain = 1): void {
  v.tone({ freq: vary(112, 40), to: 46, glide: 0.14, gain: 0.95 * gain, dur: 0.5, at });
  v.noise({ gain: 0.32 * gain, dur: 0.12, at, filter: { type: 'lowpass', freq: 2200, to: 220 } });
}

/** A beast's roar: detuned saws growling through a closing lowpass. */
function roar(v: Voice, pitch: number, length: number, gain: number): void {
  for (const detune of [-16, 0, 13]) {
    v.tone({
      type: 'sawtooth',
      freq: pitch,
      to: pitch * 0.55,
      gain: gain * 0.34,
      attack: 0.07,
      hold: length * 0.35,
      dur: length * 0.65,
      detune,
      vibrato: { rate: rand(8, 11), depth: 45 },
      filter: { type: 'lowpass', freq: 1500, to: 240, q: 2.2 },
    });
  }
  v.noise({
    gain: gain * 0.45,
    attack: 0.06,
    hold: length * 0.3,
    dur: length * 0.7,
    filter: { type: 'bandpass', freq: 800, to: 260, q: 1.1 },
  });
}

/** Short high pings with inharmonic overtones: a coin, a chip of crystal. */
function ping(v: Voice, freq: number, at: number, gain: number, dur: number): void {
  v.tone({ freq, gain, dur, at, attack: 0.002 });
  v.tone({ freq: freq * 1.52, gain: gain * 0.55, dur: dur * 0.75, at, attack: 0.002 });
  v.tone({ freq: freq * 2.31, gain: gain * 0.28, dur: dur * 0.5, at, attack: 0.002 });
}

// ── Hero auto-attacks ────────────────────────────────────────────────────────

/** Blade on a body: crack, thump, and a short ring of steel. */
export const bladeHit: Recipe = (v) => {
  v.noise({ gain: 0.75, dur: 0.06, filter: { type: 'bandpass', freq: vary(2300, 250), q: 0.9 } });
  v.noise({ gain: 0.45, dur: 0.12, filter: { type: 'lowpass', freq: 1000, to: 200 } });
  const body = vary(160, 140);
  v.tone({ freq: body, to: body * 0.38, gain: 0.85, dur: 0.14 });
  const ring = vary(1350, 180);
  v.tone({ freq: ring, gain: 0.09, dur: 0.18, at: 0.003 });
  v.tone({ freq: ring * 1.47, gain: 0.06, dur: 0.12, at: 0.003 });
  v.tone({ freq: ring * 2.09, gain: 0.035, dur: 0.08, at: 0.003 });
};

/** The same blow landed with everything behind it. */
export const bladeCrit: Recipe = (v) => {
  bladeHit(v);
  v.tone({ freq: 100, to: 36, gain: 0.95, dur: 0.34 });
  v.noise({ gain: 0.55, dur: 0.28, filter: { type: 'lowpass', freq: 1600, to: 150 } });
  const ting = vary(2900, 90);
  v.tone({ freq: ting, gain: 0.11, dur: 0.4, at: 0.012 });
  v.tone({ freq: ting * 1.34, gain: 0.07, dur: 0.28, at: 0.012 });
};

/** An arcane bolt: a falling zap, a hiss, and a soft pop where it lands. */
export const arcaneShot: Recipe = (v) => {
  const f = vary(1150, 120);
  v.tone({ type: 'triangle', freq: f, to: f * 0.33, gain: 0.4, dur: 0.17 });
  v.tone({ freq: f * 2.01, to: f * 0.7, gain: 0.12, dur: 0.12 });
  v.noise({ gain: 0.2, dur: 0.12, filter: { type: 'highpass', freq: 4200 } });
  v.tone({ freq: 330, to: 120, gain: 0.4, dur: 0.1, at: 0.07 });
  v.noise({ gain: 0.2, dur: 0.08, at: 0.07, filter: { type: 'bandpass', freq: 1300, q: 1.2 } });
};

export const arcaneCrit: Recipe = (v) => {
  arcaneShot(v);
  v.tone({ freq: 140, to: 45, gain: 0.8, dur: 0.3, at: 0.07 });
  for (let i = 0; i < 5; i++) v.tone({ freq: rand(2600, 5200), gain: 0.05, dur: rand(0.12, 0.3), at: 0.07 + rand(0, 0.08) });
};

/** A swing through empty air. */
export const whoosh: Recipe = (v) => {
  v.noise({ gain: 0.7, attack: 0.05, dur: 0.17, filter: { type: 'bandpass', freq: 420, to: 2600, q: 1.6 } });
};

/** The player's hero taking a blow: duller and lower than giving one. */
export const hurt: Recipe = (v) => {
  v.noise({ gain: 0.6, dur: 0.09, filter: { type: 'lowpass', freq: 1200, to: 300 } });
  const f = vary(125, 110);
  v.tone({ freq: f, to: f * 0.5, gain: 0.7, dur: 0.13 });
  // Mail rattling on impact.
  v.noise({ gain: 0.12, dur: 0.05, at: 0.012, filter: { type: 'bandpass', freq: 5200, q: 2 } });
};

// ── Deaths ───────────────────────────────────────────────────────────────────

export const deathSmall: Recipe = (v) => {
  grunt(v, 190, 0.24, 0.9);
  bodyFall(v, 0.15, 0.35);
};

/** Quick, light creatures: higher, shorter. */
export const deathLight: Recipe = (v) => {
  grunt(v, 290, 0.17, 0.8);
  bodyFall(v, 0.1, 0.2);
};

export const deathHeavy: Recipe = (v) => {
  grunt(v, 95, 0.4, 1);
  bodyFall(v, 0.22, 1);
  v.noise({ gain: 0.25, dur: 0.45, at: 0.24, filter: { type: 'lowpass', freq: 1400, to: 300 } });
};

/** A skeleton coming apart: a clatter of small, dry, woody knocks. */
export const deathBones: Recipe = (v) => {
  let t = 0;
  for (let i = 0; i < 8; i++) {
    v.noise({ gain: rand(0.3, 0.6), dur: rand(0.012, 0.03), at: t, filter: { type: 'bandpass', freq: rand(1600, 3600), q: 4 } });
    v.tone({ type: 'triangle', freq: rand(450, 950), gain: 0.14, dur: 0.035, at: t });
    t += rand(0.02, 0.065);
  }
  bodyFall(v, 0.04, 0.05);
};

/** A wraith: a falling, wavering cry that dissolves into breath. */
export const deathWraith: Recipe = (v) => {
  const f = vary(900, 120);
  v.tone({ freq: f, to: f * 0.3, gain: 0.32, attack: 0.04, dur: 0.8, vibrato: { rate: 7, depth: 45 } });
  v.tone({ freq: f * 1.5, to: f * 0.42, gain: 0.13, attack: 0.06, dur: 0.65, detune: 14, vibrato: { rate: 5.3, depth: 60 } });
  v.noise({ gain: 0.3, attack: 0.05, dur: 0.65, filter: { type: 'bandpass', freq: 2600, to: 450, q: 1.2 } });
};

/** The boss falls: a last roar, the ground taking the weight, rubble settling. */
export const deathTitan: Recipe = (v) => {
  roar(v, 82, 1.3, 1);
  v.tone({ freq: 70, to: 24, gain: 1, dur: 1.4, at: 0.75 });
  v.noise({ gain: 0.8, dur: 1.6, at: 0.75, brown: true, filter: { type: 'lowpass', freq: 900, to: 60 } });
  v.noise({ gain: 0.3, dur: 1.2, at: 0.8, filter: { type: 'lowpass', freq: 2500, to: 250 } });
};

export const heroFall: Recipe = (v) => {
  bodyFall(v, 0.03, 0.8);
  // A minor second between the two tones: grief rather than just "low".
  v.tone({ type: 'triangle', freq: 220, to: 110, gain: 0.26, attack: 0.06, dur: 1.7 });
  v.tone({ type: 'triangle', freq: 233.1, to: 116.5, gain: 0.18, attack: 0.06, dur: 1.7 });
  bell(v, 146.8, 0.12, 0.12, 2.6);
};

export const revive: Recipe = (v) => {
  v.noise({ gain: 0.22, attack: 0.6, dur: 0.5, filter: { type: 'bandpass', freq: 700, to: 5200, q: 1.2 } });
  [261.63, 392, 523.25, 659.25].forEach((f, i) => {
    v.tone({ freq: f, gain: 0.13, attack: 0.5 - i * 0.08, hold: 0.15, dur: 1.1, at: i * 0.08 });
  });
};

// ── Economy ──────────────────────────────────────────────────────────────────

export const coins: Recipe = (v) => {
  let t = 0;
  for (let i = 0; i < 3; i++) {
    ping(v, rand(2500, 3400), t, 0.17, 0.13);
    t += rand(0.045, 0.08);
  }
};

export const purchase: Recipe = (v) => {
  let t = 0;
  for (let i = 0; i < 6; i++) {
    ping(v, rand(2300, 3600), t, 0.14, 0.14);
    t += rand(0.03, 0.055);
  }
  bell(v, 1318.5, t + 0.02, 0.06, 0.7);
};

/** Drinking: a few rising bubbles, then a sparkle as it takes effect. */
export const potion: Recipe = (v) => {
  for (let i = 0; i < 4; i++) {
    const f = rand(380, 640);
    v.tone({ freq: f, to: f * 2.3, glide: 0.05, gain: 0.3, dur: 0.07, at: i * 0.085 + rand(0, 0.02) });
  }
  v.tone({ freq: 1568, gain: 0.07, attack: 0.01, dur: 0.6, at: 0.36 });
  v.tone({ freq: 2093, gain: 0.05, attack: 0.01, dur: 0.5, at: 0.4 });
  v.noise({ gain: 0.05, attack: 0.1, dur: 0.4, at: 0.34, filter: { type: 'highpass', freq: 6000 } });
};

export const levelUp: Recipe = (v) => {
  [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
    v.tone({ type: 'triangle', freq: f, gain: 0.22, dur: 0.95, at: i * 0.075 });
    v.tone({ freq: f * 2, gain: 0.05, dur: 0.5, at: i * 0.075 });
  });
  v.noise({ gain: 0.08, attack: 0.3, dur: 0.8, filter: { type: 'highpass', freq: 6000 } });
};

// ── Abilities ────────────────────────────────────────────────────────────────

/** Bulwark Q — a shield driven into bodies: a huge thump and a thick plate ringing. */
export const shieldBash: Recipe = (v) => {
  v.tone({ freq: 140, to: 44, gain: 1, dur: 0.32 });
  v.noise({ gain: 0.8, dur: 0.1, filter: { type: 'bandpass', freq: 1000, q: 0.8 } });
  v.noise({ gain: 0.5, dur: 0.38, brown: true, filter: { type: 'lowpass', freq: 900, to: 140 } });
  const plate = vary(410, 50);
  for (const [ratio, g, d] of [
    [1, 0.16, 0.65],
    [2.32, 0.1, 0.48],
    [3.87, 0.07, 0.32],
    [5.4, 0.04, 0.2],
  ] as const) {
    v.tone({ freq: plate * ratio, gain: g, dur: d, at: 0.003 });
  }
};

/** Bulwark W — a war cry over a drum: several throats, one shout. */
export const warCry: Recipe = (v) => {
  drum(v, 0, 0.9);
  for (const detune of [-18, 0, 15]) {
    for (const [formant, g, q] of [
      [720, 0.9, 5],
      [1180, 0.55, 6],
      [2600, 0.2, 7],
    ] as const) {
      v.tone({
        type: 'sawtooth',
        freq: 165,
        to: 128,
        gain: g * 0.45,
        attack: 0.05,
        hold: 0.3,
        dur: 0.45,
        detune,
        vibrato: { rate: 5.5, depth: 30 },
        filter: { type: 'bandpass', freq: formant, q },
      });
    }
  }
  v.noise({ gain: 0.14, attack: 0.05, hold: 0.25, dur: 0.4, filter: { type: 'bandpass', freq: 1600, q: 1 } });
};

/** Bulwark E — armour locking into place: a grinding rise, then a clank. */
export const fortify: Recipe = (v) => {
  v.noise({ gain: 0.5, attack: 0.26, dur: 0.18, brown: true, filter: { type: 'bandpass', freq: 220, to: 900, q: 1.5 } });
  v.tone({ type: 'triangle', freq: 210, to: 430, gain: 0.12, attack: 0.28, dur: 0.2 });
  const clank = 0.3;
  v.tone({ freq: 120, to: 55, gain: 0.8, dur: 0.18, at: clank });
  v.noise({ gain: 0.45, dur: 0.05, at: clank, filter: { type: 'bandpass', freq: 2400, q: 1.2 } });
  for (const [ratio, g, d] of [
    [1, 0.12, 0.45],
    [2.71, 0.08, 0.3],
    [4.12, 0.05, 0.2],
  ] as const) {
    v.tone({ freq: 640 * ratio, gain: g, dur: d, at: clank + 0.003 });
  }
};

/** Bulwark R — the shockwave, and the healing that rides behind it. */
export const shockwave: Recipe = (v) => {
  v.tone({ freq: 95, to: 26, gain: 1, dur: 1.15 });
  v.noise({ gain: 0.9, dur: 1.2, filter: { type: 'lowpass', freq: 4200, to: 120, q: 0.6 } });
  v.noise({ gain: 0.55, attack: 0.02, dur: 1.4, brown: true, filter: { type: 'lowpass', freq: 520, to: 60 } });
  [659.25, 830.61, 987.77, 1318.5].forEach((f, i) => {
    v.tone({ freq: f, gain: 0.08, attack: 0.02, dur: 1.2, at: 0.35 + i * 0.06 });
  });
};

/** Oracle W — frost spreading: a cold gust full of tiny cracking crystals. */
export const frost: Recipe = (v) => {
  v.noise({ gain: 0.45, attack: 0.05, dur: 0.75, filter: { type: 'bandpass', freq: 3200, to: 800, q: 1 } });
  for (let i = 0; i < 18; i++) {
    const at = rand(0, 0.65);
    v.noise({ gain: rand(0.12, 0.32), dur: rand(0.008, 0.025), at, filter: { type: 'highpass', freq: 4500 } });
    v.tone({ freq: rand(2200, 4800), gain: rand(0.025, 0.06), dur: rand(0.08, 0.25), at });
  }
  v.tone({ freq: 190, to: 80, gain: 0.35, dur: 0.3 });
};

/** Oracle Q — the bolt: a split-second crack, an electric buzz, thunder behind. */
export const chainLightning: Recipe = (v) => {
  v.noise({ gain: 0.9, dur: 0.05, filter: { type: 'highpass', freq: 1800 } });
  // Micro-crackles: the discharge is not one spark but dozens.
  for (let i = 0; i < 14; i++) {
    v.noise({ gain: rand(0.2, 0.55), dur: rand(0.004, 0.012), at: rand(0, 0.22), filter: { type: 'bandpass', freq: rand(2500, 7000), q: 3 } });
  }
  v.tone({ type: 'square', freq: 118, gain: 0.12, dur: 0.22, vibrato: { rate: 42, depth: 90 }, filter: { type: 'bandpass', freq: 1900, q: 1.3 } });
  v.noise({ gain: 0.5, attack: 0.04, dur: 0.9, at: 0.05, brown: true, filter: { type: 'lowpass', freq: 380, to: 90 } });
};

/** A jump of the chain: the same crack, smaller and alone. */
export const lightningJump: Recipe = (v) => {
  v.noise({ gain: 0.7, dur: 0.04, filter: { type: 'bandpass', freq: vary(3600, 250), q: 1.6 } });
  for (let i = 0; i < 5; i++) {
    v.noise({ gain: rand(0.2, 0.45), dur: 0.008, at: rand(0, 0.08), filter: { type: 'highpass', freq: 3000 } });
  }
  v.tone({ type: 'sawtooth', freq: vary(240, 120), to: 110, gain: 0.08, dur: 0.1, filter: { type: 'lowpass', freq: 2400 } });
};

/** A pulse of the frost storm: a few ice crystals snapping. */
export const iceTick: Recipe = (v) => {
  for (let i = 0; i < 4; i++) {
    const at = rand(0, 0.25);
    v.noise({ gain: rand(0.15, 0.35), dur: rand(0.006, 0.018), at, filter: { type: 'highpass', freq: 5000 } });
    v.tone({ freq: rand(2400, 5200), gain: rand(0.03, 0.06), dur: rand(0.08, 0.2), at });
  }
  v.noise({ gain: 0.12, attack: 0.06, dur: 0.3, filter: { type: 'bandpass', freq: 2600, to: 1200, q: 1 } });
};

/** Oracle E, on cast — the seal drawing itself: a rising, tightening hum. */
export const sealCharge: Recipe = (v) => {
  for (const [f, g] of [
    [330, 0.18],
    [333, 0.14],
    [495, 0.08],
  ] as const) {
    v.tone({ freq: f, to: f * 1.5, glide: 0.6, gain: g, attack: 0.25, hold: 0.3, dur: 0.1, vibrato: { rate: 9, depth: 15 } });
  }
  v.noise({ gain: 0.1, attack: 0.5, dur: 0.1, filter: { type: 'bandpass', freq: 1500, to: 5000, q: 3 } });
};

/** Oracle E, detonation — the seal snaps shut: a thump and a struck arcane bell. */
export const sealBurst: Recipe = (v) => {
  v.tone({ freq: 200, to: 60, gain: 0.9, dur: 0.28 });
  v.noise({ gain: 0.5, dur: 0.16, filter: { type: 'lowpass', freq: 3000, to: 300 } });
  bell(v, 523.25, 0.005, 0.1, 1.1);
  v.tone({ freq: 1568, to: 1100, gain: 0.08, dur: 0.5, at: 0.01, vibrato: { rate: 6, depth: 25 } });
};

/** Oracle R, on cast — the meteor coming: a long descending shriek of air. */
export const meteorFall: Recipe = (v) => {
  v.noise({ gain: 0.5, attack: 0.9, dur: 0.35, filter: { type: 'bandpass', freq: 3800, to: 500, q: 2.2 } });
  v.tone({ freq: 2200, to: 320, gain: 0.13, attack: 0.5, hold: 0.45, dur: 0.3, vibrato: { rate: 11, depth: 35 } });
  v.noise({ gain: 0.3, attack: 1.0, dur: 0.2, brown: true, filter: { type: 'lowpass', freq: 500 } });
};

/** Oracle R, impact — a detonation with fire in it, and rubble raining down. */
export const meteorImpact: Recipe = (v) => {
  v.tone({ freq: 90, to: 24, gain: 1, dur: 1.3 });
  v.noise({ gain: 0.95, dur: 1.4, filter: { type: 'lowpass', freq: 4500, to: 110, q: 0.6 } });
  v.noise({ gain: 0.6, attack: 0.02, dur: 1.8, brown: true, filter: { type: 'lowpass', freq: 600, to: 60 } });
  // Fire: irregular crackle that outlasts the boom.
  for (let i = 0; i < 22; i++) {
    v.noise({ gain: rand(0.1, 0.3), dur: rand(0.005, 0.02), at: 0.15 + rand(0, 1.4), filter: { type: 'bandpass', freq: rand(1500, 4500), q: 2 } });
  }
  for (let i = 0; i < 10; i++) {
    v.noise({ gain: rand(0.15, 0.35), dur: rand(0.03, 0.07), at: 0.3 + rand(0, 1), filter: { type: 'lowpass', freq: rand(800, 1800) } });
  }
};

/** Sabotage sent: a dark rushing sweep and a low struck bell, like a curse leaving. */
export const sabotageCast: Recipe = (v) => {
  v.noise({ gain: 0.45, attack: 0.25, dur: 0.45, filter: { type: 'bandpass', freq: 2400, to: 300, q: 1.4 } });
  bell(v, 138.6, 0.18, 0.18, 1.8);
  v.tone({ type: 'sawtooth', freq: 69.3, gain: 0.08, attack: 0.2, dur: 1.2, at: 0.18, filter: { type: 'lowpass', freq: 400, to: 120 } });
};

/**
 * Sabotage received: a dissonant low horn stab over a drum — unmistakably bad
 * news, and different from the wave horn so it is never mistaken for one.
 */
export const sabotageHit: Recipe = (v) => {
  drum(v, 0, 1);
  for (const [f, detune] of [
    [98, 0],
    [103.8, 6],
    [146.8, -4],
  ] as const) {
    v.tone({
      type: 'sawtooth',
      freq: f * 0.97,
      to: f,
      glide: 0.12,
      gain: 0.22,
      attack: 0.06,
      hold: 0.35,
      dur: 0.6,
      detune,
      at: 0.04,
      filter: { type: 'lowpass', freq: 1400, to: 380, q: 1.3 },
    });
  }
  drum(v, 0.42, 0.7);
};

// ── Match ────────────────────────────────────────────────────────────────────

/** A war horn: chorused saws with a breathy edge, dipping into pitch. */
function horn(v: Voice, freq: number, length: number, at: number): void {
  for (const [mult, g, detune, type] of [
    [1, 0.3, 0, 'sawtooth'],
    [1, 0.26, 9, 'sawtooth'],
    [2, 0.08, -6, 'sawtooth'],
    [0.5, 0.3, 0, 'sine'],
  ] as const) {
    v.tone({
      type,
      freq: freq * mult * 0.96,
      to: freq * mult,
      glide: 0.2,
      gain: g,
      attack: 0.22,
      hold: length * 0.55,
      dur: length * 0.45,
      detune,
      at,
      filter: { type: 'lowpass', freq: 1700, to: 420, q: 1.2 },
    });
  }
  v.noise({ gain: 0.05, attack: 0.15, hold: length * 0.5, dur: length * 0.4, at, filter: { type: 'bandpass', freq: 1300, q: 0.8 } });
}

export const waveHorn: Recipe = (v) => {
  horn(v, 110, 0.55, 0);
  horn(v, 110, 1.5, 0.62);
};

/** A boss wave: a lower horn, and war drums under it. */
export const bossHorn: Recipe = (v) => {
  horn(v, 73.4, 2.3, 0);
  drum(v, 0.05, 1);
  drum(v, 0.62, 0.8);
  drum(v, 1.2, 1);
  drum(v, 1.45, 0.7);
  drum(v, 1.75, 1);
};

export const waveClear: Recipe = (v) => {
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => bell(v, f, i * 0.11, 0.1, 1.3));
};

/** The Core struck: the crystal shudders under the hit. */
export const coreCrack: Recipe = (v) => {
  v.tone({ freq: 95, to: 38, gain: 0.9, dur: 0.45 });
  v.noise({ gain: 0.5, dur: 0.32, filter: { type: 'lowpass', freq: 2600, to: 200 } });
  for (let i = 0; i < 6; i++) ping(v, rand(1800, 4200), rand(0, 0.09), 0.05, rand(0.2, 0.55));
};

/** "The Core is under attack": an alarm bell tolled three times. */
export const coreAlarm: Recipe = (v) => {
  for (let i = 0; i < 3; i++) bell(v, 349.2, i * 0.42, 0.16, 1.5);
};

/** The Core destroyed: detonation, shattering crystal, and a doomed drone. */
export const coreExplosion: Recipe = (v) => {
  v.tone({ freq: 72, to: 22, gain: 1, dur: 2.3 });
  v.tone({ freq: 46, to: 20, gain: 0.8, attack: 0.01, dur: 2.9 });
  v.noise({ gain: 0.95, dur: 2.6, filter: { type: 'lowpass', freq: 5200, to: 90, q: 0.5 } });
  v.noise({ gain: 0.6, attack: 0.02, hold: 0.3, dur: 3.6, brown: true, filter: { type: 'lowpass', freq: 650, to: 60 } });
  for (let i = 0; i < 30; i++) {
    // Squared so most shards fall early and the last few trickle in.
    const at = 0.02 + Math.pow(Math.random(), 2) * 1.4;
    ping(v, rand(1900, 6500), at, rand(0.025, 0.07), rand(0.15, 0.6));
  }
  for (const f of [55, 58.3]) {
    v.tone({
      type: 'sawtooth',
      freq: f,
      gain: 0.12,
      attack: 1.2,
      hold: 1.6,
      dur: 3,
      at: 0.8,
      filter: { type: 'lowpass', freq: 420, to: 110 },
    });
  }
};

export const bossPhase: Recipe = (v) => {
  roar(v, 95, 1.0, 1);
  drum(v, 0, 1);
  drum(v, 0.32, 0.8);
};

export const victory: Recipe = (v) => {
  horn(v, 146.8, 0.4, 0);
  horn(v, 196, 0.4, 0.45);
  horn(v, 220, 1.6, 0.9);
  [587.33, 739.99, 880].forEach((f, i) => bell(v, f, 0.9 + i * 0.12, 0.08, 1.6));
};

/** A soft wooden knock for pause, a touch higher for resume. */
export const pause: Recipe = (v) => {
  v.tone({ type: 'triangle', freq: 300, to: 170, gain: 0.35, dur: 0.09 });
  v.noise({ gain: 0.12, dur: 0.03, filter: { type: 'bandpass', freq: 1800, q: 3 } });
};

export const resume: Recipe = (v) => {
  v.tone({ type: 'triangle', freq: 420, to: 260, gain: 0.32, dur: 0.08 });
  v.noise({ gain: 0.12, dur: 0.03, filter: { type: 'bandpass', freq: 2400, q: 3 } });
};


// ── Talon, the archer ────────────────────────────────────────────────────────

/** The pierce shot: a bowstring released, then the shaft tearing the air. */
export const bowShot: Recipe = (v) => {
  // String: a short, tight thump with a little pitch to it.
  const f0 = vary(320, 280);
  v.tone({ freq: f0, to: f0 * 0.45, gain: 0.5, dur: 0.07, type: 'triangle' });
  v.noise({ gain: 0.45, dur: 0.06, filter: { type: 'bandpass', freq: 1800, to: 700, q: 2.4 } });
  // Shaft: the air it leaves behind, sweeping up and away.
  v.noise({ gain: 0.34, at: 0.02, attack: 0.02, dur: 0.24, filter: { type: 'bandpass', freq: 900, to: 4200, q: 1.5 } });
};

/** A critical shot: the same bow, drawn further, landing harder. */
export const bowCrit: Recipe = (v) => {
  bowShot(v);
  const f0 = vary(700, 620);
  v.tone({ freq: f0, to: f0 * 1.6, gain: 0.3, at: 0.05, dur: 0.16, type: 'triangle' });
  v.noise({ gain: 0.3, at: 0.05, dur: 0.16, filter: { type: 'bandpass', freq: 3200, to: 6000, q: 1.6 } });
};

/** The net leaving her hand: cloth and cord, no metal. */
export const netThrow: Recipe = (v) => {
  v.noise({ gain: 0.5, attack: 0.05, dur: 0.3, filter: { type: 'bandpass', freq: 500, to: 1500, q: 1.1 } });
  v.noise({ gain: 0.22, at: 0.14, dur: 0.18, filter: { type: 'bandpass', freq: 2200, q: 1.8 } });
};

/** The trap springing shut: a snap, a whip of rope, a body dropping. */
export const netSnap: Recipe = (v) => {
  v.noise({ gain: 0.8, dur: 0.05, filter: { type: 'highpass', freq: 1400 } });
  const f0 = vary(180, 150);
  v.tone({ freq: f0, to: f0 * 0.4, gain: 0.55, dur: 0.16, type: 'triangle' });
  v.noise({ gain: 0.3, at: 0.05, dur: 0.22, filter: { type: 'bandpass', freq: 700, to: 260, q: 1.2 } });
};

/** The sidestep: air, and the creak of leather. Nothing magical. */
export const windStep: Recipe = (v) => {
  v.noise({ gain: 0.62, attack: 0.03, dur: 0.26, filter: { type: 'bandpass', freq: 600, to: 3200, q: 1.3 } });
  v.noise({ gain: 0.18, at: 0.08, dur: 0.12, filter: { type: 'bandpass', freq: 240, q: 1.6 } });
};

/** The volley taking off: many strings at once, staggered. */
export const arrowVolley: Recipe = (v) => {
  for (let i = 0; i < 5; i++) {
    const at = i * 0.035;
    const f0 = vary(300, 260);
    v.tone({ freq: f0, to: f0 * 0.5, gain: 0.26, dur: 0.07, at, type: 'triangle' });
    v.noise({ gain: 0.2, at: at + 0.02, attack: 0.03, dur: 0.3, filter: { type: 'bandpass', freq: 1100, to: 3600, q: 1.4 } });
  }
};

/** Arrows landing: a scatter of shafts in earth and shield. */
export const arrowRainTick: Recipe = (v) => {
  for (let i = 0; i < 3; i++) {
    const at = i * 0.05 + rand(0, 0.04);
    v.noise({ gain: 0.34, at, dur: 0.07, filter: { type: 'bandpass', freq: vary(1500, 900), q: 2.2 } });
    const f0 = vary(150, 120);
    v.tone({ freq: f0, to: f0 * 0.6, gain: 0.22, dur: 0.09, at, type: 'triangle' });
  }
};


// ── Vesper, the healer ───────────────────────────────────────────────────────

/** The piercing light: a struck bell with a bright tail. */
export const holyLance: Recipe = (v) => {
  bell(v, vary(880, 820), 0, 0.55, 0.5);
  v.noise({ gain: 0.2, attack: 0.02, dur: 0.22, filter: { type: 'bandpass', freq: 3600, to: 7000, q: 1.4 } });
};

/** Consecrated ground: a low chord that sits under the fight. */
export const consecrate: Recipe = (v) => {
  const root = vary(196, 186);
  v.tone({ freq: root, gain: 0.3, attack: 0.25, dur: 1.4, type: 'sine' });
  v.tone({ freq: root * 1.5, gain: 0.22, attack: 0.3, dur: 1.4, type: 'sine' });
  v.tone({ freq: root * 2, gain: 0.14, attack: 0.35, dur: 1.3, type: 'triangle' });
};

/** One pulse of the circle: a small bell, barely there. */
export const mendTick: Recipe = (v) => {
  bell(v, vary(1320, 1240), 0, 0.22, 0.22);
};

/** The shield going up: a swell that resolves rather than decays. */
export const aegis: Recipe = (v) => {
  const root = vary(330, 310);
  v.tone({ freq: root * 0.75, to: root, gain: 0.34, attack: 0.12, dur: 0.7, type: 'sine' });
  bell(v, root * 2, 0.02, 0.3, 0.6);
  v.noise({ gain: 0.14, attack: 0.1, dur: 0.5, filter: { type: 'bandpass', freq: 2400, q: 1.2 } });
};

/** Dawn: the whole bell tower at once, then the room ringing. */
export const dawnBreak: Recipe = (v) => {
  bell(v, vary(440, 400), 0, 0.75, 1.6);
  bell(v, vary(660, 620), 0.05, 0.5, 1.4);
  bell(v, vary(880, 840), 0.1, 0.34, 1.2);
  v.noise({ gain: 0.3, attack: 0.08, dur: 1.1, filter: { type: 'bandpass', freq: 1200, to: 5200, q: 0.9 } });
};

/** A bird somewhere off in the trees: a short phrase of rising chirps. */
export const birdsong: Recipe = (v) => {
  const base = rand(2600, 3800);
  const notes = Math.floor(rand(2, 5));
  let t = 0;
  for (let i = 0; i < notes; i++) {
    const f = base * rand(0.9, 1.15);
    v.tone({ freq: f, to: f * rand(1.15, 1.45), glide: 0.05, gain: 0.25, attack: 0.008, dur: rand(0.05, 0.09), at: t });
    t += rand(0.09, 0.16);
  }
};

// ── Table ────────────────────────────────────────────────────────────────────

export interface SoundDef {
  play: Recipe;
  /** Trim so recipes sit at a common loudness. */
  gain: number;
  /** Reverb send. */
  wet: number;
  /** Minimum seconds between two plays; a sound asked for sooner is skipped. */
  gap: number;
  /** `ui` is never panned or attenuated: announcements must always be heard. */
  bus: 'sfx' | 'ui' | 'ambient';
  /** Plays even when the voice budget is exhausted. */
  priority?: boolean;
  /** Lowest distance gain, for sounds the player must not lose off-screen. */
  floor?: number;
}

const sfx = (play: Recipe, gain: number, gap: number, wet = 0.12, extra: Partial<SoundDef> = {}): SoundDef => ({
  play,
  gain,
  gap,
  wet,
  bus: 'sfx',
  ...extra,
});
const ui = (play: Recipe, gain: number, gap: number, wet = 0.2): SoundDef => ({
  play,
  gain,
  gap,
  wet,
  bus: 'ui',
  priority: true,
});

export const SOUNDS = {
  'attack.blade': sfx(bladeHit, 0.7, 0.05),
  'attack.bladeCrit': sfx(bladeCrit, 0.61, 0.05, 0.18),
  'attack.arcane': sfx(arcaneShot, 1.1, 0.05),
  'attack.arcaneCrit': sfx(arcaneCrit, 0.79, 0.05, 0.18),
  'attack.bow': sfx(bowShot, 0.85, 0.05),
  'attack.bowCrit': sfx(bowCrit, 0.7, 0.05, 0.18),
  'attack.miss': sfx(whoosh, 2.45, 0.06),
  'hero.hurt': sfx(hurt, 0.57, 0.11),
  'hero.death': ui(heroFall, 0.54, 1),
  'hero.revive': ui(revive, 0.54, 1),
  'hero.levelUp': ui(levelUp, 0.71, 0.3),
  'hero.potion': ui(potion, 1.32, 0.2, 0.1),
  'shop.purchase': ui(purchase, 0.99, 0.1, 0.1),
  'death.small': sfx(deathSmall, 0.51, 0.05),
  'death.light': sfx(deathLight, 0.53, 0.05),
  'death.heavy': sfx(deathHeavy, 0.4, 0.08, 0.16),
  'death.bones': sfx(deathBones, 0.7, 0.06),
  'death.wraith': sfx(deathWraith, 0.58, 0.08, 0.35),
  'death.titan': sfx(deathTitan, 0.48, 1, 0.3, { priority: true, floor: 0.6 }),
  'bounty.coins': sfx(coins, 0.5, 0.09, 0.08),
  'ability.bulwark.q': sfx(shieldBash, 0.93, 0.2, 0.18, { priority: true, floor: 0.4 }),
  'ability.bulwark.w': sfx(warCry, 0.73, 0.2, 0.3, { priority: true, floor: 0.4 }),
  'ability.bulwark.e': sfx(fortify, 1.09, 0.2, 0.15, { priority: true, floor: 0.4 }),
  'ability.bulwark.r': sfx(shockwave, 0.51, 0.2, 0.3, { priority: true, floor: 0.4 }),
  'ability.oracle.q': sfx(chainLightning, 1.4, 0.2, 0.25, { priority: true, floor: 0.4 }),
  'ability.oracle.q.jump': sfx(lightningJump, 1.36, 0.05, 0.15, { floor: 0.3 }),
  'ability.oracle.w': sfx(frost, 1.35, 0.2, 0.3, { priority: true, floor: 0.4 }),
  'ability.oracle.w.tick': sfx(iceTick, 1.07, 0.3, 0.25, { floor: 0.3 }),
  'ability.oracle.e': sfx(sealCharge, 0.52, 0.2, 0.25, { priority: true, floor: 0.4 }),
  'ability.oracle.e.burst': sfx(sealBurst, 0.99, 0.2, 0.3, { priority: true, floor: 0.4 }),
  'ability.oracle.r': sfx(meteorFall, 0.89, 0.2, 0.35, { priority: true, floor: 0.5 }),
  'ability.oracle.r.impact': sfx(meteorImpact, 0.49, 0.2, 0.35, { priority: true, floor: 0.6 }),
  'ability.talon.q': sfx(bowShot, 1, 0.12, 0.18, { priority: true, floor: 0.4 }),
  'ability.talon.w': sfx(netThrow, 1, 0.2, 0.2, { priority: true, floor: 0.35 }),
  'ability.talon.w.snap': sfx(netSnap, 1, 0.12, 0.22, { priority: true, floor: 0.4 }),
  'ability.talon.e': sfx(windStep, 1, 0.15, 0.2, { floor: 0.35 }),
  'ability.talon.r': sfx(arrowVolley, 1, 0.2, 0.3, { priority: true, floor: 0.5 }),
  'ability.talon.r.tick': sfx(arrowRainTick, 1, 0.25, 0.22, { floor: 0.3 }),
  'ability.vesper.q': sfx(holyLance, 1, 0.15, 0.3, { priority: true, floor: 0.4 }),
  'ability.vesper.w': sfx(consecrate, 1, 0.25, 0.4, { priority: true, floor: 0.4 }),
  'ability.vesper.w.tick': sfx(mendTick, 1, 0.3, 0.3, { floor: 0.25 }),
  'ability.vesper.e': sfx(aegis, 1, 0.2, 0.35, { priority: true, floor: 0.4 }),
  'ability.vesper.r': sfx(dawnBreak, 1, 0.3, 0.45, { priority: true, floor: 0.6 }),
  'boss.phase': sfx(bossPhase, 0.42, 0.5, 0.35, { priority: true, floor: 0.6 }),
  'wave.horn': ui(waveHorn, 0.34, 2, 0.35),
  'wave.bossHorn': ui(bossHorn, 0.43, 2, 0.35),
  'wave.clear': ui(waveClear, 1.08, 2, 0.3),
  'core.crack': ui(coreCrack, 0.6, 0.15, 0.25),
  'core.alarm': ui(coreAlarm, 1.6, 6, 0.3),
  'core.explosion': ui(coreExplosion, 0.39, 5, 0.4),
  'match.victory': ui(victory, 0.42, 5, 0.35),
  'sabotage.cast': ui(sabotageCast, 0.95, 0.3, 0.35),
  'sabotage.hit': ui(sabotageHit, 0.53, 0.6, 0.3),
  'ui.pause': ui(pause, 1.31, 0.05, 0.05),
  'ui.resume': ui(resume, 1.5, 0.05, 0.05),
  'ambient.bird': { play: birdsong, gain: 0.26, gap: 0.5, wet: 0.45, bus: 'ambient' } as SoundDef,
} satisfies Record<string, SoundDef>;

export type SoundId = keyof typeof SOUNDS;
