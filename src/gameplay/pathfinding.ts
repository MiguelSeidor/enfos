/**
 * Grid A* over the walkable surface. Owner: GAMEPLAY.
 *
 * ## Why this exists
 *
 * Heroes used to steer straight at the ordered position. On a terraced map that
 * is not a path: the seek vector pushes into a cliff, `canStand` refuses every
 * candidate step, and the hero grinds against the wall until the player gives a
 * different order. Ordering a move to the far side of the map did nothing at
 * all. This turns an order into a route the hero can actually walk.
 *
 * Creeps are deliberately **not** routed through here — they follow the authored
 * lane, which is the design (GDD §5) and costs nothing. A hundred agents
 * replanning would dominate the tick for a path that never changes.
 *
 * ## Shape of the search
 *
 * The grid is coarser than the terrain field. `NODE` is a bit under the hero's
 * diameter, which keeps the node count low enough to search the whole map
 * inside a frame while still fitting through the lane's narrowest neck. Costs
 * are integer-ish and the heuristic is octile distance, which is admissible for
 * 8-way movement and therefore yields optimal paths.
 *
 * Traversability uses the same rule the mover does — walkable, and the gradient
 * between two adjacent nodes within `maxSlope` — so a path is never returned
 * that `canStand` will then refuse step by step.
 */

import type { Vec2 } from '@/core/contracts';
import type { TerrainService } from '@/core/services';
import { hypot } from '@/core/detmath';

/** Node spacing in metres. */
const NODE = 2;
/**
 * Hard ceiling on nodes expanded per search.
 *
 * A full-map route is roughly 3,000 nodes; 20,000 leaves generous headroom for
 * a pathological case while bounding the worst frame. Exceeding it returns the
 * best partial route rather than nothing, so an unreachable click still walks
 * the hero as close as the terrain allows instead of freezing them.
 */
const MAX_EXPANSIONS = 20000;

/** Diagonal cost, for octile distance. */
const SQRT2 = Math.SQRT2;

/**
 * Directions probed around a node to test that a body fits there.
 *
 * Cardinals only. A diagonal probe at the same radius lies further from the
 * centre than the disc actually reaches, so including them rejects corridors
 * that are genuinely wide enough.
 */
const CLEARANCE_PROBES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Minimal binary heap keyed by f-score.
 *
 * A sorted array was the obvious first cut and profiled badly: the open set
 * reaches a few thousand entries on a cross-map route and `splice` on every
 * push made the search quadratic.
 */
class MinHeap {
  private readonly keys: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, value: number): void {
    this.keys.push(key);
    this.values.push(value);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent]! <= this.keys[i]!) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.values[0]!;
    const lastKey = this.keys.pop()!;
    const lastValue = this.values.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastKey;
      this.values[0] = lastValue;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[smallest]!) smallest = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[smallest]!) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  clear(): void {
    this.keys.length = 0;
    this.values.length = 0;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a]!;
    this.keys[a] = this.keys[b]!;
    this.keys[b] = k;
    const v = this.values[a]!;
    this.values[a] = this.values[b]!;
    this.values[b] = v;
  }
}

export class PathFinder {
  private readonly open = new MinHeap();
  /** Scratch maps keyed by packed node index; cleared per search. */
  private readonly gScore = new Map<number, number>();
  private readonly cameFrom = new Map<number, number>();
  private readonly closed = new Set<number>();

  constructor(
    private readonly terrain: TerrainService,
    private readonly halfExtent: number,
    private readonly maxSlope: number,
    /**
     * How much walkable room a node needs around it, in metres.
     *
     * The planner is a point search; the thing walking the path is a disc. A
     * route that threads the exact edge of a terrace is valid for a point and
     * impossible for a body — the mover's own `canStand` refuses the step as
     * soon as the unit's centre drifts a few centimetres toward the drop, and
     * the hero stops on a path the planner swore was fine. Requiring clearance
     * pushes routes off the lip.
     */
    private readonly clearance: number,
  ) {}

  /** Grid width in nodes. Packing depends on it, so it is computed once. */
  private get span(): number {
    return Math.ceil((this.halfExtent * 2) / NODE) + 1;
  }

  private pack(ix: number, iz: number): number {
    return iz * this.span + ix;
  }

