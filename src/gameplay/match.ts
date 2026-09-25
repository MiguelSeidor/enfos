/**
 * Match setup and flow. Owner: GAMEPLAY.
 *
 * Places each team's Core and fountain, spawns every player's hero, wires the
 * modules that need to know about each other, and owns win/loss. Runs late
 * (order 550) so every service it depends on is registered.
 *
 * ## Teams
 *
 * The map is mirrored across x = 0: team 0 holds the −X half, team 1 the +X
 * half. Each team defends its own Core against its own copy of every wave; the
 * halves are not connected, so the teams never meet — they compete, as in the
 * game this draws on, by outlasting each other and by sabotage.
 *
 * A solo match is the same code with one team.
 */

import type { EntityId, GameContext, GameModule, HeroState, TeamId, UnitState, Vec2 } from '@/core/contracts';
import { Faction } from '@/core/contracts';
import { TerrainKey, type TerrainService } from '@/core/services';
import { LANE_COUNT, landmark } from '@/world/layout';
import { dist2, levelScale } from '@/core/mathx';
import type { CombatModule } from './combat';
import type { MovementModule } from './movement';
import { heroOrders } from './movement';
import type { MatchSetup } from './setup';
import { teamsOf } from './setup';
import { runtimeOf, type UnitModule } from './units';
import type { WaveModule } from './waves';
import { WAVES_TOTAL } from './waves';
import { hypot } from '@/core/detmath';

const CORE_LIVES = 12;
/** Fraction of max health and mana the fountain restores per second. */
const FOUNTAIN_FRACTION_PER_SECOND = 0.09;
/** Every fifth level is a milestone, worth extra progression rewards. */
const MILESTONE_EVERY = 5;
/**
 * How far from the Core's centre the hero stands, on spawn and on revive.
 *
 * The Core's landmark radius is 9 and its plinth occupies the middle of that,
 * so anything under about 6 puts the hero inside the geometry.
 */
const HERO_SPAWN_OFFSET = 7;
/** Sideways spacing between teammates standing at the same Core. */
const TEAMMATE_SPACING = 2.2;

/** First revival wait, in seconds. */
const FIRST_REVIVE_SECONDS = 10;
/** Added to the wait for every death after the first: 10 s, 15 s, 20 s, … */
const REVIVE_INCREMENT = 5;

/** XP needed to reach `level + 1`. Grows forever, never overflows (GDD §9). */
export function xpToNext(level: number): number {
  return Math.round(90 * level * levelScale(level, 1, 1.035));
}

/** −1 for team 0's half of the map, +1 for team 1's. */
export function teamSign(team: TeamId): -1 | 1 {
  return team === 1 ? 1 : -1;
}

interface TeamSite {
  team: TeamId;
  core: Vec2;
  /** Where this team's creeps enter, used to face spawned heroes the right way. */
  spawn: Vec2;
  fountain: { pos: Vec2; radius: number };
  eliminated: boolean;
}

interface Revival {
  /** Tick the downed hero comes back, or null while it is alive. */
  atTick: number | null;
  deaths: number;
  seconds: number;
}

export class MatchModule implements GameModule {
  readonly id = 'match';
  readonly order = 550;

  private ctx!: GameContext;
  private terrain!: TerrainService;
  private readonly sites = new Map<TeamId, TeamSite>();
  private readonly slotHeroes = new Map<number, HeroState>();
  private readonly revivals = new Map<EntityId, Revival>();
  private readonly forfeited = new Set<number>();
  /** Why the match ended, for the end screen. */
  endCause: 'core' | 'forfeit' | 'waves' | null = null;
  private pendingCause: 'core' | 'forfeit' | 'waves' = 'core';

  /** The hero this machine controls. Presentation reads it; the simulation never does. */
  playerHero: HeroState | null = null;

  constructor(
    private readonly unitModule: UnitModule,
    private readonly combat: CombatModule,
    private readonly movement: MovementModule,
    private readonly waves: WaveModule,
    readonly setup: MatchSetup,
  ) {}

  /** The local player's team. */
  get localTeam(): TeamId {
    return this.setup.players.find((p) => p.slot === this.setup.localSlot)?.team ?? 0;
  }

