/**
 * SHARED CONTRACTS — owned by the architecture lead.
 *
 * Every subsystem builds against this file. Subsystem agents MUST NOT edit it;
 * if a contract is missing, request the change instead of forking the types.
 *
 * Design rules enforced here:
 *  - Level is an unbounded integer. Nothing in this file declares MAX_LEVEL. (GDD §9)
 *  - All content is data-driven via *Definition records. (GDD §19)
 *  - Simulation is deterministic given a seed. (GDD §7)
 */

import type * as THREE from 'three';
import type { Rng } from './rng';
import type { EventBus, GameEvents } from './events';

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

export type EntityId = number;
export type DefId = string;
export type TeamId = 0 | 1;

export interface Vec2 {
  x: number;
  z: number;
}

/** Unbounded hero level. Never clamp this against a design cap. */
export type Level = number;

export const enum DamageType {
  Physical = 0,
  Fire = 1,
  Frost = 2,
  Shadow = 3,
  Nature = 4,
  Arcane = 5,
  Holy = 6,
  Pure = 7,
}

export const enum UnitKind {
  Hero = 0,
  Creep = 1,
  Elite = 2,
  Miniboss = 3,
  Boss = 4,
  Summon = 5,
  Structure = 6,
}

export const enum ArmorClass {
  Unarmored = 0,
  Light = 1,
  Medium = 2,
  Heavy = 3,
  Fortified = 4,
  Ethereal = 5,
}

