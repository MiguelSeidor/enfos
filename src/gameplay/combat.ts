/**
 * Combat resolution. Owner: GAMEPLAY.
 *
 * Damage, healing, death, bounty and the broad-phase index every other system
 * queries. Runs at order 400, after movement has settled positions for the tick,
 * so range checks test where units actually are rather than where they were.
 *
 * The spatial hash is rebuilt once per tick rather than incrementally updated:
 * with hundreds of units all moving every tick, a full rebuild is cheaper than
 * tracking cell transitions, and it cannot drift out of sync with reality.
 */

import type {
  GameContext,
  GameModule,
  EntityId,
  UnitState,
  Vec2,
} from '@/core/contracts';
import { DamageType, Faction, UnitKind } from '@/core/contracts';
import {
  CombatKey,
  TerrainKey,
  UnitKey,
  UnitViewKey,
  type CombatService,
  type DamageRequest,
  type TerrainService,
  type UnitService,
} from '@/core/services';
import { SpatialHash } from '@/core/spatial';
import { armorMitigation, clamp01, dist2 } from '@/core/mathx';
import { isConcealed, isFrozen, runtimeOf } from './units';
import { hasLineOfSight, isRanged } from './sight';

/** Ticks a corpse lingers before its mesh is released. 30 Hz sim → ~1.6 s. */
const CORPSE_TICKS = 48;

/** Hostiles and heroes are mutually hostile; heroes never damage each other. */
export function isHostileTo(a: UnitState, b: UnitState): boolean {
  if (a.faction === Faction.Hostile) return b.faction !== Faction.Hostile;
  return b.faction === Faction.Hostile;
}

/**
 * Hardest ceiling on reach, as a multiple of the hero's own base.
 *
 * A multiple rather than a number of metres, for the same reason the attribute
 * grants a percentage: 4.8 m is generous on a melee hero and crippling on a
 * marksman who starts at 12.
 */
const REACH_CAP = 1.6;

/**
 * Below this reach a swing cannot have terrain between its two ends, so the
 * line trace is skipped. It is an optimisation, not a rule: anything above it
 * is traced regardless of what kind of unit it is.
 */
const NO_TRACE_UNDER = 2.5;

/**
 * How far into a swing the blow lands, as a share of the attack interval.
 *
 * Near the end of it: the owner wanted the hit on the last third, where the
 * hammer is finishing its arc, not the first. Not the whole interval, so a
 * blow still lands before the next swing begins.
 */
const SWING_IMPACT = 0.85;

/** And never later than this, however slowly the unit attacks. */
const SWING_IMPACT_CAP = 1.0;

/** The simulation's fixed step, as a rate. */
const TICKS_PER_SECOND = 30;

export class CombatModule implements GameModule {
  readonly id = 'combat';
  readonly order = 400;

  readonly spatial = new SpatialHash(8);
  private ctx!: GameContext;
  private units!: UnitService;
  private readonly scratch: EntityId[] = [];
  /** Deaths queued during damage resolution, with the credit still attached. */
  private readonly dead: { id: EntityId; killerId: EntityId | null }[] = [];
  /** Corpses awaiting despawn, counted down in ticks — never wall-clock time. */
  private readonly corpses: { id: EntityId; ticksLeft: number }[] = [];
  /** Absent in headless tests without a world; sight is then never blocked. */
  private terrain: TerrainService | undefined;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.units = ctx.services.get(UnitKey);
    this.terrain = ctx.services.tryGet(TerrainKey);

