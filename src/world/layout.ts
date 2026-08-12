/**
 * Authored map layout. Owner: TERRAIN agent.
 *
 * Everything here is expressed in MIRRORED space: `u = |x|`, `v = z`. A single
 * authored description is evaluated for both halves of the map, which makes the
 * geometric symmetry demanded by GDD §5 a structural property rather than
 * something we have to remember to maintain.
 *
 * The elevation model is a discrete terrace system, not smooth noise: the field
 * below produces a continuous "level potential", which `field.ts` quantises into
 * integer terrace levels and turns into flat plateaus separated by generated
 * cliff walls. Ramps are the only places where the level stays fractional, so
 * they are the only places units can change elevation.
 *
 *   u   0–13   central gorge and river (levels -2 … 0)
 *   u  13–25   home terrace: preparation zone and the two shops (level 1)
 *   u  24–46   core plateau (level 2)
 *   u  40–64   combat basin (level 1)
 *   u  56–82   mid highlands, cut by the lane canyon (level 3)
 *   u  82–104  far highlands and the spawn shelf (level 4 / pad at 3)
 *   u > 104    rim mountains (levels 7–8), the visual bound of the arena
 */

import { createNoise2D } from 'simplex-noise';
import { createRng } from '@/core/rng';
import { clamp, clamp01, lerp, smoothstep } from '@/core/mathx';

// ── Scale ────────────────────────────────────────────────────────────────────

export const MAP_SIZE = 240;
export const MAP_HALF = MAP_SIZE / 2;

/** Coarse terrace cell: one elevation level per cell. Sets the cliff cadence. */
export const CELL = 4;
export const CELLS = MAP_SIZE / CELL; // 60 × 60
/** Fine quads per coarse cell edge; controls ground tessellation. */
export const SUB = 4;
/** World height of one terrace step. Roughly a unit and a half tall. */
export const LEVEL_STEP = 2.6;

export const MIN_LEVEL = -2;
export const MAX_LEVEL = 8;

/** Water surface sits just under the level -1 plane, inside the gorge. */
export const WATER_LEVEL = -1.05 * LEVEL_STEP;

export const LANE_HALF_WIDTH = 6.5;
export const LANE_FEATHER = 7.5;

/** Beyond this the map is scenery only: no props scattered, no gameplay. */
export const PLAY_RADIUS = 104;

// ── Lane ─────────────────────────────────────────────────────────────────────

export interface LaneNode {
  u: number;
  v: number;
  /** Terrace level the lane sits at when it passes this node. */
  level: number;
}

/**
 * The enemy route: spawn shelf in the far highlands, a serpentine descent
 * through the canyon, across the combat basin, then a final ramp up onto the
 * core plateau. Kept close to the v0 waypoints so downstream systems that
 * already read `lanePath()` see the same shape.
 */
export const LANE_NODES: readonly LaneNode[] = [
  { u: 96, v: -62, level: 3 },
  { u: 74, v: -44, level: 3 },
  { u: 82, v: -16, level: 3 },
  { u: 58, v: 4, level: 2 },
  { u: 72, v: 30, level: 2 },
  { u: 50, v: 50, level: 1 },
  { u: 40, v: 22, level: 1 },
  { u: 34, v: -8, level: 2 },
];

// ── Landmarks (GDD §5) ───────────────────────────────────────────────────────

export type LandmarkKind =
  | 'spawnPortal'
  | 'core'
  | 'shopProgression'
  | 'shopSabotage'
  | 'prepZone'
  | 'combatZone';

export interface Landmark {
  kind: LandmarkKind;
  u: number;
  v: number;
  /** Footprint radius: props are cleared inside it, ground is flattened. */
  radius: number;
  /** Terrace level the pad is forced to. */
  level: number;
}

export const LANDMARKS: readonly Landmark[] = [
  { kind: 'spawnPortal', u: 96, v: -62, radius: 11, level: 3 },
  { kind: 'core', u: 34, v: -8, radius: 11.5, level: 2 },
  { kind: 'shopProgression', u: 19, v: -32, radius: 7.5, level: 1 },
  { kind: 'shopSabotage', u: 19, v: 14, radius: 7.5, level: 1 },
  { kind: 'prepZone', u: 19, v: -8, radius: 8.5, level: 1 },
  { kind: 'combatZone', u: 50, v: 8, radius: 20, level: 1 },
];

export function landmark(kind: LandmarkKind): Landmark {
  const found = LANDMARKS.find((l) => l.kind === kind);
  if (!found) throw new Error(`unknown landmark ${kind}`);
  return found;
}

/** Explicit walkable connections between terraces that the lane does not cover. */
interface RampCorridor {
  au: number;
  av: number;
  bu: number;
  bv: number;
  halfWidth: number;
  from: number;
  to: number;
}

