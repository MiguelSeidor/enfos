/**
 * Terrace field: the data model behind the terrain mesh. Owner: TERRAIN agent.
 *
 * The map is a grid of coarse cells, each holding four *corner* elevation
 * levels. Flat cells have four identical integer corners, which is what makes a
 * plateau read as a plateau; ramp cells keep fractional corners so they slope.
 * Because the corners belong to the cell (not to a shared vertex grid) two
 * neighbouring cells can sit at different levels — and the gap between them is
 * a cliff, generated as real geometry by `terrain.ts`.
 *
 * A continuous `macro()` displacement is added to every vertex at its world
 * position, so cells that share a level also share the exact same edge vertices
 * and the surface stays watertight without any welding pass.
 */

import {
  CELL,
  CELLS,
  LEVEL_STEP,
  LANE_ROUTES,
  LANDMARKS,
  MAP_HALF,
  MAP_SIZE,
  MAX_LEVEL,
  MIN_LEVEL,
  PLAY_RADIUS,
  WATER_LEVEL,
  createElevationField,
  inBaseTerrace,
  segmentQuery,
  type Elevation,
  type ElevationField,
} from './layout';
import { clamp, clamp01, lerp, smoothstep } from '@/core/mathx';
import type { MapOverlay } from './overlay';
import { atan, cos, hypot, sin } from '@/core/detmath';

/** Sample resolution of the cached height/AO lookup grid. */
const SAMPLE_RES = CELLS * 4 + 1; // 241 → 1 world unit
const SAMPLE_CELL = MAP_SIZE / (SAMPLE_RES - 1);

export interface CellQuery {
  level: number;
  ramp: boolean;
  lane: number;
  gorge: number;
}

/**
 * Inside a building, as opposed to inside its pad.
 *
 * Mirrored in x, like `landmarkDistance`: the map is symmetric and the
 * landmark table holds one side of it.
 */
function insideSolid(x: number, z: number): boolean {
  const u = Math.abs(x);
  for (const l of LANDMARKS) {
    if (!l.solid) continue;
    const dx = u - l.u;
    const dz = z - l.v;
    if (dx * dx + dz * dz < l.solid * l.solid) return true;
  }
  return false;
}

export class TerrainFieldData {
  /** Quantised level per coarse cell. */
  readonly level = new Int8Array(CELLS * CELLS);
  /** Four corner levels per cell, order: (0,0) (1,0) (1,1) (0,1). */
  readonly corners = new Float32Array(CELLS * CELLS * 4);
  readonly ramp = new Uint8Array(CELLS * CELLS);
  readonly carveMask = new Float32Array(CELLS * CELLS);
  readonly laneMask = new Float32Array(CELLS * CELLS);
  readonly gorgeMask = new Float32Array(CELLS * CELLS);
  readonly walkable = new Uint8Array(CELLS * CELLS);

  /** Cached top-surface height on a 1 m grid; used by heightAt(). */
  readonly heightGrid = new Float32Array(SAMPLE_RES * SAMPLE_RES);
  /** Baked horizon occlusion on the same grid; feeds the ground shader. */
  readonly aoGrid = new Float32Array(SAMPLE_RES * SAMPLE_RES);
  /** Max absolute level difference to a neighbouring cell. */
  readonly cliffiness = new Float32Array(CELLS * CELLS);

  readonly elevation: ElevationField;

  constructor(seed: number) {
    this.elevation = createElevationField(seed);
    this.buildLevels();
    this.buildCorners();
    this.buildHeightGrid();
    this.buildAo();
  }

  // ── Construction ───────────────────────────────────────────────────────────

