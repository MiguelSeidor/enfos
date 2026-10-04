/**
 * Wave composition and scheduling. Owner: GAMEPLAY.
 *
 * Waves are generated from a seed and a budget rather than hand-authored, so the
 * 60-wave curve (GDD §7) is a formula that can be tuned and replayed rather than
 * sixty tables to maintain. Same seed and same wave number always produce the
 * same roster — that is what makes a QA repro possible.
 *
 * Difficulty rises on several axes at once, as the GDD requires: budget (count),
 * a stat multiplier, composition drift toward harder archetypes, and periodic
 * elite and boss waves.
 */

import type { GameContext, GameModule, TeamId, UnitState, Vec2 } from '@/core/contracts';
import {
  CombatKey,
  TerrainKey,
  UnitKey,
  WaveKey,
  type TerrainService,
  type UnitService,
  type WaveService,
} from '@/core/services';
import { createRng } from '@/core/rng';
import { ENEMIES } from './defs';
import { runtimeOf, type UnitModule } from './units';
import { pow } from '@/core/detmath';

export const WAVES_TOTAL = 60;
/** Seconds of preparation before the first wave and between waves. */
export const INTERMISSION = 20;
const BOSS_EVERY = 10;

export interface WavePlan {
  wave: number;
  entries: { defKey: string; count: number }[];
  difficulty: number;
  isBoss: boolean;
  /** Sudden death: past the last authored wave, with the overtime multipliers. */
  sudden: boolean;
  /** Seconds between individual spawns. */
  interval: number;
}

/**
 * Sudden death, from wave 61 on.
 *
 * Sixty waves survived by both teams is a draw, and a draw is not a result.
 * Overtime keeps sending waves that move and hit twice as fast and twice as
 * hard, growing every time, until one Core falls. Nobody outlasts this.
 */
export const SUDDEN_SPEED = 1;
export const SUDDEN_DAMAGE = 1;
/** Each overtime wave beyond the first adds this much to the stat multiplier. */
const SUDDEN_STEP = 0.35;

/**
 * Budget curve.
 *
 * The first pass opened with 37 points — three creeps — which read as a test
 * wave rather than a wave. This starts at ~80 (eight creeps split across two
 * portals) and uses a sub-quadratic exponent so the count keeps climbing without
 * running past the 300-unit performance budget at wave 60:
 *
 *   wave  1 →   82 pts ≈   8 creeps
 *   wave 10 →  300 pts ≈  30
 *   wave 30 →  889 pts ≈  89
 *   wave 60 → 1953 pts ≈ 195
 */
function budgetFor(wave: number): number {
  return 60 + wave * 20 + pow(wave, 1.6);
}

/** Stat multiplier. Sub-exponential; doubles roughly every 18 waves. */
function difficultyFor(wave: number): number {
  return pow(1.04, wave) + wave * 0.012;
}

/**
 * How much bigger a wave gets per extra defender on a site.
 *
 * Not linear: two heroes on one Core are worth more than twice one hero —
 * they cover each other, share a fountain and stack their slows — so a 2v2
 * whose waves were merely doubled would be easier than the 1v1.
 */
const PER_EXTRA_DEFENDER = 0.55;

