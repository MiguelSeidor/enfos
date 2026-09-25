/**
 * Prop scatter: decides *where* every doodad stands. Owner: TERRAIN agent.
 *
 * Placement is authored in mirrored space (`u = |x|`, `v = z`), the same trick
 * the elevation field uses: each accepted candidate emits one instance per
 * half, so both teams see the identical arrangement of trees, rocks and cover
 * (GDD §5 fairness) while yaw / scale / tint jitter independently so the halves
 * do not read as a photocopy.
 *
 * Everything is driven by the terrain field — splat weights, slope, openness,
 * lane and landmark distances — so the scatter *explains* the map: forests pool
 * on the highlands, rocks collect at cliff bases and along the gorge, the
 * combat basin is churned and dead, and nothing stands on the enemy route or
 * the landmark plazas.
 *
 * Determinism: a single `Rng` stream (forked as 'props' by the module) drives
 * every decision. Same seed, same forest.
 */

import { createNoise2D } from 'simplex-noise';
import type { Rng } from '@/core/rng';
import { clamp01 } from '@/core/mathx';
import { MAP_HALF, PLAY_RADIUS, WATER_LEVEL, BRIDGES, landmark } from './layout';
import { splatAt, type TerrainFieldData } from './field';
import { hypot } from '@/core/detmath';

export interface Placement {
  x: number;
  z: number;
  y: number;
  yaw: number;
  scale: number;
  /** Small random lean, radians. Trees and posts only. */
  tilt: number;
  /** Albedo multiplier packed as rgb; 1,1,1 = untinted. */
  r: number;
  g: number;
  b: number;
}

export interface ScatterOutput {
  /** Indexed by variant. */
  broadleaf: Placement[][];
  conifer: Placement[][];
  deadTree: Placement[];
  rock: Placement[][];
  log: Placement[];
  stump: Placement[];
  bush: Placement[][];
  ruinColumn: Placement[];
  ruinWall: Placement[];
  ruinBlock: Placement[];
  grass: Placement[];
}

const BROADLEAF_VARIANTS = 2;
const CONIFER_VARIANTS = 2;
const ROCK_VARIANTS = 3;
const BUSH_VARIANTS = 2;

/** Showcase pad (layout.ts step 9) — the capture harness poses units there. */
const SHOWCASE = { x: 0, z: -88, r: 17 };

