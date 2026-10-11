/**
 * Movement, steering and enemy AI. Owner: GAMEPLAY.
 *
 * Order 300: after spawning, before combat, so this tick's range checks see
 * this tick's positions.
 *
 * ## Pathfinding, and who gets it
 *
 * Heroes plan with A* (see `pathfinding.ts`). They are player-directed, the
 * player clicks arbitrary destinations, and the map is terraced — steering
 * straight at the goal walked them into cliffs, where `canStand` refused every
 * candidate step and they simply stopped.
 *
 * Enemies still follow the authored lane polyline. The lane *is* the design
 * (GDD §5), it never changes, and a hundred agents replanning would dominate
 * the CPU budget for a route that is already authored. Local avoidance handles
 * the rest.
 *
 * ## AI budgeting (GDD §18)
 *
 * Target acquisition is the expensive part, so units are split into
 * `AI_BUCKETS` groups by id and only one bucket re-acquires per tick. Steering
 * and movement still run for everyone every tick, so motion stays smooth — only
 * the decision of *what to hit* is staggered, and at 30 Hz a unit re-evaluates
 * roughly six times a second, which is well below reaction time.
 */

import type { EntityId, GameContext, GameModule, TeamId, UnitState, Vec2 } from '@/core/contracts';
import { Faction, UnitKind } from '@/core/contracts';
import {
  TerrainKey,
  UnitKey,
  type TerrainService,
  type UnitService,
} from '@/core/services';
import { angleTo, dist, dist2, rotateToward } from '@/core/mathx';
import { MAP_HALF } from '@/world/layout';
import { isFrozen, runtimeOf, type UnitRuntime } from './units';
import { SUMMON_CAP } from './waves';
import { PathFinder } from './pathfinding';
import type { CombatModule } from './combat';
import { cos, hypot, sin } from '@/core/detmath';

const AI_BUCKETS = 5;
/** How far a unit will look for something to fight. */
const AGGRO_RANGE = 11;
/** Distance at which a lane waypoint counts as reached. */
const WAYPOINT_EPS = 2.4;
/** Separation strength; high enough to stop stacking, low enough not to jitter. */
const SEPARATION = 5.2;
/**
 * Steepest gradient a unit may climb, as rise over run.
 *
 * This has to be a *slope*, not a rise-per-step. The first attempt capped the
 * absolute height gained between two consecutive positions, which sounds
 * equivalent and is not: at 6.6 m/s on a 30 Hz tick a step is only 0.22 m long,
 * and a three-terrace wall interpolated across one 4 m cell climbs about 0.43 m
 * in that distance — comfortably under any sane per-step cap. Units simply
 * walked up cliffs in small increments.
 *
 * 0.55 (~29°) passes the authored ramps, which rise one terrace over 36 m
 * (0.07), and rejects a terrace edge, which rises 2.6 m over roughly a metre.
 */
const MAX_SLOPE = 0.55;

/**
 * How far an attack-moving hero looks for something to fight.
 *
 * Wider than `AGGRO_RANGE`, which governs what a creep notices: the player has
 * explicitly asked to sweep, so the sweep should be generous enough to clear a
 * lane in one order rather than needing a click every few metres. Not so wide
 * that the hero abandons the march for something across the map.
 */
const ATTACK_MOVE_RANGE = 15;

/**
 * How close a creep has to get to the Core to leak, in metres.
 *
 * The Core's solid radius plus a stride: it has to sit outside the shell the
 * creep is now stopped by, or nothing ever arrives.
 */
const CORE_LEAK_RANGE = 6.5;

export class MovementModule implements GameModule {
  readonly id = 'movement';
  readonly order = 300;