  /** The local team's fountain, for the HUD and the minimap. */
  get fountain(): { pos: Vec2; radius: number } | null {
    return this.sites.get(this.localTeam)?.fountain ?? null;
  }

  saveState(): unknown {
    return {
      eliminated: [...this.sites.values()].filter((s) => s.eliminated).map((s) => s.team),
      revivals: this.revivals,
      forfeited: this.forfeited,
      endCause: this.endCause,
      pendingCause: this.pendingCause,
    };
  }

  loadState(state: unknown): void {
    const s = state as {
      eliminated: TeamId[];
      revivals: Map<EntityId, Revival>;
      forfeited: Set<number>;
      endCause: MatchModule['endCause'];
      pendingCause: MatchModule['pendingCause'];
    };
    for (const site of this.sites.values()) site.eliminated = s.eliminated.includes(site.team);
    this.revivals.clear();
    for (const [id, revival] of s.revivals) this.revivals.set(id, revival);
    this.forfeited.clear();
    for (const slot of s.forfeited) this.forfeited.add(slot);
    this.endCause = s.endCause;
    this.pendingCause = s.pendingCause;
    // The hero objects are new; re-point the slot table at them.
    this.slotHeroes.clear();
    for (const hero of this.ctx.match.heroes.values()) {
      const slot = Number(hero.ownerId.startsWith('slot:') ? hero.ownerId.slice(5) : NaN);
      if (Number.isInteger(slot)) this.slotHeroes.set(slot, hero);
    }
    this.playerHero = this.slotHeroes.get(this.setup.localSlot) ?? null;
  }

  /** Teams still standing that are not `team`: the targets a sabotage can hit. */
  rivalsOf(team: TeamId): TeamId[] {
    const out: TeamId[] = [];
    for (const site of this.sites.values()) {
      if (site.team !== team && !site.eliminated) out.push(site.team);
    }
    return out;
  }

  /** Whether the match has ended. */
  get over(): boolean {
    return this.isOver;
  }

  heroOfSlot(slot: number): HeroState | null {
    return this.slotHeroes.get(slot) ?? null;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.terrain = ctx.services.get(TerrainKey);

    this.movement.bind(this.combat);
    this.waves.bind(this.unitModule);

    const coreMark = landmark('core');
    const fountainMark = landmark('fountain');
    const teams = teamsOf(this.setup);

    for (const team of teams) {
      // Landmarks are authored once, in mirrored space.
      const sign = teamSign(team);
      const place = (l: { u: number; v: number }): Vec2 => ({ x: sign * l.u, z: l.v });
      const lane = this.terrain.lanePath(team, 0);
      this.sites.set(team, {
        team,
        core: place(coreMark),
        spawn: lane.length > 0 ? { ...lane[0]! } : place(landmark('spawnPortal')),
        fountain: { pos: place(fountainMark), radius: fountainMark.radius + 2.5 },
        eliminated: false,
      });
    }

    ctx.match.cores = teams.map((team) => ({
      team,
      pos: this.sites.get(team)!.core,
      lives: CORE_LIVES,
      maxLives: CORE_LIVES,
    }));
    for (const site of this.sites.values()) {
      this.waves.spawnPoints[site.team] = site.spawn;
      this.movement.corePositions[site.team] = site.core;
    }
    this.waves.activeTeams = [...teams];
    this.waves.teamSize = Math.max(
      1,
      ...teams.map((team) => this.setup.players.filter((p) => p.team === team).length),
    );
    // Both forks share the spawn shelf, so one spawn point covers them all.
    this.waves.laneCount = LANE_COUNT;
    this.waves.onAllWavesSurvived = () => this.onAllWavesSurvived();
    this.movement.onLeak = (unit) => this.onLeak(unit);
    // Summoners raise minions through the match module rather than calling the
    // unit module directly, so a summon marches on the summoner's own site.
    // Difficulty 1: minions do not scale with the wave. A summoner that got
    // stronger creeps as the match went on would compound with its own count.
    this.movement.onSummon = (defId, pos, siteTeam) =>
      this.unitModule.spawnEnemy(defId, pos, siteTeam, 1).id;

    // Heroes in slot order, so every machine hands out the same entity ids.
    const players = [...this.setup.players].sort((a, b) => a.slot - b.slot);
    const perTeam = new Map<TeamId, number>();
    for (const player of players) {
      const index = perTeam.get(player.team) ?? 0;
      perTeam.set(player.team, index + 1);
      const hero = this.unitModule.spawnHero(
        player.heroKey,
        this.homeSpot(player.team, index),
        player.team,
        `slot:${player.slot}`,
      );
      this.slotHeroes.set(player.slot, hero);
      this.revivals.set(hero.id, { atTick: null, deaths: 0, seconds: 0 });
    }
    this.playerHero = this.slotHeroes.get(this.setup.localSlot) ?? null;

    ctx.match.phase = 'preparation';
    ctx.bus.emit('match:start', { seed: ctx.match.seed, mode: ctx.match.mode });

    ctx.bus.on('hero:xp', ({ id, amount }) => this.grantXp(id, amount));
  }

