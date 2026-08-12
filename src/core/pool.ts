/**
 * Object pooling. Required by GDD §18 — hundreds of enemies, projectiles and
 * VFX must not allocate per frame.
 */

export class Pool<T> {
  private readonly free: T[] = [];
  private liveCount = 0;

  constructor(
    private readonly factory: () => T,
    private readonly reset: (item: T) => void,
    prewarm = 0,
    private readonly hardLimit = Infinity,
  ) {
    for (let i = 0; i < prewarm; i++) this.free.push(factory());
  }

  acquire(): T | null {
    if (this.free.length > 0) {
      this.liveCount++;
      return this.free.pop()!;
    }
    if (this.liveCount >= this.hardLimit) return null;
    this.liveCount++;
    return this.factory();
  }

  release(item: T): void {
    this.reset(item);
    this.free.push(item);
    this.liveCount = Math.max(0, this.liveCount - 1);
  }

  get live(): number {
    return this.liveCount;
  }

  get pooled(): number {
    return this.free.length;
  }

  drain(dispose: (item: T) => void): void {
    for (const item of this.free) dispose(item);
    this.free.length = 0;
    this.liveCount = 0;
  }
}

/**
 * Dense array with a free-list of indices. Iteration stays cache-friendly and
 * ids remain stable, which the render layer relies on for instance slots.
 */
export class SlotMap<T> {
  private readonly items: (T | undefined)[] = [];
  private readonly freeIds: number[] = [];
  private count = 0;

  insert(item: T): number {
    const id = this.freeIds.pop();
    if (id !== undefined) {
      this.items[id] = item;
      this.count++;
      return id;
    }
    this.items.push(item);
    this.count++;
    return this.items.length - 1;
  }

  get(id: number): T | undefined {
    return this.items[id];
  }

  remove(id: number): void {
    if (this.items[id] === undefined) return;
    this.items[id] = undefined;
    this.freeIds.push(id);
    this.count--;
  }

  get size(): number {
    return this.count;
  }

  get capacity(): number {
    return this.items.length;
  }

  forEach(fn: (item: T, id: number) => void): void {
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (item !== undefined) fn(item, i);
    }
  }

  clear(): void {
    this.items.length = 0;
    this.freeIds.length = 0;
    this.count = 0;
  }
}