    const service: CombatService = {
      spatial: this.spatial,
      applyDamage: (req) => this.applyDamage(req),
      applyHeal: (target, source, amount) => this.applyHeal(target, source, amount),
      applyStatus: () => {},
      removeStatus: () => {},
      hasStatus: () => false,
      recomputeStats: (unit) => this.recomputeStats(unit),
      queryUnits: (pos, radius, filter) => this.queryUnits(pos, radius, filter),
      killUnit: (id, killerId) => this.killUnit(id, killerId),
    };
    ctx.services.register(CombatKey, service);
  }

  fixedUpdate(step: number, ctx: GameContext): void {
    this.rebuildIndex();
    this.regenerate(step);
    this.landPendingHits();
    this.resolveAttacks(step);
    this.reapDead();
    void ctx;
  }

  private rebuildIndex(): void {
    this.spatial.clear();
    for (const unit of this.units.all()) {
      if (unit.alive) this.spatial.insert(unit.id, unit.pos);
    }
  }

  private regenerate(step: number): void {
    for (const unit of this.units.all()) {
      if (!unit.alive) continue;
      if (unit.stats.healthRegen > 0 && unit.health < unit.stats.maxHealth) {
        unit.health = Math.min(unit.stats.maxHealth, unit.health + unit.stats.healthRegen * step);
      }
      if (unit.stats.manaRegen > 0 && unit.mana < unit.stats.maxMana) {
        unit.mana = Math.min(unit.stats.maxMana, unit.mana + unit.stats.manaRegen * step);
      }
      if (unit.attackCooldown > 0) unit.attackCooldown -= step;
    }
  }

  /**
   * Auto-attacks. A unit swings when it has a live hostile target inside range
   * and its swing timer has elapsed. Range is measured between hulls, not
   * centres, so a large unit does not have to overlap a small one to reach it.
   */
  /**
   * Blows in flight: struck now, landing part way through the swing.
   *
   * A hit used to be applied on the same tick the animation started, so the
   * number popped and the health bar dropped while the hammer was still going
   * up -- the owner's words were that it looked like the mace was not what was
   * doing the damage. The swing is now scheduled and lands at `SWING_IMPACT`
   * of the way through the attack interval.
   *
   * The crit is rolled at swing time, not at landing time. That keeps the RNG
   * consumed at a fixed point in the tick order, which the determinism test
   * depends on.
   */
  private pendingHits: {
    atTick: number;
    sourceId: EntityId;
    targetId: EntityId;
    amount: number;
    crit: boolean;
  }[] = [];

  /** Lands everything whose moment has come, in the order it was struck. */
  private landPendingHits(): void {
    if (this.pendingHits.length === 0) return;
    const tick = this.ctx.clock.tick;
    let kept = 0;
    for (const hit of this.pendingHits) {
      if (hit.atTick > tick) {
        this.pendingHits[kept++] = hit;
        continue;
      }
      // A blow whose striker died mid-swing does not land; one whose target
      // died is simply dropped, since `applyDamage` would ignore it anyway.
      const source = this.units.get(hit.sourceId);
      const target = this.units.get(hit.targetId);
      if (!source?.alive || !target?.alive) continue;
      this.applyDamage({
        targetId: hit.targetId,
        sourceId: hit.sourceId,
        amount: hit.amount,
        type: DamageType.Physical,
        canCrit: false,
        crit: hit.crit,
      });
    }
    this.pendingHits.length = kept;
  }

  private resolveAttacks(step: number): void {
    void step;
    const tick = this.ctx.clock.tick;
    for (const unit of this.units.all()) {
      if (!unit.alive || unit.attackCooldown > 0) continue;
      // Movement freezes a stunned unit but used to leave its target set, so it
      // stood still and kept swinging. A stun stops the attack too.
      if (tick < (runtimeOf(unit.id)?.stunnedUntilTick ?? 0)) continue;
      // And a frozen one, for the same reason: the lesson above was learned by
      // shipping a stun that stopped the legs and not the sword.
      if (isFrozen(unit.id, tick)) continue;

      const target = unit.targetId === null ? undefined : this.units.get(unit.targetId);
      if (!target || !target.alive) {
        unit.targetId = null;
        continue;
      }

      const reach = unit.stats.attackRange + unit.radius + target.radius;
      if (dist2(unit.pos, target.pos) > reach * reach) continue;
      // Melee reach is too short for terrain to fit between the two; only a
      // ranged swing needs the line checked.
      if (!this.canSee(unit, target)) continue;

      const interval = 1 / Math.max(0.05, unit.stats.attackSpeed);
      unit.attackCooldown = interval;
      this.ctx.services.tryGet(UnitViewKey)?.playAnimation(unit.id, 'attack', 0.08);

      const crit = unit.stats.critChance > 0 && this.ctx.rng.bool(unit.stats.critChance);
      // Scheduled, not applied: see `pendingHits`. The delay is a share of the
      // swing interval so a fast attacker's blow does not land after the next
      // one has started, and capped so a very slow one does not leave a
      // second of silence between the swing and the hit.
      const delay = Math.min(SWING_IMPACT_CAP, interval * SWING_IMPACT);
      this.pendingHits.push({
        atTick: this.ctx.clock.tick + Math.max(1, Math.round(delay * TICKS_PER_SECOND)),
        sourceId: unit.id,
        targetId: target.id,
        amount: unit.stats.attackDamage * (crit ? unit.stats.critMultiplier : 1),
        crit,
      });
    }
  }

  applyDamage(req: DamageRequest): number {
    const target = this.units.get(req.targetId);
    if (!target || !target.alive) return 0;
    const source = req.sourceId === null ? undefined : this.units.get(req.sourceId);

    let amount = req.amount;
    let crit = req.crit ?? false;

    if (req.canCrit && source && source.stats.critChance > 0) {
      crit = this.ctx.rng.bool(source.stats.critChance);
      if (crit) amount *= source.stats.critMultiplier;
    }

    // Evasion only applies to physical hits; spells always land.
    if (
      !req.trueDamage &&
      req.type === DamageType.Physical &&
      target.stats.evasion > 0 &&
      this.ctx.rng.bool(clamp01(target.stats.evasion))
    ) {
      // A dodge used to return silently, so from the player's side an attack
      // that missed and an attack that never happened looked identical — the
      // swing played, no number appeared, and the health bar did not move.
      this.ctx.bus.emit('unit:miss', {
        targetId: target.id,
        sourceId: source?.id ?? null,
        pos: target.pos,
      });
      return 0;
    }

    const raw = amount;
    if (!req.trueDamage) {
      amount *=
        req.type === DamageType.Physical
          ? armorMitigation(target.stats.armor)
          : 1 - clamp01(target.stats.magicResist);
    }
    amount = Math.max(1, amount);

    target.health -= amount;

    this.ctx.bus.emit('unit:damage', {
      targetId: target.id,
      sourceId: source?.id ?? null,
      amount,
      mitigated: Math.max(0, raw - amount),
      type: req.type,
      crit,
      pos: target.pos,
      abilityId: req.abilityId ?? null,
    });

    if (source && source.stats.lifesteal > 0 && req.type === DamageType.Physical) {
      this.applyHeal(source.id, source.id, amount * source.stats.lifesteal);
    }

    // Boss phases are checked here rather than on a timer: a phase is a health
    // threshold, and health only changes when damage lands. Polling every tick
    // would do the same work hundreds of times for one transition.
    this.checkBossPhase(target);

    // Trait creeps act on a landed hit, not on the swing: a dodged blow neither
    // stuns nor reveals, which is what makes evasion worth having.
    if (source) {
      const sourceRuntime = runtimeOf(source.id);
      const traits = sourceRuntime?.traits;
      // Striking breaks concealment. Without this an invisible creep is simply
      // untargetable forever, which is not a puzzle, only an annoyance.
      if (traits?.invisible && sourceRuntime) {
        sourceRuntime.revealFor = traits.invisible.revealSeconds;
      }
      if (traits?.stunOnHit && this.ctx.rng.bool(traits.stunOnHit.chance)) {
        const targetRuntime = runtimeOf(target.id);
        if (targetRuntime) {
          // Tenacity shortens it, the same lever the stat block already
          // documents for crowd control.
          const seconds = traits.stunOnHit.seconds * (1 - clamp01(target.stats.tenacity));
          targetRuntime.stunnedUntilTick = this.ctx.clock.tick + Math.round(seconds * 30);
          this.ctx.bus.emit('unit:status', {
            targetId: target.id,
            statusId: 'stun',
            applied: true,
            stacks: 1,
          });
        }
      }
    }

    if (target.health <= 0) this.dead.push({ id: target.id, killerId: source?.id ?? null });
    return amount;
  }

  applyHeal(targetId: EntityId, sourceId: EntityId | null, amount: number): number {
    const target = this.units.get(targetId);
    if (!target || !target.alive) return 0;
    const before = target.health;
    target.health = Math.min(target.stats.maxHealth, target.health + amount);
    const healed = target.health - before;
    if (healed > 0) {
      this.ctx.bus.emit('unit:heal', { targetId, sourceId, amount: healed, pos: target.pos });
    }
    return healed;
  }

  queryUnits(pos: Vec2, radius: number, filter?: (u: UnitState) => boolean): UnitState[] {
    this.spatial.query(pos, radius, this.scratch);
    const out: UnitState[] = [];
    for (const id of this.scratch) {
      const unit = this.units.get(id);
      if (!unit || !unit.alive) continue;
      if (filter && !filter(unit)) continue;
      out.push(unit);
    }
    return out;
  }

  /** Nearest live unit hostile to `from`, within `radius`. */
  nearestHostile(from: UnitState, radius: number): UnitState | null {
    const id = this.spatial.nearest(from.pos, radius, (candidate) => {
      const unit = this.units.get(candidate);
      if (!unit || !unit.alive || !isHostileTo(from, unit)) return false;
      // Concealed creeps are not auto-acquired. This is the whole trait: the
      // player has to click one deliberately, so attack-move walks straight
      // past it. A manual order still works — it goes through `issueOrder`,
      // not through here.
      if (isConcealed(unit.id, from.team, this.ctx.clock.tick)) return false;
      // A ranged unit does not lock onto what it cannot see: otherwise it
      // would stand at a wall "attacking" a creep on the far side forever.
      return this.canSee(from, unit);
    });
    return id === null ? null : this.units.get(id) ?? null;
  }

  /**
   * Whether `from` has a clear line to `to` for an attack. Always true for
   * melee attackers, whose reach is shorter than any terrain feature.
   */
  canSee(from: UnitState, to: UnitState): boolean {
    if (!this.terrain) return true;
    // Decided by actual reach, not by the ranged flag. The flag was a fair
    // stand-in while melee reach was fixed and shorter than any wall, and it
    // stopped being one the moment `Destreza` could stretch it: a melee hero
    // with 4.8 m would otherwise have swung through a terrace lip, and the rule
    // is that terrain always wins.
    if (from.stats.attackRange < NO_TRACE_UNDER && !isRanged(from)) return true;
    return hasLineOfSight(this.terrain, from, to);
  }

  /**
   * Advances a boss into any phase its current health has unlocked.
   *
   * A `while`, not an `if`: one very large hit can cross two thresholds at
   * once, and skipping the middle phase would silently drop its modifiers — the
   * boss would arrive in its final stage weaker than a boss that got there
   * gradually.
   */
  private checkBossPhase(unit: UnitState): void {
    const runtime = runtimeOf(unit.id);
    if (!runtime?.bossPhases || runtime.bossPhases.length === 0) return;

    const fraction = unit.health / Math.max(1, unit.stats.maxHealth);
    while (runtime.bossPhases.length > 0 && fraction <= runtime.bossPhases[0]!.at) {
      const phase = runtime.bossPhases.shift()!;
      runtime.bossPhaseIndex = (runtime.bossPhaseIndex ?? 0) + 1;

      // Modifiers accumulate; traits replace. A later phase is meant to carry
      // every earlier stat change but to define its own behaviour outright.
      if (phase.modifiers) {
        for (const mod of phase.modifiers) unit.modifiers.push({ ...mod });
        // Health is preserved as a fraction so a phase that raises maximum
        // health cannot heal the boss, and one that lowers it cannot kill it.
        const before = unit.stats.maxHealth;
        this.recomputeStats(unit);
        if (unit.stats.maxHealth !== before) {
          unit.health = (unit.health / before) * unit.stats.maxHealth;
        }
      }
      if (phase.traits) runtime.traits = phase.traits;
      // Summoning restarts on entry rather than carrying a stale countdown, so
      // a phase that adds summons produces its first wave promptly.
      if (phase.traits?.summons) runtime.summonTimer = 0.5;

      this.ctx.bus.emit('boss:phase', {
        id: unit.id,
        phase: runtime.bossPhaseIndex,
        healthFraction: unit.health / Math.max(1, unit.stats.maxHealth),
        announce: phase.announce,
      });
      // Only the team fighting this boss hears about its phases.
      const team = runtime.siteTeam;
      this.ctx.bus.emit('ui:notify', { text: phase.announce, severity: 'danger', team });
      this.ctx.bus.emit('camera:shake', { intensity: 0.9, duration: 0.7, team });
      this.ctx.bus.emit('vfx:request', {
        vfxId: 'impact',
        pos: { x: unit.pos.x, z: unit.pos.z },
        scale: 2.6,
      });
    }
  }

  recomputeStats(unit: UnitState): void {
    const next = { ...unit.baseStats };
    for (const mod of unit.modifiers) {
      if (mod.op === 'flat') next[mod.stat] += mod.value;
    }
    for (const mod of unit.modifiers) {
      if (mod.op === 'pct') next[mod.stat] *= 1 + mod.value;
    }
    // Reach is the one stat with a ceiling, because levels have none. Sixty per
    // cent over the base takes a melee hero from 3 m to 4.8 and Talon from 12
    // to 19.2: enough to stop being swarmed, nowhere near shooting the portal
    // from the Core. It is reached in about seven points, and the attribute
    // keeps paying in attack speed after that.
    next.attackRange = Math.min(next.attackRange, unit.baseStats.attackRange * REACH_CAP);
    unit.stats = next;
  }

  killUnit(id: EntityId, killerId: EntityId | null): void {
    const unit = this.units.get(id);
    if (!unit || !unit.alive) return;
    unit.alive = false;
    unit.health = 0;
    unit.vel.x = 0;
    unit.vel.z = 0;
    unit.targetId = null;

    this.ctx.bus.emit('unit:death', { id, killerId, pos: unit.pos });

    // Bounty goes to the killer if it was a hero, otherwise to every hero of the
    // team whose site the creep was on — a creep that dies to something other
    // than a hero should not deny that team its economy, nor pay the rivals.
    const runtime = runtimeOf(id);
    if (runtime && unit.kind !== UnitKind.Hero) {
      const killer = killerId === null ? undefined : this.units.get(killerId);
      const paid: EntityId[] = [];
      if (killer && killer.kind === UnitKind.Hero) {
        paid.push(killer.id);
      } else {
        for (const hero of this.ctx.match.heroes.values()) {
          if (hero.team === runtime.siteTeam) paid.push(hero.id);
        }
      }
      for (const heroId of paid) this.awardBounty(heroId, runtime.bounty);
      // One event per kill, not per hero: the floating reward is a piece of
      // feedback about the corpse, and paying two heroes should not stack two
      // numbers on the same body.
      this.ctx.bus.emit('unit:bounty', {
        pos: { x: unit.pos.x, z: unit.pos.z },
        gold: runtime.bounty.gold,
        xp: runtime.bounty.xp,
        heroIds: paid,
      });
    }

    // Heroes are never retired. A downed hero stays in the unit table with
    // `alive = false` so the match module can revive it in place; despawning it
    // removed it from `match.heroes` and detached its mesh, and the revive then
    // had nothing left to bring back — which is exactly why the respawn timer
    // appeared to do nothing.
    if (unit.kind === UnitKind.Hero) return;

    // Hold the corpse for the death animation, counted in simulation ticks so a
    // replay of the same seed retires bodies on exactly the same tick.
    this.corpses.push({ id, ticksLeft: CORPSE_TICKS });
  }

  private awardBounty(heroId: EntityId, bounty: { gold: number; xp: number }): void {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero) return;
    hero.gold += bounty.gold;
    this.ctx.bus.emit('economy:gold', {
      heroId,
      delta: bounty.gold,
      total: hero.gold,
      reason: 'bounty',
    });
    this.ctx.bus.emit('hero:xp', { id: heroId, amount: bounty.xp, total: hero.xp + bounty.xp });
  }

  saveState(): unknown {
    // `dead` is always empty between ticks; the spatial hash is rebuilt at the
    // start of every tick. Only the corpses carry over.
    return { corpses: this.corpses, pendingHits: this.pendingHits };
  }

  loadState(state: unknown): void {
    const s = state as {
      corpses: { id: EntityId; ticksLeft: number }[];
      pendingHits?: typeof CombatModule.prototype.pendingHits;
    };
    this.corpses.length = 0;
    this.corpses.push(...s.corpses);
    // Blows in flight carry over too, or a save taken mid-swing loses the hit
    // and two replays of the same match diverge.
    this.pendingHits.length = 0;
    if (s.pendingHits) this.pendingHits.push(...s.pendingHits);
    this.dead.length = 0;
  }

  private reapDead(): void {
    for (const entry of this.dead) this.killUnit(entry.id, entry.killerId);
    this.dead.length = 0;

    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const corpse = this.corpses[i]!;
      if (--corpse.ticksLeft > 0) continue;
      this.units.despawn(corpse.id);
      this.corpses[i] = this.corpses[this.corpses.length - 1]!;
      this.corpses.pop();
    }
  }
}