  private buildLevels(): void {
    const out: Elevation = { e: 0, ramp: false, lane: 0, gorge: 0, carve: 0 };
    const raw = new Float32Array(CELLS * CELLS);

    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const x = -MAP_HALF + (i + 0.5) * CELL;
        const z = -MAP_HALF + (j + 0.5) * CELL;
        this.elevation.sample(Math.abs(x), z, out);
        const c = j * CELLS + i;
        raw[c] = out.e;
        this.ramp[c] = out.ramp ? 1 : 0;
        this.carveMask[c] = out.carve;
        this.laneMask[c] = out.lane;
        this.gorgeMask[c] = out.gorge;
      }
    }

    // Low-pass the potential before quantising. The regional noise rides right
    // on the rounding boundaries, and quantising it raw dithers every terrace
    // outline into cell-sized speckle — the v1 map fragmented into dozens of
    // knee-high islands. Two weighted 3×3 passes kill the dither while moving
    // an intended boundary by less than a cell. Carved corridors are exempt as
    // *targets*: the lane is authored last and must win over smoothing, or a
    // ridge neighbour bleeds in and pinches the route shut.
    const blurred = new Float32Array(CELLS * CELLS);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = 0; j < CELLS; j++) {
        for (let i = 0; i < CELLS; i++) {
          const c = j * CELLS + i;
          // The base terrace is exempt for the same reason carved corridors
          // are: it is authored as a hard-edged shelf, and smoothing its
          // boundary drags the neighbouring highland inward. Two passes reach
          // two cells, so a 3-terrace drop at the rim produced intermediate
          // levels a couple of cells *inside* the plaza — which quantise into a
          // maze of knee-high walls between the fountain and the Core, exactly
          // where the player walks.
          const bx = -MAP_HALF + (i + 0.5) * CELL;
          const bz = -MAP_HALF + (j + 0.5) * CELL;
          if (this.carveMask[c] > 0.35 || this.ramp[c] || inBaseTerrace(bx, bz)) {
            blurred[c] = raw[c];
            continue;
          }
          let sum = 0;
          let wsum = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const ni = i + di;
              const nj = j + dj;
              if (ni < 0 || nj < 0 || ni >= CELLS || nj >= CELLS) continue;
              const w = di === 0 && dj === 0 ? 2 : di === 0 || dj === 0 ? 1 : 0.5;
              sum += raw[nj * CELLS + ni]! * w;
              wsum += w;
            }
          }
          blurred[c] = sum / wsum;
        }
      }
      raw.set(blurred);
    }

    for (let c = 0; c < CELLS * CELLS; c++) {
      this.level[c] = clamp(Math.round(raw[c]!), MIN_LEVEL, MAX_LEVEL);
    }

    // Majority passes remove any single-cell speckle the blur left behind.
    for (let pass = 0; pass < 2; pass++) {
      const src = Int8Array.from(this.level);
      for (let j = 1; j < CELLS - 1; j++) {
        for (let i = 1; i < CELLS - 1; i++) {
          const c = j * CELLS + i;
          if (this.ramp[c] || this.carveMask[c] > 0.35) continue;
          const me = src[c];
          const n = [src[c - 1], src[c + 1], src[c - CELLS], src[c + CELLS]];
          let same = 0;
          let alt = n[0];
          let altCount = 0;
          for (const v of n) {
            if (v === me) same++;
          }
          for (const v of n) {
            let k = 0;
            for (const w of n) if (w === v) k++;
            if (v !== me && k > altCount) {
              altCount = k;
              alt = v;
            }
          }
          if (same <= 1 && altCount >= 3) this.level[c] = alt;
        }
      }
    }

    this.mergeSmallRegions();

    // Symmetry guard: force the +X half to mirror the -X half exactly. The
    // authored field is already mirrored, but rounding on the cell centre can
    // differ by one ULP; this makes the property exact by construction.
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS / 2; i++) {
        const a = j * CELLS + i;
        const b = j * CELLS + (CELLS - 1 - i);
        this.level[b] = this.level[a];
        this.ramp[b] = this.ramp[a];
        this.carveMask[b] = this.carveMask[a];
        this.laneMask[b] = this.laneMask[a];
        this.gorgeMask[b] = this.gorgeMask[a];
        raw[b] = raw[a];
      }
    }

    // Snapshot the generated result before any authored edit touches it. The
    // overlay stores *deltas*, so it needs a stable base to add to — and a
    // rebuild has to start from the generator's answer, not from the last
    // edited state, or repeated edits would compound.
    this.baseLevel = Int8Array.from(this.level);
    this.baseRamp = Uint8Array.from(this.ramp);
    this.deriveFromLevels();
  }

  /**
   * Everything downstream of `level`.
   *
   * Split out of `buildLevels` so the editor can re-run it after changing a few
   * cells. The expensive half is the elevation sampling and the blur above;
   * this half is a handful of linear passes over the grid and is fast enough to
   * run on every brush stroke.
   */
  private deriveFromLevels(): void {
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const c = j * CELLS + i;
        let maxDiff = 0;
        if (i > 0) maxDiff = Math.max(maxDiff, Math.abs(this.level[c] - this.level[c - 1]));
        if (i < CELLS - 1) maxDiff = Math.max(maxDiff, Math.abs(this.level[c] - this.level[c + 1]));
        if (j > 0) maxDiff = Math.max(maxDiff, Math.abs(this.level[c] - this.level[c - CELLS]));
        if (j < CELLS - 1)
          maxDiff = Math.max(maxDiff, Math.abs(this.level[c] - this.level[c + CELLS]));
        this.cliffiness[c] = maxDiff;

        const x = -MAP_HALF + (i + 0.5) * CELL;
        const z = -MAP_HALF + (j + 0.5) * CELL;
        const inPlay = Math.abs(x) < PLAY_RADIUS && Math.abs(z) < PLAY_RADIUS;
        const lvl = this.level[c];

        // Walkable is the *authored* route plus the base terrace — not simply
        // "anything below the highland".
        //
        // The level test alone marked 78 % of the map walkable, because the
        // central gorge leaves a continuous low bank running the full length of
        // the map beside the lane. A hero ordered across the map pathed along
        // that bank and skipped the corridor entirely; the lane read as
        // decoration. The route is the design (GDD §5) and this is what makes
        // it so for the player as well as for the creeps.
        //
        // 0.55 on the carve. The lane mask feathers from 1 to 0 across
        // `LANE_FEATHER`, and at a low threshold the walkable corridor spread
        // to roughly u±20 — wide enough to touch the base terrace's inner edge
        // at u=26. That contact is what let a hero step off the plaza straight
        // onto the avenue and skip the lane's entire northern loop. Cutting
        // just past the half-way point keeps a corridor comfortably wider than
        // a creep pack while leaving highland between the shelf and the lane.
        const onRoute = this.carveMask[c] > 0.55;
        const onBase = inBaseTerrace(x, z);
        // And nothing walks through a building. Until now the Core, the
        // fountain and both shops were scenery a unit passed straight
        // through, because the only thing standing between a unit and a prop
        // was the prop's own pad being walkable -- which it has to be, or
        // nobody could reach the shop counter.
        const solid = insideSolid(x, z);
        this.walkable[c] = !solid && inPlay && lvl >= 0 && lvl <= 4 && (onRoute || onBase) ? 1 : 0;
      }
    }
  }

  /**
   * Applies an authored overlay and rebuilds everything derived from it.
   *
   * Starts from `baseLevel` every time rather than from the current state, so
   * removing an edit genuinely removes it. Costs the derived passes plus the
   * corner, height and AO rebuilds — the elevation sampling and the blur, which
   * are the expensive parts, are not repeated.
   */
  applyOverlay(overlay: MapOverlay): void {
    this.level.set(this.baseLevel);
    this.ramp.set(this.baseRamp);
    for (const [key, delta] of Object.entries(overlay.terrain)) {
      const comma = key.indexOf(',');
      const ix = Number(key.slice(0, comma));
      const iz = Number(key.slice(comma + 1));
      if (!Number.isFinite(ix) || !Number.isFinite(iz)) continue;
      if (ix < 0 || iz < 0 || ix >= CELLS || iz >= CELLS) continue;
      const c = iz * CELLS + ix;
      this.level[c] = clamp(this.level[c] + delta, MIN_LEVEL, MAX_LEVEL);
      // Clearing the ramp flag is what makes the edit visible at all.
      // `buildCorners` treats a ramp cell as continuous and re-samples the
      // elevation field for its four corners, discarding `level` entirely — so
      // raising a cell on the lane or on an approach ramp changed the array and
      // nothing on screen. An authored cell is authored: it is flat at the
      // level it was given, and the generator no longer has a say.
      this.ramp[c] = 0;
    }
    this.deriveFromLevels();
    this.buildCorners();
    this.buildHeightGrid();
    this.buildAo();
  }

  /** Cell index for a world position, or null when outside the grid. */
  cellAt(x: number, z: number): { ix: number; iz: number } | null {
    const ix = Math.floor((x + MAP_HALF) / CELL);
    const iz = Math.floor((z + MAP_HALF) / CELL);
    if (ix < 0 || iz < 0 || ix >= CELLS || iz >= CELLS) return null;
    return { ix, iz };
  }

  /** Generated levels and ramp flags, before any authored edit. */
  private baseLevel = new Int8Array(0);
  private baseRamp = new Uint8Array(0);
  private rawLevels = new Float32Array(0);

  /**
   * Flood-fills connected components of equal level and absorbs any region too
   * small to stand on into the neighbouring level it shares the longest border
   * with. This is the difference between "noise that happens to be quantised"
   * and plateaus that read (and play) as authored terrain: after this pass
   * every terrace inside the play space is at least a handful of cells wide.
   * The rim mountains (level > 5) and the outer scenery ring are exempt — up
   * there the fragmentation *is* the craggy skyline.
   */
  private mergeSmallRegions(): void {
    const MIN_CELLS = 8; // 8 cells × 16 m² — smallest plateau worth keeping
    const MARGIN = PLAY_RADIUS + 12;
    const total = CELLS * CELLS;
    const stack = new Int32Array(total);
    const region = new Int32Array(total);

    for (let iter = 0; iter < 4; iter++) {
      let changed = false;
      const visited = new Uint8Array(total);

      for (let start = 0; start < total; start++) {
        if (visited[start] || this.ramp[start] || this.carveMask[start]! > 0.35) continue;
        const lvl = this.level[start]!;

        let head = 0;
        let size = 0;
        stack[head++] = start;
        visited[start] = 1;
        let eligible = lvl <= 5;
        const borders = new Map<number, number>();

        while (head > 0) {
          const c = stack[--head]!;
          region[size++] = c;
          const i = c % CELLS;
          const j = (c / CELLS) | 0;
          const x = -MAP_HALF + (i + 0.5) * CELL;
          const z = -MAP_HALF + (j + 0.5) * CELL;
          if (Math.abs(x) > MARGIN || Math.abs(z) > MARGIN) eligible = false;
          const left = i > 0 ? c - 1 : -1;
          const right = i < CELLS - 1 ? c + 1 : -1;
          const down = j > 0 ? c - CELLS : -1;
          const up = j < CELLS - 1 ? c + CELLS : -1;
          for (const n of [left, right, down, up]) {
            if (n < 0) continue;
            if (this.ramp[n] || this.carveMask[n]! > 0.35) continue;
            const nl = this.level[n]!;
            if (nl === lvl) {
              if (!visited[n]) {
                visited[n] = 1;
                stack[head++] = n;
              }
            } else {
              borders.set(nl, (borders.get(nl) ?? 0) + 1);
            }
          }
        }

        if (!eligible || size >= MIN_CELLS || borders.size === 0) continue;
        let bestLevel = lvl;
        let bestCount = -1;
        for (const [l, count] of borders) {
          if (count > bestCount) {
            bestCount = count;
            bestLevel = l;
          }
        }
        for (let k = 0; k < size; k++) this.level[region[k]!] = bestLevel;
        changed = true;
      }

      if (!changed) break;
    }
  }

  private buildCorners(): void {
    const out: Elevation = { e: 0, ramp: false, lane: 0, gorge: 0, carve: 0 };

    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const c = j * CELLS + i;
        const base = c * 4;
        if (!this.ramp[c]) {
          const l = this.level[c];
          this.corners[base] = l;
          this.corners[base + 1] = l;
          this.corners[base + 2] = l;
          this.corners[base + 3] = l;
          continue;
        }
        // Ramp cell: sample the continuous potential at the four corners so
        // adjacent ramp cells agree exactly and the slope stays unbroken.
        const cx = [0, 1, 1, 0];
        const cz = [0, 0, 1, 1];
        for (let k = 0; k < 4; k++) {
          const x = -MAP_HALF + (i + cx[k]) * CELL;
          const z = -MAP_HALF + (j + cz[k]) * CELL;
          this.elevation.sample(Math.abs(x), z, out);
          this.corners[base + k] = clamp(out.e, MIN_LEVEL, MAX_LEVEL);
        }
      }
    }

    // Weld ramp mouths to the plateaus they meet, so a ramp never leaves a
    // knee-high lip you would have to step over.
    const cornerCells: [number, number][][] = [
      [
        [-1, -1],
        [0, -1],
        [-1, 0],
      ],
      [
        [1, -1],
        [0, -1],
        [1, 0],
      ],
      [
        [1, 1],
        [0, 1],
        [1, 0],
      ],
      [
        [-1, 1],
        [0, 1],
        [-1, 0],
      ],
    ];
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++) {
        const c = j * CELLS + i;
        if (!this.ramp[c]) continue;
        for (let k = 0; k < 4; k++) {
          const value = this.corners[c * 4 + k];
          let bestDiff = 0.45;
          let snap = value;
          for (const [di, dj] of cornerCells[k]!) {
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= CELLS || nj >= CELLS) continue;
            const nc = nj * CELLS + ni;
            if (this.ramp[nc]) continue;
            const d = Math.abs(this.level[nc] - value);
            if (d < bestDiff) {
              bestDiff = d;
              snap = this.level[nc];
            }
          }
          this.corners[c * 4 + k] = snap;
        }
      }
    }

    // Mirror corners exactly: cell i maps to CELLS-1-i with the X corners swapped.
    for (let j = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS / 2; i++) {
        const a = (j * CELLS + i) * 4;
        const b = (j * CELLS + (CELLS - 1 - i)) * 4;
        this.corners[b] = this.corners[a + 1];
        this.corners[b + 1] = this.corners[a];
        this.corners[b + 2] = this.corners[a + 3];
        this.corners[b + 3] = this.corners[a + 2];
      }
    }
  }

  private buildHeightGrid(): void {
    for (let j = 0; j < SAMPLE_RES; j++) {
      for (let i = 0; i < SAMPLE_RES; i++) {
        const x = -MAP_HALF + i * SAMPLE_CELL;
        const z = -MAP_HALF + j * SAMPLE_CELL;
        this.heightGrid[j * SAMPLE_RES + i] = this.exactHeightAt(x, z);
      }
    }
  }

  /**
   * Horizon-based ambient occlusion baked into the terrain. This is what makes
   * cliff bases and canyon floors sit in shadow instead of glowing like the
   * plateau above them; the screen-space AO pass only reaches a few metres.
   */
  private buildAo(): void {
    const DIRS = 8;
    const STEPS = [2, 4, 7, 11, 17, 25];
    const dirX = new Float32Array(DIRS);
    const dirZ = new Float32Array(DIRS);
    for (let d = 0; d < DIRS; d++) {
      const a = (d / DIRS) * Math.PI * 2;
      dirX[d] = cos(a);
      dirZ[d] = sin(a);
    }

    for (let j = 0; j < SAMPLE_RES; j++) {
      for (let i = 0; i < SAMPLE_RES; i++) {
        const x = -MAP_HALF + i * SAMPLE_CELL;
        const z = -MAP_HALF + j * SAMPLE_CELL;
        const h = this.heightGrid[j * SAMPLE_RES + i];
        let occ = 0;
        for (let d = 0; d < DIRS; d++) {
          let maxSlope = 0;
          for (const r of STEPS) {
            const sx = x + dirX[d] * r;
            const sz = z + dirZ[d] * r;
            const sh = this.sampleHeightGrid(sx, sz);
            const slope = (sh - h) / r;
            if (slope > maxSlope) maxSlope = slope;
          }
          occ += maxSlope / (1 + maxSlope);
        }
        this.aoGrid[j * SAMPLE_RES + i] = clamp01(1 - (occ / DIRS) * 1.35);
      }
    }
  }

  private sampleHeightGrid(x: number, z: number): number {
    const fx = clamp((x + MAP_HALF) / SAMPLE_CELL, 0, SAMPLE_RES - 1.001);
    const fz = clamp((z + MAP_HALF) / SAMPLE_CELL, 0, SAMPLE_RES - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const g = this.heightGrid;
    const a = g[j * SAMPLE_RES + i];
    const b = g[j * SAMPLE_RES + i + 1];
    const c = g[(j + 1) * SAMPLE_RES + i];
    const d = g[(j + 1) * SAMPLE_RES + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  cellIndex(x: number, z: number): number {
    const i = clamp(Math.floor((x + MAP_HALF) / CELL), 0, CELLS - 1);
    const j = clamp(Math.floor((z + MAP_HALF) / CELL), 0, CELLS - 1);
    return j * CELLS + i;
  }

  /**
   * Exact top surface, discontinuous at cliffs. Used to build geometry.
   *
   * The +X half is evaluated by mirroring to −X: the corners are mirror-exact
   * and `macro()` is even in x, so the surface is symmetric — but a sample
   * landing exactly on a cliff edge (cell boundary) tie-breaks via `floor()`
   * toward +x on *both* halves, picking the cliff top on one side and the
   * cliff base on the other. Mirroring the query resolves every tie the same
   * way and makes `heightAt` symmetric to the last bit.
   */
  exactHeightAt(x: number, z: number): number {
    if (x > 0) x = -x;
    const fx = clamp((x + MAP_HALF) / CELL, 0, CELLS - 0.0001);
    const fz = clamp((z + MAP_HALF) / CELL, 0, CELLS - 0.0001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    return this.cellSurface(i, j, fx - i, fz - j);
  }

  /** Bilinear corner interpolation inside one cell, plus continuous detail. */
  cellSurface(i: number, j: number, tu: number, tv: number): number {
    const base = (j * CELLS + i) * 4;
    const c0 = this.corners[base];
    const c1 = this.corners[base + 1];
    const c2 = this.corners[base + 2];
    const c3 = this.corners[base + 3];
    const top = lerp(lerp(c0, c1, tu), lerp(c3, c2, tu), tv);
    const x = -MAP_HALF + (i + tu) * CELL;
    const z = -MAP_HALF + (j + tv) * CELL;
    return top * LEVEL_STEP + this.elevation.macro(x, z);
  }

  /** Smoothed height for gameplay, camera and props. Never NaN, never jumps. */
  heightAt(x: number, z: number): number {
    return this.sampleHeightGrid(x, z);
  }

  aoAt(x: number, z: number): number {
    const fx = clamp((x + MAP_HALF) / SAMPLE_CELL, 0, SAMPLE_RES - 1.001);
    const fz = clamp((z + MAP_HALF) / SAMPLE_CELL, 0, SAMPLE_RES - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const g = this.aoGrid;
    const a = g[j * SAMPLE_RES + i];
    const b = g[j * SAMPLE_RES + i + 1];
    const c = g[(j + 1) * SAMPLE_RES + i];
    const d = g[(j + 1) * SAMPLE_RES + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  /** Surface slope in radians, from the smoothed grid. */
  slopeAt(x: number, z: number): number {
    const e = 1.2;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return atan(hypot(dx, dz) / (2 * e));
  }

  levelAt(x: number, z: number): number {
    return this.level[this.cellIndex(x, z)];
  }

  isRamp(x: number, z: number): boolean {
    return this.ramp[this.cellIndex(x, z)] === 1;
  }

  isWalkable(x: number, z: number): boolean {
    return this.walkable[this.cellIndex(x, z)] === 1;
  }

  /** True where the water plane sits above the ground. */
  isUnderwater(x: number, z: number): boolean {
    return this.heightAt(x, z) < WATER_LEVEL - 0.05;
  }

  waterDepth(x: number, z: number): number {
    return WATER_LEVEL - this.heightAt(x, z);
  }

  /**
   * Distance to the nearest lane centreline, in world units.
   *
   * Walks each route separately — the two routes share a head and a tail, so a
   * flattened loop would measure against a phantom segment joining one route's
   * end to the next route's start.
   */
  laneDistance(x: number, z: number): number {
    const u = Math.abs(x);
    let best = 1e9;
    for (const route of LANE_ROUTES) {
      for (let i = 0; i < route.length - 1; i++) {
        const a = route[i]!;
        const b = route[i + 1]!;
        const d = segmentQuery(u, z, a.u, a.v, b.u, b.v).dist;
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** Distance to the nearest landmark footprint edge (negative when inside). */
  landmarkDistance(x: number, z: number): number {
    const u = Math.abs(x);
    let best = 1e9;
    for (const l of LANDMARKS) {
      if (l.kind === 'combatZone') continue;
      const d = hypot(u - l.u, z - l.v) - l.radius;
      if (d < best) best = d;
    }
    return best;
  }

  /** True near a terrace edge, where a prop would hang over the drop. */
  nearCliff(x: number, z: number, margin = 1.6): boolean {
    const c = this.cellIndex(x, z);
    if (this.cliffiness[c] > 0.5) {
      const lx = ((x + MAP_HALF) % CELL + CELL) % CELL;
      const lz = ((z + MAP_HALF) % CELL + CELL) % CELL;
      if (lx < margin || lx > CELL - margin || lz < margin || lz > CELL - margin) return true;
    }
    return this.slopeAt(x, z) > 0.55;
  }

  /**
   * How exposed a point is; 0 deep in a canyon, 1 on an open plateau. Used to
   * bias vegetation so the highlands read as woodland and the basin as churned
   * battle ground.
   */
  opennessAt(x: number, z: number): number {
    return clamp01((this.aoAt(x, z) - 0.55) / 0.42);
  }

  rawLevelAt(x: number, z: number): number {
    return this.rawLevels[this.cellIndex(x, z)];
  }
}

/**
 * Ground splat weights at a world position. Order matches the control map:
 * grass, dirt, rock, path. Returned normalised.
 */
export function splatAt(field: TerrainFieldData, x: number, z: number, out: Float32Array): void {
  const h = field.heightAt(x, z);
  const slope = field.slopeAt(x, z);
  const laneD = field.laneDistance(x, z);
  const depth = WATER_LEVEL - h;

  // Rock takes over on anything steep, on the high shelves, and in the river bed.
  const steep = smoothstep((slope - 0.34) / 0.30);
  const alpine = smoothstep((h - 13.5) / 6);
  const bed = smoothstep((depth + 0.4) / 1.2);
  let rock = clamp01(Math.max(steep, alpine * 0.9, bed * 0.75));

  // Worn path: hard core, trodden shoulder.
  const path = clamp01(1 - smoothstep((laneD - 5.2) / 4.4));

  // Dirt: path shoulders, shorelines, cliff aprons, and the churned basin.
  const shoulder = clamp01(1 - smoothstep((laneD - 9) / 7)) * (1 - path);
  const shore = clamp01(1 - smoothstep((Math.abs(depth) - 1.1) / 2.0));
  const apron = smoothstep((slope - 0.17) / 0.2) * (1 - steep);
  // Landmark plazas are trodden bare only in their inner half; leaving the
  // outer ring green keeps the pads from bleeding into one brown smear.
  const plaza = clamp01(1 - smoothstep((field.landmarkDistance(x, z) + 5) / 4));
  let dirt = clamp01(Math.max(shoulder, shore * 0.85, apron, plaza * 0.75));

  rock = clamp01(rock);
  dirt = clamp01(dirt * (1 - rock * 0.65));
  const pathW = path * (1 - rock * 0.7);
  const grass = clamp01(1 - Math.max(rock, Math.max(dirt, pathW)));

  const sum = grass + dirt + rock + pathW || 1;
  out[0] = grass / sum;
  out[1] = dirt / sum;
  out[2] = rock / sum;
  out[3] = pathW / sum;
}

export { SAMPLE_RES, SAMPLE_CELL };
