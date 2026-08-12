/**
 * Deterministic RNG. The whole simulation must be reproducible from a seed
 * (GDD §7: "Las oleadas deben soportar seeds deterministas").
 *
 * Never call Math.random() inside fixedUpdate. Presentation-only randomness
 * (particle jitter, idle animation offsets) may use a separate visual stream so
 * it cannot desync the simulation.
 */

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [min, max) */
  range(min: number, max: number): number;
  /** [min, max] integers */
  int(min: number, max: number): number;
  bool(chance: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Weighted pick; weights must be positive and the array non-empty. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T;
  shuffle<T>(items: T[]): T[];
  /** Fork a child stream so subsystems cannot perturb each other's sequence. */
  fork(label: string): Rng;
  readonly seed: number;
  state(): number;
  restore(state: number): void;
}

/** xorshift32 — fast, small state, adequate distribution for gameplay. */
export function createRng(seed: number): Rng {
  let s = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;

  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    // Map to [0,1) using the unsigned 32-bit value.
    return (s >>> 0) / 4294967296;
  };

  const rng: Rng = {
    seed,
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    bool: (chance) => next() < chance,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    weighted: (items, weight) => {
      let total = 0;
      for (const it of items) total += weight(it);
      let roll = next() * total;
      for (const it of items) {
        roll -= weight(it);
        if (roll <= 0) return it;
      }
      return items[items.length - 1]!;
    },
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = items[i]!;
        items[i] = items[j]!;
        items[j] = tmp;
      }
      return items;
    },
    fork: (label) => createRng(hashString(label) ^ (s | 0)),
    state: () => s,
    restore: (state) => {
      s = state | 0;
    },
  };

  return rng;
}

/** FNV-1a. Stable across runs — used for seeding child streams by name. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * Presentation-only RNG. Safe to use in update(), never in fixedUpdate().
 * Seeded from wall-clock so visual noise varies between sessions.
 */
export const visualRng: Rng = createRng((Date.now() & 0x7fffffff) | 1);