  /**
   * Beside the team's Core, toward its lane. At the Core, which is also where a
   * revive puts them: one place the player learns as "home". Teammates stand
   * side by side rather than on top of each other.
   */
  private homeSpot(team: TeamId, index: number): Vec2 {
    const site = this.sites.get(team)!;
    const dx = site.spawn.x - site.core.x;
    const dz = site.spawn.z - site.core.z;
    const len = hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    // 0, +1, −1, +2… along the perpendicular. Flipped with the site, so the two
    // line-ups are mirror images: otherwise one team's second hero started
    // toward the middle of the map and the other's away from it.
    const side =
      (index === 0 ? 0 : (index % 2 === 1 ? 1 : -1) * Math.ceil(index / 2) * TEAMMATE_SPACING) *
      teamSign(team);
    return {
      x: site.core.x + ux * HERO_SPAWN_OFFSET - uz * side,
      z: site.core.z + uz * HERO_SPAWN_OFFSET + ux * side,
    };
  }

  /**
   * A hero's place in its team's home line-up, so a revive returns it to the
   * same spot it started on instead of stacking every teammate on one tile.
   * Read from the setup, which is identical on every machine.
   */
  private homeIndexOf(hero: HeroState): number {
    let slot = -1;
    for (const [s, h] of this.slotHeroes) if (h === hero) slot = s;
    if (slot < 0) return 0;
    const mates = this.setup.players
      .filter((p) => p.team === hero.team)
      .sort((a, b) => a.slot - b.slot);
    return Math.max(0, mates.findIndex((p) => p.slot === slot));
  }

  private grantXp(heroId: number, amount: number): void {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero) return;
    hero.xp += amount;
    let levelled = false;

