/**
 * Uniform spatial hash for broad-phase queries (targeting, AoE, separation).
 * O(1) insert, O(k) neighbourhood query. Rebuilt each simulation step.
 *
 * Chosen over a quadtree because unit density is high and uniform across the
 * lanes; rebuild cost is a single pass and there is no tree churn.
 */

import type { EntityId, Vec2 } from './contracts';

export class SpatialHash {
  private readonly cells = new Map<number, EntityId[]>();
  private readonly positions = new Map<EntityId, Vec2>();
  private readonly invCell: number;

  constructor(private readonly cellSize = 8) {
    this.invCell = 1 / cellSize;
  }

  clear(): void {
    this.cells.clear();
    this.positions.clear();
  }

  private key(cx: number, cz: number): number {
    // Pack two 16-bit signed cell coords into one integer key.
    return ((cx + 32768) << 16) | (cz + 32768);
  }

  insert(id: EntityId, pos: Vec2): void {
    const cx = Math.floor(pos.x * this.invCell);
    const cz = Math.floor(pos.z * this.invCell);
    const k = this.key(cx, cz);
    let bucket = this.cells.get(k);
    if (!bucket) {
      bucket = [];
      this.cells.set(k, bucket);
    }
    bucket.push(id);
    this.positions.set(id, pos);
  }

  /**
   * Collects ids whose stored position lies within `radius` of `pos`.
   * `out` is reused by the caller to avoid per-query allocation.
   */
  query(pos: Vec2, radius: number, out: EntityId[]): EntityId[] {
    out.length = 0;
    const r2 = radius * radius;
    const minX = Math.floor((pos.x - radius) * this.invCell);
    const maxX = Math.floor((pos.x + radius) * this.invCell);
    const minZ = Math.floor((pos.z - radius) * this.invCell);
    const maxZ = Math.floor((pos.z + radius) * this.invCell);

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.cells.get(this.key(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i++) {
          const id = bucket[i]!;
          const p = this.positions.get(id)!;
          const dx = p.x - pos.x;
          const dz = p.z - pos.z;
          if (dx * dx + dz * dz <= r2) out.push(id);
        }
      }
    }
    return out;
  }

  /** Nearest id matching `filter`, or null. Expands ring by ring. */
  nearest(
    pos: Vec2,
    maxRadius: number,
    filter: (id: EntityId) => boolean,
  ): EntityId | null {
    let best: EntityId | null = null;
    let bestD2 = maxRadius * maxRadius;
    const step = this.cellSize;
    const rings = Math.ceil(maxRadius / step);

    for (let ring = 0; ring <= rings; ring++) {
      const cx0 = Math.floor(pos.x * this.invCell);
      const cz0 = Math.floor(pos.z * this.invCell);
      for (let cx = cx0 - ring; cx <= cx0 + ring; cx++) {
        for (let cz = cz0 - ring; cz <= cz0 + ring; cz++) {
          // Only walk the ring perimeter; inner cells were covered already.
          if (ring > 0 && Math.abs(cx - cx0) !== ring && Math.abs(cz - cz0) !== ring) continue;
          const bucket = this.cells.get(this.key(cx, cz));
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i++) {
            const id = bucket[i]!;
            if (!filter(id)) continue;
            const p = this.positions.get(id)!;
            const dx = p.x - pos.x;
            const dz = p.z - pos.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = id;
            }
          }
        }
      }
      // A hit inside the current ring cannot be beaten by an outer ring.
      if (best !== null && Math.sqrt(bestD2) <= ring * step) break;
    }
    return best;
  }

  get occupancy(): number {
    return this.cells.size;
  }
}
