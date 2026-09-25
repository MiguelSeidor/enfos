/**
 * Simulation checksum. Owner: NET.
 *
 * Online play works only if every machine computes the exact same match. When
 * one does not — a desync — nothing crashes: the two players simply start
 * seeing different games, and the bug is invisible until someone notices a
 * creep that is dead on one screen and alive on the other.
 *
 * So every few ticks each client hashes the state that matters and the server
 * compares the hashes. The hash reads the *bits* of every float, not a rounded
 * value: rounding would hide the first microscopic divergence, and divergence
 * in a simulation only ever grows.
 */

import type { MatchState } from '@/core/contracts';

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

class Hasher {
  private h = 0x811c9dc5;

  int(n: number): void {
    this.h = Math.imul(this.h ^ (n | 0), 0x01000193);
  }

  float(n: number): void {
    f64[0] = n;
    this.int(u32[0]!);
    this.int(u32[1]!);
  }

  get value(): number {
    return this.h >>> 0;
  }
}

export function checksum(match: MatchState, rngState: number): number {
  const h = new Hasher();
  h.int(match.tick);
  h.int(match.wave);
  h.int(rngState);
  for (const core of match.cores) {
    h.int(core.team);
    h.int(core.lives);
  }
  for (const unit of match.units.values()) {
    h.int(unit.id);
    h.int(unit.alive ? 1 : 0);
    h.float(unit.pos.x);
    h.float(unit.pos.z);
    h.float(unit.health);
    h.float(unit.mana);
    h.int(unit.targetId ?? -1);
  }
  for (const hero of match.heroes.values()) {
    h.int(hero.id);
    h.float(hero.gold);
    h.float(hero.influence);
    h.float(hero.xp);
    h.int(hero.level);
    h.int(hero.items.length);
  }
  return h.value;
}