  private toIndex(v: number): number {
    return Math.round((v + this.halfExtent) / NODE);
  }

  private toWorld(i: number): number {
    return i * NODE - this.halfExtent;
  }

  /**
   * Same rule the mover applies, sampled along the leg.
   *
   * Endpoint-only testing is not equivalent and the difference is not subtle.
   * The height field is interpolated, so a 2 m leg that starts and ends on a
   * cliff face gains 2.6 m over 2 m — slope 1.3, correctly rejected — but a leg
   * that merely *crosses* the lip gains little end to end while passing through
   * a section far steeper than the cap. The planner approved those, the mover
   * refused them a fraction of a metre in, and the hero stopped dead partway
   * along a route the planner insisted was fine.
   *
   * `SAMPLE` is well under the mover's own step so the planner is never more
   * permissive than the thing that has to walk it.
   */
  /**
   * Is there room for a body of `clearance` radius centred here?
   *
   * Four cardinal probes, not eight: a diagonal probe at the same radius sits
   * further from the centre than the disc actually reaches, which rejects legal
   * corridors. Cardinals under-approximate slightly, which is the safe
   * direction for a test whose failure mode is a hero stuck against a wall.
   */
  private hasRoom(x: number, z: number): boolean {
    const r = this.clearance;
    if (r <= 0 || this.relaxed) return true;

    // Walkability is not enough, and assuming it was is what let routes hug the
    // shoulder of a ramp: the shoulder is perfectly walkable ground that
    // happens to sit a metre from a 2.8 m drop. The hero, steering at a
    // waypoint two nodes away, drifted onto it and then could not climb back,
    // because `canStand` rejects the gradient it was now facing. So the probes
    // check the gradient too, in both directions — the top of a cliff snags a
    // body as readily as the foot of one.
    const here = this.terrain.heightAt(x, z);
    const limit = this.maxSlope * r;
    for (const [dx, dz] of CLEARANCE_PROBES) {
      const px = x + dx * r;
      const pz = z + dz * r;
      if (!this.terrain.isWalkable(px, pz)) return false;
      if (Math.abs(this.terrain.heightAt(px, pz) - here) > limit) return false;
    }
    return true;
  }

