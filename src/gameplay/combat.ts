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
import { isConcealed, runtimeOf } from './units';
import { hasLineOfSight, isRanged } from './sight';

/** Ticks a corpse lingers before its mesh is released. 30 Hz sim → ~1.6 s. */
const CORPSE_TICKS = 48;

/** Hostiles and heroes are mutually hostile; heroes never damage each other. */
export function isHostileTo(a: UnitState, b: UnitState): boolean {
  if (a.faction === Faction.Hostile) return b.faction !== Faction.Hostile;
  return b.faction === Faction.Hostile;
}

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
  private resolveAttacks(step: number): void {
    void step;
    const tick = this.ctx.clock.tick;
    for (const unit of this.units.all()) {
      if (!unit.alive || unit.attackCooldown > 0) continue;
      // Movement freezes a stunned unit but used to leave its target set, so it
      // stood still and kept swinging. A stun stops the attack too.
      if (tick < (runtimeOf(unit.id)?.stunnedUntilTick ?? 0)) continue;

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

      unit.attackCooldown = 1 / Math.max(0.05, unit.stats.attackSpeed);
      this.ctx.services.tryGet(UnitViewKey)?.playAnimation(unit.id, 'attack', 0.08);

      const crit = unit.stats.critChance > 0 && this.ctx.rng.bool(unit.stats.critChance);
      this.applyDamage({
        targetId: target.id,
        sourceId: unit.id,
        amount: unit.stats.attackDamage * (crit ? unit.stats.critMultiplier : 1),
        type: DamageType.Physical,
        canCrit: false, // already rolled
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
      if (isConcealed(unit.id)) return false;
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
    if (!this.terrain || !isRanged(from)) return true;
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
    return { corpses: this.corpses };
  }

  loadState(state: unknown): void {
    const s = state as { corpses: { id: EntityId; ticksLeft: number }[] };
    this.corpses.length = 0;
    this.corpses.push(...s.corpses);
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