  private units!: UnitService;
  private terrain!: TerrainService;
  private combat!: CombatModule;
  private bucket = 0;
  private readonly neighbours: number[] = [];
  private paths!: PathFinder;
  /**
   * The route the hero is currently walking, and the order it was planned for.
   *
   * Keyed by hero so a future 2v2 does not need this rewritten. The stored goal
   * lets a replan be skipped when the order has not changed — planning is cheap
   * but not free, and re-running it every tick would also reset progress along
   * the route each time.
   */
  private readonly routes = new Map<
    number,
    {
      goal: Vec2;
      waypoints: Vec2[];
      index: number;
      /** Consecutive ticks with no meaningful progress. */
      stalled: number;
      /** Position at the last progress check. */
      lastX: number;
      lastZ: number;
      /** Replans already attempted for this order; caps the retry loop. */
      retries: number;
    }
  >();
  /**
   * Each team's Core, set by the match module. A creep walks to the Core of the
   * site it spawned on and leaks there — never into the other team's.
   */
  corePositions: Partial<Record<TeamId, Vec2>> = {};
  onLeak: ((unit: UnitState) => void) | null = null;
  /**
   * Injected by the match module so a summoner can raise minions.
   *
   * A callback rather than a direct `UnitModule` reference: units register at
   * order 200 and this module at 300, so the service is reachable, but spawning
   * needs the *match's* wave bookkeeping too — which only the match module has.
   */
  onSummon: ((defId: string, pos: Vec2, siteTeam: TeamId) => EntityId | null) | null = null;

