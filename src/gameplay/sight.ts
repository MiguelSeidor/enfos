/**
 * Line of sight. Owner: GAMEPLAY.
 *
 * A ranged attacker used to hit anything inside its range circle, so the
 * Oracle could shoot through a ridge at creeps in the next corridor. Range is
 * a circle; sight is a ray, and the terrain can stand in its way.
 *
 * The test runs a ray from the attacker's eye to the target's chest and walks
 * it over the heightfield. If the ground rises above the ray anywhere between
 * them, the shot is blocked. Pure function of positions and terrain, so it is
 * deterministic and safe to call from the simulation.
 */

import type { UnitState } from '@/core/contracts';
import type { TerrainService } from '@/core/services';
import { runtimeOf } from './units';
import { hypot } from '@/core/detmath';

/** Attack ranges above this are ranged and need a clear line. */
export const RANGED_ATTACK = 5;

const EYE_HEIGHT = 1.5;
const CHEST_HEIGHT = 1.1;
/** Sample spacing along the ray, metres. Well under a terrace ramp's width. */
const STEP = 0.6;
/**
 * Metres at each end the test ignores: a unit standing right at the foot of a
 * slope would otherwise be blinded by the ground under its own feet.
 */
const END_SKIP = 0.9;
/** Ground may poke this far above the ray before it counts as blocking. */
const TOLERANCE = 0.15;

export function isRanged(unit: UnitState): boolean {
  return unit.stats.attackRange > RANGED_ATTACK;
}

/** Height above the ground a unit's body sits at; fliers see over walls. */
function altitudeOf(unit: UnitState): number {
  return runtimeOf(unit.id)?.traits?.flying?.altitude ?? 0;
}

export function hasLineOfSight(terrain: TerrainService, from: UnitState, to: UnitState): boolean {
  const ax = from.pos.x;
  const az = from.pos.z;
  const dx = to.pos.x - ax;
  const dz = to.pos.z - az;
  const length = hypot(dx, dz);
  if (length <= END_SKIP * 2) return true;

  const eye = terrain.heightAt(ax, az) + EYE_HEIGHT + altitudeOf(from);
  const aim = terrain.heightAt(to.pos.x, to.pos.z) + CHEST_HEIGHT + altitudeOf(to);
  const span = length - END_SKIP * 2;
  const samples = Math.ceil(span / STEP);

  for (let i = 0; i <= samples; i++) {
    const t = (END_SKIP + (span * i) / samples) / length;
    const x = ax + dx * t;
    const z = az + dz * t;
    const ray = eye + (aim - eye) * t + TOLERANCE;
    if (terrain.heightAt(x, z) > ray) return false;
    // Authored cover — a boulder, a broken pillar — stops a shot the same way
    // a ridge does. A flier is usually above it, which is the point of flying.
    if (terrain.blockerTop(x, z) > ray) return false;
  }
  return true;
}