export const enum Faction {
  TeamA = 0,
  TeamB = 1,
  Hostile = 2,
  Neutral = 3,
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical stat block. Additive `flat` and multiplicative `mult` layers are
 * resolved by the combat module; nothing else may mutate `final` directly.
 */
export interface StatBlock {
  maxHealth: number;
  healthRegen: number;
  maxMana: number;
  manaRegen: number;

  attackDamage: number;
  attackSpeed: number; // attacks per second
  attackRange: number;
  critChance: number; // 0..1
  critMultiplier: number;

  spellPower: number;
  cooldownReduction: number; // 0..1, soft-capped
  castSpeed: number;

  armor: number;
  magicResist: number; // 0..1 after soft cap
  moveSpeed: number;
  evasion: number; // 0..1, soft-capped

  lifesteal: number; // 0..1
  spellVamp: number; // 0..1
  tenacity: number; // 0..1, crowd-control duration reduction
}

export type StatKey = keyof StatBlock;

export interface StatModifier {
  stat: StatKey;
  /** 'flat' adds, 'pct' multiplies the post-flat value, 'final' multiplies last. */
  op: 'flat' | 'pct' | 'final';
  value: number;
  sourceId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Definitions (data-driven content)
// ─────────────────────────────────────────────────────────────────────────────

export interface HeroDefinition {
  id: DefId;
  name: string;
  title: string;
  role: HeroRole;
  /** Visual identity handed to the character builder. */
  visual: VisualDescriptor;
  baseStats: StatBlock;
  /** Per-level growth. Applied through HeroLevelCurve, not raw multiplication. */
  growth: Partial<StatBlock>;
  abilities: DefId[];
  ultimate: DefId;
  talentTreeId: DefId;
  attackProjectile?: DefId;
  synergies: string[];
  weaknesses: string[];
}

export type HeroRole =
  | 'Tank'
  | 'Bruiser'
  | 'Assassin'
  | 'RangedDPS'
  | 'Archer'
  | 'AoECaster'
  | 'Elementalist'
  | 'SingleTarget'
  | 'Summoner'
  | 'Necromancer'
  | 'Healer'
  | 'Support'
  | 'Controller'
  | 'Hybrid';

/**
 * Art direction contract. The character/VFX agents read this; gameplay never does.
 * Keeps look-and-feel data-driven and reviewable without touching logic.
 */
export interface VisualDescriptor {
  silhouette: string;
  palette: { primary: number; secondary: number; accent: number; emissive: number };
  scale: number;
  rigId: DefId;
  /** Optional per-hero shader/material overrides resolved by the material library. */
  materialTags?: string[];
}

export interface HeroLevelCurve {
  id: DefId;
  /** xpToNext(level) must stay finite and monotonic for arbitrarily large level. */
  xpToNext: (level: Level) => number;
  /** Stat growth applied at `level`. Must use diminishing returns, not linear ramps. */
  statGain: (level: Level, base: StatBlock) => Partial<StatBlock>;
  /** Levels that unlock a choice (skill, talent, specialization). */
  isMilestone: (level: Level) => boolean;
  /** Points awarded on milestone levels. */
  milestoneReward: (level: Level) => MilestoneReward;
}

export interface MilestoneReward {
  kind: 'ability' | 'talent' | 'specialization' | 'attribute';
  points: number;
}

export interface AbilityDefinition {
  id: DefId;
  name: string;
  description: string;
  icon: string;
  targeting: 'self' | 'unit' | 'point' | 'direction' | 'passive' | 'toggle';
  maxRank: number;
  cooldown: number[]; // per rank
  manaCost: number[];
  castTime: number;
  range: number;
  radius?: number;
  damageType?: DamageType;
  /** Telegraph shape shown before impact (GDD §14, §16). */
  telegraph?: TelegraphSpec;
  vfxId?: DefId;
  sfxId?: DefId;
  /** Resolved by the ability runtime; keeps effects data-driven. */
  effects: AbilityEffectSpec[];
  tags: string[];
}

export interface TelegraphSpec {
  shape: 'circle' | 'cone' | 'line' | 'ring' | 'cross';
  size: number;
  angle?: number;
  leadTime: number;
  color: number;
}

export interface AbilityEffectSpec {
  kind:
    | 'damage'
    | 'heal'
    | 'shield'
    | 'buff'
    | 'debuff'
    | 'summon'
    | 'dash'
    | 'teleport'
    | 'knockback'
    | 'stun'
    | 'slow'
    | 'silence'
    | 'aura'
    | 'projectile'
    | 'custom';
  amount?: number[]; // per rank
  scaling?: { stat: StatKey; ratio: number }[];
  duration?: number;
  radius?: number;
  targets?: number;
  statusId?: DefId;
  summonId?: DefId;
  projectileId?: DefId;
  /** Hook name resolved by the ability runtime for bespoke behaviour. */
  customId?: string;
}

export interface TalentDefinition {
  id: DefId;
  treeId: DefId;
  tier: number;
  name: string;
  description: string;
  icon: string;
  maxRank: number;
  /** Talents may repeat infinitely when `maxRank` is Infinity (post-level-20 mastery). */
  requires?: DefId[];
  modifiers: StatModifier[];
  abilityMods?: AbilityModifier[];
}

export interface AbilityModifier {
  abilityId: DefId;
  field: 'cooldown' | 'damage' | 'radius' | 'duration' | 'targets' | 'manaCost';
  op: 'flat' | 'pct';
  value: number;
}

export interface ItemDefinition {
  id: DefId;
  name: string;
  description: string;
  icon: string;
  slot: 'weapon' | 'armor' | 'accessory' | 'consumable' | 'book' | 'special';
  tier: number;
  cost: number;
  currency: CurrencyKind;
  modifiers: StatModifier[];
  grantedAbility?: DefId;
  /** Permanent stat books consumed on purchase. */
  consumeOnUse?: boolean;
  stackLimit?: number;
  recipe?: DefId[];
}

export type CurrencyKind = 'gold' | 'influence';

export interface EnemyDefinition {
  id: DefId;
  name: string;
  kind: UnitKind;
  archetype: EnemyArchetype;
  visual: VisualDescriptor;
  armorClass: ArmorClass;
  baseStats: StatBlock;
  /** Behaviour tree id — enemies differ by behaviour, not only numbers (GDD §13). */
  behaviorId: DefId;
  abilities: DefId[];
  bounty: { gold: number; xp: number };
  dropTableId?: DefId;
  /** Budget cost used by the wave composer. */
  waveCost: number;
  resistances?: Partial<Record<DamageType, number>>;
}

export type EnemyArchetype =
  | 'melee'
  | 'ranged'
  | 'fast'
  | 'tank'
  | 'caster'
  | 'healer'
  | 'summoner'
  | 'assassin'
  | 'siege'
  | 'elite'
  | 'miniboss'
  | 'boss';

export interface BossDefinition extends EnemyDefinition {
  phases: BossPhase[];
  enrageAt: number; // seconds
  arenaMechanics: string[];
}

export interface BossPhase {
  healthThreshold: number; // 0..1
  abilities: DefId[];
  addSpawns?: { enemyId: DefId; count: number; interval: number }[];
  modifiers?: StatModifier[];
  dpsCheck?: { window: number; requiredFraction: number };
}

export interface WaveDefinition {
  waveNumber: number;
  seed: number;
  budget: number;
  enemyPool: DefId[];
  compositionRules: CompositionRule[];
  eliteChance: number;
  bossRule?: { enemyId: DefId; count: number };
  modifiers: DefId[];
  spawnPattern: SpawnPattern;
  difficultyMultiplier: number;
}

export interface CompositionRule {
  archetype: EnemyArchetype;
  minFraction: number;
  maxFraction: number;
}

export interface SpawnPattern {
  kind: 'stream' | 'burst' | 'staggered' | 'flank' | 'ambush';
  interval: number;
  groupSize: number;
  lanes: number[];
}

export interface SabotageDefinition {
  id: DefId;
  name: string;
  description: string;
  icon: string;
  cost: number;
  currency: CurrencyKind;
  cooldown: number;
  /** Every sabotage must document its counterplay (GDD §11). Enforced by tests. */
  counterplay: string;
  effects: SabotageEffectSpec[];
  telegraph: TelegraphSpec;
}

export interface SabotageEffectSpec {
  kind: 'spawnWave' | 'modifyWave' | 'debuffTeam' | 'terrain' | 'disable' | 'summonElite';
  magnitude: number;
  duration: number;
  targetId?: DefId;
}

export interface DropTable {
  id: DefId;
  entries: { itemId: DefId; weight: number; minWave?: number }[];
  rolls: number;
  chance: number;
}

export interface DifficultyDefinition {
  id: DefId;
  name: string;
  enemyStatScale: number;
  enemyCountScale: number;
  bountyScale: number;
  coreLives: number;
}

export interface StatusDefinition {
  id: DefId;
  name: string;
  icon: string;
  kind: 'buff' | 'debuff';
  /** Crowd control statuses are reduced by tenacity. */
  isCrowdControl: boolean;
  maxStacks: number;
  modifiers: StatModifier[];
  tickInterval?: number;
  tickEffect?: AbilityEffectSpec;
  vfxId?: DefId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime state
// ─────────────────────────────────────────────────────────────────────────────

export interface UnitState {
  id: EntityId;
  defId: DefId;
  kind: UnitKind;
  faction: Faction;
  team: TeamId | -1;

  pos: Vec2;
  vel: Vec2;
  facing: number;
  radius: number;

  health: number;
  mana: number;
  stats: StatBlock;
  baseStats: StatBlock;
  modifiers: StatModifier[];
  statuses: ActiveStatus[];

  level: Level;
  xp: number;

  targetId: EntityId | null;
  attackCooldown: number;
  castingUntil: number;
  alive: boolean;

  /** Render handle owned by the presentation layer; simulation never reads it. */
  renderRef?: unknown;
}

export interface ActiveStatus {
  defId: DefId;
  stacks: number;
  expiresAt: number;
  nextTickAt: number;
  sourceId: EntityId;
}

export interface HeroState extends UnitState {
  ownerId: string;
  gold: number;
  influence: number;
  abilityRanks: Map<DefId, number>;
  abilityCooldowns: Map<DefId, number>;
  talentRanks: Map<DefId, number>;
  unspentPoints: MilestoneReward[];
  items: DefId[];
  specialization: DefId | null;
}

export interface CoreState {
  team: TeamId;
  pos: Vec2;
  lives: number;
  maxLives: number;
}

export interface MatchState {
  seed: number;
  tick: number;
  time: number;
  wave: number;
  phase: MatchPhase;
  mode: '1v1' | '2v2' | '3v3';
  cores: CoreState[];
  units: Map<EntityId, UnitState>;
  heroes: Map<EntityId, HeroState>;
  winner: TeamId | null;
}

export type MatchPhase =
  | 'heroSelect'
  | 'preparation'
  | 'wave'
  | 'intermission'
  | 'boss'
  | 'victory'
  | 'defeat';

// ─────────────────────────────────────────────────────────────────────────────
// Module lifecycle & service locator
// ─────────────────────────────────────────────────────────────────────────────

export interface GameContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.Camera;
  readonly renderer: THREE.WebGLRenderer;
  readonly clock: { time: number; delta: number; tick: number };
  readonly rng: Rng;
  readonly bus: EventBus<GameEvents>;
  readonly match: MatchState;
  readonly services: ServiceLocator;
}

export interface GameModule {
  readonly id: string;
  /** Modules with a lower order run first. Render modules use 800+. */
  readonly order: number;
  init(ctx: GameContext): Promise<void> | void;
  /** Deterministic simulation step. Fixed dt. No rendering, no Math.random. */
  fixedUpdate?(step: number, ctx: GameContext): void;
  /** Presentation step. Variable dt. Never mutates simulation state. */
  update?(dt: number, ctx: GameContext): void;
  dispose?(): void;
}

export interface ServiceLocator {
  register<T>(key: ServiceKey<T>, value: T): void;
  get<T>(key: ServiceKey<T>): T;
  tryGet<T>(key: ServiceKey<T>): T | undefined;
}

/** Branded key so service lookups stay type-safe across modules. */
export interface ServiceKey<T> {
  readonly name: string;
  readonly __type?: T;
}

export function serviceKey<T>(name: string): ServiceKey<T> {
  return { name };
}