  private ctx!: GameContext;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.units = ctx.services.get(UnitKey);
    this.terrain = ctx.services.get(TerrainKey);
    // Clearance is a little under a hero's radius: enough to keep routes off
    // terrace lips, not so much that it refuses the lane's narrowest neck.
    this.paths = new PathFinder(this.terrain, MAP_HALF, MAX_SLOPE, 0.7);
    // Combat arrives through bind(): it registers at order 400 and this module
    // runs at 300, so requesting its service here would fail during init.
  }

  /** Injected by the match module so movement can reach the combat internals. */
  saveState(): unknown {
    // Routes are saved, not replanned on restore: a plan made from where the
    // hero stood when the order was given is not the plan made from where it
    // stands now, and the other machines are still walking the original.
    return { bucket: this.bucket, routes: this.routes, orders: heroOrders };
  }

  loadState(state: unknown): void {
    const s = state as { bucket: number; routes: MovementModule['routes']; orders: Map<number, HeroOrder> };
    this.bucket = s.bucket;
    this.routes.clear();
    for (const [id, route] of s.routes) this.routes.set(id, route);
    // The same order objects, not copies: a pending cast recognises its own
    // walk order by identity.
    heroOrders.clear();
    for (const [id, order] of s.orders) heroOrders.set(id, order);
  }

  bind(combat: CombatModule): void {
    this.combat = combat;
  }

  fixedUpdate(step: number): void {
    this.bucket = (this.bucket + 1) % AI_BUCKETS;
    // The simulation clock, not a counter of our own. Combat stamps stun expiry
    // with `ctx.clock.tick`, and a local counter starts at zero whenever this
    // module does — the two drifted apart and no stun ever appeared to expire
    // on the tick it should have.
    const tick = this.ctx.clock.tick;

    for (const unit of this.units.all()) {
      if (!unit.alive) continue;
      const runtime = runtimeOf(unit.id);
      if (!runtime) continue;
      runtime.age += step;

      // Stun: no movement, no orders, no attacks. Checked before anything else
      // so a stunned unit is genuinely inert rather than merely slowed.
      if (runtime.stunnedUntilTick && tick < runtime.stunnedUntilTick) {
        this.decelerate(unit, step);
        continue;
      }

      // Held by `Parar el tiempo` on the site this creep marches against. Same
      // shape as the stun above and deliberately so: stopping time is a stun
      // with a different author, and reusing the path means nothing downstream
      // has to learn a second way for a unit to be inert.
      if (isFrozen(unit.id, tick)) {
        unit.vel.x = 0;
        unit.vel.z = 0;
        continue;
      }

      if (unit.kind === UnitKind.Hero) {
        this.stepHero(unit, step);
        continue;
      }

      this.tickTraits(unit, runtime, step);

      if (unit.id % AI_BUCKETS === this.bucket) this.acquireTarget(unit, runtime.behavior);
      this.stepEnemy(unit, runtime.behavior, step);
    }
  }

  /** Per-tick upkeep for trait creeps: invisibility decay and summoning. */
  private tickTraits(unit: UnitState, runtime: UnitRuntime, step: number): void {
    const traits = runtime.traits;
    if (!traits) return;

    if (traits.invisible && runtime.revealFor !== undefined && runtime.revealFor > 0) {
      runtime.revealFor = Math.max(0, runtime.revealFor - step);
    }

    if (traits.summons && runtime.summonTimer !== undefined) {
      runtime.summonTimer -= step;
      if (runtime.summonTimer > 0) return;
      runtime.summonTimer = traits.summons.everySeconds;

      // Prune the dead before counting: a summoner that has lost its brood must
      // be allowed to raise a new one, or killing minions would permanently
      // defang it and the trait would stop mattering after one exchange.
      const alive = (runtime.summoned ?? []).filter((id) => this.units.get(id)?.alive);
      runtime.summoned = alive;
      const scale = Math.max(1, runtime.summonScale ?? 1);
      // Capped: see SUMMON_CAP in `waves.ts`. The scale still shortens the gap
      // between raisings and refills the brood the instant it is thinned, which
      // is what a player feels; an uncapped cap is just more bodies to draw.
      const maxAlive = Math.min(SUMMON_CAP, Math.round(traits.summons.maxAlive * scale));
      if (alive.length >= maxAlive) return;

      const room = Math.min(Math.round(traits.summons.count * scale), maxAlive - alive.length);
      for (let i = 0; i < room; i++) {
        const a = (i / room) * Math.PI * 2 + runtime.age;
        const id = this.onSummon?.(
          traits.summons.defId,
          { x: unit.pos.x + cos(a) * 1.8, z: unit.pos.z + sin(a) * 1.8 },
          runtime.siteTeam,
        );
        if (id !== undefined && id !== null) alive.push(id);
      }
    }
  }

  // ── Targeting ──────────────────────────────────────────────────────────────

  private acquireTarget(unit: UnitState, behavior: string): void {
    // Siege units are Core-focused by design: they walk past heroes entirely,
    // which is what makes them a threat the players must actively intercept.
    if (behavior === 'siege') {
      const blocker = this.combat.nearestHostile(unit, unit.stats.attackRange + 2);
      unit.targetId = blocker?.id ?? null;
      return;
    }

    const range = behavior === 'hunter' ? AGGRO_RANGE * 1.6 : AGGRO_RANGE;
    const found = this.combat.nearestHostile(unit, Math.max(range, unit.stats.attackRange + 1));
    unit.targetId = found?.id ?? null;
  }

  // ── Enemy stepping ─────────────────────────────────────────────────────────

  private stepEnemy(unit: UnitState, behavior: string, step: number): void {
    const runtime = runtimeOf(unit.id)!;
    const target = unit.targetId === null ? null : this.units.get(unit.targetId) ?? null;

    let goal: Vec2 | null = null;
    let holdAt = 0;

    // A ranged creep that has lost sight of its target lets it go and returns
    // to the lane, rather than holding position at a wall it cannot shoot past.
    if (target && target.alive && !this.combat.canSee(unit, target)) {
      unit.targetId = null;
      goal = this.nextWaypoint(unit, runtime);
    } else if (target && target.alive) {
      const reach = unit.stats.attackRange + unit.radius + target.radius;
      // Skirmishers hold near max range; melee close all the way in.
      holdAt = behavior === 'skirmisher' ? reach * 0.85 : reach * 0.6;
      goal = target.pos;
    } else {
      goal = this.nextWaypoint(unit, runtime);
    }

    if (!goal) {
      this.decelerate(unit, step);
      return;
    }

    const d = dist(unit.pos, goal);
    if (d <= holdAt) {
      this.decelerate(unit, step);
      this.face(unit, goal, step);
      return;
    }

    this.seek(unit, goal, step);
  }

  /**
   * Advances the lane cursor and returns the point to walk toward. Returns null
   * once the unit has consumed the whole lane, which means it reached the Core.
   */
  private nextWaypoint(unit: UnitState, runtime: ReturnType<typeof runtimeOf>): Vec2 | null {
    const rt = runtime!;
    const core = this.corePositions[rt.siteTeam];
    if (!core) return null;
    // Everything walks the lane, fliers included.
    //
    // They used to ignore it and head straight for the Core, which was the
    // whole point of the trait: a player parked at a choke had to notice and
    // reposition. The owner cut it on 2026-10-04 because in practice it asked
    // them to hold the lane and the open ground at the same time, and a run to
    // wave 14 was not survivable. The creature it belongs to also renders
    // invisible today -- see the missing `creep.stalker` art slot -- so the
    // threat arrived with no warning at all, which is most of why it read as
    // unfair rather than as pressure. If that art lands, this is the decision
    // to revisit first.
    //
    // Flight still means something: `sight.ts` puts the creature's eye above
    // the ridges and `unitView` hovers it. It just no longer cuts the corner.
    // Close enough to the Core is a leak, whatever the lane says.
    //
    // This used to live below, reachable only after the unit had consumed
    // every waypoint. That worked while the Core was walkable and the last
    // waypoints sat on top of it. Once its footprint became solid the pack
    // could not stand on those waypoints, never advanced past them, and so
    // milled around four metres from the Core forever with the lives bar
    // untouched: a wave that cannot lose the game is not a wave.
    if (dist2(unit.pos, core) < CORE_LEAK_RANGE * CORE_LEAK_RANGE) {
      this.onLeak?.(unit);
      return null;
    }

    const lane = rt.lane;
    if (lane.length === 0) return core;

    while (rt.laneIndex < lane.length && dist2(unit.pos, lane[rt.laneIndex]!) < WAYPOINT_EPS * WAYPOINT_EPS) {
      rt.laneIndex++;
    }
    if (rt.laneIndex >= lane.length) {
      // Past the last waypoint: head for the Core itself, then leak.
      return core;
    }
    return lane[rt.laneIndex]!;
  }

  // ── Hero stepping ──────────────────────────────────────────────────────────

  /** Heroes are driven by orders, not AI; this only integrates their motion. */
  private stepHero(hero: UnitState, step: number): void {
    const order = heroOrders.get(hero.id);
    if (order?.kind === 'attack') {
      const target = this.units.get(order.targetId);
      if (!target || !target.alive) {
        heroOrders.delete(hero.id);
      } else {
        const reach = hero.stats.attackRange + hero.radius + target.radius;
        hero.targetId = target.id;
        // In range is not enough for a ranged hero: with a ridge in the way it
        // has to walk round until it can see the target. Routed rather than
        // steered straight, because straight at a target behind a wall is
        // straight into the wall.
        if (dist(hero.pos, target.pos) > reach * 0.9 || !this.combat.canSee(hero, target)) {
          this.seek(hero, this.nextRouteStep(hero, target.pos), step);
        } else {
          this.routes.delete(hero.id);
          this.decelerate(hero, step);
          this.face(hero, target.pos, step);
        }
        return;
      }
    }

    // Attack-move: fight first, walk second.
    //
    // Handled before the move branch and re-checked every tick, so the hero
    // breaks off to engage and then resumes the march on its own. The order is
    // deliberately *not* cleared when a target appears — clearing it would turn
    // one attack-move into a single kill and strand the hero there.
    if (order?.kind === 'attackMove') {
      const found = this.combat.nearestHostile(hero, ATTACK_MOVE_RANGE);
      if (found) {
        hero.targetId = found.id;
        const reach = hero.stats.attackRange + hero.radius + found.radius;
        if (dist(hero.pos, found.pos) > reach * 0.9) {
          this.seek(hero, found.pos, step);
        } else {
          this.decelerate(hero, step);
          this.face(hero, found.pos, step);
        }
        return;
      }

      hero.targetId = null;
      if (dist(hero.pos, order.pos) < 1.2) {
        heroOrders.delete(hero.id);
        this.routes.delete(hero.id);
        this.decelerate(hero, step);
        return;
      }
      this.seek(hero, this.nextRouteStep(hero, order.pos), step);
      return;
    }

    if (order?.kind === 'move') {
      if (dist(hero.pos, order.pos) < 1.2) {
        heroOrders.delete(hero.id);
        this.routes.delete(hero.id);
        this.decelerate(hero, step);
        return;
      }

      // Steering straight at the goal only works on open ground. On a terraced
      // map it drives the hero into a cliff and `canStand` refuses every step,
      // which is exactly what "the hero gets stuck" looked like. Follow a
      // planned route instead, and seek only the next waypoint.
      const waypoint = this.nextRouteStep(hero, order.pos);
      this.seek(hero, waypoint, step);
      // Auto-acquire while moving so a hero fights what walks into it.
      if (hero.targetId === null) {
        hero.targetId = this.combat.nearestHostile(hero, hero.stats.attackRange + 1)?.id ?? null;
      }
      return;
    }

    // Idle: hold ground but strike anything that comes into reach.
    this.routes.delete(hero.id);
    this.decelerate(hero, step);
    const found = this.combat.nearestHostile(hero, hero.stats.attackRange + 2);
    hero.targetId = found?.id ?? null;
    if (found) this.face(hero, found.pos, step);
  }

  /**
   * The point the hero should steer at right now, given a move order.
   *
   * Plans once per order and then walks the route. Replans when the goal moves,
   * and when the hero has drifted far off its own route — being shoved out of a
   * corridor by a creep pack is common enough that following a stale plan would
   * be worse than the straight-line steering this replaced.
   */
  private nextRouteStep(hero: UnitState, goal: Vec2): Vec2 {
    let route = this.routes.get(hero.id);

    // Stall detection. A plan can be valid and still not be walkable in
    // practice — a creep pack blocking a neck, or a corner the disc cannot
    // round — and without this the hero pushed into the obstruction forever
    // because the route never changed and so was never replanned.
    let stalled = false;
    if (route) {
      const moved = hypot(hero.pos.x - route.lastX, hero.pos.z - route.lastZ);
      if (moved < 0.02) route.stalled++;
      else {
        route.stalled = 0;
        route.retries = 0;
      }
      route.lastX = hero.pos.x;
      route.lastZ = hero.pos.z;
      // ~0.5 s at 30 Hz. Long enough not to fire on a single blocked tick.
      stalled = route.stalled > 15;
    }

    const stale =
      route === undefined ||
      dist2(route.goal, goal) > 1 ||
      // Off-route: the current leg is more than a few metres away.
      (route.index < route.waypoints.length &&
        dist(hero.pos, route.waypoints[route.index]!) > 12) ||
      stalled;

    if (stale) {
      // Give up rather than replan forever. Three failed attempts means the
      // goal is genuinely unreachable from here, and a hero that keeps
      // recomputing a route it cannot walk burns a frame budget doing nothing.
      const retries = stalled ? (route?.retries ?? 0) + 1 : 0;
      if (retries > 3) {
        heroOrders.delete(hero.id);
        this.routes.delete(hero.id);
        return { x: hero.pos.x, z: hero.pos.z };
      }

      const waypoints = this.paths.find(hero.pos, goal);
      // The planner works on a 2 m grid, so the last node is up to a node away
      // from where the player actually clicked. Append the true goal when it is
      // reachable from that node, or the hero stops short of its own order.
      if (waypoints.length > 0) {
        const last = waypoints[waypoints.length - 1]!;
        if (dist(last, goal) > 0.5 && this.canStand(hero, goal.x, goal.z)) {
          waypoints.push({ x: goal.x, z: goal.z });
        }
      }
      route = {
        goal: { x: goal.x, z: goal.z },
        waypoints,
        index: 0,
        stalled: 0,
        lastX: hero.pos.x,
        lastZ: hero.pos.z,
        retries,
      };
      this.routes.set(hero.id, route);
    }

    // Advance past every waypoint already reached. A loop, not an `if`: the
    // simplifier leaves long legs and short ones, and a fast hero can clear
    // more than one short leg in a single tick.
    while (
      route!.index < route!.waypoints.length &&
      dist(hero.pos, route!.waypoints[route!.index]!) < WAYPOINT_EPS
    ) {
      route!.index++;
    }

    // Route exhausted (or empty because the goal was already this node): steer
    // at the order itself and let the arrival check end the order.
    if (route!.index >= route!.waypoints.length) return goal;
    return route!.waypoints[route!.index]!;
  }

  // ── Steering primitives ────────────────────────────────────────────────────

  private seek(unit: UnitState, goal: Vec2, step: number): void {
    const dx = goal.x - unit.pos.x;
    const dz = goal.z - unit.pos.z;
    const len = hypot(dx, dz) || 1;
    let vx = (dx / len) * unit.stats.moveSpeed;
    let vz = (dz / len) * unit.stats.moveSpeed;

    // Local avoidance: push away from crowded neighbours so a pack spreads out
    // along the lane instead of collapsing into one point.
    this.combat.spatial.query(unit.pos, unit.radius * 3.2, this.neighbours);
    let sx = 0;
    let sz = 0;
    for (const id of this.neighbours) {
      if (id === unit.id) continue;
      const other = this.units.get(id);
      if (!other || !other.alive) continue;
      const ox = unit.pos.x - other.pos.x;
      const oz = unit.pos.z - other.pos.z;
      const d2 = ox * ox + oz * oz;
      const want = unit.radius + other.radius;
      if (d2 > want * want || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (want - d) / want;
      sx += (ox / d) * push;
      sz += (oz / d) * push;
    }
    vx += sx * SEPARATION;
    vz += sz * SEPARATION;

    const speed = hypot(vx, vz);
    const max = unit.stats.moveSpeed;
    if (speed > max) {
      vx = (vx / speed) * max;
      vz = (vz / speed) * max;
    }

    unit.vel.x = vx;
    unit.vel.z = vz;

    const nx = unit.pos.x + vx * step;
    const nz = unit.pos.z + vz * step;

    // Fliers are held to the ground rules too, which is not redundant with
    // walking the lane: steering and separation push a creep off the line
    // between two waypoints, and without this a flier drifts over the gorge on
    // every corner and rejoins further along. Following the lane only means
    // anything if the ground between the waypoints is respected.

    // Try the full step, then each axis alone, so a blocked diagonal slides
    // along the obstacle instead of stopping dead against it.
    if (this.canStand(unit, nx, nz)) {
      unit.pos.x = nx;
      unit.pos.z = nz;
    } else if (this.canStand(unit, nx, unit.pos.z)) {
      unit.pos.x = nx;
    } else if (this.canStand(unit, unit.pos.x, nz)) {
      unit.pos.z = nz;
    }

    this.face(unit, goal, step);
  }

  /**
   * Whether a unit may occupy a position.
   *
   * `isWalkable` alone was not enough: the map is terraced, and two adjacent
   * cells can both be walkable while a full cliff step separates them. That let
   * the hero walk straight up walls it should have had to go around. This also
   * gates on the height difference from where the unit currently stands, so a
   * ramp (a gradual rise) passes and a terrace edge does not.
   */
  private canStand(unit: UnitState, x: number, z: number): boolean {
    if (!this.terrain.isWalkable(x, z)) return false;

    const dx = x - unit.pos.x;
    const dz = z - unit.pos.z;
    const run = hypot(dx, dz);
    if (run < 1e-4) return true;

    const rise = this.terrain.heightAt(x, z) - this.terrain.heightAt(unit.pos.x, unit.pos.z);
    // Climbing is limited; dropping is not — falling off a ledge is allowed.
    return rise / run <= MAX_SLOPE;
  }

  private decelerate(unit: UnitState, step: number): void {
    unit.vel.x *= Math.max(0, 1 - 12 * step);
    unit.vel.z *= Math.max(0, 1 - 12 * step);
  }

  private face(unit: UnitState, at: Vec2, step: number): void {
    unit.facing = rotateToward(unit.facing, angleTo(unit.pos, at), 9 * step);
  }

}

// ── Hero order queue ─────────────────────────────────────────────────────────

export type HeroOrder =
  | { kind: 'move'; pos: Vec2 }
  | { kind: 'attack'; targetId: number }
  /**
   * March toward `pos`, engaging anything hostile met on the way and resuming
   * once it is dead.
   *
   * Distinct from `move`, which only auto-acquires targets already inside
   * attack range: attack-move sweeps a wider radius and *stops* to fight, which
   * is the whole reason a player reaches for it — clearing a lane without
   * having to click each creep.
   */
  | { kind: 'attackMove'; pos: Vec2 };

/**
 * Orders live outside the unit table because they are input, not simulation
 * state: a replay re-issues them rather than restoring them.
 */
export const heroOrders = new Map<number, HeroOrder>();

export function issueOrder(heroId: number, order: HeroOrder): void {
  heroOrders.set(heroId, order);
}

export function clearOrders(): void {
  heroOrders.clear();
}

/** Convenience for the match module: is anything hostile still alive? */
export function countHostiles(units: UnitService): number {
  let n = 0;
  for (const unit of units.all()) {
    if (unit.alive && unit.faction === Faction.Hostile) n++;
  }
  return n;
}