const RAMPS: readonly RampCorridor[] = [
  // Home terrace (1) up onto the core plateau (2), behind the Core.
  { au: 23, av: -8, bu: 30, bv: -8, halfWidth: 5, from: 1, to: 2 },
  // Core plateau (2) down into the combat basin (1) on the north flank.
  { au: 42, av: 4, bu: 49, bv: 12, halfWidth: 5, from: 2, to: 1 },
];

/** Stone bridges across the gorge — scenery, and the only mid-line crossings. */
export const BRIDGES: readonly { v: number; ruined: boolean }[] = [
  { v: 22, ruined: false },
  { v: -44, ruined: true },
];

// ── Field helpers ────────────────────────────────────────────────────────────

/** Distance from (px,pz) to segment (ax,az)-(bx,bz), plus the segment param. */
export function segmentQuery(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { dist: number; t: number } {
  const abx = bx - ax;
  const abz = bz - az;
  const lenSq = abx * abx + abz * abz;
  const t = lenSq === 0 ? 0 : clamp01(((px - ax) * abx + (pz - az) * abz) / lenSq);
  const cx = ax + abx * t;
  const cz = az + abz * t;
  return { dist: Math.hypot(px - cx, pz - cz), t };
}

/** 1 inside `radius`, falling to 0 over `feather`. */
function diskMask(u: number, v: number, cu: number, cv: number, radius: number, feather: number): number {
  const d = Math.hypot(u - cu, v - cv);
  return 1 - smoothstep((d - radius) / feather);
}

function rectMask(
  u: number,
  v: number,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  feather: number,
): number {
  const du = Math.min(u - u0, u1 - u);
  const dv = Math.min(v - v0, v1 - v);
  return smoothstep(du / feather) * smoothstep(dv / feather);
}

export interface Elevation {
  /** Continuous terrace potential. Quantised into integer levels downstream. */
  e: number;
  /** True where the surface must stay a smooth slope (no cliff, walkable). */
  ramp: boolean;
  /** 0..1 lane influence; drives the worn path splat and prop clearing. */
  lane: number;
  /** 0..1 gorge influence; drives water, wet banks and shore foam. */
  gorge: number;
}

export interface ElevationField {
  /** Sample in mirrored space. `u` must be >= 0. */
  sample(u: number, v: number, out: Elevation): Elevation;
  /** Continuous surface detail added to every vertex; keeps cells welded. */
  macro(x: number, z: number): number;
}

export function createElevationField(seed: number): ElevationField {
  const rng = createRng(seed ^ 0x5eed17);
  const shape = createNoise2D(() => rng.next());
  const grain = createNoise2D(() => rng.next());
  const detail = createNoise2D(() => rng.next());

  const laneLen = LANE_NODES.length;

  /** Lane influence and the terrace level the lane holds at this point. */
  const laneQuery = (u: number, v: number): { t: number; level: number } => {
    let bestT = 0;
    let bestLevel = 1;
    for (let i = 0; i < laneLen - 1; i++) {
      const a = LANE_NODES[i]!;
      const b = LANE_NODES[i + 1]!;
      const q = segmentQuery(u, v, a.u, a.v, b.u, b.v);
      const t = 1 - smoothstep((q.dist - LANE_HALF_WIDTH) / LANE_FEATHER);
      if (t > bestT) {
        bestT = t;
        // Compress the level change into the middle of the segment so the
        // approaches stay flat and the ramp itself reads as a built slope.
        const k = smoothstep((q.t - 0.28) / 0.44);
        bestLevel = lerp(a.level, b.level, k);
      }
    }
    return { t: bestT, level: bestLevel };
  };

  const rampQuery = (u: number, v: number): { t: number; level: number } => {
    let bestT = 0;
    let bestLevel = 1;
    for (const r of RAMPS) {
      const q = segmentQuery(u, v, r.au, r.av, r.bu, r.bv);
      const t = 1 - smoothstep((q.dist - r.halfWidth) / 5);
      if (t > bestT) {
        bestT = t;
        bestLevel = lerp(r.from, r.to, smoothstep((q.t - 0.15) / 0.7));
      }
    }
    return { t: bestT, level: bestLevel };
  };

  const macro = (x: number, z: number): number => {
    const u = Math.abs(x);
    return (
      shape(u * 0.0125, z * 0.0125) * 0.85 +
      grain(u * 0.085, z * 0.085) * 0.3 +
      detail(u * 0.23, z * 0.23) * 0.11
    );
  };

  const sample = (u: number, v: number, out: Elevation): Elevation => {
    const av = Math.abs(v);

    // 1. Regional relief. Amplitude below 0.5 so it perturbs terrace outlines
    //    into organic shapes without ever moving a plateau by a whole level.
    //    The high-frequency term is what stops the quantised boundaries from
    //    running in long straight lines along the cell grid.
    let e =
      1 +
      shape(u * 0.0165, v * 0.0165) * 0.46 +
      shape(u * 0.045, v * 0.045) * 0.18 +
      grain(u * 0.108, v * 0.108) * 0.24 +
      grain(u * 0.21, v * 0.21) * 0.1;

    // 2. The land rises away from the middle: basin → highlands → far shelf.
    e += 2.15 * smoothstep((u - 54) / 20);
    e += 1.05 * smoothstep((u - 82) / 12);

    // 3. Ridge fingers between the lane legs. These are what turn the
    //    serpentine into a canyon instead of a stripe painted on a plane.
    e += 1.5 * (1 - smoothstep((segmentQuery(u, v, 68, -58, 60, -30).dist - 8) / 9));
    e += 1.35 * (1 - smoothstep((segmentQuery(u, v, 80, -4, 68, 12).dist - 7) / 9));
    e += 1.5 * (1 - smoothstep((segmentQuery(u, v, 63, 26, 57, 44).dist - 7) / 9));
    e += 1.15 * (1 - smoothstep((segmentQuery(u, v, 44, 40, 34, 30).dist - 8) / 10));
    e += 1.25 * (1 - smoothstep((segmentQuery(u, v, 88, -34, 92, -6).dist - 8) / 10));

    // 4. The combat basin: an open bowl in front of the Core where the lane
    //    empties out and the defence line forms.
    e -= 1.25 * diskMask(u, v, 50, 8, 16, 12);

    // 5. Home terrace — the flat shelf holding both shops and the prep zone.
    e = lerp(e, 1, rectMask(u, v, 13, 25, -44, 30, 5) * 0.95);

    // 6. Landmark pads.
    for (const l of LANDMARKS) {
      if (l.kind === 'combatZone') continue;
      e = lerp(e, l.level, diskMask(u, v, l.u, l.v, l.radius, 4.5) * 0.97);
    }

    // 7. Rim mountains. Hard bound of the arena, tall enough to close the
    //    horizon at every camera pitch. A superellipse rather than a square,
    //    with a noisy radius so the skyline is a mountain range not a wall.
    const nu = u / MAP_HALF;
    const nv = av / MAP_HALF;
    const edge =
      Math.pow(Math.pow(nu, 5) + Math.pow(nv, 5), 0.2) + shape(u * 0.03, v * 0.03) * 0.05;
    const rim = smoothstep((edge - 0.79) / 0.15);
    e = Math.max(e, 1 + 7.2 * rim + grain(u * 0.06, v * 0.06) * 2.4 * rim);

    // 8. Central gorge. Two terraces down to a river bed, closed at both ends
    //    so the map still has a continuous outer plain. The channel meanders so
    //    the mirror line reads as a river, not as a canal.
    const meander = shape(v * 0.021, 3.7) * 3.4 + shape(v * 0.058, 8.1) * 1.5;
    const across = 1 - smoothstep((u - meander - 6) / 8);
    const along = 1 - smoothstep((av - 58) / 14);
    const gorge = across * along;
    e = lerp(e, -1.75, gorge);

    // 9. Keep the character showcase pad flat — it is outside the play space
    //    but the capture harness stands units on it.
    e = lerp(e, 1, diskMask(u, v, 0, -88, 13, 7) * 0.98);

    // 10. Lane and ramps are carved last: they must win over everything so the
    //     route is guaranteed walkable end to end.
    const ramp = rampQuery(u, v);
    if (ramp.t > 0.01) e = lerp(e, ramp.level, ramp.t);
    const lane = laneQuery(u, v);
    if (lane.t > 0.01) e = lerp(e, lane.level, lane.t);

    const carved = Math.max(lane.t, ramp.t);
    const carvedLevel = lane.t >= ramp.t ? lane.level : ramp.level;

    out.e = clamp(e, MIN_LEVEL, MAX_LEVEL);
    out.lane = lane.t;
    out.gorge = gorge;
    // A carved corridor is a ramp only where its level is genuinely between
    // two terraces; flat stretches stay quantised so they keep their cliffs.
    out.ramp = carved > 0.55 && Math.abs(carvedLevel - Math.round(carvedLevel)) > 0.07;
    return out;
  };

  return { sample, macro };
}

/** World-space lane polyline for a team (team 0 = -X, team 1 = +X). */
export function lanePolyline(sign: number): { x: number; z: number }[] {
  return LANE_NODES.map((n) => ({ x: sign * n.u, z: n.v }));
}
