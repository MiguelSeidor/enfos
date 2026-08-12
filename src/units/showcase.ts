/**
 * Character showcase. Owner: CHARACTERS agent.
 *
 * A dev-only line-up that places one of every buildable character on flat ground
 * in front of the review camera, so mesh construction, rigging and animation can
 * be reviewed visually before gameplay exists to spawn them.
 *
 * Enabled with `?showcase=1`. The headless capture harness turns it on for the
 * `characters` shot.
 */

import * as THREE from 'three';
import type { GameContext, GameModule } from '@/core/contracts';
import { TerrainKey } from '@/core/services';

/** Where the showcase line-up stands. The capture harness points a shot here. */
export const SHOWCASE_ORIGIN = { x: 0, z: -88 };
export const SHOWCASE_SPACING = 4.5;

export class ShowcaseModule implements GameModule {
  readonly id = 'showcase';
  readonly order = 820;

  private readonly root = new THREE.Group();

  init(ctx: GameContext): void {
    this.root.name = 'showcase';
    const terrain = ctx.services.get(TerrainKey);
    this.root.position.set(
      SHOWCASE_ORIGIN.x,
      terrain.heightAt(SHOWCASE_ORIGIN.x, SHOWCASE_ORIGIN.z),
      SHOWCASE_ORIGIN.z,
    );
    ctx.scene.add(this.root);
  }

  dispose(): void {
    this.root.removeFromParent();
  }
}
