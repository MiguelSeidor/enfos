/**
 * Environment props: rocks, trees, vegetation, ruins, ambient dressing.
 * Owner: TERRAIN agent.
 *
 * The bar (GDD §16, qa/REVIEW_RUBRIC.md §5): no empty ground inside the play
 * space. Everything here must be instanced and frustum-culled — this module is
 * allowed to add thousands of objects but only a handful of draw calls.
 *
 * v0 is intentionally empty so the module wiring is in place; filling it is the
 * TERRAIN agent's first task.
 */

import * as THREE from 'three';
import type { GameContext, GameModule } from '@/core/contracts';
import { TerrainKey } from '@/core/services';

export class PropsModule implements GameModule {
  readonly id = 'props';
  readonly order = 110;

  private readonly root = new THREE.Group();

  init(ctx: GameContext): void {
    this.root.name = 'props';
    ctx.scene.add(this.root);
    // Terrain must exist first; props are scattered against its height field.
    void ctx.services.get(TerrainKey);
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