export function planWave(wave: number, seed: number, teamSize = 1): WavePlan {
  const rng = createRng(seed ^ (wave * 0x9e3779b9));
  const overtime = Math.max(0, wave - WAVES_TOTAL);
  const sudden = overtime > 0;
  const isBoss = !sudden && wave % BOSS_EVERY === 0;
  const difficulty = difficultyFor(wave) * (1 + SUDDEN_STEP * overtime);

  if (isBoss) {
    return {
      wave,
      // One boss per defender: three heroes make short work of a single one.
      entries: [{ defKey: 'marrowTitan', count: Math.max(1, teamSize) }],
      difficulty: difficulty * 0.85,
      isBoss: true,
      sudden: false,
      interval: 0.6,
    };
  }

  // Archetype availability widens with the wave, so early waves stay simple.
  //
  // Trait creeps are introduced one at a time and late, each with several waves
  // of quiet after it: they change what the player has to *do*, and stacking
  // two new answers in one wave reads as unfairness rather than as escalation.
  // `skeleton` is absent on purpose — it is a summon, not a wave entry, and its
  // zero cost would let the composer buy an unbounded number of them.
  //
  // `wraith` sits at 25 rather than 10 because its character has no art: the
  // slot `creep.stalker` does not exist in the catalog, so the creature renders
  // as nothing at all and arrives with no warning a player can act on. Moving
  // it past the point a run normally reaches is the cheap fix, and it costs
  // nothing to undo: when the art lands, put it back at 10 and the wave curve
  // is what it was. `prowler` shares that missing slot and is still at 18.
  const pool: string[] = ['cleaver'];
  if (wave >= 2) pool.push('duskrunner');
  if (wave >= 3) pool.push('spinebolt');
  if (wave >= 6) pool.push('hexwright');
  if (wave >= 8) pool.push('bastion');
  if (wave >= 14) pool.push('breaker');
  if (wave >= 18) pool.push('prowler');
  if (wave >= 22) pool.push('necromancer');
  if (wave >= 25) pool.push('wraith');

  let budget = budgetFor(wave) * (1 + PER_EXTRA_DEFENDER * (Math.max(1, teamSize) - 1));
  const counts = new Map<string, number>();
  // Guarantee at least one of two distinct types once the pool allows it, so a
  // wave never degenerates into a single-archetype blob.
  const guaranteed = Math.min(2, pool.length);
  for (let i = 0; i < guaranteed; i++) {
    const key = pool[i]!;
    counts.set(key, 1);
    budget -= ENEMIES[key]!.cost;
  }

  let guard = 400;
  while (budget > 0 && guard-- > 0) {
    const key = rng.pick(pool);
    const cost = ENEMIES[key]!.cost;
    if (cost > budget) break;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    budget -= cost;
  }

  return {
    wave,
    entries: [...counts.entries()].map(([defKey, count]) => ({ defKey, count })),
    difficulty,
    isBoss: false,
    sudden,
    // Later waves arrive faster, floored so they never become a single burst.
    // The floor is 0.5 s rather than 0.28: with two portals firing at once, a
    // shorter gap put the whole wave on the road simultaneously and it reached
    // the Core as one unbroken column with no time to intercept.
    interval: Math.max(0.5, 1.6 - wave * 0.012),
  };
}

interface PendingSpawn {
  defKey: string;
  siteTeam: TeamId;
  /** Which fork of the lane this one walks. */
  route: number;
  atTime: number;
  /** Scatter around the portal, already mirrored for the site's half. */
  jx: number;
  jz: number;
}

export class WaveModule implements GameModule {
  readonly id = 'waves';
  readonly order = 500;

  private ctx!: GameContext;
  private units!: UnitService;
  private terrain!: TerrainService;
  private unitModule!: UnitModule;
  private queue: PendingSpawn[] = [];
  private plan: WavePlan | null = null;
  private timer = INTERMISSION;
  private running = false;
  /** Spawn points per site, set by the match module. */
  spawnPoints: Record<number, Vec2> = { 0: { x: 0, z: 0 }, 1: { x: 0, z: 0 } };
  /** Teams that still have a live site; waves only spawn for these. */
  activeTeams: TeamId[] = [0];
  /** How many lane forks each site has; set by the match module. */
  laneCount = 1;
  /** Defenders per site. Waves grow with it, so 2v2 and 3v3 are not easier. */
  teamSize = 1;
  /** Called when the intermission after the final wave runs out. */
  onAllWavesSurvived: (() => void) | null = null;
  /** Overtime: waves keep coming, faster and harder, until a Core falls. */
  private suddenDeath = false;
  /** Teams that have already emptied their side of the current wave. */
  private cleared = new Set<number>();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.units = ctx.services.get(UnitKey);
    this.terrain = ctx.services.get(TerrainKey);

