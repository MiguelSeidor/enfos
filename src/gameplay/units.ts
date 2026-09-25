/**
 * Unit lifecycle. Owner: GAMEPLAY.
 *
 * Owns the authoritative unit table and is the only place units are created or
 * destroyed. Everything else mutates units it was handed; nothing else may add
 * to or remove from `match.units`, because the view layer mirrors this table and
 * would leak meshes if spawning happened in two places.
 *
 * Ids are monotonic and never reused within a match, so a stale reference can be
 * detected rather than silently resolving to a different unit.
 */

import type {
  GameContext,
  GameModule,
  EntityId,
  HeroState,
  UnitState,
  Vec2,
  TeamId,
  VisualDescriptor,
} from '@/core/contracts';
import { Faction, UnitKind } from '@/core/contracts';
import { UnitKey, UnitViewKey, TerrainKey, type UnitService, type TerrainService } from '@/core/services';
import { getCharacter } from '@/units/catalog';
import {
  BOSSES,
  ENEMIES,
  ENEMY_SPEED_SCALE,
  HEROES,
  type EnemyDef,
  type EnemyTraits,
  type BossPhaseDef,
} from './defs';
import { levelScale } from '@/core/mathx';

/** Extra runtime state gameplay needs that is not part of the shared contract. */
export interface UnitRuntime {
  /**
   * The team whose site this unit belongs to: for a creep, the half it marches
   * on and whose Core it leaks into; for a hero, its own team.
   */
  siteTeam: TeamId;
  /** Index of the next lane waypoint this unit is walking toward. */
  laneIndex: number;
  lane: Vec2[];
  behavior: string;
  bounty: { gold: number; xp: number };
  ranged: boolean;
  /** Wave this unit belongs to, for cleanup and scoring. */
  wave: number;
  /** Seconds since spawn; used to stagger AI work across ticks. */
  age: number;
  scale: number;
  /** Optional abilities from the def. Absent for plain creeps and heroes. */
  traits?: EnemyTraits;
  /** Countdown to the next summon, seconds. Only used when `traits.summons`. */
  summonTimer?: number;
  /** Ids this unit has summoned and that may still be alive. */
  summoned?: EntityId[];
  /**
   * Seconds of visibility remaining after striking. Only used when
   * `traits.invisible`; at or below zero the unit is unseen.
   */
  revealFor?: number;
  /** Simulation tick at which a stun ends, or 0 when not stunned. */
  stunnedUntilTick?: number;
  /**
   * Boss phases still ahead, and how many have been entered.
   *
   * Held on the runtime rather than looked up from the def each tick so the
   * transition check is a number compare, and so a boss that has already
   * entered a phase can never re-enter it after a heal.
   */
  bossPhases?: BossPhaseDef[];
  bossPhaseIndex?: number;
}

const runtimes = new Map<EntityId, UnitRuntime>();

/**
 * Is this unit currently unseen?
 *
 * True only for creeps carrying the `invisible` trait whose reveal window has
 * run out. Everything else is always visible, so the common case is one map
 * lookup and a couple of undefined checks.
 */
export function isConcealed(id: EntityId): boolean {
  const runtime = runtimes.get(id);
  return !!runtime?.traits?.invisible && (runtime.revealFor ?? 0) <= 0;
}

export function runtimeOf(id: EntityId): UnitRuntime | undefined {
  return runtimes.get(id);
}

export class UnitModule implements GameModule {
  readonly id = 'units';
  readonly order = 200;

  private ctx!: GameContext;
  private terrain!: TerrainService;
  private nextId: EntityId = 1;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.terrain = ctx.services.get(TerrainKey);
    runtimes.clear();