    // `while`, not `if`: a boss bounty can carry a hero through several levels.
    //
    // The event fires once *per level*, not once per grant. Emitting only the
    // final level made a multi-level jump pay out a single level's worth of
    // attribute points and skip any milestone it passed through — a hero going
    // 4 → 7 in one bounty would miss level 5's bonus entirely.
    while (hero.xp >= xpToNext(hero.level)) {
      hero.xp -= xpToNext(hero.level);
      hero.level++;
      levelled = true;
      this.ctx.bus.emit('hero:levelUp', {
        id: heroId,
        level: hero.level,
        milestone: hero.level % MILESTONE_EVERY === 0,
      });
    }
    if (!levelled) return;
    this.unitModule.applyHeroLevel(hero);
    // `applyHeroLevel` rebuilds the block from the level curve alone, which
    // wipes every modifier the hero is carrying. Without this the hero silently
    // *lost* its items and spent attribute points on each level-up — the stat
    // panel showing "36" with no bonus was reporting that faithfully.
    this.combat.recomputeStats(hero);
  }

  private onLeak(unit: UnitState): void {
    const team = runtimeOf(unit.id)?.siteTeam ?? 0;
    const core = this.ctx.match.cores.find((c) => c.team === team);
    this.unitModule.despawn(unit.id);
    if (!core || this.isOver) return;

    core.lives = Math.max(0, core.lives - 1);
    this.ctx.bus.emit('core:leak', { team, livesLeft: core.lives, enemyDefId: unit.defId });
    this.ctx.bus.emit('ui:notify', { text: '¡El Núcleo ha sido alcanzado!', severity: 'danger', team });
    this.ctx.bus.emit('camera:shake', { intensity: 0.7, duration: 0.4, team });

    if (core.lives === 0) this.eliminate(team);
  }

  private get isOver(): boolean {
    return this.ctx.match.phase === 'victory' || this.ctx.match.phase === 'defeat';
  }

  /**
   * A team's Core has fallen. The site goes quiet — its creeps are cleared and
   * no more spawn there — and if only one team is left standing, it has won.
   */
  private eliminate(team: TeamId, cause: 'core' | 'forfeit' = 'core'): void {
    const site = this.sites.get(team);
    if (!site || site.eliminated) return;
    site.eliminated = true;
    // A team that walked away has not had its Core blown up: no explosion.
    if (cause === 'core') this.ctx.bus.emit('core:destroyed', { team });
    this.pendingCause = cause;

    this.waves.activeTeams = this.waves.activeTeams.filter((t) => t !== team);
    // Clear the field. With the Core gone the wave has nothing to attack and
    // nothing to leak into, so leaving the creeps walking made the defeat
    // look like a rendering glitch rather than the end of the match.
    for (const unit of [...this.ctx.match.units.values()]) {
      if (unit.faction === Faction.Hostile && runtimeOf(unit.id)?.siteTeam === team) {
        this.unitModule.despawn(unit.id);
      }
    }
    for (const hero of this.ctx.match.heroes.values()) {
      if (hero.team === team) heroOrders.delete(hero.id);
    }

    const standing = [...this.sites.values()].filter((s) => !s.eliminated);
    if (this.sites.size === 1) {
      // Solo: the only Core fell. There is no winning team, only a loss.
      this.end(null);
    } else if (standing.length <= 1) {
      this.end(standing[0]?.team ?? null);
    }
  }

  /**
   * A player left. Their hero stops where it is; once every player of a team
   * has left, that team is out, exactly as if its Core had fallen.
   */
  forfeit(slot: number): void {
    if (this.forfeited.has(slot)) return;
    this.forfeited.add(slot);
    const player = this.setup.players.find((p) => p.slot === slot);
    if (!player) return;
    const hero = this.slotHeroes.get(slot);
    if (hero) heroOrders.delete(hero.id);
    this.ctx.bus.emit('ui:notify', { text: `${player.name} ha abandonado la partida`, severity: 'warn' });
    const teamLeft = this.setup.players.filter((p) => p.team === player.team).every((p) => this.forfeited.has(p.slot));
    if (teamLeft) this.eliminate(player.team, 'forfeit');
  }

  /**
   * Every wave survived. Solo, that is a win. With rivals still standing, the
   * team whose Core has taken the fewest hits wins; equal lives is a draw.
   */
  private onAllWavesSurvived(): void {
    const standing = [...this.sites.values()].filter((s) => !s.eliminated);
    if (standing.length <= 1) {
      // Solo, or everyone else already gone: surviving the sixty waves wins it.
      this.pendingCause = 'waves';
      this.end(standing[0]?.team ?? null);
      return;
    }
    // Two teams still standing after sixty waves is a draw, and a draw settles
    // nothing. Overtime keeps sending waves until one Core falls.
    this.waves.beginSuddenDeath();
    this.ctx.bus.emit('ui:notify', {
      text: '¡MUERTE SÚBITA! Las oleadas no paran hasta que caiga un Núcleo',
      severity: 'danger',
    });
  }

  /**
   * Ends the match. `winner` null means nobody won: a solo loss, or a draw.
   * `victory` is the phase whenever a team won; each client decides from
   * `winner` whether that is its own victory or its defeat.
   */
  private end(winner: TeamId | null): void {
    if (this.isOver) return;
    this.endCause = this.pendingCause;
    this.ctx.match.winner = winner;
    this.ctx.match.phase = winner === null ? 'defeat' : 'victory';
    this.ctx.bus.emit('match:end', { winner });
    heroOrders.clear();
  }

  /**
   * Fountain restoration.
   *
   * Percentage-based rather than a flat rate, so it stays meaningful as the
   * hero's pools grow without bound (GDD §9). Only heroes benefit — a fountain
   * that healed creeps would make the base unassailable — and only at their
   * own team's fountain.
   */
  private tickFountain(step: number, ctx: GameContext): void {
    for (const hero of ctx.match.heroes.values()) {
      if (!hero.alive) continue;
      const pool = this.sites.get(hero.team as TeamId)?.fountain;
      if (!pool || dist2(hero.pos, pool.pos) > pool.radius * pool.radius) continue;
      const healed = Math.min(
        hero.stats.maxHealth - hero.health,
        hero.stats.maxHealth * FOUNTAIN_FRACTION_PER_SECOND * step,
      );
      if (healed > 0) hero.health += healed;
      hero.mana = Math.min(
        hero.stats.maxMana,
        hero.mana + hero.stats.maxMana * FOUNTAIN_FRACTION_PER_SECOND * step,
      );
      // One pulse a second keeps the feedback legible without spamming numbers.
      if (healed > 0 && ctx.clock.tick % 30 === 0) {
        ctx.bus.emit('unit:heal', {
          targetId: hero.id,
          sourceId: null,
          amount: hero.stats.maxHealth * FOUNTAIN_FRACTION_PER_SECOND,
          pos: hero.pos,
        });
      }
    }
  }

  /** Puts a downed hero back on its feet at its team's Core. */
  private revive(hero: HeroState, ctx: GameContext): void {
    hero.alive = true;
    hero.health = hero.stats.maxHealth * 0.5;
    hero.mana = hero.stats.maxMana * 0.5;
    const spot = this.homeSpot(hero.team as TeamId, this.homeIndexOf(hero));
    hero.pos.x = spot.x;
    hero.pos.z = spot.z;
    hero.vel.x = 0;
    hero.vel.z = 0;
    hero.targetId = null;
    heroOrders.delete(hero.id);
    ctx.bus.emit('hero:revive', { id: hero.id, pos: hero.pos });
    ctx.bus.emit('ui:notify', { text: 'Héroe reconstituido en el Núcleo', severity: 'warn', heroId: hero.id });
  }

  /** Seconds until the local hero returns, or -1 when it is alive. */
  get reviveCountdown(): number {
    const hero = this.playerHero;
    const revival = hero ? this.revivals.get(hero.id) : undefined;
    if (!revival || revival.atTick === null) return -1;
    // The match is over: there is nothing to come back for, and a timer still
    // counting down over a destroyed Core reads as though the game continues.
    if (this.isOver) return -1;
    return Math.max(0, (revival.atTick - this.ctx.clock.tick) / 30);
  }

  get reviveDelay(): number {
    const hero = this.playerHero;
    return hero ? (this.revivals.get(hero.id)?.seconds ?? 0) : 0;
  }

  fixedUpdate(step: number, ctx: GameContext): void {
    this.tickFountain(step, ctx);
    if (this.isOver) return;

    // Downed heroes: a timed revival at the Core rather than ending the run.
    // Losing is the Core's job (GDD §6); a hero death is a tempo loss.
    //
    // The wait grows with each death — 10 s, then 15 s, then +5 s every time —
    // so dying stays survivable early and becomes genuinely costly in the late
    // waves, when the hero is the only thing holding the lane.
    for (const hero of ctx.match.heroes.values()) {
      const revival = this.revivals.get(hero.id);
      if (!revival) continue;
      if (hero.alive) {
        revival.atTick = null;
        continue;
      }
      if (revival.atTick === null) {
        revival.deaths++;
        const wait = FIRST_REVIVE_SECONDS + Math.max(0, revival.deaths - 1) * REVIVE_INCREMENT;
        revival.atTick = ctx.clock.tick + Math.round(wait / step);
        revival.seconds = wait;
        ctx.bus.emit('ui:notify', {
          text: `Héroe caído — reaparece en ${Math.round(wait)} s`,
          severity: 'danger',
          heroId: hero.id,
        });
      } else if (ctx.clock.tick >= revival.atTick) {
        this.revive(hero, ctx);
        revival.atTick = null;
      }
    }
  }

  get totalWaves(): number {
    return WAVES_TOTAL;
  }

  dispose(): void {
    heroOrders.clear();
  }
}
