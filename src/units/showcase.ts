/**
 * Character showcase. Owner: CHARACTERS agent.
 *
 * A dev-only line-up that places one of every buildable character on flat ground
 * in front of the review camera, so mesh construction, rigging and animation can
 * be reviewed visually before gameplay exists to spawn them.
 *
 * Layout is driven by the fixed `characters` capture shot (focus 0,-88, zoom
 * 0.06, yaw 0 — the eye sits at +Z looking toward -Z, ~19 units out, which frames
 * roughly 22 world units of ground). Eight figures at 4.5 spacing will not fit
 * one line, so the skinned figures stand in two rows facing the camera and the
 * instanced VAT packs march in the background — every code path on screen in a
 * single frame:
 *
 *   front  bulwark(attack+trail)  oracle(cast)  cleaver(attack+trail)
 *          spinebolt(shoot)       duskrunner(run)
 *   back   hexwright(cast)        titan(idle)   bastion(death loop)
 *   rear   creep pack x2 — CreepBatch instances playing walk/run via VAT
 *
 * One-shot clips replay on a short cadence so anticipation and follow-through
 * can be watched repeatedly; the death figure loops with a longer rest.
 *
 * Enabled with `?showcase=1`. The headless capture harness turns it on for the
 * `characters` shot.
 */

import * as THREE from 'three';
import type { GameContext, GameModule } from '@/core/contracts';
import { TerrainKey, type TerrainService } from '@/core/services';
import { buildCharacter, getCharacter, type BuiltCharacter } from './catalog';
import { HeroView, type TrailSpec } from './render/heroView';
import { CreepBatch, makeVatGeometry } from './render/creepBatch';
import { bakeVat } from './anim/vat';
import type { ClipId } from './anim/clips';

/** Where the showcase line-up stands. The capture harness points a shot here. */
export const SHOWCASE_ORIGIN = { x: 0, z: -88 };
export const SHOWCASE_SPACING = 4.2;

interface FigureSpec {
  id: string;
  /** Local offset from SHOWCASE_ORIGIN. +Z is toward the camera. */
  x: number;
  z: number;
  clip: ClipId;
  /** Seconds of rest between replays of a one-shot clip. */
  rest: number;
  /** Extra yaw so weapons/shields don't hide behind the torso. Radians. */
  yaw: number;
  /** Ground speed fed to the animator so locomotion cycles at native rate. */
  speed?: number;
  trail?: TrailSpec;
}

const F = SHOWCASE_SPACING;

/**
 * The key light sits to the frame's left, so every figure turns slightly left
 * (negative yaw) — fronts catch the light instead of presenting their shadowed
 * side to the fixed review camera.
 */
const FIGURES: FigureSpec[] = [
  // ── Front row.
  {
    id: 'hero.bulwark',
    x: -2 * F,
    z: 0.4,
    clip: 'attack',
    rest: 0.5,
    yaw: -0.3,
    trail: {
      bone: 'hand.R',
      base: [0, -0.05, 0.04],
      tip: [-0.06, 0.58, 0.28],
      color: 0xffb347,
      clips: ['attack'],
    },
  },
  { id: 'hero.oracle', x: -F, z: 0.0, clip: 'cast', rest: 0.6, yaw: -0.18 },
  // Turned further than the rest: the bow is her whole silhouette and it lives
  // on her left side, so it has to face the camera.
  { id: 'hero.talon', x: -F * 0.05, z: 0.9, clip: 'attack', rest: 0.7, yaw: 0.34 },
  { id: 'hero.vesper', x: F * 0.95, z: 0.9, clip: 'cast', rest: 0.8, yaw: -0.22 },
  {
    id: 'creep.cleaver',
    x: 0,
    z: 0.4,
    clip: 'attack',
    rest: 1.1,
    yaw: -0.42,
    trail: {
      bone: 'hand.R',
      base: [0.02, 0.16, 0.08],
      tip: [0.05, 0.88, 0.34],
      color: 0x9fe86a,
      clips: ['attack'],
    },
  },
  { id: 'creep.spinebolt', x: F, z: 0.0, clip: 'attack', rest: 0.9, yaw: -0.5 },
  { id: 'creep.duskrunner', x: 2 * F, z: 0.4, clip: 'run', rest: 0, yaw: -0.35, speed: 8.4 },
  // ── Back row.
  { id: 'creep.hexwright', x: -1.3 * F, z: -4.2, clip: 'cast', rest: 0.7, yaw: -0.22 },
  { id: 'boss.marrowTitan', x: 0.1 * F, z: -4.6, clip: 'idle', rest: 0, yaw: -0.12 },
  { id: 'creep.bastion', x: 1.3 * F, z: -4.2, clip: 'death', rest: 1.5, yaw: -0.25 },
];

interface PackSpec {
  id: string;
  /** Pack centre, local offset from SHOWCASE_ORIGIN. */
  x: number;
  z: number;
  cols: number;
  rows: number;
  gap: number;
  clip: ClipId;
}

