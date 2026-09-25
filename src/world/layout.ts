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
import { hypot, pow } from '@/core/detmath';

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
export const MAX_LEVEL = 10;

/**
 * Terrace level of the impassable plateau that fills everything the route does
 * not carve out.
 *
 * At 4 levels above the lane this is ~10.4 m of cliff, against a 1.6 m climb
 * limit — no unit can shortcut across it, and at RTS camera distance the wall
 * reads instantly as "not that way".
 */
export const HIGHLAND = 5;

/**
 * The base shelf holding Core, fountain and shops: one step above the lane, so
 * it presents as a defended platform reached by a ramp rather than as more of
 * the same ground.
 */
export const BASE_LEVEL = 2;

/**
 * The base terrace's authored bounds, in mirrored (u, v) space.
 *
 * Exported because walkability needs them: the shelf is a walkable region that
 * is not part of the lane carve, so the field cannot derive it from the carve
 * mask alone.
 */
export const BASE_RECT = { u0: 26, u1: 70, v0: 18, v1: 54 } as const;

/** True inside the base terrace, in world coordinates. */
export function inBaseTerrace(x: number, z: number): boolean {
  const u = Math.abs(x);
  return u >= BASE_RECT.u0 && u <= BASE_RECT.u1 && z >= BASE_RECT.v0 && z <= BASE_RECT.v1;
}

/** Water surface sits just under the level -1 plane, inside the gorge. */
export const WATER_LEVEL = -1.05 * LEVEL_STEP;

/**
 * Half-width of the carved lane.
 *
 * Widened from 6.5: at 13 m across, with a wave 8+ units abreast, the route read
 * as a scratch in the terrain rather than a road. 9.5 gives it the presence of a
 * built avenue and makes the path material wide enough to actually see, which is
 * what makes the route legible from the RTS camera.
 */
export const LANE_HALF_WIDTH = 9.5;

/**
 * Falloff outside the half-width.
 *
 * Cut from 7.5. Half-width plus feather is the lane's true reach, and at 17 m
 * an avenue authored at u=12 carved from u=-5 to u=29: it crossed the map's own
 * mirror line, joining the two halves through the gorge, and simultaneously
 * touched the base terrace's inner edge at u=26. The consequence was that the
 * lane stopped being a corridor — the base, both avenues and the river bank
 * merged into one open plain, and a hero ordered across the map quite correctly
 * walked straight over it instead of following the route.
 *
 * 3.5 keeps a 26 m carved road (ample for a wave eight abreast) while leaving
 * highland on both sides of it.
 */
export const LANE_FEATHER = 3.5;

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
 * The enemy route: spawn shelf in the far highlands, a switchback loop, a
 * descent along the outer wall, an inner hook, a long return leg across the
 * combat basin, then a final ramp up onto the core plateau.
 *
 * Length is the point. The v0 route was ~208 world units — about 37 seconds of
 * walking for a base creep, which left almost no window to intercept a wave
 * before it reached the Core. This one is ~435 units (~78 s), so a leak is the
 * result of failing to defend rather than of the map being too small to defend.
 *
 * Every node stays inside a radius of ~115 (the map half-extent is 120), and the
 * whole polyline is mirrored for the second site, so both teams walk exactly the
 * same distance (GDD §5).
 */
/**
 * ## The route, in the classic shape
 *
 * ```
 *   PORTAL A          PORTAL B      v = -80   (level 3, highland shelf)
 *       |                 |
 *       |                 |                    two parallel descents
 *       |                 |
 *       \_______   _______/          v = -18   first junction
 *               | |
 *               | |                             shared trunk
 *        _______| |_______            v =  0    second fork
 *       |                 |
 *       |   FUENTE  T1 T2 |                     base terrace: fountain,
 *       |     NÚCLEO      |                     shops and the Core sit
 *       |                 |                     between the two branches
 *       \________|________/           v = 52    both branches reach the Core
 * ```
 *
 * Two portals fire at once, the streams merge briefly, split again around the
 * base, and only converge on the Core itself — which is the only place a leak
 * costs integrity. The second fork is what makes the base hard to hold: the
 * defence has to cover two approaches that arrive at the same objective.
 */

/** Left descent: portal A, held wide before the first junction. */
const LANE_DESCENT_A: readonly LaneNode[] = [
  // The whole approach stays on terrace 2. Every terrace change the route made
  // up here produced a cliff across the road: the level is compressed into the
  // middle of a segment, so a 12 m leg gives the ramp about 5 m to cover a
  // 2.6 m drop, and the validator measured 2.21 m/m. The route now changes
  // terrace exactly once, on the longest leg it has (see LANE_AVENUE_LEFT).
  { u: 18, v: -84, level: 2 },
  { u: 20, v: -62, level: 2 },
  { u: 24, v: -50, level: 2 },
  { u: 36, v: -44, level: 2 },
];

