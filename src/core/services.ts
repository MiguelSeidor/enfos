/**
 * Service keys. Modules publish their public surface here so subsystems can
 * talk to each other without import cycles or hard build-order coupling.
 *
 * Adding a key is cheap; a subsystem agent may append its own key + interface
 * to this file, but must not change existing signatures.
 */

import type * as THREE from 'three';
import { serviceKey } from './contracts';
import type {
  AbilityDefinition,
  BossDefinition,
  DefId,
  DifficultyDefinition,
  DropTable,
  EnemyDefinition,
  EntityId,
  HeroDefinition,
  HeroState,
  ItemDefinition,
  SabotageDefinition,
  StatusDefinition,
  TalentDefinition,
  TeamId,
  UnitState,
  Vec2,
  VisualDescriptor,
  DamageType,
  Level,
} from './contracts';
import type { Registry } from './registry';
import type { SpatialHash } from './spatial';

// ── Content ──────────────────────────────────────────────────────────────────

export interface ContentService {
  heroes: Registry<HeroDefinition>;
  enemies: Registry<EnemyDefinition>;
  bosses: Registry<BossDefinition>;
  abilities: Registry<AbilityDefinition>;
  talents: Registry<TalentDefinition>;
  items: Registry<ItemDefinition>;
  sabotage: Registry<SabotageDefinition>;
  statuses: Registry<StatusDefinition>;
  dropTables: Registry<DropTable>;
  difficulties: Registry<DifficultyDefinition>;
  /** Returns human-readable issues; empty array means the content set is valid. */
  validate(): string[];
}

export const ContentKey = serviceKey<ContentService>('content');

// ── Combat ───────────────────────────────────────────────────────────────────

export interface DamageRequest {
  targetId: EntityId;
  sourceId: EntityId | null;
  amount: number;
  type: DamageType;
  canCrit?: boolean;
  /** Skips armor and resistances; use sparingly. */
  trueDamage?: boolean;
  abilityId?: DefId;
}

export interface CombatService {
  spatial: SpatialHash;
  applyDamage(req: DamageRequest): number;
  applyHeal(targetId: EntityId, sourceId: EntityId | null, amount: number): number;
  applyStatus(targetId: EntityId, statusId: DefId, sourceId: EntityId, stacks?: number): void;
  removeStatus(targetId: EntityId, statusId: DefId): void;
  hasStatus(targetId: EntityId, statusId: DefId): boolean;
  recomputeStats(unit: UnitState): void;
  queryUnits(pos: Vec2, radius: number, filter?: (u: UnitState) => boolean): UnitState[];
  killUnit(id: EntityId, killerId: EntityId | null): void;
}

export const CombatKey = serviceKey<CombatService>('combat');

// ── Units / spawning ─────────────────────────────────────────────────────────

export interface UnitService {
  spawnEnemy(defId: DefId, pos: Vec2, laneIndex: number, scale: number): UnitState;
  spawnHero(defId: DefId, pos: Vec2, team: TeamId, ownerId: string): HeroState;
  despawn(id: EntityId): void;
  get(id: EntityId): UnitState | undefined;
  all(): IterableIterator<UnitState>;
  readonly count: number;
}

export const UnitKey = serviceKey<UnitService>('units');

// ── Progression (infinite levels) ────────────────────────────────────────────

export interface ProgressionService {
  grantXp(heroId: EntityId, amount: number): void;
  xpToNext(level: Level): number;
  /** Applies growth for `level`; must remain finite for arbitrarily large level. */
  applyLevel(hero: HeroState, level: Level): void;
  spendTalent(heroId: EntityId, talentId: DefId): boolean;
  chooseSpecialization(heroId: EntityId, specId: DefId): boolean;
  rankUpAbility(heroId: EntityId, abilityId: DefId): boolean;
}

export const ProgressionKey = serviceKey<ProgressionService>('progression');

// ── Abilities ────────────────────────────────────────────────────────────────

export interface AbilityService {
  cast(casterId: EntityId, abilityId: DefId, target: Vec2 | EntityId | null): boolean;
  canCast(casterId: EntityId, abilityId: DefId): { ok: boolean; reason?: string };
  cooldownRemaining(casterId: EntityId, abilityId: DefId): number;
  /** Registers a bespoke effect handler referenced by AbilityEffectSpec.customId. */
  registerCustom(id: string, handler: CustomEffectHandler): void;
}

export type CustomEffectHandler = (
  caster: UnitState,
  target: Vec2 | EntityId | null,
  rank: number,
) => void;

