/**
 * Unit presentation layer. Owner: CHARACTERS agent.
 *
 * Bridges simulation `UnitState` to renderable meshes. Heroes and bosses get
 * individual skinned meshes; creeps render through instanced batches keyed by
 * definition id, so 300 enemies cost a handful of draw calls (GDD §18).
 *
 * Interpolates between the last two simulation ticks so 30 Hz gameplay reads as
 * smooth motion at display rate.
 */

import * as THREE from 'three';
import type { GameContext, GameModule, EntityId, UnitState, VisualDescriptor } from '@/core/contracts';
import { UnitViewKey, type UnitViewService } from '@/core/services';

interface ViewRecord {
  object: THREE.Object3D;
  prevPos: { x: number; z: number };
  prevFacing: number;
}

export class UnitViewModule implements GameModule {
  readonly id = 'unitView';
  readonly order = 800;

  private readonly root = new THREE.Group();
  private readonly views = new Map<EntityId, ViewRecord>();

  init(ctx: GameContext): void {
    this.root.name = 'units';
    ctx.scene.add(this.root);

    const service: UnitViewService = {
      attach: (unit, visual) => this.attach(unit, visual),
      detach: (id) => this.detach(id),
      playAnimation: () => {},
      sync: (alpha, dt) => this.sync(alpha, dt),
    };
    ctx.services.register(UnitViewKey, service);
  }

  private attach(_unit: UnitState, _visual: VisualDescriptor): void {
    // CHARACTERS agent: build the mesh here.
  }

  private detach(id: EntityId): void {
    const view = this.views.get(id);
    if (!view) return;
    view.object.removeFromParent();
    this.views.delete(id);
  }

  private sync(_alpha: number, _dt: number): void {
    // CHARACTERS agent: interpolate transforms and advance animation here.
  }

  update(dt: number, _ctx: GameContext): void {
    this.sync(0, dt);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.views.clear();
  }
}