/** Right descent: portal B. Mirrors A about u≈48. */
const LANE_DESCENT_B: readonly LaneNode[] = [
  { u: 78, v: -84, level: 2 },
  { u: 76, v: -62, level: 2 },
  { u: 72, v: -50, level: 2 },
  { u: 60, v: -44, level: 2 },
];

/** Shared trunk between the first junction and the second fork. */
const LANE_TRUNK: readonly LaneNode[] = [
  { u: 48, v: -38, level: 2 },
  { u: 48, v: -22, level: 2 },
];

/** Left avenue: runs the full height of the map down to the bottom sweep. */
const LANE_AVENUE_LEFT: readonly LaneNode[] = [
  // The route's only terrace change, 2→1, spread over this 38 m leg — the
  // longest straight it has, which keeps the ramp under the validator's 1 m/m
  // gate with room to spare.
  { u: 14, v: -18, level: 2 },
  { u: 12, v: 30, level: 1 },
  { u: 16, v: 62, level: 1 },
  { u: 30, v: 86, level: 1 },
];

/** Right avenue. */
const LANE_AVENUE_RIGHT: readonly LaneNode[] = [
  { u: 82, v: -18, level: 2 },
  { u: 84, v: 30, level: 1 },
  { u: 80, v: 62, level: 1 },
  { u: 66, v: 86, level: 1 },
];

/**
 * The bottom junction and the climb back up to the Core.
 *
 * This is the shape the earlier version got wrong. The avenues do not end at
 * the Core: they run all the way to the bottom of the map, close into a U, and
 * meet at a single intersection at (48, 96). Only from there does one shared
 * approach turn back north to the Core — so the base is attacked from below,
 * with the whole southern half of the map in play instead of sitting empty.
 */
const LANE_CORE_APPROACH: readonly LaneNode[] = [
  { u: 48, v: 96, level: 1 },
  { u: 48, v: 92, level: 1 },
  // The ramp onto the base shelf. 36 m for a single terrace: the level is
  // interpolated across the middle of a segment and then quantised back to
  // terraces, so a short leg produces a cliff instead of a slope — a 12 m leg
  // measured 2.21 m/m against a 1.0 gate.
  //
  // It must finish climbing *at the terrace's own edge* (v=54), not 10 m inside
  // it. Ending at v=44 meant the ramp was still at level 1.65 as it crossed the
  // boundary and only reached BASE_LEVEL near the Core, so a 10 m strip of the
  // plaza carried fractional levels — which quantise into a maze of knee-high
  // walls right where the player walks between the fountain and the Core.
  { u: 48, v: 56, level: BASE_LEVEL },
  // Flat continuation to the Core. Both ends are BASE_LEVEL, so this leg carves
  // nothing: it exists to give the creeps a waypoint on the shelf.
  { u: 48, v: 44, level: BASE_LEVEL },
];

/**
 * Four complete routes: {portal A, portal B} × {left branch, right branch}.
 * Every one runs spawn → junction → trunk → branch → Core, so a unit only ever
 * needs its own polyline and never has to reason about the topology.
 *
 * Every consumer must iterate routes separately. Flattening them into one list
 * would create a phantom segment joining the end of one route to the start of
 * the next, and the terrain would carve a lane across open ground.
 */
export const LANE_ROUTES: readonly (readonly LaneNode[])[] = [
  [...LANE_DESCENT_A, ...LANE_TRUNK, ...LANE_AVENUE_LEFT, ...LANE_CORE_APPROACH],
  [...LANE_DESCENT_B, ...LANE_TRUNK, ...LANE_AVENUE_RIGHT, ...LANE_CORE_APPROACH],
  [...LANE_DESCENT_A, ...LANE_TRUNK, ...LANE_AVENUE_RIGHT, ...LANE_CORE_APPROACH],
  [...LANE_DESCENT_B, ...LANE_TRUNK, ...LANE_AVENUE_LEFT, ...LANE_CORE_APPROACH],
];

/** The two spawn portals, in mirrored space. */
export const PORTAL_NODES: readonly LaneNode[] = [
  LANE_DESCENT_A[0]!,
  LANE_DESCENT_B[0]!,
];

/** Route 0. Kept for consumers that only need one representative path. */
export const LANE_NODES: readonly LaneNode[] = LANE_ROUTES[0]!;

// ── Landmarks (GDD §5) ───────────────────────────────────────────────────────