/** Instanced VAT packs in the rear — the path 300-unit waves actually render on. */
const PACKS: PackSpec[] = [
  { id: 'creep.cleaver', x: -6.6, z: -7.4, cols: 4, rows: 2, gap: 1.7, clip: 'walk' },
  { id: 'creep.duskrunner', x: 6.6, z: -7.4, cols: 4, rows: 2, gap: 1.7, clip: 'run' },
];

interface Figure {
  view: HeroView;
  clip: ClipId;
  rest: number;
  timer: number;
  waiting: boolean;
}

export class ShowcaseModule implements GameModule {
  readonly id = 'showcase';
  readonly order = 820;

  private readonly root = new THREE.Group();
  private readonly figures: Figure[] = [];
  private readonly batches: CreepBatch[] = [];
  private time = 0;

  init(ctx: GameContext): void {
    this.root.name = 'showcase';
    const terrain = ctx.services.get(TerrainKey);
    const rootY = terrain.heightAt(SHOWCASE_ORIGIN.x, SHOWCASE_ORIGIN.z);
    this.root.position.set(SHOWCASE_ORIGIN.x, rootY, SHOWCASE_ORIGIN.z);
    ctx.scene.add(this.root);

    for (let i = 0; i < FIGURES.length; i++) {
      const spec = FIGURES[i]!;
      const def = getCharacter(spec.id);
      if (!def) {
        console.warn(`[showcase] unknown character ${spec.id}`);
        continue;
      }
      const built = buildCharacter(def);
      const view = new HeroView(built, def.visual.scale, i * 0.173, spec.trail);
      this.placeOnGround(view.group, terrain, rootY, spec.x, spec.z);
      view.group.rotation.y = spec.yaw;
      this.root.add(view.group);

      if (spec.speed !== undefined) view.setSpeed(spec.speed);
      view.play(spec.clip, 0);
      this.figures.push({
        view,
        clip: spec.clip,
        rest: spec.rest,
        timer: 0,
        waiting: false,
      });
    }

    for (const pack of PACKS) {
      const batch = this.buildPack(pack, terrain);
      if (!batch) continue;
      this.batches.push(batch);
      ctx.scene.add(batch.mesh);
    }
  }

  private placeOnGround(
    obj: THREE.Object3D,
    terrain: TerrainService,
    rootY: number,
    localX: number,
    localZ: number,
  ): void {
    const wx = SHOWCASE_ORIGIN.x + localX;
    const wz = SHOWCASE_ORIGIN.z + localZ;
    obj.position.set(localX, terrain.heightAt(wx, wz) - rootY, localZ);
  }

  private buildPack(spec: PackSpec, terrain: TerrainService): CreepBatch | null {
    const def = getCharacter(spec.id);
    if (!def) return null;
    const built: BuiltCharacter = buildCharacter(def);
    const bake = bakeVat(built.rig, def.profile, built.geometry);
    const capacity = spec.cols * spec.rows;
    const batch = new CreepBatch(
      `${spec.id}:showcase`,
      makeVatGeometry(built.geometry),
      built.materials,
      bake,
      capacity,
    );
    // World-space transforms: the batch mesh lives at the scene origin.
    batch.mesh.position.set(0, 0, 0);

    for (let r = 0; r < spec.rows; r++) {
      for (let c = 0; c < spec.cols; c++) {
        const slot = batch.alloc();
        if (slot === null) break;
        const jitter = Math.sin(slot * 12.9898) * 0.4;
        const x = SHOWCASE_ORIGIN.x + spec.x + (c - (spec.cols - 1) / 2) * spec.gap + jitter * 0.5;
        const z = SHOWCASE_ORIGIN.z + spec.z - r * spec.gap + jitter;
        batch.setTransform(slot, x, terrain.heightAt(x, z), z, jitter * 0.5, def.visual.scale);
        // startTime doubles as the phase offset for looping clips.
        batch.setClip(slot, spec.clip, -slot * 0.41);
      }
    }
    batch.markTransformsDirty();
    // These packs never move; static usage avoids per-frame re-upload churn.
    batch.mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    return batch;
  }

  update(dt: number): void {
    this.time += dt;

    for (const f of this.figures) {
      f.view.update(dt);
      if (f.rest <= 0) continue; // looping clip, nothing to retrigger
      if (f.view.animator.isFinished) {
        f.timer += dt;
        if (f.timer >= f.rest) {
          // play() on a finished one-shot restarts it with a cross-fade, so the
          // corpse stands back up smoothly instead of teleporting.
          f.view.play(f.clip, f.clip === 'death' ? 0.4 : 0.2);
          f.timer = 0;
        }
      }
    }

    for (const batch of this.batches) batch.update(this.time);
  }

  dispose(): void {
    for (const f of this.figures) f.view.dispose();
    this.figures.length = 0;
    for (const b of this.batches) b.dispose();
    this.batches.length = 0;
    this.root.removeFromParent();
  }
}