export const AbilityKey = serviceKey<AbilityService>('abilities');

// ── Waves ────────────────────────────────────────────────────────────────────

export interface WaveService {
  readonly current: number;
  startWave(waveNumber: number): void;
  forceNext(): void;
  remainingEnemies(team: TeamId): number;
  /** Sabotage hooks: inject extra units or modifiers into an in-flight wave. */
  injectSpawn(team: TeamId, enemyId: DefId, count: number, elite: boolean): void;
  applyModifier(team: TeamId, modifierId: DefId, duration: number): void;
}

export const WaveKey = serviceKey<WaveService>('waves');

// ── Economy & shops ──────────────────────────────────────────────────────────

export interface EconomyService {
  addGold(heroId: EntityId, amount: number, reason: string): void;
  addInfluence(heroId: EntityId, amount: number, reason: string): void;
  canAfford(heroId: EntityId, cost: number, currency: 'gold' | 'influence'): boolean;
  buyItem(heroId: EntityId, itemId: DefId): boolean;
  sellItem(heroId: EntityId, itemId: DefId): boolean;
  launchSabotage(heroId: EntityId, sabotageId: DefId): boolean;
}

export const EconomyKey = serviceKey<EconomyService>('economy');

// ── Presentation ─────────────────────────────────────────────────────────────

export interface RenderService {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Quality tier drives shadow resolution, particle budget and post-FX chain. */
  setQuality(tier: 'low' | 'medium' | 'high' | 'ultra'): void;
  readonly quality: 'low' | 'medium' | 'high' | 'ultra';
  resize(width: number, height: number): void;
  render(alpha: number, dt: number): void;
  /** Screen-space position of a world point, for UI anchoring. */
  project(pos: Vec2, height: number, out: { x: number; y: number }): boolean;
}

export const RenderKey = serviceKey<RenderService>('render');

export interface TerrainService {
  /** Ground height at a world position; used by units, VFX and the camera. */
  heightAt(x: number, z: number): number;
  /** Surface normal, for aligning decals and footstep effects. */
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  isWalkable(x: number, z: number): boolean;
  /** Ordered lane waypoints from spawn to core for a given team and lane. */
  lanePath(team: TeamId, lane: number): Vec2[];
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export const TerrainKey = serviceKey<TerrainService>('terrain');

export interface UnitViewService {
  /** Creates the visual representation for a unit; called on spawn. */
  attach(unit: UnitState, visual: VisualDescriptor): void;
  detach(id: EntityId): void;
  playAnimation(id: EntityId, clip: string, fade?: number): void;
  /** Interpolated transform sync; called once per rendered frame. */
  sync(alpha: number, dt: number): void;
}

export const UnitViewKey = serviceKey<UnitViewService>('unitView');

export interface VfxService {
  spawn(vfxId: DefId, pos: Vec2, opts?: { scale?: number; rotation?: number; height?: number }): void;
  beam(vfxId: DefId, from: Vec2, to: Vec2, duration: number): void;
  telegraph(shape: string, pos: Vec2, size: number, leadTime: number, color: number): void;
  decal(id: DefId, pos: Vec2, size: number, life: number): void;
  damageNumber(pos: Vec2, amount: number, crit: boolean, type: DamageType): void;
  shake(intensity: number, duration: number): void;
}

export const VfxKey = serviceKey<VfxService>('vfx');

export interface AudioService {
  play(sfxId: DefId, opts?: { pos?: Vec2; volume?: number; pitch?: number }): void;
  playMusic(trackId: DefId, fade?: number): void;
  setBusVolume(bus: 'master' | 'music' | 'sfx' | 'ui' | 'ambient', volume: number): void;
  setIntensity(value: number): void;
}

export const AudioKey = serviceKey<AudioService>('audio');

export interface UiService {
  setPhase(phase: string): void;
  openShop(kind: 'hero' | 'sabotage'): void;
  closeShop(): void;
  notify(text: string, severity: 'info' | 'warn' | 'danger' | 'reward'): void;
  /** Called once per rendered frame after simulation sync. */
  refresh(dt: number): void;
}

export const UiKey = serviceKey<UiService>('ui');

export interface InputService {
  /** Screen-to-ground raycast result, updated each frame. */
  readonly cursorWorld: Vec2;
  readonly hoveredUnit: EntityId | null;
  isActionDown(action: string): boolean;
  consumeAction(action: string): boolean;
  setBinding(action: string, code: string): void;
}

export const InputKey = serviceKey<InputService>('input');
