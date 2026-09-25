/** Allocation-free math helpers for the simulation hot path. */

import type { Vec2 } from './contracts';
import { atan2, exp, log2, pow } from './detmath';

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : (v - a) / (b - a);

export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const smootherstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/** Frame-rate independent exponential smoothing. `rate` in units per second. */
export const damp = (a: number, b: number, rate: number, dt: number): number =>
  b + (a - b) * exp(-rate * dt);

export const dist2 = (a: Vec2, b: Vec2): number => {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
};

export const dist = (a: Vec2, b: Vec2): number => Math.sqrt(dist2(a, b));

export const angleTo = (from: Vec2, to: Vec2): number =>
  atan2(to.x - from.x, to.z - from.z);

/** Shortest signed delta between two angles, in (-PI, PI]. */
export const angleDelta = (from: number, to: number): number => {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

export const rotateToward = (current: number, target: number, maxStep: number): number => {
  const d = angleDelta(current, target);
  return current + clamp(d, -maxStep, maxStep);
};

/**
 * Diminishing-returns curve used across the infinite progression system.
 * Returns 0..softCap asymptotically; `value` may grow without bound (GDD §9).
 */
export const softCap = (value: number, cap: number, k = 1): number =>
  cap * (1 - exp((-k * value) / cap));

/**
 * Armor mitigation. Never reaches 100%, stays finite for arbitrarily large armor.
 * Returns the damage multiplier in (0, 1].
 */
export const armorMitigation = (armor: number, constant = 100): number => {
  if (armor >= 0) return constant / (constant + armor);
  return 2 - constant / (constant - armor);
};

/**
 * Growth curve for unbounded levels. Sub-linear in the exponent so power grows
 * forever without overflowing or trivialising content.
 */
export const levelScale = (level: number, base: number, exponent = 1.06): number =>
  base * pow(exponent, log2(level + 1) * Math.sqrt(level));

/** Numeric guard used by balance tests; catches NaN/Infinity leaking into stats. */
export const isFiniteNumber = (v: number): boolean =>
  typeof v === 'number' && Number.isFinite(v);

/** Deterministic 2D value noise; used by terrain and by procedural texture gen. */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
