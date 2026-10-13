/**
 * Sabotage. Owner: GAMEPLAY. Module order 620.
 *
 * The rival pressure of a versus match: influence, earned by killing your own
 * waves, is spent in the T2 shop to make the other team's life harder. The
 * teams never meet on the map, so this is the only way to hurt them directly.
 *
 * | Sabotage     | Effect on the rival                                        |
 * | ------------ | ---------------------------------------------------------- |
 * | Refuerzos    | 4 extra creeps of the current wave's kinds, from its portal |
 * | Frenesí      | its creeps move 25 % faster for 20 s, new spawns included   |
 * | Invocar élite| its strongest creep becomes elite (or its next one)         |
 * | Maleficio    | its heroes deal 20 % less damage for 15 s                   |
 *
 * Every sabotage names its counterplay in the shop (`items.ts`), and the
 * victims are told what hit them and for how long — a sabotage that arrives
 * unexplained reads as the game being unfair rather than the rival being clever.
 *
 * Timed effects refresh rather than stack: buying Frenzy twice keeps it on for
 * longer, not twice as fast. Everything here runs in the simulation, on ticks,
 * with the match RNG — it is part of what every client must agree on.
 */

import type {
  EntityId,
  GameContext,
  GameModule,
  StatModifier,
  TeamId,
  UnitState,
  Vec2,
} from '@/core/contracts';
import { Faction, UnitKind } from '@/core/contracts';
import { SIM_STEP } from '@/core/engine';
import { cos, sin } from '@/core/detmath';
import { TerrainKey } from '@/core/services';
import type { CombatModule } from './combat';
import type { MatchModule } from './match';
import { runtimeOf, type UnitModule } from './units';
import { SUMMON_COST } from '@/economy/items';
import { planWave } from './waves';
import { BOSSES } from './defs';

export type SabotageId = 'sab.reinforcements' | 'sab.frenzy' | 'sab.elite' | 'sab.hex';

const REINFORCEMENTS = 4;
/** Seconds between reinforcement spawns, so they arrive as a trickle and can be picked off. */
const REINFORCEMENT_INTERVAL = 0.7;
const FRENZY_SECONDS = 20;
const FRENZY_SPEED = 0.25;
const HEX_SECONDS = 15;

/** How many creeps one conjuring puts on the field. */
const SUMMON_COUNT = 10;
/** How long they last, in seconds. */
const SUMMON_SECONDS = 60;
/** Spread of the pack around the chosen spot, in metres. */
const SUMMON_SPREAD = 3.2;

const HEX_DAMAGE = -0.2;

/** Status marker on an elite creep; the world HUD draws its bar in gold. */
export const ELITE_STATUS = 'status.elite';

interface TimedEffect {
  kind: 'frenzy' | 'hex';
  team: TeamId;
  untilTick: number;
}

interface PendingSpawn {
  team: TeamId;
  defKey: string;
  route: number;
  atTick: number;
  difficulty: number;
}

/** What the HUD shows about a sabotage in progress. */
export interface ActiveSabotage {
  id: SabotageId;
  name: string;
  /** The team suffering it. */
  team: TeamId;
  secondsLeft: number;
}

const NAMES: Record<SabotageId, string> = {
  'sab.reinforcements': 'Refuerzos',
  'sab.frenzy': 'Frenesí',
  'sab.elite': 'Élite',
  'sab.hex': 'Maleficio',
};

export class SabotageModule implements GameModule {
  readonly id = 'sabotage';
  readonly order = 620;

  private ctx!: GameContext;
  private readonly effects: TimedEffect[] = [];
  private readonly spawns: PendingSpawn[] = [];
  /** Elites owed to a team whose field was empty when the sabotage landed. */
  private readonly pendingElites = new Map<TeamId, number>();
  laneCount = 1;

  constructor(
    private readonly match: MatchModule,
    private readonly units: UnitModule,
    private readonly combat: CombatModule,
  ) {}

  init(ctx: GameContext): void {
    this.ctx = ctx;
    // New creeps join an active frenzy, and an owed elite claims the first
    // creep to arrive on that site. Emitted inside the simulation, so every
    // client handles the same spawn identically.
    ctx.bus.on('unit:spawn', ({ id }) => this.onSpawn(id));
  }