  private canStep(fromX: number, fromZ: number, toX: number, toZ: number): boolean {
    if (!this.terrain.isWalkable(toX, toZ)) return false;
    if (!this.hasRoom(toX, toZ)) return false;
    const run = hypot(toX - fromX, toZ - fromZ);
    if (run < 1e-4) return true;

    const SAMPLE = 0.5;
    const steps = Math.max(1, Math.ceil(run / SAMPLE));
    let prevX = fromX;
    let prevZ = fromZ;
    let prevH = this.terrain.heightAt(fromX, fromZ);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = fromX + (toX - fromX) * t;
      const z = fromZ + (toZ - fromZ) * t;
      if (!this.terrain.isWalkable(x, z)) return false;
      const h = this.terrain.heightAt(x, z);
      const subRun = hypot(x - prevX, z - prevZ);
      if (subRun > 1e-4 && (h - prevH) / subRun > this.maxSlope) return false;
      prevX = x;
      prevZ = z;
      prevH = h;
    }
    return true;
  }

  /**
   * Routes from `start` to `goal`.
   *
   * Returns waypoints in world space, excluding the start. An empty array means
   * the goal is the current node — the caller should simply not move.
   *
   * When the goal is unreachable the search still returns the route to whatever
   * it got closest to. A click on a cliff top should walk to the foot of the
   * cliff, not be silently discarded.
   */
  find(start: Vec2, goal: Vec2): Vec2[] {
    const path = this.search(start, goal);
    if (path.length > 0) return path;

    // Nothing at all. Almost always this means the unit is already standing
    // somewhere too tight to satisfy the clearance test — shoved against a
    // cliff by a creep pack, most often — so every neighbour is rejected and
    // the hero would simply refuse to move. Retry as a point search: a cramped
    // route out is better than none, and one step later the normal search
    // applies again.
    const saved = this.relaxed;
    this.relaxed = true;
    const escape = this.search(start, goal);
    this.relaxed = saved;
    return escape;
  }

  private relaxed = false;

  private search(start: Vec2, goal: Vec2): Vec2[] {
    const sx = this.toIndex(start.x);
    const sz = this.toIndex(start.z);
    const gx = this.toIndex(goal.x);
    const gz = this.toIndex(goal.z);
    if (sx === gx && sz === gz) return [];

    this.open.clear();
    this.gScore.clear();
    this.cameFrom.clear();
    this.closed.clear();

    const startKey = this.pack(sx, sz);
    const goalKey = this.pack(gx, gz);
    this.gScore.set(startKey, 0);
    this.open.push(this.heuristic(sx, sz, gx, gz), startKey);

    // Tracked so an unreachable goal still produces useful movement.
    let bestKey = startKey;
    let bestH = this.heuristic(sx, sz, gx, gz);
    let expansions = 0;

    while (this.open.size > 0 && expansions < MAX_EXPANSIONS) {
      const current = this.open.pop();
      if (current === goalKey) return this.reconstruct(current);
      if (this.closed.has(current)) continue;
      this.closed.add(current);
      expansions++;

      const cx = current % this.span;
      const cz = (current - cx) / this.span;
      const wx = this.toWorld(cx);
      const wz = this.toWorld(cz);
      const g = this.gScore.get(current)!;

      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= this.span || nz >= this.span) continue;
          const neighbourKey = this.pack(nx, nz);
          if (this.closed.has(neighbourKey)) continue;

          const nwx = this.toWorld(nx);
          const nwz = this.toWorld(nz);
          if (!this.canStep(wx, wz, nwx, nwz)) continue;
          // Diagonals may not cut a corner between two blocked orthogonals, or
          // a unit clips the inside edge of a cliff and the mover refuses the
          // step the path promised.
          if (dx !== 0 && dz !== 0) {
            if (!this.canStep(wx, wz, this.toWorld(nx), wz)) continue;
            if (!this.canStep(wx, wz, wx, this.toWorld(nz))) continue;
          }

          const stepCost = (dx !== 0 && dz !== 0 ? SQRT2 : 1) * NODE;
          const tentative = g + stepCost;
          const known = this.gScore.get(neighbourKey);
          if (known !== undefined && tentative >= known) continue;

          this.gScore.set(neighbourKey, tentative);
          this.cameFrom.set(neighbourKey, current);
          const h = this.heuristic(nx, nz, gx, gz);
          if (h < bestH) {
            bestH = h;
            bestKey = neighbourKey;
          }
          this.open.push(tentative + h, neighbourKey);
        }
      }
    }

    return this.reconstruct(bestKey);
  }

  /** Octile distance: admissible for 8-way movement, so A* stays optimal. */
  private heuristic(ax: number, az: number, bx: number, bz: number): number {
    const dx = Math.abs(ax - bx);
    const dz = Math.abs(az - bz);
    return (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)) * NODE;
  }

  /**
   * Walks `cameFrom` back to the start, then simplifies.
   *
   * Raw grid output is one waypoint every 2 m, most of them collinear. Dropping
   * the collinear ones cuts the list by an order of magnitude and, more
   * importantly, stops the hero from visibly stair-stepping along diagonals.
   */
  private reconstruct(endKey: number): Vec2[] {
    const keys: number[] = [endKey];
    let cursor = endKey;
    while (this.cameFrom.has(cursor)) {
      cursor = this.cameFrom.get(cursor)!;
      keys.push(cursor);
    }
    keys.reverse();
    // Index 0 is the node the unit is standing on.
    keys.shift();

    const out: Vec2[] = [];
    let prevDx = NaN;
    let prevDz = NaN;
    let prevX = NaN;
    let prevZ = NaN;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const ix = key % this.span;
      const iz = (key - ix) / this.span;
      const x = this.toWorld(ix);
      const z = this.toWorld(iz);
      if (i > 0) {
        const dx = Math.sign(x - prevX);
        const dz = Math.sign(z - prevZ);
        if (dx === prevDx && dz === prevDz) {
          // Collinear with the previous leg: replace rather than append.
          out[out.length - 1] = { x, z };
          prevX = x;
          prevZ = z;
          continue;
        }
        prevDx = dx;
        prevDz = dz;
      }
      out.push({ x, z });
      prevX = x;
      prevZ = z;
    }
    return out;
  }
}