    const service: UnitService = {
      spawnEnemy: (defId, pos, lane, scale) => this.spawnEnemy(defId, pos, lane, scale),
      spawnHero: (defId, pos, team, ownerId) => this.spawnHero(defId, pos, team, ownerId),
      despawn: (id) => this.despawn(id),
      get: (id) => ctx.match.units.get(id),
      all: () => ctx.match.units.values(),
      get count() {
        return ctx.match.units.size;
      },
    };
    ctx.services.register(UnitKey, service);
  }

  /**
   * `difficulty` scales enemy stats with the wave number. It multiplies health
   * and damage but deliberately not move speed — a wave that outruns the hero
   * is not harder, it is unplayable.
   */
  /**
   * `siteTeam` selects whose site this enemy marches on: 0 or 1.
   * `route` selects which fork of that site's lane it takes.
   */
  spawnEnemy(
    defKey: string,
    pos: Vec2,
    siteTeam: number,
    difficulty: number,
    route = 0,
  ): UnitState {
    const laneTeam = (siteTeam === 1 ? 1 : 0) as TeamId;
    const def: EnemyDef = ENEMIES[defKey] ?? BOSSES[defKey]!;
    const isBoss = BOSSES[defKey] !== undefined;
    const character = getCharacter(def.characterId);

    const base = { ...def.stats };
    base.maxHealth = Math.round(base.maxHealth * difficulty);
    base.attackDamage = Math.round(base.attackDamage * difficulty);
    base.armor = Math.round(base.armor * Math.sqrt(difficulty));
    // Pacing dial, applied here so it covers every enemy definition at once and
    // never gets multiplied into the wave difficulty curve.
    base.moveSpeed *= ENEMY_SPEED_SCALE;

    const unit: UnitState = {
      id: this.nextId++,
      defId: defKey,
      kind: isBoss ? UnitKind.Boss : UnitKind.Creep,
      faction: Faction.Hostile,
      team: -1,
      pos: { x: pos.x, z: pos.z },
      vel: { x: 0, z: 0 },
      facing: 0,
      radius: 0.85 * def.scale,
      health: base.maxHealth,
      mana: base.maxMana,
      stats: { ...base },
      baseStats: base,
      modifiers: [],
      statuses: [],
      level: 1,
      xp: 0,
      targetId: null,
      attackCooldown: 0,
      castingUntil: 0,
      alive: true,
    };

    const lane = this.terrain.lanePath(laneTeam, route);
    runtimes.set(unit.id, {
      siteTeam: laneTeam,
      laneIndex: 0,
      lane,
      behavior: def.behavior,
      bounty: def.bounty,
      ranged: def.ranged === true,
      wave: this.ctx.match.wave,
      age: 0,
      scale: def.scale,
      traits: def.traits,
      // Staggered by id so a group of summoners spawned together does not
      // raise its minions in one synchronised burst.
      summonTimer: def.traits?.summons
        ? def.traits.summons.everySeconds * (0.35 + ((unit.id * 37) % 60) / 100)
        : undefined,
      summoned: def.traits?.summons ? [] : undefined,
      revealFor: def.traits?.invisible ? 0 : undefined,
      stunnedUntilTick: 0,
      // Copied, not referenced: the module shifts entries off as they are
      // entered, and mutating the shared def would leave the next boss of the
      // same kind with no phases at all.
      bossPhases: isBoss ? [...(def as { phases?: BossPhaseDef[] }).phases ?? []] : undefined,
      bossPhaseIndex: isBoss ? 0 : undefined,
    });

    this.ctx.match.units.set(unit.id, unit);
    this.attachView(unit, character?.visual, def.characterId, def.scale);
    this.ctx.bus.emit('unit:spawn', { id: unit.id, defId: defKey, pos: unit.pos });
    return unit;
  }

  spawnHero(defKey: string, pos: Vec2, team: TeamId, ownerId: string): HeroState {
    const def = HEROES[defKey]!;
    const character = getCharacter(def.characterId);
    const base = { ...def.stats };

    const hero: HeroState = {
      id: this.nextId++,
      defId: defKey,
      kind: UnitKind.Hero,
      faction: team === 0 ? Faction.TeamA : Faction.TeamB,
      team,
      pos: { x: pos.x, z: pos.z },
      vel: { x: 0, z: 0 },
      facing: 0,
      radius: 0.9,
      health: base.maxHealth,
      mana: base.maxMana,
      stats: { ...base },
      baseStats: base,
      modifiers: [],
      statuses: [],
      level: 1,
      xp: 0,
      targetId: null,
      attackCooldown: 0,
      castingUntil: 0,
      alive: true,
      ownerId,
      gold: 300,
      influence: 0,
      abilityRanks: new Map(),
      abilityCooldowns: new Map(),
      talentRanks: new Map(),
      unspentPoints: [],
      items: [],
      specialization: null,
    };

    runtimes.set(hero.id, {
      siteTeam: team,
      laneIndex: 0,
      lane: [],
      behavior: 'hero',
      bounty: { gold: 0, xp: 0 },
      ranged: def.ranged === true,
      wave: 0,
      age: 0,
      scale: def.scale,
    });

    this.ctx.match.units.set(hero.id, hero);
    this.ctx.match.heroes.set(hero.id, hero);
    this.attachView(hero, character?.visual, def.characterId, def.scale);
    this.ctx.bus.emit('unit:spawn', { id: hero.id, defId: defKey, pos: hero.pos });
    return hero;
  }

  /**
   * Applies a level's worth of growth. Uses `levelScale` so power keeps rising
   * for arbitrarily large levels without the linear blow-up the GDD forbids
   * (§9 — there is no maximum level).
   */
  applyHeroLevel(hero: HeroState): void {
    const def = HEROES[hero.defId]!;
    const l = hero.level;
    const curve = levelScale(l, 1, 1.045);
    const next = { ...def.stats };
    for (const [key, gain] of Object.entries(def.growth) as [keyof typeof next, number][]) {
      next[key] = def.stats[key] + gain * (l - 1) * curve;
    }
    const healthFraction = hero.health / hero.stats.maxHealth;
    hero.baseStats = next;
    // Only the *base* is rebuilt here. `stats` is set to match so the block is
    // never left stale, but it is not the final answer: the caller must run
    // `CombatService.recomputeStats` to fold the hero's modifiers back in, or
    // every item and spent attribute point is discarded on level-up. This
    // module cannot do it itself — combat registers at order 400 and units at
    // 200, so the service does not exist from here.
    hero.stats = { ...next };
    hero.health = next.maxHealth * healthFraction;
  }

  private attachView(
    unit: UnitState,
    visual: VisualDescriptor | undefined,
    characterId: string,
    scale: number,
  ): void {
    const view = this.ctx.services.tryGet(UnitViewKey);
    if (!view) return;
    const descriptor: VisualDescriptor = visual ?? {
      silhouette: characterId,
      palette: { primary: 0x808080, secondary: 0x606060, accent: 0xa0a0a0, emissive: 0 },
      scale,
      rigId: `rig.${characterId}`,
    };
    view.attach(unit, descriptor);
  }

  despawn(id: EntityId): void {
    const unit = this.ctx.match.units.get(id);
    if (!unit) return;
    this.ctx.services.tryGet(UnitViewKey)?.detach(id);
    this.ctx.match.units.delete(id);
    this.ctx.match.heroes.delete(id);
    runtimes.delete(id);
  }

  saveState(): unknown {
    return { nextId: this.nextId, runtimes };
  }

  /** The old units' meshes go before the restored ones arrive. */
  beforeRestore(): void {
    const view = this.ctx.services.tryGet(UnitViewKey);
    for (const id of this.ctx.match.units.keys()) view?.detach(id);
  }

  loadState(state: unknown): void {
    const s = state as { nextId: EntityId; runtimes: Map<EntityId, UnitRuntime> };
    this.nextId = s.nextId;
    runtimes.clear();
    for (const [id, runtime] of s.runtimes) runtimes.set(id, runtime);
    // Every restored unit needs a body on screen, built the way spawning builds it.
    for (const unit of this.ctx.match.units.values()) {
      const def = HEROES[unit.defId] ?? ENEMIES[unit.defId] ?? BOSSES[unit.defId];
      if (!def) continue;
      this.attachView(unit, getCharacter(def.characterId)?.visual, def.characterId, def.scale);
    }
  }

  dispose(): void {
    runtimes.clear();
  }
}