export function scatterProps(field: TerrainFieldData, rng: Rng): ScatterOutput {
  const forestNoise = createNoise2D(() => rng.next());
  const meadowNoise = createNoise2D(() => rng.next());

  const out: ScatterOutput = {
    broadleaf: Array.from({ length: BROADLEAF_VARIANTS }, () => []),
    conifer: Array.from({ length: CONIFER_VARIANTS }, () => []),
    deadTree: [],
    rock: Array.from({ length: ROCK_VARIANTS }, () => []),
    log: [],
    stump: [],
    bush: Array.from({ length: BUSH_VARIANTS }, () => []),
    ruinColumn: [],
    ruinWall: [],
    ruinBlock: [],
    grass: [],
  };

  const splat = new Float32Array(4);

  /** Shared hard rejects for anything with a trunk or a footprint. */
  const blocked = (u: number, v: number, margin: number): boolean => {
    const x = -u;
    if (u > MAP_HALF - 3 || Math.abs(v) > MAP_HALF - 3) return true;
    if (field.heightAt(x, v) < WATER_LEVEL + 0.15) return true;
    if (field.laneDistance(x, v) < 6.5 + margin) return true;
    if (field.landmarkDistance(x, v) < 2.5 + margin) return true;
    if (field.carveMask[field.cellIndex(x, v)]! > 0.3) return true;
    if (hypot(u - SHOWCASE.x, v - SHOWCASE.z) < SHOWCASE.r + margin) return true;
    for (const b of BRIDGES) {
      if (u < 17 && Math.abs(v - b.v) < 6 + margin) return true;
    }
    return false;
  };

  /**
   * Emits the candidate mirrored: identical position and size class on both
   * halves, independent yaw and tint. `list` receives both instances.
   */
  const emit = (
    list: Placement[],
    u: number,
    v: number,
    scale: number,
    sink: number,
    maxTilt: number,
    tint: () => [number, number, number],
  ): void => {
    for (const sign of [-1, 1] as const) {
      const x = sign * u;
      const [r, g, b] = tint();
      list.push({
        x,
        z: v,
        y: field.heightAt(x, v) - sink,
        yaw: rng.range(0, Math.PI * 2),
        scale: scale * rng.range(0.94, 1.06),
        tilt: rng.range(-maxTilt, maxTilt),
        r,
        g,
        b,
      });
    }
  };

  /** Jittered-grid pass over the mirrored half space. */
  const pass = (spacing: number, fn: (u: number, v: number) => void): void => {
    for (let v = -MAP_HALF + 3; v < MAP_HALF - 3; v += spacing) {
      for (let u = 0.8; u < MAP_HALF - 3; u += spacing) {
        fn(u + rng.range(-0.45, 0.45) * spacing, v + rng.range(-0.45, 0.45) * spacing);
      }
    }
  };

  const foliageTint = (): [number, number, number] => {
    const warm = rng.range(0, 1);
    return [0.82 + warm * 0.4, 0.9 + rng.range(0, 0.18), 0.7 + (1 - warm) * 0.3];
  };
  const barkTint = (): [number, number, number] => {
    const t = rng.range(0.85, 1.1);
    return [t, t * rng.range(0.95, 1.02), t * rng.range(0.9, 1.0)];
  };
  const stoneTint = (): [number, number, number] => {
    const t = rng.range(0.8, 1.12);
    return [t * rng.range(0.98, 1.06), t, t * rng.range(0.96, 1.08)];
  };

  const combat = landmark('combatZone');

  // ── Trees ────────────────────────────────────────────────────────────────
  // Forests pool where the forest noise is high; broadleaf on the low green
  // terraces, conifers take over on the highlands and the rim slopes.
  pass(5.2, (u, v) => {
    if (blocked(u, v, 2.2)) return;
    const x = -u;
    const slope = field.slopeAt(x, v);
    if (slope > 0.34) return;
    const level = field.levelAt(x, v);
    if (level < 0) return;
    // The combat basin stays open — it is a battlefield, not a park.
    if (hypot(u - combat.u, v - combat.v) < combat.radius + 2) return;

    const forest = forestNoise(u * 0.021, v * 0.021) + forestNoise(u * 0.06, v * 0.06) * 0.35;
    const inPlay = u < PLAY_RADIUS && Math.abs(v) < PLAY_RADIUS;
    // Sparse in the play space, dense outside it and on the high shelves.
    const threshold = inPlay ? 0.34 : 0.05;
    if (forest < threshold) return;
    splatAt(field, x, v, splat);
    if (splat[2]! > 0.75) return; // no trees growing out of bare rock caps

    const conifer = level >= 3 || !inPlay ? rng.bool(0.8) : rng.bool(0.25);
    if (conifer) {
      emit(out.conifer[rng.int(0, CONIFER_VARIANTS - 1)]!, u, v, rng.range(0.85, 1.3), 0.25, 0.05, foliageTint);
    } else {
      emit(out.broadleaf[rng.int(0, BROADLEAF_VARIANTS - 1)]!, u, v, rng.range(0.8, 1.15), 0.25, 0.06, foliageTint);
    }
  });

  // Rim forest: a second, denser conifer band on the mountain slopes closes
  // the horizon so the arena reads as a valley rather than a diorama edge.
  pass(6.0, (u, v) => {
    const x = -u;
    if (u > MAP_HALF - 4 || Math.abs(v) > MAP_HALF - 4) return;
    const level = field.levelAt(x, v);
    if (level < 4.5 || level > 7) return;
    if (field.slopeAt(x, v) > 0.62) return;
    if (forestNoise(u * 0.03 + 40, v * 0.03) < -0.25) return;
    emit(out.conifer[rng.int(0, CONIFER_VARIANTS - 1)]!, u, v, rng.range(1.0, 1.5), 0.35, 0.07, foliageTint);
  });

  // ── Rocks and boulders ───────────────────────────────────────────────────
  // Rocks collect where rock is exposed: cliff aprons, the gorge banks, the
  // alpine shelves. Occasional boulder clusters anchor open ground.
  pass(7.5, (u, v) => {
    if (blocked(u, v, 0.6)) return;
    const x = -u;
    const nearCliff = field.nearCliff(x, v, 2.2);
    const gorge = field.gorgeMask[field.cellIndex(x, v)]!;
    splatAt(field, x, v, splat);
    const rockiness = Math.max(splat[2]! * 1.1, nearCliff ? 0.55 : 0, gorge > 0.05 && gorge < 0.7 ? 0.5 : 0);
    if (rockiness < 0.3 || !rng.bool(clamp01(rockiness))) return;

    const cluster = rng.bool(0.22) ? rng.int(2, 4) : 1;
    for (let k = 0; k < cluster; k++) {
      const du = k === 0 ? 0 : rng.range(-2.2, 2.2);
      const dv = k === 0 ? 0 : rng.range(-2.2, 2.2);
      if (blocked(u + du, v + dv, 0.4)) continue;
      const scale = rng.range(0.5, cluster > 1 ? 2.6 : 1.7);
      emit(out.rock[rng.int(0, ROCK_VARIANTS - 1)]!, u + du, v + dv, scale, 0.3 * scale, 0.3, stoneTint);
    }
  });

  // ── Bushes: forest fringe and scattered filler ───────────────────────────
  pass(6.2, (u, v) => {
    if (blocked(u, v, 0.9)) return;
    const x = -u;
    if (field.slopeAt(x, v) > 0.42) return;
    splatAt(field, x, v, splat);
    if (splat[0]! < 0.3) return;
    const forest = forestNoise(u * 0.021, v * 0.021);
    const fringe = forest > 0.05 && forest < 0.42 ? 0.55 : 0.16;
    if (!rng.bool(fringe)) return;
    emit(out.bush[rng.int(0, BUSH_VARIANTS - 1)]!, u, v, rng.range(0.7, 1.25), 0.12, 0.08, foliageTint);
  });

  // ── Battlefield dressing: dead trees, logs, stumps around the basin ─────
  pass(8.5, (u, v) => {
    if (blocked(u, v, 1.2)) return;
    const x = -u;
    if (field.slopeAt(x, v) > 0.3) return;
    const level = field.levelAt(x, v);
    if (level < 0 || level > 4) return;
    if (u > PLAY_RADIUS || Math.abs(v) > PLAY_RADIUS) return;
    splatAt(field, x, v, splat);
    const dCombat = hypot(u - combat.u, v - combat.v);
    const laneShoulder = field.laneDistance(x, v) < 15;
    const churn = clamp01(1 - dCombat / (combat.radius + 9)) * 0.8 + (laneShoulder ? 0.25 : 0) + splat[1]! * 0.25;
    if (!rng.bool(clamp01(churn) * 0.5)) return;
    const roll = rng.next();
    if (roll < 0.34) {
      emit(out.deadTree, u, v, rng.range(0.8, 1.2), 0.2, 0.1, barkTint);
    } else if (roll < 0.62) {
      emit(out.log, u, v, rng.range(0.8, 1.3), 0.08, 0, barkTint);
    } else {
      emit(out.stump, u, v, rng.range(0.8, 1.3), 0.1, 0.05, barkTint);
    }
  });

  // ── Ruins: old masonry along the lane and around the gorge crossings ────
  pass(16, (u, v) => {
    if (blocked(u, v, 1.6)) return;
    const x = -u;
    if (field.slopeAt(x, v) > 0.25) return;
    const level = field.levelAt(x, v);
    if (level < 0 || level > 4) return;
    if (u > PLAY_RADIUS - 4 || Math.abs(v) > PLAY_RADIUS - 4) return;
    const laneD = field.laneDistance(x, v);
    const gorgeD = u < 26 ? 1 : 0;
    const want = (laneD < 18 ? 0.3 : 0.05) + gorgeD * 0.2;
    if (!rng.bool(want)) return;
    const roll = rng.next();
    const list = roll < 0.4 ? out.ruinColumn : roll < 0.7 ? out.ruinWall : out.ruinBlock;
    emit(list, u, v, rng.range(0.85, 1.3), 0.15, 0.06, stoneTint);
  });

  // ── Grass: the ground cover that removes "empty ground" ─────────────────
  // Grass follows the grass splat weight, thickens in meadow patches, dries
  // toward the dirt, and thins to nothing on rock and the worn path.
  pass(2.0, (u, v) => {
    const x = -u;
    if (u > MAP_HALF - 4 || Math.abs(v) > MAP_HALF - 4) return;
    if (field.heightAt(x, v) < WATER_LEVEL + 0.2) return;
    if (field.laneDistance(x, v) < 5.4) return;
    if (field.landmarkDistance(x, v) < 0.5) return;
    if (hypot(u - SHOWCASE.x, v - SHOWCASE.z) < SHOWCASE.r) return;
    if (field.slopeAt(x, v) > 0.5) return;
    const level = field.levelAt(x, v);
    if (level < 0 || level > 6) return;
    splatAt(field, x, v, splat);
    const meadow = meadowNoise(u * 0.045, v * 0.045) * 0.3 + 0.7;
    const density = clamp01(splat[0]! * 1.25 - 0.18) * meadow;
    if (!rng.bool(density)) return;

    const tufts = rng.int(2, 3);
    for (let k = 0; k < tufts; k++) {
      const du = rng.range(-0.85, 0.85);
      const dv = rng.range(-0.85, 0.85);
      // Dry straw tint toward dirt and in the open, lush green in the shade.
      const dry = clamp01(splat[1]! * 1.6 + rng.range(-0.2, 0.35));
      emit(
        out.grass,
        u + du,
        v + dv,
        rng.range(0.8, 1.45),
        0.04,
        0,
        () => [0.55 + dry * 0.6, 0.72 + dry * 0.25, 0.45 + dry * 0.1],
      );
    }
  });

  return out;
}