export type LandmarkKind =
  | 'spawnPortal'
  | 'spawnPortalB'
  | 'core'
  | 'fountain'
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

/**
 * The base terrace holds the Core with the fountain in front of it and the two
 * shops flanking it, exactly as the route diagram above lays it out. Everything
 * a player needs between waves is within a few seconds' walk of the objective
 * they are defending, so shopping never means abandoning the Core.
 *
 * Footprints are sized so no two pads overlap and no pad is clipped by a lane
 * carve — a clipped pad comes out tilted, which the terrain validator rejects.
 */
export const LANDMARKS: readonly Landmark[] = [
  { kind: 'spawnPortal', u: 18, v: -84, radius: 10, level: 2 },
  { kind: 'spawnPortalB', u: 78, v: -84, radius: 10, level: 2 },
  // The Core caps the northern end of the climb from the bottom junction. The
  // shops flank it and the fountain sits just behind, all off the lane centre
  // by more than half-width + footprint so no carve tilts a pad.
  // The base cluster is squeezed into the corridor between the two avenues. A
  // pad has to clear the lane by half-width + feather + its own radius (~22 m)
  // or the lane carve drags it down to the lane's terrace — which is exactly
  // what the validator caught when the shops sat at u=30/66.
  { kind: 'core', u: 48, v: 44, radius: 9, level: BASE_LEVEL },
  { kind: 'shopProgression', u: 36, v: 30, radius: 6, level: BASE_LEVEL },
  { kind: 'shopSabotage', u: 60, v: 30, radius: 6, level: BASE_LEVEL },
  { kind: 'fountain', u: 48, v: 26, radius: 5.5, level: BASE_LEVEL },
  { kind: 'combatZone', u: 48, v: 66, radius: 10, level: 1 },
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
  return { dist: hypot(px - cx, pz - cz), t };
}

