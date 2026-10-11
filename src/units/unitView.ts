/**
 * Unit presentation layer. Owner: CHARACTERS agent.
 *
 * Bridges simulation `UnitState` to renderable meshes. Heroes and bosses get
 * individual skinned meshes (`HeroView`: clip blending, cloth springs, weapon
 * trails); creeps render through instanced VAT batches keyed by definition id
 * (`CreepBatch`), so 300 enemies cost a handful of draw calls (GDD §18).
 *
 * Interpolation: `fixedUpdate` (order 800, after every simulation module has
 * moved its units) snapshots each unit's transform, keeping the previous tick's
 * snapshot beside it. `sync(alpha)` blends between the two. Nothing external
 * calls the service's `sync` yet, so this module drives it from `update()` with
 * a mirrored accumulator: `update` adds the frame dt, `fixedUpdate` subtracts a
 * SIM_STEP — the estimate trails the engine's true accumulator by at most one
 * frame, which is beneath perception at 30 Hz sim / 60+ fps render.
 *
 * Clip selection: gameplay may drive clips explicitly via `playAnimation`;
 * between explicit calls this module keeps locomotion honest on its own by
 * switching idle/walk/run from actual ground speed (never interrupting an
 * unfinished one-shot) and playing `death` when a unit stops being alive.
 */

import * as THREE from 'three';
import type { GameContext, GameModule, EntityId, UnitState, VisualDescriptor } from '@/core/contracts';
import { TerrainKey, UnitViewKey, type TerrainService, type UnitViewService } from '@/core/services';
import { buildCharacter, getCharacter, type CharacterDef } from './catalog';
import { HeroView } from './render/heroView';
import { AuthoredView } from './render/authoredView';
import { CreepBatch, makeVatGeometry } from './render/creepBatch';
import { bakeVat } from './anim/vat';
import { bakeImportedVat } from './anim/vatImported';
import { getAuthored } from './build/authoredCharacter';
import { CLIP_IDS, type ClipId } from './anim/clips';
import { runtimeOf } from '@/gameplay/units';

const SIM_STEP = 1 / 30;
/** Clips that locomotion drives, and that must yield to an unfinished action. */
const LOCOMOTION: ReadonlySet<ClipId> = new Set<ClipId>(['idle', 'walk', 'run']);
/** Capacity per creep definition; the budget is 300 live units total. */
const BATCH_CAPACITY = 400;

interface ViewRecord {
  unit: UnitState;
  def: CharacterDef;
  clip: ClipId;
  /** Skinned path: heroes, bosses, and any creature authored by an artist. */
  view?: HeroView | AuthoredView;
  /** Instanced path (creeps). */
  batch?: CreepBatch;
  slot?: number;
  scale: number;
  /** Render-time stamp of the last clip change; completes VAT one-shots. */
  clipSetAt: number;
  prevX: number;
  prevZ: number;
  prevFacing: number;
  curX: number;
  curZ: number;
  curFacing: number;
}

export class UnitViewModule implements GameModule {
  readonly id = 'unitView';
  readonly order = 800;

  private readonly root = new THREE.Group();
  private readonly views = new Map<EntityId, ViewRecord>();
  private readonly batches = new Map<string, CreepBatch>();
  private terrain!: TerrainService;
  private ctx!: GameContext;
  /** Render-time clock for VAT playback and clip start stamps. */
  private time = 0;
  /** Mirror of the engine's fixed-step accumulator; see header. */
  private accum = 0;
  private readonly warned = new Set<string>();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.root.name = 'units';
    ctx.scene.add(this.root);
    this.terrain = ctx.services.get(TerrainKey);

