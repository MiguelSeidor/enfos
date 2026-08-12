/**
 * Content registry. All balanceable content is data-driven (GDD §25) and
 * resolved through here, so QA/balance workers can swap tables without touching
 * gameplay code.
 */

import type { DefId } from './contracts';

export class Registry<T extends { id: DefId }> {
  private readonly items = new Map<DefId, T>();

  constructor(public readonly name: string) {}

  add(item: T): T {
    if (this.items.has(item.id)) {
      throw new Error(`[${this.name}] duplicate definition id: ${item.id}`);
    }
    this.items.set(item.id, item);
    return item;
  }

  addAll(items: readonly T[]): void {
    for (const item of items) this.add(item);
  }

  get(id: DefId): T {
    const item = this.items.get(id);
    if (!item) throw new Error(`[${this.name}] unknown definition id: ${id}`);
    return item;
  }

  tryGet(id: DefId): T | undefined {
    return this.items.get(id);
  }

  has(id: DefId): boolean {
    return this.items.has(id);
  }

  all(): T[] {
    return [...this.items.values()];
  }

  ids(): DefId[] {
    return [...this.items.keys()];
  }

  filter(pred: (item: T) => boolean): T[] {
    return this.all().filter(pred);
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}

/** Thrown by validation passes so CI reports every issue at once. */
export class ContentValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Content validation failed with ${issues.length} issue(s):\n  ${issues.join('\n  ')}`);
    this.name = 'ContentValidationError';
  }
}