  /** Whether `heroId` could launch a sabotage right now, and why not. */
  check(heroId: EntityId): { ok: boolean; reason?: string } {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero) return { ok: false, reason: 'Sin héroe' };
    if (this.match.over) return { ok: false, reason: 'La partida ha terminado' };
    if (this.match.rivalsOf(hero.team as TeamId).length === 0) {
      return { ok: false, reason: 'No hay ningún rival al que sabotear' };
    }
    return { ok: true };
  }

  /**
   * Fires a sabotage from `heroId` at the rival team. The economy has already
   * checked the shop and the purse; this only refuses when there is no rival.
   */
  launch(heroId: EntityId, sabotageId: string): { ok: boolean; reason?: string } {
    const verdict = this.check(heroId);
    if (!verdict.ok) return verdict;
    const hero = this.ctx.match.heroes.get(heroId)!;
    const from = hero.team as TeamId;
    const id = sabotageId as SabotageId;
    if (!(id in NAMES)) return { ok: false, reason: 'Sabotaje desconocido' };

    for (const to of this.match.rivalsOf(from)) {
      switch (id) {
        case 'sab.reinforcements':
          this.reinforce(to);
          break;
        case 'sab.frenzy':
          this.startTimed('frenzy', to, FRENZY_SECONDS);
          break;
        case 'sab.elite':
          this.elite(to);
          break;
        case 'sab.hex':
          this.startTimed('hex', to, HEX_SECONDS);
          break;
      }
      this.ctx.bus.emit('sabotage:launched', { sabotageId: id, fromTeam: from, toTeam: to });
      this.ctx.bus.emit('ui:notify', { text: this.victimMessage(id), severity: 'danger', team: to });
      this.ctx.bus.emit('camera:shake', { intensity: 0.35, duration: 0.3, team: to });
    }
    this.ctx.bus.emit('ui:notify', { text: `Sabotaje lanzado: ${NAMES[id]}`, severity: 'reward', heroId });
    return { ok: true };
  }

  /**
   * Conjures a pack of ten where the player pointed.
   *
   * Which side of the map the spot falls on decides whose creatures they are,
   * and that is the whole feature:
   *
   * - **On the rival's half** they are ordinary hostiles. They pick the lane
   *   up at the spot they land on — `laneIndexNear`, the same rule a boss's
   *   minions use — so they walk on toward that Core and never back up the way
   *   they came.
   * - **On your own half** they take your team's faction instead. `isHostileTo`
   *   then has them fight the wave and ignore every hero on the field, yours
   *   and the rival's, which is exactly "they will not hurt you or your
   *   allies". They hold the ground they were put on rather than marching,
   *   because the lane only runs one way and a bodyguard that walks off to the
   *   enemy Core is not a bodyguard.
   *
   * The kinds come from the NEXT wave rather than the current one: the player
   * is buying a preview of what is about to arrive, which is what makes the
   * defensive use a read on the match instead of a lottery.
   */
  summon(heroId: EntityId, pos: Vec2): { ok: boolean; reason?: string } {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero || !hero.alive) return { ok: false, reason: 'Sin héroe' };
    if (hero.influence < SUMMON_COST) return { ok: false, reason: 'Influencia insuficiente' };

    // Never a boss wave: ten dragons for 220 influence would end the match.
    const next = Math.max(1, this.ctx.match.wave + 1);
    let plan = planWave(next, this.ctx.match.seed);
    if (plan.isBoss) plan = planWave(Math.max(1, next - 1), this.ctx.match.seed);
    const entries = plan.entries.filter((e) => BOSSES[e.defKey] === undefined);
    if (entries.length === 0) return { ok: false, reason: 'Nada que convocar' };

    const team = hero.team as TeamId;
    // The map is mirrored on x and team 0 holds the negative half.
    const homeSign = team === 1 ? 1 : -1;
    const rival = this.match.rivalsOf(team)[0];
    // With no rival there is no far half to send anything to: a solo match
    // builds one site, so a pack pointed across the map would march a lane
    // toward a Core that does not exist. Everything conjured is yours.
    const mine = rival === undefined || Math.sign(pos.x) === homeSign || pos.x === 0;
    const siteTeam: TeamId = mine ? team : rival;

    hero.influence -= SUMMON_COST;
    const until = this.ctx.clock.tick + Math.round(SUMMON_SECONDS / SIM_STEP);
    const ids: EntityId[] = [];
    for (let i = 0; i < SUMMON_COUNT; i++) {
      const pick = this.ctx.rng.weighted(entries, (e) => e.count);
      // A ring, so ten bodies do not arrive inside one another and spend their
      // first second pushing apart.
      const a = (i / SUMMON_COUNT) * Math.PI * 2;
      const at = {
        x: pos.x + cos(a) * SUMMON_SPREAD,
        z: pos.z + sin(a) * SUMMON_SPREAD,
      };
      const unit = this.units.spawnEnemy(pick.defKey, at, siteTeam, plan.difficulty);
      const runtime = runtimeOf(unit.id);
      if (runtime) {
        runtime.expiresAtTick = until;
        runtime.summonedAtTick = this.ctx.clock.tick;
        runtime.allied = mine;
      }
      if (mine) {
        // The allegiance lives in the faction, which is what combat reads.
        unit.faction = (team === 1 ? Faction.TeamB : Faction.TeamA) as Faction;
        unit.team = team;
      }
      ids.push(unit.id);
    }

    this.ctx.bus.emit('ui:notify', {
      text: mine ? `Has convocado ${SUMMON_COUNT} aliados` : `Has enviado ${SUMMON_COUNT} monstruos`,
      severity: 'reward',
      heroId,
    });
    if (!mine) {
      this.ctx.bus.emit('ui:notify', {
        text: 'Monstruos convocados en tu campo', severity: 'danger', team: siteTeam,
      });
    }
    return { ok: true };
  }

  /**
   * Sends conjured creeps to a spot.
   *
   * Only your own, and only summons: the order is a player's, and a command
   * that could walk the rival's wave off the lane would be a different game.
   */
  herd(
    heroId: EntityId,
    ids: EntityId[],
    order: 'move' | 'attackMove' | 'attack' | 'hold',
    pos?: Vec2,
    targetId?: EntityId,
  ): void {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero) return;
    // An attack order at something that is already dead, or at one of your own,
    // is dropped whole rather than sent to ten creeps one by one.
    const victim = order === 'attack' && targetId !== undefined
      ? this.ctx.match.units.get(targetId)
      : undefined;
    if (order === 'attack' && (!victim || !victim.alive || victim.team === hero.team)) return;

    for (const id of ids) {
      const unit = this.ctx.match.units.get(id);
      const runtime = runtimeOf(id);
      if (!unit || !unit.alive || !runtime?.allied || unit.team !== hero.team) continue;
      if (order === 'hold') {
        runtime.holding = true;
        runtime.orderPos = undefined;
        unit.targetId = null;
        continue;
      }
      // Any order to go somewhere, or at something, releases the hold.
      runtime.holding = false;
      if (order === 'attack') {
        unit.targetId = targetId ?? null;
        runtime.orderPos = undefined;
        runtime.passive = false;
      } else if (pos) {
        runtime.orderPos = { x: pos.x, z: pos.z };
        // A march engages; a move walks past. That is the whole difference
        // between the two, and it is why `A` is worth having.
        runtime.passive = order === 'move';
        if (order === 'move') unit.targetId = null;
      }
    }
  }

  /** Sabotages in progress, for the HUD. */
  active(): ActiveSabotage[] {
    const tick = this.ctx.clock.tick;
    const out: ActiveSabotage[] = [];
    for (const e of this.effects) {
      const id: SabotageId = e.kind === 'frenzy' ? 'sab.frenzy' : 'sab.hex';
      out.push({ id, name: NAMES[id], team: e.team, secondsLeft: Math.max(0, (e.untilTick - tick) * SIM_STEP) });
    }
    for (const [team, count] of this.pendingElites) {
      if (count > 0) out.push({ id: 'sab.elite', name: 'Élite pendiente', team, secondsLeft: -1 });
    }
    return out;
  }

  fixedUpdate(): void {
    const tick = this.ctx.clock.tick;

    // Conjured creeps have a deadline. Swept here rather than in the unit
    // module because this is where they were made, and a minute is long
    // enough that scanning the field once a tick for them would be the only
    // thing this list ever costs.
    for (const unit of [...this.ctx.match.units.values()]) {
      const runtime = runtimeOf(unit.id);
      if (runtime?.expiresAtTick === undefined || tick < runtime.expiresAtTick) continue;
      // Despawned rather than killed: a conjuring that ends should not pay a
      // bounty to whoever happens to be standing next to it.
      this.units.despawn(unit.id);
    }

    for (let i = 0; i < this.spawns.length; ) {
      const s = this.spawns[i]!;
      if (s.atTick > tick) {
        i++;
        continue;
      }
      this.spawns.splice(i, 1);
      // The victim's Core may have fallen while these were on their way.
      const standing = this.match.rivalsOf(s.team === 1 ? 0 : 1).includes(s.team);
      if (this.match.over || !standing) continue;
      const path = this.laneStart(s.team, s.route);
      if (!path) continue;
      const pos = { x: path.x + this.ctx.rng.range(-2.5, 2.5), z: path.z + this.ctx.rng.range(-2.5, 2.5) };
      this.units.spawnEnemy(s.defKey, pos, s.team, s.difficulty, s.route);
    }

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i]!;
      if (tick < e.untilTick) continue;
      this.effects.splice(i, 1);
      this.removeModifiers(e.kind, e.team);
      this.ctx.bus.emit('sabotage:resolved', { sabotageId: e.kind === 'frenzy' ? 'sab.frenzy' : 'sab.hex', toTeam: e.team });
    }
  }

  // ── Effects ────────────────────────────────────────────────────────────────

  private reinforce(team: TeamId): void {
    // Kinds from the wave the rival is facing — never a boss, which would turn
    // a 120-influence purchase into a match-ending one.
    let wave = Math.max(1, this.ctx.match.wave);
    let plan = planWave(wave, this.ctx.match.seed);
    if (plan.isBoss) plan = planWave(Math.max(1, wave - 1), this.ctx.match.seed);
    wave = plan.wave;
    const entries = plan.entries.filter((e) => BOSSES[e.defKey] === undefined);
    const now = this.ctx.clock.tick;
    for (let i = 0; i < REINFORCEMENTS; i++) {
      const pick = this.ctx.rng.weighted(entries, (e) => e.count);
      this.spawns.push({
        team,
        defKey: pick.defKey,
        route: i % Math.max(1, this.laneCount),
        atTick: now + 1 + Math.round((i * REINFORCEMENT_INTERVAL) / SIM_STEP),
        difficulty: plan.difficulty,
      });
    }
  }

  private startTimed(kind: TimedEffect['kind'], team: TeamId, seconds: number): void {
    const until = this.ctx.clock.tick + Math.round(seconds / SIM_STEP);
    const existing = this.effects.find((e) => e.kind === kind && e.team === team);
    if (existing) {
      existing.untilTick = Math.max(existing.untilTick, until);
      return;
    }
    this.effects.push({ kind, team, untilTick: until });
    for (const unit of this.ctx.match.units.values()) this.applyTo(kind, team, unit);
  }

  private applyTo(kind: TimedEffect['kind'], team: TeamId, unit: UnitState): void {
    if (!unit.alive && unit.kind !== UnitKind.Hero) return;
    const source = kind === 'frenzy' ? 'sab.frenzy' : 'sab.hex';
    if (unit.modifiers.some((m) => m.sourceId === source)) return;
    let mods: StatModifier[];
    if (kind === 'frenzy') {
      if (unit.faction !== Faction.Hostile || runtimeOf(unit.id)?.siteTeam !== team) return;
      mods = [{ stat: 'moveSpeed', op: 'pct', value: FRENZY_SPEED, sourceId: source }];
    } else {
      if (unit.kind !== UnitKind.Hero || unit.team !== team) return;
      mods = [
        { stat: 'attackDamage', op: 'pct', value: HEX_DAMAGE, sourceId: source },
        { stat: 'spellPower', op: 'pct', value: HEX_DAMAGE, sourceId: source },
      ];
    }
    unit.modifiers.push(...mods);
    this.combat.recomputeStats(unit);
  }

  private removeModifiers(kind: TimedEffect['kind'], team: TeamId): void {
    const source = kind === 'frenzy' ? 'sab.frenzy' : 'sab.hex';
    for (const unit of this.ctx.match.units.values()) {
      const onTeam =
        kind === 'frenzy' ? runtimeOf(unit.id)?.siteTeam === team && unit.faction === Faction.Hostile : unit.team === team;
      if (!onTeam) continue;
      const before = unit.modifiers.length;
      unit.modifiers = unit.modifiers.filter((m) => m.sourceId !== source);
      if (unit.modifiers.length !== before) this.combat.recomputeStats(unit);
    }
  }

  /** The rival's strongest creep becomes elite; with none on the field, the next one will. */
  private elite(team: TeamId): void {
    let best: UnitState | null = null;
    for (const unit of this.ctx.match.units.values()) {
      if (!this.eligible(unit, team)) continue;
      // Highest health wins; ids break ties, so every client picks the same one.
      if (!best || unit.stats.maxHealth > best.stats.maxHealth) best = unit;
    }
    if (best) this.makeElite(best);
    else this.pendingElites.set(team, (this.pendingElites.get(team) ?? 0) + 1);
  }

  private eligible(unit: UnitState, team: TeamId): boolean {
    return (
      unit.alive &&
      unit.faction === Faction.Hostile &&
      unit.kind !== UnitKind.Boss &&
      runtimeOf(unit.id)?.siteTeam === team &&
      !unit.statuses.some((s) => s.defId === ELITE_STATUS)
    );
  }

  private makeElite(unit: UnitState): void {
    const runtime = runtimeOf(unit.id);
    if (!runtime) return;
    const before = unit.stats.maxHealth;
    unit.modifiers.push(
      { stat: 'maxHealth', op: 'pct', value: 2, sourceId: 'sab.elite' },
      { stat: 'attackDamage', op: 'pct', value: 0.5, sourceId: 'sab.elite' },
      { stat: 'armor', op: 'flat', value: 6, sourceId: 'sab.elite' },
    );
    this.combat.recomputeStats(unit);
    // Keep the wounds it already has: triple the pool, not a full heal.
    unit.health = (unit.health / Math.max(1, before)) * unit.stats.maxHealth;
    // A copy: the bounty object is shared with every creep of the same kind.
    runtime.bounty = { gold: runtime.bounty.gold * 3, xp: runtime.bounty.xp * 3 };
    unit.statuses.push({ defId: ELITE_STATUS, stacks: 1, expiresAt: Infinity, nextTickAt: Infinity, sourceId: 0 });
    this.ctx.bus.emit('vfx:request', { vfxId: 'aura.guard', pos: unit.pos, scale: 2.2 });
  }

  private onSpawn(id: EntityId): void {
    const unit = this.ctx.match.units.get(id);
    if (!unit) return;
    for (const e of this.effects) this.applyTo(e.kind, e.team, unit);
    const team = runtimeOf(id)?.siteTeam;
    if (team === undefined) return;
    const owed = this.pendingElites.get(team) ?? 0;
    if (owed > 0 && this.eligible(unit, team)) {
      this.pendingElites.set(team, owed - 1);
      this.makeElite(unit);
    }
  }

  private laneStart(team: TeamId, route: number): { x: number; z: number } | null {
    return this.ctx.services.get(TerrainKey).lanePath(team, route)[0] ?? null;
  }

  private victimMessage(id: SabotageId): string {
    switch (id) {
      case 'sab.reinforcements':
        return `¡Sabotaje! Refuerzos: ${REINFORCEMENTS} enemigos más vienen hacia tu Núcleo`;
      case 'sab.frenzy':
        return `¡Sabotaje! Frenesí: tus enemigos corren un 25 % más durante ${FRENZY_SECONDS} s`;
      case 'sab.elite':
        return '¡Sabotaje! Un enemigo se ha convertido en élite';
      case 'sab.hex':
        return `¡Sabotaje! Maleficio: tu daño baja un 20 % durante ${HEX_SECONDS} s`;
    }
  }

  saveState(): unknown {
    return { effects: this.effects, spawns: this.spawns, pendingElites: this.pendingElites };
  }

  loadState(state: unknown): void {
    const s = state as { effects: TimedEffect[]; spawns: PendingSpawn[]; pendingElites: Map<TeamId, number> };
    this.effects.length = 0;
    this.effects.push(...s.effects);
    this.spawns.length = 0;
    this.spawns.push(...s.spawns);
    this.pendingElites.clear();
    for (const [team, count] of s.pendingElites) this.pendingElites.set(team, count);
  }

  dispose(): void {
    this.effects.length = 0;
    this.spawns.length = 0;
    this.pendingElites.clear();
  }
}