    const service: UnitViewService = {
      attach: (unit, visual) => this.attach(unit, visual),
      detach: (id) => this.detach(id),
      playAnimation: (id, clip, fade) => this.playAnimation(id, clip, fade),
      sync: (alpha, dt) => this.sync(alpha, dt),
    };
    ctx.services.register(UnitViewKey, service);
  }

  // ── Attach / detach ─────────────────────────────────────────────────────────

  private attach(unit: UnitState, visual: VisualDescriptor): void {
    if (this.views.has(unit.id)) this.detach(unit.id);

    const def = this.resolveDef(unit, visual);
    if (!def) return;

    const record: ViewRecord = {
      unit,
      def,
      clip: 'idle',
      clipSetAt: this.time,
      scale: visual.scale > 0 ? visual.scale : 1,
      prevX: unit.pos.x,
      prevZ: unit.pos.z,
      prevFacing: unit.facing,
      curX: unit.pos.x,
      curZ: unit.pos.z,
      curFacing: unit.facing,
    };

    // An authored creature renders as a plain skinned mesh. The instanced
    // batch is faster but it is also this project's own vertex-animation
    // bake, and that bake failed silently four times running on exactly this
    // kind of character. See the header of `render/authoredView.ts`.
    // Not gated on `kind` any more. It was written when only creeps had
    // authored art, and the gate silently sent the first hero that got some --
    // Bulwark -- down the procedural path instead: the portrait in the HUD
    // changed and the figure on the field did not. Membership of
    // AUTHORED_MANIFEST is the whole condition; anything not in it falls
    // through to the batch or the procedural build exactly as before.
    const authoredSource = getAuthored(def.id);
    if (authoredSource) {
      const view = new AuthoredView(authoredSource, record.scale, (unit.id % 13) / 13);
      view.group.position.set(unit.pos.x, this.terrain.heightAt(unit.pos.x, unit.pos.z), unit.pos.z);
      view.group.rotation.y = unit.facing;
      this.root.add(view.group);
      record.view = view;
    } else if (def.kind === 'creep') {
      const batch = this.batchFor(def);
      const slot = batch.alloc();
      if (slot === null) {
        this.warnOnce(`batch-full:${def.id}`, `[unitView] batch full for ${def.id} (${BATCH_CAPACITY})`);
        return;
      }
      record.batch = batch;
      record.slot = slot;
      const y = this.terrain.heightAt(unit.pos.x, unit.pos.z);
      batch.setTransform(slot, unit.pos.x, y, unit.pos.z, unit.facing, record.scale);
      batch.markTransformsDirty();
      // Negative stamp de-phases the pack so a wave never breathes in lockstep.
      batch.setClip(slot, 'idle', this.time - (unit.id % 17) * 0.37);
    } else {
      const built = buildCharacter(def);
      const view = new HeroView(built, record.scale, (unit.id % 13) / 13);
      view.group.position.set(unit.pos.x, this.terrain.heightAt(unit.pos.x, unit.pos.z), unit.pos.z);
      view.group.rotation.y = unit.facing;
      view.play('idle', 0);
      this.root.add(view.group);
      record.view = view;
    }

    this.views.set(unit.id, record);
    unit.renderRef = record;
  }

  private resolveDef(unit: UnitState, visual: VisualDescriptor): CharacterDef | undefined {
    // The art contract carries `rig.<characterId>`; fall back to the unit's own
    // definition id so gameplay can spawn before its visuals are catalogued.
    const rigId = visual.rigId?.startsWith('rig.') ? visual.rigId.slice(4) : visual.rigId;
    const def = (rigId ? getCharacter(rigId) : undefined) ?? getCharacter(unit.defId);
    if (!def) {
      this.warnOnce(
        `no-def:${unit.defId}`,
        `[unitView] no character for defId=${unit.defId} rigId=${visual.rigId}`,
      );
    }
    return def;
  }

  private batchFor(def: CharacterDef): CreepBatch {
    let batch = this.batches.get(def.id);
    if (batch) return batch;
    // An authored character takes precedence over the procedural build: it
    // brings its own skeleton, its own painted weights and its own clips, all
    // of which are better than what this project generates. Only the bake
    // differs, and it produces the same textures, so everything below is
    // identical either way.
    const authored = getAuthored(def.id);
    if (authored) {
      const bake = bakeImportedVat(authored);
      batch = new CreepBatch(
        def.id,
        makeVatGeometry(authored.mesh.geometry),
        authored.materials as THREE.MeshStandardMaterial[],
        bake,
        BATCH_CAPACITY,
      );
      this.batches.set(def.id, batch);
      this.root.add(batch.mesh);
      return batch;
    }
    const built = buildCharacter(def);
    const bake = bakeVat(built.rig, def.profile, built.geometry);
    batch = new CreepBatch(def.id, makeVatGeometry(built.geometry), built.materials, bake, BATCH_CAPACITY);
    this.batches.set(def.id, batch);
    this.root.add(batch.mesh);
    return batch;
  }

  private detach(id: EntityId): void {
    const record = this.views.get(id);
    if (!record) return;
    if (record.view) record.view.dispose();
    if (record.batch && record.slot !== undefined) record.batch.release(record.slot);
    if (record.unit.renderRef === record) record.unit.renderRef = undefined;
    this.views.delete(id);
  }

  // ── Animation ───────────────────────────────────────────────────────────────

  private playAnimation(id: EntityId, clip: string, fade?: number): void {
    const record = this.views.get(id);
    if (!record || !isClipId(clip)) return;
    this.setClip(record, clip, fade ?? 0.18, true);
  }

  /**
   * Is this unit part way through an action it should be allowed to finish?
   *
   * Both presentation paths answer it their own way: a skinned view knows when
   * its action is done, while an instanced one holds its last frame forever and
   * has to be timed out against the clip's length.
   */
  private midOneShot(record: ViewRecord): boolean {
    const clip = record.clip;
    if (clip !== 'attack' && clip !== 'cast' && clip !== 'hit') return false;
    if (record.view) return !record.view.animator.isFinished;
    if (record.batch) return this.time - record.clipSetAt < record.batch.clipDuration(clip);
    return false;
  }

  private setClip(record: ViewRecord, clip: ClipId, fade: number, force: boolean): void {
    // Locomotion never interrupts an action that has not finished. `autoClip`
    // re-asserts idle/walk/run every frame, which is harmless for a loop and
    // lethal for a one-shot: combat starts an attack and the next frame would
    // replace it, so the swing never plays for more than a frame.
    //
    // `movement` used to assert locomotion too, from the simulation, with its
    // own speed thresholds. Two selectors reading the same velocity through
    // different rules agree for most characters and disagree inside a narrow
    // band -- the archer travels at 3.22 m/s, which `movement` called a run and
    // this called a walk -- and then each one reset the other's action every
    // frame. Her legs articulated 0.08 m instead of 0.61 while her blend weight
    // never rose above 0.3. Clip choice is presentation, so it lives here, once.
    if (LOCOMOTION.has(clip) && this.midOneShot(record)) return;

    if (record.view) {
      // Animator ignores re-plays of looping clips on its own; one-shots
      // retrigger, which is what repeated attack commands want.
      if (force || record.clip !== clip) record.view.play(clip, fade);
    } else if (record.batch && record.slot !== undefined) {
      if (force || record.clip !== clip) record.batch.setClip(record.slot, clip, this.time);
    }
    record.clip = clip;
    record.clipSetAt = this.time;
  }

  /** Keeps locomotion clips agreeing with actual movement between explicit calls. */
  private autoClip(record: ViewRecord, speed: number): void {
    const unit = record.unit;
    if (!unit.alive) {
      if (record.clip !== 'death') this.setClip(record, 'death', 0.12, true);
      return;
    }
    const current = record.clip;
    // Never interrupt a one-shot that is still playing.
    if (current === 'death') {
      // Unit came back (respawn/resurrect): stand up.
      this.setClip(record, 'idle', 0.3, true);
      return;
    }
    if (this.midOneShot(record)) return;
    // A stunned unit has to read as inert. Deceleration is exponential, so its
    // velocity takes about a fifth of a second to fall under the walk
    // threshold, and a creep that keeps walking for that long after a stun
    // lands looks like the stun did nothing.
    const stunnedUntil = runtimeOf(unit.id)?.stunnedUntilTick;
    if (stunnedUntil !== undefined && this.ctx.clock.tick < stunnedUntil) {
      if (record.clip !== 'idle') this.setClip(record, 'idle', 0.12, true);
      return;
    }
    const prof = record.def.profile;
    // The threshold is the walk speed itself, not the midpoint between walk
    // and run. An authored walk cycle covers real ground: measured on the orc,
    // its stride peaks at 0.78 m and the cycle lasts 2.42 s, so the clip is
    // built for about 0.64 m/s. The midpoint rule kept a creep moving at
    // 3.47 m/s in that walk, and feet that cannot cover a fifth of the ground
    // they travel do not read as walking, they read as gliding. Anything
    // faster than a walking pace belongs in the run clip, whose stride is
    // three times longer.
    const desired: ClipId =
      speed > prof.walkSpeed ? 'run' : speed > 0.25 ? 'walk' : 'idle';
    if (desired !== current) this.setClip(record, desired, 0.16, false);
  }

  // ── Frame sync ──────────────────────────────────────────────────────────────

  fixedUpdate(): void {
    this.accum -= SIM_STEP;
    if (this.accum < 0) this.accum = 0;
    for (const record of this.views.values()) {
      record.prevX = record.curX;
      record.prevZ = record.curZ;
      record.prevFacing = record.curFacing;
      record.curX = record.unit.pos.x;
      record.curZ = record.unit.pos.z;
      record.curFacing = record.unit.facing;
    }
  }

  private sync(alpha: number, dt: number): void {
    this.time += dt;
    let batchesDirty = false;

    for (const record of this.views.values()) {
      const unit = record.unit;
      const x = record.prevX + (record.curX - record.prevX) * alpha;
      const z = record.prevZ + (record.curZ - record.prevZ) * alpha;
      const facing = lerpAngle(record.prevFacing, record.curFacing, alpha);
      // Fliers ride above whatever is under them, with a slow bob so they read
      // as airborne rather than as a unit standing on an invisible floor. The
      // simulation ignores terrain for them entirely (see `movement.ts`); this
      // is only where that becomes visible.
      const altitude = runtimeOf(unit.id)?.traits?.flying?.altitude;
      const y =
        altitude === undefined
          ? this.terrain.heightAt(x, z)
          : this.terrain.heightAt(x, z) + altitude + Math.sin(this.time * 1.6 + unit.id) * 0.35;
      const speed = Math.hypot(unit.vel.x, unit.vel.z);

      this.autoClip(record, speed);

      if (record.view) {
        record.view.group.position.set(x, y, z);
        record.view.group.rotation.y = facing;
        record.view.setSpeed(speed);
        record.view.update(dt);
      } else if (record.batch && record.slot !== undefined) {
        record.batch.setTransform(record.slot, x, y, z, facing, record.scale);
        batchesDirty = true;
      }
    }

    if (batchesDirty) {
      for (const batch of this.batches.values()) batch.markTransformsDirty();
    }
    for (const batch of this.batches.values()) batch.update(this.time);
  }

  update(dt: number): void {
    this.accum += dt;
    const alpha = Math.min(1, this.accum / SIM_STEP);
    this.sync(alpha, dt);
  }

  // ── Housekeeping ────────────────────────────────────────────────────────────

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  dispose(): void {
    for (const record of this.views.values()) {
      if (record.view) record.view.dispose();
    }
    this.views.clear();
    for (const batch of this.batches.values()) batch.dispose();
    this.batches.clear();
    this.root.removeFromParent();
  }
}

function isClipId(value: string): value is ClipId {
  return (CLIP_IDS as readonly string[]).includes(value);
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