/** 1 inside `radius`, falling to 0 over `feather`. */
function diskMask(u: number, v: number, cu: number, cv: number, radius: number, feather: number): number {
  const d = hypot(u - cu, v - cv);
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
  /**
   * 0..1 corridor influence (lane or ramp). Cells the route carved must never
   * be touched by the smoothing passes downstream — the route wins over
   * everything, including the filters that clean up everything else.
   */
  carve: number;
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

  /**
   * Lane influence and the terrace level the lane holds at this point.
   *
   * Iterates each route separately: the routes share a head and a tail, so a
   * single flattened loop would carve a phantom segment from one route's end to
   * the next route's start.
   */
  const laneQuery = (u: number, v: number): { t: number; level: number } => {
    let bestT = 0;
    let bestLevel = 1;
    for (const route of LANE_ROUTES) {
      for (let i = 0; i < route.length - 1; i++) {
        const a = route[i]!;
        const b = route[i + 1]!;
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
    const relief =
      shape(u * 0.0125, z * 0.0125) * 0.85 +
      grain(u * 0.085, z * 0.085) * 0.3 +
      detail(u * 0.23, z * 0.23) * 0.11;

    // The base terrace is a built plaza, not a hillside. `macro` is added on
    // top of the already-quantised terrace height, so leaving it live here gave
    // the shelf a ±0.65 m swell — measured 4.51–5.82 m where the terrace is
    // 5.20 — which reads as lumpy ground under the Core and, worse, produced
    // local gradients steep enough for `canStand` to refuse a step, so the hero
    // snagged crossing his own base. Flattened completely inside, feathered out
    // over 6 m so the ramp onto the shelf still blends into the hillside.
    // Same rectangle the terrace itself is cut from (step 4), with a tighter
    // feather: the boundary lands on the cliff edge, where a seam is hidden by
    // the drop, so there is no need to give the blend the terrace's full 7 m.
    const plaza = rectMask(u, z, 26, 70, 18, 54, 3);
    return relief * (1 - plaza);
  };

  const sample = (u: number, v: number, out: Elevation): Elevation => {
    const av = Math.abs(v);

    // 1. Regional relief. Amplitude below 0.5 so it perturbs terrace outlines
    //    into organic shapes without ever moving a plateau by a whole level.
    //    The mid/high frequencies stop the quantised boundaries from running in
    //    long straight lines along the cell grid, but their amplitude is kept
    //    small: everything above ~0.15 here rides across the rounding boundary
    //    and shatters plateaus into cell-sized speckle (the v1 fragmentation
    //    bug — see the potential blur in field.ts, which is the other half of
    //    this fix).
    let e =
      1 +
      shape(u * 0.0165, v * 0.0165) * 0.44 +
      shape(u * 0.045, v * 0.045) * 0.13 +
      grain(u * 0.108, v * 0.108) * 0.14 +
      grain(u * 0.21, v * 0.21) * 0.06;

    // 2. Everything that is not the route or the base is HIGHLAND.
    //
    //    This is the load-bearing rule of the map. Previously the terrain was a
    //    broad walkable bowl with the lane scratched into it, so a melee hero
    //    could ignore the route entirely and cut straight from the Core to the
    //    portals — and the wave's path looked like a suggestion rather than a
    //    corridor. Now the default is a plateau four terraces above the lane
    //    (HIGHLAND - 1 = 4 levels ≈ 10.4 m of cliff), which is far beyond the
    //    1.6 m a unit can climb. The only ground below it is what the lane, the
    //    ramps and the landmark pads carve out.
    e += HIGHLAND - 1;

    // 3. Ridge crests, so the plateau between the lane legs reads as a mountain
    //    mass rather than one flat table.
    //    Kept clear of the base corridor (u 30–66, v 0–40) and of both avenues:
    //    a crest through the shelf splits it into disconnected pads, which the
    //    validator reports as landmarks unreachable from the spawn portal.
    e += 1.5 * (1 - smoothstep((segmentQuery(u, v, 48, -66, 48, -46).dist - 9) / 11));
    e += 1.3 * (1 - smoothstep((segmentQuery(u, v, 48, -30, 48, -14).dist - 9) / 11));
    e += 1.2 * (1 - smoothstep((segmentQuery(u, v, 24, 40, 24, 74).dist - 7) / 10));
    e += 1.2 * (1 - smoothstep((segmentQuery(u, v, 72, 40, 72, 74).dist - 7) / 10));

    // 4. The base terrace: one connected shelf holding the Core, the fountain
    //    and both shops. It sits a single step above the lane so it reads as a
    //    defended platform, and the final approach ramps onto it.
    //
    //    A HARD rectangle, not a feathered one. The 7 m feather this used to
    //    have meant the shelf only reached full strength well inside its own
    //    bounds: near the edge the surrounding highland still won the blend, so
    //    the plateau ended in a ragged fringe with knolls poking into it (a
    //    13.1 m spur at v=52 was inside what the player reads as the base) and
    //    the hero snagged on the resulting one-terrace steps. `* 1` rather than
    //    `* 0.98` for the same reason: the residual 2 % was 0.1 of a level of
    //    the highland's noise riding on every cell of the plaza.
    //
    //    The 1.5 m feather that remains is one cell wide — just enough to stop
    //    the boundary aliasing along the sample grid, not enough to slope.
    e = lerp(e, BASE_LEVEL, rectMask(u, v, BASE_RECT.u0, BASE_RECT.u1, BASE_RECT.v0, BASE_RECT.v1, 1.5));

    // 6. Landmark pads. Also hard inside the base, so a pad cannot dish or
    //    crown the shelf it stands on — the Core's plinth is geometry, and the
    //    terrain under it must simply be the plaza.
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
      pow(pow(nu, 5) + pow(nv, 5), 0.2) + shape(u * 0.03, v * 0.03) * 0.05;
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

    // 11. The base terrace, re-asserted.
    //
    //     Steps 4 and 6 place the shelf, but step 10 runs after them and must
    //     win everywhere else, so any lane or ramp that strays inside the
    //     rectangle used to gouge it. Re-applying here makes the plaza the one
    //     surface nothing may cut: a ramp has to arrive at the boundary already
    //     level, which is now what the Core approach does.
    const plaza = rectMask(u, v, BASE_RECT.u0, BASE_RECT.u1, BASE_RECT.v0, BASE_RECT.v1, 1.5);
    if (plaza > 0.001) e = lerp(e, BASE_LEVEL, plaza);

    const carved = Math.max(lane.t, ramp.t);
    const carvedLevel = lane.t >= ramp.t ? lane.level : ramp.level;

    out.e = clamp(e, MIN_LEVEL, MAX_LEVEL);
    out.lane = lane.t;
    out.gorge = gorge;
    out.carve = carved;
    // A carved corridor is a ramp only where its level is genuinely between
    // two terraces; flat stretches stay quantised so they keep their cliffs.
    out.ramp = carved > 0.55 && Math.abs(carvedLevel - Math.round(carvedLevel)) > 0.07;
    return out;
  };

  return { sample, macro };
}

/** World-space lane polyline for a team (team 0 = -X, team 1 = +X). */
export function lanePolyline(sign: number, route = 0): { x: number; z: number }[] {
  const nodes = LANE_ROUTES[route] ?? LANE_ROUTES[0]!;
  return nodes.map((n) => ({ x: sign * n.u, z: n.v }));
}

/** Number of independent enemy routes per site. */
export const LANE_COUNT = LANE_ROUTES.length;