    const self = this;
    const service: WaveService = {
      get current() {
        return ctx.match.wave;
      },
      startWave: (n) => this.startWave(n),
      forceNext: () => {
        this.timer = 0;
      },
      remainingEnemies: () => self.remaining(),
      injectSpawn: (team, enemyId, count) => {
        for (let i = 0; i < count; i++) {
          this.queue.push({
            defKey: enemyId,
            siteTeam: team,
            route: i % this.laneCount,
            atTime: ctx.clock.time,
            jx: 0,
            jz: 0,
          });
        }
      },
      applyModifier: () => {},
    };
    ctx.services.register(WaveKey, service);
  }

  saveState(): unknown {
    return {
      queue: this.queue,
      plan: this.plan,
      timer: this.timer,
      running: this.running,
      activeTeams: this.activeTeams,
      suddenDeath: this.suddenDeath,
      cleared: this.cleared,
    };
  }

  loadState(state: unknown): void {
    const s = state as {
      queue: PendingSpawn[];
      plan: WavePlan | null;
      timer: number;
      running: boolean;
      activeTeams: TeamId[];
      suddenDeath: boolean;
      cleared: Set<number>;
    };
    this.queue = s.queue;
    this.plan = s.plan;
    this.timer = s.timer;
    this.running = s.running;
    this.activeTeams = s.activeTeams;
    this.suddenDeath = s.suddenDeath;
    this.cleared = s.cleared;
  }

  bind(unitModule: UnitModule): void {
    this.unitModule = unitModule;
  }

  /** Seconds until the next wave, or -1 while a wave is in progress. */
  get countdown(): number {
    return this.running ? -1 : Math.max(0, this.timer);
  }

  private remaining(): number {
    let n = 0;
    for (const unit of this.units.all()) {
      if (unit.alive && unit.faction === 2 /* Faction.Hostile */) n++;
    }
    return n + this.queue.length;
  }

  /** Overtime creeps: twice the pace, twice the damage. */
  private makeSudden(unit: UnitState): void {
    unit.modifiers.push(
      { stat: 'moveSpeed', op: 'pct', value: SUDDEN_SPEED, sourceId: 'wave.sudden' },
      { stat: 'attackSpeed', op: 'pct', value: SUDDEN_SPEED, sourceId: 'wave.sudden' },
      { stat: 'attackDamage', op: 'pct', value: SUDDEN_DAMAGE, sourceId: 'wave.sudden' },
    );
    this.ctx.services.get(CombatKey).recomputeStats(unit);
  }

  startWave(wave: number): void {
    const plan = planWave(wave, this.ctx.match.seed, this.teamSize);
    this.plan = plan;
    this.running = true;
    this.cleared.clear();
    this.ctx.match.wave = wave;
    // Overtime reads as a boss fight to everything downstream: the same drums,
    // the same red banner, the same weight.
    this.ctx.match.phase = plan.isBoss || plan.sudden ? 'boss' : 'wave';

    const now = this.ctx.clock.time;
    // One sequence, dealt identically to every team: same creeps, same order,
    // same routes, same timing, mirrored scatter. Building a list per team and
    // shuffling them together gave each side its wave in a different order and
    // at half the rate — a fairness bug the moment two players share a match.
    const sequence: { defKey: string; route: number; jx: number; jz: number }[] = [];
    let route = 0;
    for (const entry of plan.entries) {
      for (let i = 0; i < entry.count; i++) {
        // Cycle the routes so both portals fire together and both branches
        // around the base get used. A boss is the exception: one unit cannot
        // be split across routes, so it always takes route 0.
        sequence.push({ defKey: entry.defKey, route: plan.isBoss ? 0 : route % this.laneCount, jx: 0, jz: 0 });
        route++;
      }
    }
    // Interleave so a wave arrives mixed rather than in archetype blocks.
    this.ctx.rng.shuffle(sequence);
    for (const s of sequence) {
      // Scatter so a column does not emerge from one pixel.
      s.jx = this.ctx.rng.range(-3, 3);
      s.jz = this.ctx.rng.range(-3, 3);
    }

    const spawns: PendingSpawn[] = [];
    sequence.forEach((s, i) => {
      for (const team of this.activeTeams) {
        spawns.push({
          defKey: s.defKey,
          siteTeam: team,
          route: s.route,
          atTime: now + i * plan.interval,
          // The map is mirrored across x = 0, so mirroring the scatter keeps the
          // two sites' creeps in exactly corresponding places.
          jx: team === 1 ? -s.jx : s.jx,
          jz: s.jz,
        });
      }
    });
    this.queue = spawns;

    this.ctx.bus.emit('wave:announce', {
      wave,
      modifiers: [],
      isBoss: plan.isBoss,
      sudden: plan.sudden,
    });
    this.ctx.bus.emit('ui:notify', {
      text: plan.sudden
        ? 'MUERTE SÚBITA — el doble de rápidos, el doble de daño'
        : plan.isBoss
          ? `Oleada ${wave} — JEFE`
          : `Oleada ${wave}`,
      severity: plan.isBoss || plan.sudden ? 'danger' : 'warn',
    });
  }

  fixedUpdate(step: number, ctx: GameContext): void {
    if (ctx.match.phase === 'victory' || ctx.match.phase === 'defeat') return;

    this.reportClears(ctx);

    if (!this.running) {
      this.timer -= step;
      if (this.timer <= 0) {
        const next = ctx.match.wave + 1;
        if (next > WAVES_TOTAL && !this.suddenDeath) {
          // What follows the last authored wave — a solo victory or overtime —
          // is the match module's knowledge, not this one's. It answers by
          // calling `beginSuddenDeath`, or by ending the match.
          this.onAllWavesSurvived?.();
          if (!this.suddenDeath) return;
        }
        this.startWave(next);
      }
      return;
    }

    const now = ctx.clock.time;
    while (this.queue.length > 0 && this.queue[0]!.atTime <= now) {
      const spawn = this.queue.shift()!;
      // Each route starts at its own portal, so the spawn point comes from the
      // route itself rather than one point shared by the whole site.
      const path = this.terrain.lanePath(spawn.siteTeam, spawn.route);
      const point = path[0] ?? this.spawnPoints[spawn.siteTeam] ?? { x: 0, z: 0 };
      const jitter = { x: point.x + spawn.jx, z: point.z + spawn.jz };
      const unit = this.unitModule.spawnEnemy(
        spawn.defKey,
        jitter,
        spawn.siteTeam,
        this.plan!.difficulty,
        spawn.route,
      );
      if (this.plan!.sudden) this.makeSudden(unit);
    }

    // The clock starts the moment the wave has finished *arriving*, not when
    // it has been killed. Waves that outlast their welcome pile up on the team
    // that could not clear them — which is the pressure the mode is built on.
    if (this.queue.length === 0) {
      this.running = false;
      this.timer = INTERMISSION;
      ctx.match.phase = 'intermission';
    }
  }

  /**
   * Tells a team it has cleared its side. Per team, because with the waves on a
   * clock the two sites are rarely empty at the same moment — and a team that
   * cleared its wave has earned the chime whatever the rival is doing.
   */
  private reportClears(ctx: GameContext): void {
    // Before the first wave there is nothing to have cleared.
    if (ctx.match.wave === 0) return;
    if (this.cleared.size === this.activeTeams.length) return;
    const alive = new Map<number, number>();
    for (const unit of this.units.all()) {
      if (!unit.alive || unit.faction !== 2 /* Faction.Hostile */) continue;
      const team = runtimeOf(unit.id)?.siteTeam;
      if (team !== undefined) alive.set(team, (alive.get(team) ?? 0) + 1);
    }
    for (const team of this.activeTeams) {
      if (this.cleared.has(team)) continue;
      if ((alive.get(team) ?? 0) > 0) continue;
      if (this.queue.some((s) => s.siteTeam === team)) continue;
      this.cleared.add(team);
      ctx.bus.emit('wave:clear', { wave: ctx.match.wave, duration: 0, team });
      ctx.bus.emit('ui:notify', { text: `Oleada ${ctx.match.wave} superada`, severity: 'reward', team });
    }
  }

  /** Switches the wave table into overtime; the next wave is the first of it. */
  beginSuddenDeath(): void {
    this.suddenDeath = true;
  }
}
