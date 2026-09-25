/**
 * World invariants, checked numerically. Owner: TERRAIN agent.
 *
 * GDD §5 makes two hard promises — the map is mirror-symmetric, and the enemy
 * route is traversable end to end. Both are structural properties of the field
 * build, but "structural" claims rot silently when someone tunes a noise
 * amplitude, so `TerrainModule` runs this under `?qa=1` and *fails the capture
 * harness* (console.error) on any violation. The numbers are also published on
 * `window.__TERRAIN_VALIDATION__` for the report loop to read.
 */

import { LEVEL_STEP, LANDMARKS, PLAY_RADIUS, lanePolyline, CELLS } from './layout';
import type { TerrainFieldData } from './field';
import { hypot } from '@/core/detmath';

export interface WorldValidation {
  ok: boolean;
  issues: string[];
  /** Max |heightAt(x,z) − heightAt(−x,z)| over the sampled grid. */
  symmetryMaxError: number;
  /** Worst height change per metre marched along the lane centreline. */
  maxLaneStepPerMetre: number;
  /** Fraction of lane samples on walkable cells (must be 1). */
  laneWalkableFraction: number;
  /** Landmarks reachable from the spawn portal over walkable cells. */
  reachableLandmarks: string[];
}

/** Mean top-surface height of a cell, from its four terrace corners. */
function cellMeanHeight(field: TerrainFieldData, c: number): number {
  const b = c * 4;
  return (
    ((field.corners[b]! + field.corners[b + 1]! + field.corners[b + 2]! + field.corners[b + 3]!) /
      4) *
    LEVEL_STEP
  );
}

export function validateWorld(field: TerrainFieldData): WorldValidation {
  const issues: string[] = [];

  // ── 1. Mirror symmetry of the walkable surface ────────────────────────────
  let symmetryMaxError = 0;
  for (let z = -PLAY_RADIUS; z <= PLAY_RADIUS; z += 2.5) {
    for (let x = 0.5; x <= PLAY_RADIUS; x += 2.5) {
      const d = Math.abs(field.heightAt(x, z) - field.heightAt(-x, z));
      if (d > symmetryMaxError) symmetryMaxError = d;
    }
  }
  if (symmetryMaxError > 1e-3) {
    issues.push(`symmetry broken: max height mismatch ${symmetryMaxError.toFixed(4)}m`);
  }

  // ── 2. Lane traversability, both teams ────────────────────────────────────
  let maxLaneStepPerMetre = 0;
  let laneSamples = 0;
  let laneWalkable = 0;
  for (const sign of [-1, 1] as const) {
    const path = lanePolyline(sign);
    let prevH = field.heightAt(path[0]!.x, path[0]!.z);
    for (let s = 0; s < path.length - 1; s++) {
      const a = path[s]!;
      const b = path[s + 1]!;
      const len = hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(len));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        const h = field.heightAt(x, z);
        const step = Math.abs(h - prevH) / (len / steps);
        if (step > maxLaneStepPerMetre) maxLaneStepPerMetre = step;
        prevH = h;
        laneSamples++;
        if (field.isWalkable(x, z)) laneWalkable++;
        else issues.push(`lane not walkable at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
    }
  }
  const laneWalkableFraction = laneSamples === 0 ? 0 : laneWalkable / laneSamples;
  if (maxLaneStepPerMetre > 1.0) {
    issues.push(
      `lane crosses a step of ${maxLaneStepPerMetre.toFixed(2)}m/m — a cliff, not a ramp`,
    );
  }

  // ── 3. Landmark connectivity over walkable cells ──────────────────────────
  // BFS with a height-step gate: two adjacent walkable cells connect when their
  // terrace surfaces meet (ramps), not when a cliff separates them.
  const total = CELLS * CELLS;
  const reachable = new Uint8Array(total);
  const queue = new Int32Array(total);
  const spawn = LANDMARKS.find((l) => l.kind === 'spawnPortal')!;
  const startCell = field.cellIndex(-spawn.u, spawn.v);
  let qh = 0;
  let qt = 0;
  if (field.walkable[startCell]) {
    reachable[startCell] = 1;
    queue[qt++] = startCell;
  } else {
    issues.push('spawn portal pad is not walkable');
  }
  const MAX_STEP = 1.6; // metres; a full cliff step is LEVEL_STEP = 2.6
  while (qh < qt) {
    const c = queue[qh++]!;
    const i = c % CELLS;
    const j = (c / CELLS) | 0;
    const h = cellMeanHeight(field, c);
    const neigh = [
      i > 0 ? c - 1 : -1,
      i < CELLS - 1 ? c + 1 : -1,
      j > 0 ? c - CELLS : -1,
      j < CELLS - 1 ? c + CELLS : -1,
    ];
    for (const n of neigh) {
      if (n < 0 || reachable[n] || !field.walkable[n]) continue;
      if (Math.abs(cellMeanHeight(field, n) - h) > MAX_STEP) continue;
      reachable[n] = 1;
      queue[qt++] = n;
    }
  }

  const reachableLandmarks: string[] = [];
  for (const l of LANDMARKS) {
    for (const sign of [-1, 1] as const) {
      const c = field.cellIndex(sign * l.u, l.v);
      const name = `${l.kind}${sign < 0 ? '-' : '+'}`;
      if (reachable[c]) {
        reachableLandmarks.push(name);
      } else if (sign < 0) {
        // Team + is a mirror copy; report the authored half once.
        issues.push(`landmark ${l.kind} unreachable from spawn portal`);
      }
    }
  }

  // ── 4. Landmark pads must be flat and at their authored level ─────────────
  for (const l of LANDMARKS) {
    if (l.kind === 'combatZone') continue;
    const lvl = field.levelAt(-l.u, l.v);
    if (lvl !== l.level) {
      issues.push(`landmark ${l.kind} pad level ${lvl}, authored ${l.level}`);
    }
    const slope = field.slopeAt(-l.u, l.v);
    if (slope > 0.2) {
      issues.push(`landmark ${l.kind} pad not flat (slope ${slope.toFixed(2)} rad)`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    symmetryMaxError,
    maxLaneStepPerMetre,
    laneWalkableFraction,
    reachableLandmarks,
  };
}
