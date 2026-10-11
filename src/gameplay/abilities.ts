/**
 * Hero abilities. Owner: GAMEPLAY.
 *
 * Order 450: after combat (400) has rebuilt the broad phase for this tick, so an
 * area effect hits where units actually are.
 *
 * Abilities are data plus one `cast` closure rather than a generic effect
 * interpreter. The GDD's effect spec (`AbilityEffectSpec`) is the eventual
 * data-driven form; until the shape of real abilities is settled, hand-written
 * closures keep each one readable and avoid inventing an interpreter around
 * guesses. The definitions below are the input a future interpreter would read.
 *
 * Timed modifiers (buffs, slows) are owned here: they attach a `StatModifier`
 * with an expiry tick, and this module removes them and recomputes stats. That
 * keeps `UnitState.modifiers` authoritative and means nothing has to remember to
 * undo its own buff.
 */

import type { EntityId, GameContext, GameModule, StatModifier, TeamId, UnitState, Vec2 } from '@/core/contracts';
import { DamageType, Faction, UnitKind } from '@/core/contracts';
import {
  CombatKey,
  TerrainKey,
  UnitKey,
  UnitViewKey,
  VfxKey,
  type CombatService,
  type DamageRequest,
  type TerrainService,
  type UnitService,
  type VfxService,
} from '@/core/services';
import { SIM_STEP } from '@/core/engine';
import { angleTo, dist2 } from '@/core/mathx';
import type { IconId } from '@/ui/icons';
import { isHostileTo } from './combat';
import { heroOrders, issueOrder, type HeroOrder } from './movement';
import { hasLineOfSight } from './sight';
import { runtimeOf } from './units';
import { cos, hypot, sin } from '@/core/detmath';

/**
 * How one number on an ability grows with the hero's level.
 *
 * Abilities had no level scaling at all: damage rose only because it reads the
 * caster's attack power, while range, radius and duration were constants. That
 * made a short utility like the dash strictly worse every level -- the map does
 * not shrink -- and an ultimate that stayed the same size while everything
 * around it grew.
 *
 * `max` is not optional and the cap is the point. Levels are unbounded by
 * design (GDD 9), so anything that grows per level without a ceiling eventually
 * covers the map.
 */
export interface Growth {
  /** Added per level above 1. */
  per: number;
  /** The most the growth may ever add, on top of the base. */
  max: number;
}

export interface AbilityGrowth {
  range?: Growth;
  radius?: Growth;
  /** Seconds of effect; what that means is up to the ability. */
  duration?: Growth;
}

/** `base` grown for a hero at `level`, never past the cap. */
export function grown(base: number, g: Growth | undefined, level: number): number {
  if (!g) return base;
  return base + Math.min(g.max, g.per * Math.max(0, level - 1));
}

/** The reach an ability actually has for this hero. Used for aiming too. */
export function abilityRange(def: AbilityDef, level: number): number {
  return grown(def.range, def.growth?.range, level);
}

/** The area it actually covers. */
export function abilityRadius(def: AbilityDef, level: number): number {
  return grown(def.radius, def.growth?.radius, level);
}

export interface AbilityContext {
  caster: UnitState;
  /** The caster's hero level, or 1 for anything that is not a hero. */
  level: number;
  combat: CombatService;
  units: UnitService;
  ctx: GameContext;
  /** What the player aimed at. Already validated as in range. */
  target: AbilityTarget;
  /** Adds a stat modifier that expires on its own. */
  buff(target: UnitState, mod: StatModifier, seconds: number): void;
  /** Fires a visual effect; a no-op if the VFX layer is not loaded. */
  fx(id: string, pos: Vec2, scale?: number): void;
  /** Beams, telegraphs and decals; undefined when the VFX layer is not loaded. */
  vfx: VfxService | undefined;
  /**
   * Calls this ability's `onTimer(key, data)` after a delay, on a simulation
   * tick — never on wall-clock time. `data` must be plain values: pending
   * effects are saved in snapshots, and a closure cannot be saved.
   */
  after(seconds: number, key: string, data?: TimerData): void;
  /**
   * Calls `onTimer(key, { ...data, i })` `times` times: the first immediately,
   * then every `every` seconds.
   */
  repeat(every: number, times: number, key: string, data?: TimerData): void;
  /** Stops a unit dead: no movement, no attacks, for `seconds` (less tenacity). */
  stun(target: UnitState, seconds: number): void;
  /**
   * Drops this ability's pending steps with that key. What a trap does when it
   * finally springs: the rest of its waiting has no reason to happen.
   */
  cancel(key: string): void;
  /** Whether terrain blocks a straight line between two units. */
  sees(from: UnitState, to: UnitState): boolean;
  /** Whether a unit may stand there. Used by anything that moves a hero. */
  walkable(pos: Vec2): boolean;
  /** Asks the mixer for a named sound at a position. */
  sound(id: string, pos?: Vec2): void;
}

/**
 * What an ability is aimed at. Plain data, so a cast can be queued, sent over
 * the network or replayed exactly like any other order.
 */
export type AbilityTarget =
  | { kind: 'self' }
  | { kind: 'unit'; id: EntityId }
  | { kind: 'point'; pos: Vec2 };

export interface AbilityDef {
  id: string;
  name: string;
  description: string;
  icon: IconId;
  key: string;
  cooldown: number;
  manaCost: number;
  /**
   * How the player aims it. `self` fires on the keypress; `unit` and `point`
   * arm a targeting cursor, and the hero walks into `range` before casting.
   */
  targeting: 'self' | 'unit' | 'point';
  /**
   * Who a `unit` ability may be aimed at. Enemies unless stated: a heal has to
   * say so, because the targeting cursor would otherwise refuse a friend.
   */
  targets?: 'enemy' | 'ally';
  /** Maximum cast distance for aimed abilities; ignored for `self`. */
  range: number;
  /** Area of effect, shown on the ground while aiming a `point` ability. */
  radius: number;
  /**
   * What grows with the hero's level. Absent means the ability is the same at
   * level 40 as at level 1, which is right for some and wrong for anything the
   * player is meant to keep using.
   */
  growth?: AbilityGrowth;
  cast(c: AbilityContext): boolean;
  /** Runs a delayed step booked with `c.after` / `c.repeat`. */
  onTimer?(c: AbilityContext, key: string, data: TimerData): void;
}

/** Payload of a delayed ability step. Plain values only, so it can be saved. */
export type TimerData = Record<string, number | string | boolean | null>;

interface ScheduledEffect {
  atTick: number;
  heroId: EntityId;
  abilityId: string;
  target: AbilityTarget;
  key: string;
  data: TimerData;
}

/** Collects live hostiles inside a radius. Shared by every area ability. */
function hostilesIn(c: AbilityContext, pos: Vec2, radius: number): UnitState[] {
  return c.combat.queryUnits(pos, radius, (u) => u.alive && isHostileTo(c.caster, u));
}

const BULWARK: AbilityDef[] = [
  {
    id: 'bulwark.q',
    name: 'Embate de escudo',
    description: 'Golpea a los enemigos frente a ti y los ralentiza brevemente.',
    icon: 'shield-bash',
    key: 'Q',
    cooldown: 7,
    manaCost: 35,
    targeting: 'self',
    range: 0,
    radius: 5.2,
    cast(c) {
      const targets = hostilesIn(c, c.caster.pos, this.radius);
      if (targets.length === 0) return false;
      c.fx('impact.slam', c.caster.pos, this.radius);
      for (const t of targets) {
        c.combat.applyDamage({
          targetId: t.id,
          sourceId: c.caster.id,
          amount: c.caster.stats.attackDamage * 1.6 + c.caster.stats.spellPower * 0.8,
          type: DamageType.Physical,
          canCrit: true,
        });
        c.buff(t, { stat: 'moveSpeed', op: 'pct', value: -0.45, sourceId: this.id }, 2);
      }
      return true;
    },
  },
  {
    id: 'bulwark.w',
    name: 'Grito de anclaje',
    description: 'Atrae la atención de los enemigos cercanos y reduce su daño.',
    icon: 'anchor-shout',
    key: 'W',
    cooldown: 13,
    manaCost: 45,
    targeting: 'self',
    range: 0,
    radius: 9,
    cast(c) {
      const targets = hostilesIn(c, c.caster.pos, this.radius);
      if (targets.length === 0) return false;
      c.fx('aura.shout', c.caster.pos, this.radius);
      for (const t of targets) {
        // Taunt: forcing the target makes the tank's job actually work.
        t.targetId = c.caster.id;
        c.buff(t, { stat: 'attackDamage', op: 'pct', value: -0.3, sourceId: this.id }, 5);
      }
      return true;
    },
  },
  {
    id: 'bulwark.e',
    name: 'Muro de contención',
    description: 'Aumenta tu armadura y regeneración durante unos segundos.',
    icon: 'bulwark-wall',
    key: 'E',
    cooldown: 18,
    manaCost: 50,
    targeting: 'self',
    range: 0,
    radius: 0,
    cast(c) {
      c.fx('aura.guard', c.caster.pos, 3);
      c.buff(c.caster, { stat: 'armor', op: 'flat', value: 28, sourceId: this.id }, 8);
      c.buff(c.caster, { stat: 'healthRegen', op: 'flat', value: 22, sourceId: this.id }, 8);
      return true;
    },
  },
  {
    id: 'bulwark.r',
    name: 'Bastión inquebrantable',
    description: 'Onda de choque devastadora que además te cura.',
    icon: 'unbroken',
    key: 'R',
    cooldown: 80,
    manaCost: 110,
    targeting: 'self',
    range: 0,
    radius: 13,
    // The circle, and only the circle: it is cast on itself, so there is no
    // range to grow, and the blast is instantaneous.
    growth: { radius: { per: 0.25, max: 4 } },
    cast(c) {
      c.fx('impact.nova', c.caster.pos, abilityRadius(this, c.level));
      const targets = hostilesIn(c, c.caster.pos, abilityRadius(this, c.level));
      for (const t of targets) {
        c.combat.applyDamage({
          targetId: t.id,
          sourceId: c.caster.id,
          amount: c.caster.stats.attackDamage * 3.2 + c.caster.stats.spellPower * 2,
          type: DamageType.Holy,
          canCrit: true,
        });
      }
      c.combat.applyHeal(c.caster.id, c.caster.id, c.caster.stats.maxHealth * 0.28);
      c.ctx.bus.emit('camera:shake', { intensity: 0.9, duration: 0.45, team: c.caster.team as TeamId });
      return true;
    },
  },
];

/**
 * The Oracle is a sorceress: she aims. Every one of her abilities is placed —
 * a unit for the lightning, a patch of ground for the rest — which is what
 * separates her from the Bulwark, whose whole kit is centred on himself.
 *
 * - Q strikes one enemy and arcs onward through a pack.
 * - W denies an area over time.
 * - E is the control tool: a seal that detonates and stuns.
 * - R is the skill shot: huge, telegraphed, and dodgeable by anything that
 *   reads the red circle — then it leaves the ground burning.
 */
const ORACLE: AbilityDef[] = [
  {
    id: 'oracle.q',
    name: 'Cadena de relámpagos',
    description:
      'Un rayo golpea al enemigo elegido y salta hasta a 4 enemigos cercanos más. Cada salto pierde un 20 % de daño y necesita línea de visión.',
    icon: 'bolt',
    key: 'Q',
    cooldown: 6,
    manaCost: 45,
    targeting: 'unit',
    range: 13,
    radius: 7,
    cast(c) {
      if (c.target.kind !== 'unit') return false;
      const first = c.units.get(c.target.id);
      if (!first || !first.alive || !isHostileTo(c.caster, first)) return false;

      // The whole chain is chosen now, from where everything stands at the
      // moment of casting; only the strikes are staggered. Choosing each jump
      // on arrival would let the chain wander after units that moved into it.
      const chain: UnitState[] = [first];
      const struck = new Set<EntityId>([first.id]);
      while (chain.length < 5) {
        const from = chain[chain.length - 1]!;
        let best: UnitState | null = null;
        let bestD = Infinity;
        for (const u of hostilesIn(c, from.pos, this.radius)) {
          if (struck.has(u.id) || !c.sees(from, u)) continue;
          const d = dist2(from.pos, u.pos);
          if (d < bestD) {
            bestD = d;
            best = u;
          }
        }
        if (!best) break;
        chain.push(best);
        struck.add(best.id);
      }

      let amount = c.caster.stats.spellPower * 2 + 45;
      chain.forEach((target, i) => {
        const strike = {
          sourceId: i === 0 ? c.caster.id : chain[i - 1]!.id,
          targetId: target.id,
          damage: amount,
          jump: i > 0,
        };
        if (i === 0) this.onTimer!(c, 'strike', strike);
        else c.after(i * 0.12, 'strike', strike);
        amount *= 0.8;
      });
      return true;
    },
    onTimer(c, key, data) {
      if (key !== 'strike') return;
      const target = c.units.get(data.targetId as number);
      if (!target || !target.alive) return;
      const source = c.units.get(data.sourceId as number);
      if (source) c.vfx?.beam('beam.lightning', source.pos, target.pos, 0.3);
      if (data.jump) c.sound('ability.oracle.q.jump', target.pos);
      c.combat.applyDamage({
        targetId: target.id,
        sourceId: c.caster.id,
        amount: data.damage as number,
        type: DamageType.Arcane,
        canCrit: true,
      });
    },
  },
  {
    id: 'oracle.w',
    name: 'Tormenta de escarcha',
    description:
      'Desata una tormenta de hielo sobre la zona elegida durante 3 s: daña cada medio segundo y ralentiza un 45 % a quien siga dentro.',
    icon: 'frost',
    key: 'W',
    cooldown: 12,
    manaCost: 70,
    targeting: 'point',
    range: 16,
    radius: 5.5,
    cast(c) {
      if (c.target.kind !== 'point') return false;
      const center = { x: c.target.pos.x, z: c.target.pos.z };
      c.vfx?.telegraph('ring', center, this.radius, 3.1, 0x6fc8ff);
      c.vfx?.decal('frost', center, this.radius, 5);
      c.fx('aura.frost', center, this.radius * 0.9);
      c.repeat(0.5, 6, 'pulse', { x: center.x, z: center.z });
      return true;
    },
    onTimer(c, key, data) {
      if (key !== 'pulse') return;
      const center = { x: data.x as number, z: data.z as number };
      for (const t of hostilesIn(c, center, this.radius)) {
        c.combat.applyDamage({
          targetId: t.id,
          sourceId: c.caster.id,
          amount: c.caster.stats.spellPower * 0.45 + 12,
          type: DamageType.Frost,
        });
        // Short and refreshed every pulse: the slow lasts exactly as long as
        // the unit stays in the storm, plus a moment to walk out of it.
        c.buff(t, { stat: 'moveSpeed', op: 'pct', value: -0.45, sourceId: this.id }, 0.8);
      }
      const rng = c.ctx.rng;
      for (let k = 0; k < 2; k++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.range(0, 1)) * this.radius * 0.85;
        c.fx('hit.frost', { x: center.x + cos(a) * r, z: center.z + sin(a) * r }, 1.8);
      }
      if ((data.i as number) > 0) c.sound('ability.oracle.w.tick', center);
    },
  },
  {
    id: 'oracle.e',
    name: 'Sello de éter',
    description:
      'Marca un círculo en el suelo que estalla tras 0,6 s: daña y aturde 1,6 s a los enemigos que sigan dentro.',
    icon: 'spark',
    key: 'E',
    cooldown: 14,
    manaCost: 60,
    targeting: 'point',
    range: 14,
    radius: 3.8,
    cast(c) {
      if (c.target.kind !== 'point') return false;
      const center = { x: c.target.pos.x, z: c.target.pos.z };
      c.vfx?.telegraph('circle', center, this.radius, 0.6, 0xb46cff);
      c.after(0.6, 'burst', { x: center.x, z: center.z });
      return true;
    },
    onTimer(c, key, data) {
      if (key !== 'burst') return;
      const center = { x: data.x as number, z: data.z as number };
      c.fx('bolt.arcane', center, this.radius * 0.8);
      c.vfx?.decal('sigil', center, this.radius * 0.9, 2.5);
      c.sound('ability.oracle.e.burst', center);
      for (const t of hostilesIn(c, center, this.radius)) {
        c.combat.applyDamage({
          targetId: t.id,
          sourceId: c.caster.id,
          amount: c.caster.stats.spellPower * 1.2 + 30,
          type: DamageType.Arcane,
          canCrit: true,
        });
        c.stun(t, 1.6);
      }
    },
  },
  {
    id: 'oracle.r',
    name: 'Meteoro del umbral',
    description:
      'Invoca un meteoro que cae sobre la zona elegida tras 1,2 s: daño enorme y aturdimiento breve. El suelo arde tras el impacto. Con cada nivel gana alcance, área y duración.',
    icon: 'flame',
    key: 'R',
    cooldown: 70,
    manaCost: 150,
    targeting: 'point',
    range: 18,
    radius: 6.5,
    growth: {
      range: { per: 0.5, max: 7 },
      radius: { per: 0.2, max: 3 },
      duration: { per: 0.2, max: 3 },
    },
    cast(c) {
      if (c.target.kind !== 'point') return false;
      const center = { x: c.target.pos.x, z: c.target.pos.z };
      c.vfx?.telegraph('circle', center, abilityRadius(this, c.level), 1.2, 0xff5a3c);
      c.vfx?.telegraph('ring', center, abilityRadius(this, c.level), 1.2, 0xffa050);
      // The rock itself, falling. It starts 48 m up and slightly behind the
      // camera's shoulder, and its speed is solved so that it lands on the
      // same tick the impact resolves — a meteor that arrives late reads as a
      // bug, and one that arrives early makes the telegraph a lie.
      const FALL = 1.2;
      const sky = { x: center.x - 7, z: center.z - 19 };
      const drop = 48;
      const travel = Math.sqrt(7 * 7 + 19 * 19 + drop * drop);
      c.vfx?.projectile('shot.meteor', sky, center, {
        speed: travel / FALL,
        fromHeight: drop,
        toHeight: 0.6,
      });
      c.after(FALL, 'impact', { x: center.x, z: center.z });
      return true;
    },
    onTimer(c, key, data) {
      const center = { x: data.x as number, z: data.z as number };
      const burn = abilityRadius(this, c.level) * 0.75;
      if (key === 'impact') {
        c.fx('impact.meteor', center, abilityRadius(this, c.level));
        c.vfx?.decal('scorch', center, abilityRadius(this, c.level) * 0.85, 12);
        c.sound('ability.oracle.r.impact', center);
        c.ctx.bus.emit('camera:shake', { intensity: 1, duration: 0.6, team: c.caster.team as TeamId });
        for (const t of hostilesIn(c, center, abilityRadius(this, c.level))) {
          c.combat.applyDamage({
            targetId: t.id,
            sourceId: c.caster.id,
            amount: c.caster.stats.spellPower * 4.5 + 160,
            type: DamageType.Fire,
            canCrit: true,
          });
          c.stun(t, 0.8);
        }
        // Four seconds of burning ground at base, in half-second ticks.
        const seconds = grown(4, this.growth?.duration, c.level);
        c.repeat(0.5, Math.round(seconds / 0.5), 'burn', { x: center.x, z: center.z });
        return;
      }
      if (key !== 'burn' || data.i === 0) return; // the impact itself was pulse 0
      for (const t of hostilesIn(c, center, burn)) {
        c.combat.applyDamage({
          targetId: t.id,
          sourceId: c.caster.id,
          amount: c.caster.stats.spellPower * 0.4 + 10,
          type: DamageType.Fire,
        });
      }
      const rng = c.ctx.rng;
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.range(0, 1)) * burn;
      c.fx('burn.tick', { x: center.x + cos(a) * r, z: center.z + sin(a) * r }, 1.4);
    },
  },
];

/**
 * Talon is an archer: her damage comes out of her bow, not her mana bar, and
 * the kit is built to keep her shooting from somewhere the wave cannot reach.
 *
 * - Q is the only pure damage spell, and it is a line: it rewards standing
 *   where the lane lines up rather than where the fight is.
 * - W buys time — a trap that springs on whoever walks into it first.
 * - E is the escape, and the reason she can be this frail: a step out of the
 *   pack that also makes the next seconds of shooting hurt.
 * - R covers ground she is not standing on, which is how one archer holds a
 *   lane she has already left.
 */
const TALON: AbilityDef[] = [
  {
    id: 'talon.q',
    name: 'Flecha perforante',
    description:
      'Dispara una flecha que atraviesa a todos los enemigos en línea recta. Cada enemigo alcanzado le resta un 12 % de daño a la flecha.',
    icon: 'arrow',
    key: 'Q',
    cooldown: 7,
    manaCost: 40,
    targeting: 'point',
    range: 15,
    radius: 1.3,
    cast(c) {
      if (c.target.kind !== 'point') return false;
      const from = c.caster.pos;
      const dx = c.target.pos.x - from.x;
      const dz = c.target.pos.z - from.z;
      const len = hypot(dx, dz);
      if (len < 0.5) return false;
      const ux = dx / len;
      const uz = dz / len;
      const reach = this.range;
      const tip = { x: from.x + ux * reach, z: from.z + uz * reach };

      // Everything within half a metre of the line, in the order the arrow
      // reaches it: the damage falls off along the shaft, so order matters.
      const hits: { unit: UnitState; along: number }[] = [];
      for (const u of hostilesIn(c, { x: (from.x + tip.x) / 2, z: (from.z + tip.z) / 2 }, reach / 2 + 3)) {
        const along = (u.pos.x - from.x) * ux + (u.pos.z - from.z) * uz;
        if (along < 0 || along > reach) continue;
        const side = Math.abs((u.pos.x - from.x) * uz - (u.pos.z - from.z) * ux);
        if (side > this.radius) continue;
        if (!c.sees(c.caster, u)) continue;
        hits.push({ unit: u, along });
      }
      hits.sort((a, b) => a.along - b.along);

      c.vfx?.beam('beam.arrow', from, tip, 0.22);
      c.sound('ability.talon.q', from);
      let amount = c.caster.stats.attackDamage * 1.5 + 30;
      for (const hit of hits) {
        c.combat.applyDamage({
          targetId: hit.unit.id,
          sourceId: c.caster.id,
          amount,
          type: DamageType.Physical,
          canCrit: true,
        });
        c.fx('hit.pierce', hit.unit.pos, 1.1);
        amount *= 0.88;
      }
      return true;
    },
  },
  {
    id: 'talon.w',
    name: 'Trampa de red',
    description:
      'Coloca una trampa que se arma en 0,8 s y salta con el primer enemigo que pase: lo inmoviliza 1,8 s y ralentiza a los de alrededor. Dura 12 s.',
    icon: 'net',
    key: 'W',
    cooldown: 15,
    manaCost: 55,
    targeting: 'point',
    range: 13,
    radius: 2.6,
    cast(c) {
      if (c.target.kind !== 'point') return false;
      const at = { x: c.target.pos.x, z: c.target.pos.z };
      c.vfx?.decal('frost', at, this.radius, 12.8);
      c.fx('aura.guard', at, this.radius * 0.7);
      c.sound('ability.talon.w', at);
      // Armed after a moment, then checked four times a second for twelve
      // seconds. `cancel` ends the watch the instant it springs.
      c.repeat(0.25, 52, 'watch', { x: at.x, z: at.z });
      return true;
    },
    onTimer(c, key, data) {
      if (key !== 'watch') return;
      // The first three ticks are the trap arming; it cannot catch anything yet.
      if ((data.i as number) < 3) return;
      const at = { x: data.x as number, z: data.z as number };
      const caught = hostilesIn(c, at, this.radius * 0.55);
      if (caught.length === 0) return;
      c.cancel('watch');
      c.fx('impact.slam', at, this.radius);
      c.vfx?.telegraph('ring', at, this.radius, 0.5, 0x9fe8a0);
      c.sound('ability.talon.w.snap', at);
      for (const t of caught) {
        c.combat.applyDamage({
          targetId: t.id,
          sourceId: c.caster.id,
          amount: c.caster.stats.attackDamage * 0.9 + 25,
          type: DamageType.Physical,
        });
        c.stun(t, 1.8);
      }
      // Everything else nearby is merely tangled.
      for (const t of hostilesIn(c, at, this.radius)) {
        if (caught.includes(t)) continue;
        c.buff(t, { stat: 'moveSpeed', op: 'pct', value: -0.4, sourceId: this.id }, 2.5);
      }
    },
  },
  {
    id: 'talon.e',
    name: 'Paso del viento',
    description:
      'Se desplaza al punto elegido (8 m, y más con cada nivel hasta 16) y dispara un 45 % más rápido durante 4 s. No atraviesa terreno intransitable.',
    icon: 'wind-step',
    key: 'E',
    cooldown: 13,
    manaCost: 45,
    targeting: 'point',
    range: 8,
    radius: 0,
    // Eight metres is barely two seconds of walking, so at level 1 this is an
    // escape and nothing more -- which is right -- but the map does not shrink
    // and by level 20 it had become a worse way to move than moving. Half a
    // metre a level doubles it across a long match and stops there.
    growth: { range: { per: 0.5, max: 8 } },
    cast(c) {
      if (c.target.kind !== 'point') return false;
      const reach = grown(this.range, this.growth?.range, c.level);
      const from = { x: c.caster.pos.x, z: c.caster.pos.z };
      const dx = c.target.pos.x - from.x;
      const dz = c.target.pos.z - from.z;
      const len = hypot(dx, dz);
      if (len < 0.4) return false;
      const capped = Math.min(len, reach);
      // Walks the line back from the aimed point until it finds ground she may
      // stand on, so a step aimed into a cliff lands at its foot instead of
      // failing outright — and never puts her somewhere she could not walk to.
      let landed: Vec2 | null = null;
      for (let d = capped; d >= 1; d -= 0.5) {
        const spot = { x: from.x + (dx / len) * d, z: from.z + (dz / len) * d };
        if (c.walkable(spot)) {
          landed = spot;
          break;
        }
      }
      if (!landed) return false;

      c.fx('impact.dash', from, 1.4);
      c.sound('ability.talon.e', from);
      c.caster.pos.x = landed.x;
      c.caster.pos.z = landed.z;
      c.caster.vel.x = 0;
      c.caster.vel.z = 0;
      // The order she was walking under belonged to where she stood; keep it
      // and she immediately walks back.
      heroOrders.delete(c.caster.id);
      c.fx('impact.dash', landed, 1.8);
      c.buff(c.caster, { stat: 'attackSpeed', op: 'pct', value: 0.45, sourceId: this.id }, 4);
      return true;
    },
  },
  {
    id: 'talon.r',
    name: 'Lluvia de flechas',
    description:
      'Cubre la zona elegida de flechas: daña cada medio segundo, ralentiza un 30 % y deja sin armadura a quien siga dentro. Con cada nivel gana alcance, área y duración.',
    icon: 'arrow-rain',
    key: 'R',
    cooldown: 75,
    manaCost: 120,
    targeting: 'point',
    range: 18,
    radius: 7.5,
    // All three, because an ultimate that keeps its size while the waves grow
    // stops being an ultimate. Duration is in seconds here and turned into
    // half-second volleys below.
    growth: {
      range: { per: 0.6, max: 9 },
      radius: { per: 0.22, max: 3.5 },
      duration: { per: 0.2, max: 3 },
    },
    cast(c) {
      if (c.target.kind !== 'point') return false;
      const center = { x: c.target.pos.x, z: c.target.pos.z };
      c.vfx?.telegraph('ring', center, abilityRadius(this, c.level), 0.6, 0xc9b06a);
      c.sound('ability.talon.r', center);
      c.after(0.6, 'volley', { x: center.x, z: center.z });
      return true;
    },
    onTimer(c, key, data) {
      const center = { x: data.x as number, z: data.z as number };
      const radius = abilityRadius(this, c.level);
      if (key === 'volley') {
        c.vfx?.decal('scorch', center, radius * 0.9, 6);
        c.ctx.bus.emit('camera:shake', { intensity: 0.5, duration: 0.3, team: c.caster.team as TeamId });
        // Four seconds at base, half a second apart, and longer with level.
        const seconds = grown(4, this.growth?.duration, c.level);
        c.repeat(0.5, Math.round(seconds / 0.5), 'rain', { x: center.x, z: center.z });
        return;
      }
      if (key !== 'rain') return;
      for (const t of hostilesIn(c, center, radius)) {
        c.combat.applyDamage({
          targetId: t.id,
          sourceId: c.caster.id,
          amount: c.caster.stats.attackDamage * 0.55 + 14,
          type: DamageType.Physical,
          canCrit: true,
        });
        c.buff(t, { stat: 'moveSpeed', op: 'pct', value: -0.3, sourceId: this.id }, 0.8);
        c.buff(t, { stat: 'armor', op: 'flat', value: -6, sourceId: this.id }, 0.8);
      }
      const rng = c.ctx.rng;
      for (let k = 0; k < 3; k++) {
        const a = rng.range(0, Math.PI * 2);
        const r = Math.sqrt(rng.range(0, 1)) * radius * 0.95;
        c.fx('hit.pierce', { x: center.x + cos(a) * r, z: center.z + sin(a) * r }, 1.2);
      }
      if ((data.i as number) > 0) c.sound('ability.talon.r.tick', center);
    },
  },
];

/** Live friendlies inside a radius, the caster included. */
function alliesIn(c: AbilityContext, pos: Vec2, radius: number): UnitState[] {
  return c.combat.queryUnits(pos, radius, (u) => u.alive && !isHostileTo(c.caster, u));
}

/** The friendly in most need inside a radius, or null when everyone is whole. */
function mostWounded(c: AbilityContext, pos: Vec2, radius: number): UnitState | null {
  let best: UnitState | null = null;
  let worst = 1;
  for (const u of alliesIn(c, pos, radius)) {
    const frac = u.health / u.stats.maxHealth;
    if (frac < worst) {
      worst = frac;
      best = u;
    }
  }
  return worst < 0.999 ? best : null;
}

/**
 * Vesper heals by fighting. Every spell in the kit does both jobs at once —
 * the enemy she burns is what pays for the ally she mends — so a healer alone
 * in her lane is still a hero and not a medic waiting for a patient.
 *
 * - Q is the engine: damage an enemy, and the light that leaves the wound goes
 *   to whoever nearby is worst off (herself included).
 * - W is the ground game: a circle that mends her side and burns the other.
 * - E is the save: a shield on one ally, or on herself when she is the one in
 *   trouble.
 * - R is the turn: everyone up, everything around her down.
 */
const VESPER: AbilityDef[] = [
  {
    id: 'vesper.q',
    name: 'Luz punzante',
    description:
      'Atraviesa a un enemigo con luz y cura al aliado más herido a 9 m (ella incluida) con el 65 % del daño causado.',
    icon: 'spark',
    key: 'Q',
    cooldown: 5,
    manaCost: 35,
    targeting: 'unit',
    range: 11,
    radius: 9,
    cast(c) {
      if (c.target.kind !== 'unit') return false;
      const victim = c.units.get(c.target.id);
      if (!victim || !victim.alive || !isHostileTo(c.caster, victim)) return false;

      const amount = c.caster.stats.spellPower * 1.6 + c.caster.stats.attackDamage * 0.8 + 28;
      c.vfx?.beam('beam.holy', c.caster.pos, victim.pos, 0.28);
      c.sound('ability.vesper.q', victim.pos);
      const dealt = c.combat.applyDamage({
        targetId: victim.id,
        sourceId: c.caster.id,
        amount,
        type: DamageType.Holy,
        canCrit: true,
      });
      c.fx('hit.holy', victim.pos, 1.2);

      // The heal follows the damage that actually landed, so armour on the
      // target makes the whole spell weaker rather than only half of it.
      const patient = mostWounded(c, c.caster.pos, this.radius) ?? c.caster;
      const healed = c.combat.applyHeal(patient.id, c.caster.id, dealt * 0.65);
      if (healed > 0) {
        c.fx('aura.guard', patient.pos, 1.6);
        c.vfx?.beam('beam.holy', victim.pos, patient.pos, 0.34);
      }
      return true;
    },
  },
  {
    id: 'vesper.w',
    name: 'Círculo de auxilio',
    description:
      'Consagra la zona elegida 4 s: cura a los aliados que estén dentro cada medio segundo y quema a los enemigos que la pisen.',
    icon: 'heal',
    key: 'W',
    cooldown: 16,
    manaCost: 75,
    targeting: 'point',
    range: 14,
    radius: 5,
    cast(c) {
      if (c.target.kind !== 'point') return false;
      const center = { x: c.target.pos.x, z: c.target.pos.z };
      c.vfx?.telegraph('ring', center, this.radius, 4.1, 0xffd88a);
      c.vfx?.decal('sigil', center, this.radius, 5);
      c.fx('aura.guard', center, this.radius * 0.9);
      c.sound('ability.vesper.w', center);
      c.repeat(0.5, 8, 'pulse', { x: center.x, z: center.z });
      return true;
    },
    onTimer(c, key, data) {
      if (key !== 'pulse') return;
      const center = { x: data.x as number, z: data.z as number };
      for (const ally of alliesIn(c, center, this.radius)) {
        const healed = c.combat.applyHeal(ally.id, c.caster.id, c.caster.stats.spellPower * 0.3 + 9);
        if (healed > 0 && (data.i as number) % 2 === 0) c.fx('hit.holy', ally.pos, 0.9);
      }
      for (const foe of hostilesIn(c, center, this.radius)) {
        c.combat.applyDamage({
          targetId: foe.id,
          sourceId: c.caster.id,
          amount: c.caster.stats.spellPower * 0.28 + 7,
          type: DamageType.Holy,
        });
      }
      if ((data.i as number) > 0) c.sound('ability.vesper.w.tick', center);
    },
  },
  {
    id: 'vesper.e',
    name: 'Égida del alba',
    description:
      'Envuelve a un aliado (o a sí misma) en luz: lo cura al instante y le da +30 de armadura y regeneración durante 6 s.',
    icon: 'crest',
    key: 'E',
    cooldown: 14,
    manaCost: 60,
    targeting: 'unit',
    targets: 'ally',
    range: 10,
    radius: 0,
    cast(c) {
      if (c.target.kind !== 'unit') return false;
      const ally = c.units.get(c.target.id);
      // Cast on an enemy it does nothing: better to refuse than to waste it.
      if (!ally || !ally.alive || isHostileTo(c.caster, ally)) return false;
      c.fx('aura.guard', ally.pos, 3);
      c.vfx?.beam('beam.holy', c.caster.pos, ally.pos, 0.3);
      c.sound('ability.vesper.e', ally.pos);
      c.combat.applyHeal(ally.id, c.caster.id, c.caster.stats.spellPower * 1.2 + 55);
      c.buff(ally, { stat: 'armor', op: 'flat', value: 30, sourceId: this.id }, 6);
      c.buff(ally, { stat: 'healthRegen', op: 'flat', value: 18, sourceId: this.id }, 6);
      return true;
    },
  },
  {
    id: 'vesper.r',
    name: 'Alba',
    description:
      'El alba se rompe sobre ella: cura en abundancia a todos los aliados a 13 m y abrasa a los enemigos, que además quedan ralentizados 3 s.',
    icon: 'unbroken',
    key: 'R',
    cooldown: 85,
    manaCost: 130,
    targeting: 'self',
    range: 0,
    radius: 13,
    growth: { radius: { per: 0.25, max: 4 } },
    cast(c) {
      c.fx('impact.nova', c.caster.pos, abilityRadius(this, c.level));
      c.vfx?.decal('sigil', c.caster.pos, abilityRadius(this, c.level) * 0.8, 8);
      c.sound('ability.vesper.r', c.caster.pos);
      c.ctx.bus.emit('camera:shake', { intensity: 0.7, duration: 0.4, team: c.caster.team as TeamId });
      for (const ally of alliesIn(c, c.caster.pos, abilityRadius(this, c.level))) {
        c.combat.applyHeal(ally.id, c.caster.id, c.caster.stats.spellPower * 2.4 + ally.stats.maxHealth * 0.22);
        c.fx('hit.holy', ally.pos, 1.3);
      }
      for (const foe of hostilesIn(c, c.caster.pos, abilityRadius(this, c.level))) {
        c.combat.applyDamage({
          targetId: foe.id,
          sourceId: c.caster.id,
          amount: c.caster.stats.spellPower * 2.6 + 90,
          type: DamageType.Holy,
          canCrit: true,
        });
        c.buff(foe, { stat: 'moveSpeed', op: 'pct', value: -0.35, sourceId: this.id }, 3);
      }
      return true;
    },
  },
];

export const ABILITIES: Record<string, AbilityDef[]> = {
  bulwark: BULWARK,
  oracle: ORACLE,
  talon: TALON,
  vesper: VESPER,
};

interface TimedModifier {
  unitId: EntityId;
  mod: StatModifier;
  expiresAtTick: number;
}

export class AbilityModule implements GameModule {
  readonly id = 'abilities';
  readonly order = 450;

  private ctx!: GameContext;
  private combat!: CombatService;
  private units!: UnitService;
  private terrain: TerrainService | undefined;
  private cooldowns = new Map<string, number>();
  private timed: TimedModifier[] = [];
  /** Cast requests queued by input, drained on the next simulation tick. */
  private queued: { heroId: EntityId; index: number; target: AbilityTarget }[] = [];
  /**
   * Aimed casts whose target was out of range: the hero is walking toward it
   * and casts on arrival. Keyed by hero, so a new cast replaces an old one.
   */
  private pending = new Map<EntityId, { index: number; target: AbilityTarget; order: HeroOrder }>();
  /**
   * Delayed ability effects, in the order they were scheduled. Plain data, not
   * closures: a snapshot has to be able to save them and a restored match has
   * to be able to run them.
   */
  private scheduled: ScheduledEffect[] = [];

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.units = ctx.services.get(UnitKey);
    // Combat registers at 400 and this module inits at 450, so it is available.
    this.combat = ctx.services.get(CombatKey);
    this.terrain = ctx.services.tryGet(TerrainKey);
  }

  /**
   * Called from input. Never casts immediately — the sim owns when it happens.
   * `target` is required for aimed abilities and ignored for self-casts.
   */
  request(heroId: EntityId, index: number, target: AbilityTarget = { kind: 'self' }): void {
    this.queued.push({ heroId, index, target });
  }

  abilitiesFor(defId: string): AbilityDef[] {
    return ABILITIES[defId] ?? [];
  }

  cooldownLeft(heroId: EntityId, abilityId: string): number {
    const until = this.cooldowns.get(`${heroId}:${abilityId}`);
    if (until === undefined) return 0;
    return Math.max(0, (until - this.ctx.clock.tick) * SIM_STEP);
  }

  /** The ability a hero is walking into range to cast, if any. For the HUD. */
  pendingCast(heroId: EntityId): number | null {
    return this.pending.get(heroId)?.index ?? null;
  }

  fixedUpdate(_step: number, ctx: GameContext): void {
    this.expireModifiers(ctx);
    this.runScheduled(ctx.clock.tick);
    this.advancePending();

    while (this.queued.length > 0) {
      const req = this.queued.shift()!;
      this.tryCast(req.heroId, req.index, req.target);
    }
  }

  saveState(): unknown {
    return {
      cooldowns: this.cooldowns,
      timed: this.timed,
      queued: this.queued,
      pending: this.pending,
      scheduled: this.scheduled,
    };
  }

  loadState(state: unknown): void {
    const s = state as {
      cooldowns: Map<string, number>;
      timed: TimedModifier[];
      queued: AbilityModule['queued'];
      pending: AbilityModule['pending'];
      scheduled: ScheduledEffect[];
    };
    this.cooldowns = s.cooldowns;
    this.timed = s.timed;
    this.queued = s.queued;
    this.pending = s.pending;
    this.scheduled = s.scheduled;
  }

  private tryCast(heroId: EntityId, index: number, target: AbilityTarget): void {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero || !hero.alive) return;
    const ability = this.abilitiesFor(hero.defId)[index];
    if (!ability) return;
    if (!this.affordable(hero, ability)) return;

    if (ability.targeting !== 'self') {
      const aim = this.aimPoint(target, ability);
      if (!aim) {
        this.ctx.bus.emit('ui:notify', {
          text:
            ability.targeting !== 'unit'
              ? 'Elige una zona del suelo'
              : ability.targets === 'ally'
                ? 'Elige un aliado'
                : 'Elige un enemigo',
          severity: 'warn',
          heroId,
        });
        return;
      }
      if (!this.inRange(hero, ability, target)) {
        // Out of range is not a refusal: the hero walks there and casts on
        // arrival, the way every RTS treats an aimed spell. The order object is
        // remembered so any other order the player gives cancels the cast.
        const order: HeroOrder = { kind: 'move', pos: { x: aim.x, z: aim.z } };
        issueOrder(heroId, order);
        this.pending.set(heroId, { index, target, order });
        return;
      }
    }

    this.pending.delete(heroId);
    this.execute(hero, ability, target);
  }

  /** Walks every pending cast forward: follow the target, cast once in range. */
  private advancePending(): void {
    for (const [heroId, cast] of this.pending) {
      const hero = this.ctx.match.heroes.get(heroId);
      const ability = hero ? this.abilitiesFor(hero.defId)[cast.index] : undefined;
      const aim = ability ? this.aimPoint(cast.target, ability) : null;
      const current = heroOrders.get(heroId);
      // Cancelled by death, by the target dying, or by the player ordering
      // something else. An order that simply ended (arrived) still casts below.
      if (!hero || !hero.alive || !ability || !aim || (current !== undefined && current !== cast.order)) {
        this.pending.delete(heroId);
        continue;
      }

      if (this.inRange(hero, ability, cast.target)) {
        if (current === cast.order) heroOrders.delete(heroId);
        this.pending.delete(heroId);
        if (this.affordable(hero, ability)) this.execute(hero, ability, cast.target);
        continue;
      }

      if (current === undefined) {
        // The walk ended without reaching range — the route gave up.
        this.pending.delete(heroId);
        continue;
      }
      // A unit target moves; keep walking at where it is now. Mutated in place
      // so the order keeps its identity and the route replans on its own.
      if (cast.order.kind === 'move') {
        cast.order.pos.x = aim.x;
        cast.order.pos.z = aim.z;
      }
    }
  }

  private affordable(hero: UnitState, ability: AbilityDef): boolean {
    if (this.cooldownLeft(hero.id, ability.id) > 0) return false;
    const stunned = runtimeOf(hero.id)?.stunnedUntilTick ?? 0;
    if (this.ctx.clock.tick < stunned) return false;
    if (hero.mana < ability.manaCost) {
      this.ctx.bus.emit('ui:notify', { text: 'Maná insuficiente', severity: 'warn', heroId: hero.id });
      return false;
    }
    return true;
  }

  /** Where an aimed ability lands, or null when the target is not valid for it. */
  private aimPoint(target: AbilityTarget, ability: AbilityDef): Vec2 | null {
    if (ability.targeting === 'point') return target.kind === 'point' ? target.pos : null;
    if (ability.targeting === 'unit') {
      if (target.kind !== 'unit') return null;
      const unit = this.units.get(target.id);
      if (!unit || !unit.alive) return null;
      const wantsAlly = ability.targets === 'ally';
      const hostile = unit.faction === Faction.Hostile;
      return wantsAlly === hostile ? null : unit.pos;
    }
    return null;
  }

  private inRange(hero: UnitState, ability: AbilityDef, target: AbilityTarget): boolean {
    if (ability.targeting === 'self') return true;
    // The grown reach, not the printed one: an ability whose range rises with
    // level has to be castable at that range, or it grows on paper and the
    // click is still refused.
    const level = (hero as { level?: number }).level ?? 1;
    const range = abilityRange(ability, level);
    if (target.kind === 'unit') {
      const unit = this.units.get(target.id);
      if (!unit) return false;
      const reach = range + unit.radius;
      if (dist2(hero.pos, unit.pos) > reach * reach) return false;
      // A spell aimed at a unit needs to see it, like an attack does.
      return !this.terrain || hasLineOfSight(this.terrain, hero, unit);
    }
    if (target.kind === 'point') return dist2(hero.pos, target.pos) <= range * range;
    return false;
  }

  /** Everything an ability's code may touch, for one caster and one cast. */
  private contextFor(hero: UnitState, ability: AbilityDef, target: AbilityTarget): AbilityContext {
    // Damage dealt by the ability is tagged with it so listeners can tell a
    // shield bash from an auto-attack. Wrapped here rather than tagged at each
    // call site, so a new ability cannot forget to do it. A Proxy rather than
    // `Object.create`, so a method that writes to `this` still writes to the
    // real combat module instead of a throwaway shadow.
    const tagged = (req: DamageRequest): number =>
      this.combat.applyDamage({ ...req, abilityId: req.abilityId ?? ability.id });
    const combat = new Proxy(this.combat, {
      get: (t, key) => (key === 'applyDamage' ? tagged : Reflect.get(t, key)),
    });
    const vfx = this.ctx.services.tryGet(VfxKey);
    const schedule = (seconds: number, key: string, data: TimerData): void => {
      this.scheduled.push({
        atTick: this.ctx.clock.tick + Math.max(1, Math.round(seconds / SIM_STEP)),
        heroId: hero.id,
        abilityId: ability.id,
        target,
        key,
        data,
      });
    };
    const context: AbilityContext = {
      caster: hero,
      level: hero.level,
      combat,
      units: this.units,
      ctx: this.ctx,
      target,
      vfx,
      buff: (unit, mod, seconds) => this.applyTimed(unit, mod, seconds),
      fx: (id, pos, scale) => {
        vfx?.spawn(id, pos, { scale });
      },
      after: (seconds, key, data = {}) => schedule(seconds, key, data),
      repeat: (every, times, key, data = {}) => {
        for (let i = 0; i < times; i++) {
          if (i === 0) ability.onTimer?.(context, key, { ...data, i });
          else schedule(every * i, key, { ...data, i });
        }
      },
      stun: (unit, seconds) => this.stun(unit, seconds),
      cancel: (key) => {
        this.scheduled = this.scheduled.filter(
          (e) => !(e.heroId === hero.id && e.abilityId === ability.id && e.key === key),
        );
      },
      sees: (from, to) => !this.terrain || hasLineOfSight(this.terrain, from, to),
      walkable: (pos) => !this.terrain || this.terrain.isWalkable(pos.x, pos.z),
      sound: (id, pos) => this.ctx.bus.emit('sfx:request', { sfxId: id, pos }),
    };
    return context;
  }

  private execute(hero: UnitState, ability: AbilityDef, target: AbilityTarget): void {
    const heroId = hero.id;
    // The ability decides whether it had a legal effect; a shout with nobody in
    // range should not eat the cooldown and the mana.
    if (!ability.cast(this.contextFor(hero, ability, target))) {
      this.ctx.bus.emit('ui:notify', { text: 'Sin objetivos válidos', severity: 'warn', heroId });
      return;
    }

    // Face what was aimed at, so the cast animation points the right way.
    const aim = this.aimPoint(target, ability);
    if (aim) hero.facing = angleTo(hero.pos, aim);

    hero.mana -= ability.manaCost;
    const ticks = Math.round(ability.cooldown / SIM_STEP);
    this.cooldowns.set(`${heroId}:${ability.id}`, this.ctx.clock.tick + ticks);
    this.ctx.services.tryGet(UnitViewKey)?.playAnimation(heroId, 'cast', 0.1);
    this.ctx.bus.emit('hero:abilityCast', {
      id: heroId,
      abilityId: ability.id,
      target: target.kind === 'point' ? target.pos : target.kind === 'unit' ? target.id : null,
    });
  }

  private runScheduled(tick: number): void {
    // Due entries are collected first: an effect may schedule another (a meteor
    // starting its burn), and that must not run in the same pass.
    const due: ScheduledEffect[] = [];
    for (let i = 0; i < this.scheduled.length; ) {
      if (this.scheduled[i]!.atTick <= tick) {
        due.push(this.scheduled[i]!);
        this.scheduled.splice(i, 1);
      } else {
        i++;
      }
    }
    for (const effect of due) {
      const hero = this.ctx.match.heroes.get(effect.heroId);
      const ability = hero ? this.abilitiesFor(hero.defId).find((a) => a.id === effect.abilityId) : undefined;
      if (!hero || !ability?.onTimer) continue;
      ability.onTimer(this.contextFor(hero, ability, effect.target), effect.key, effect.data);
    }
  }

  private stun(unit: UnitState, seconds: number): void {
    const runtime = runtimeOf(unit.id);
    if (!runtime || !unit.alive) return;
    const ticks = Math.round((seconds * (1 - Math.min(1, Math.max(0, unit.stats.tenacity)))) / SIM_STEP);
    // Never shortens a stun already running.
    runtime.stunnedUntilTick = Math.max(runtime.stunnedUntilTick ?? 0, this.ctx.clock.tick + ticks);
    unit.vel.x = 0;
    unit.vel.z = 0;
    this.ctx.bus.emit('unit:status', { targetId: unit.id, statusId: 'stun', applied: true, stacks: 1 });
  }

  private applyTimed(target: UnitState, mod: StatModifier, seconds: number): void {
    // Refresh rather than stack: re-casting a slow on the same target should
    // extend it, not multiply it into a permanent root.
    const existing = this.timed.find(
      (t) => t.unitId === target.id && t.mod.sourceId === mod.sourceId && t.mod.stat === mod.stat,
    );
    if (existing) {
      existing.expiresAtTick = this.ctx.clock.tick + Math.round(seconds / SIM_STEP);
      return;
    }
    target.modifiers.push(mod);
    this.timed.push({
      unitId: target.id,
      mod,
      expiresAtTick: this.ctx.clock.tick + Math.round(seconds / SIM_STEP),
    });
    this.combat.recomputeStats(target);
  }

  private expireModifiers(ctx: GameContext): void {
    for (let i = this.timed.length - 1; i >= 0; i--) {
      const entry = this.timed[i]!;
      const unit = this.units.get(entry.unitId);
      if (!unit) {
        this.timed[i] = this.timed[this.timed.length - 1]!;
        this.timed.pop();
        continue;
      }
      if (ctx.clock.tick < entry.expiresAtTick) continue;

      // By identity: the entry holds the very object pushed onto the unit. A
      // snapshot keeps that identity, because both live in one saved graph.
      const at = unit.modifiers.indexOf(entry.mod);
      if (at >= 0) unit.modifiers.splice(at, 1);
      this.combat.recomputeStats(unit);
      // Recompute can lower max health; keep current health inside the new cap.
      if (unit.health > unit.stats.maxHealth) unit.health = unit.stats.maxHealth;
      if (unit.kind !== UnitKind.Hero && unit.health <= 0) unit.health = 1;

      this.timed[i] = this.timed[this.timed.length - 1]!;
      this.timed.pop();
    }
  }

  dispose(): void {
    this.cooldowns.clear();
    this.timed.length = 0;
    this.queued.length = 0;
    this.pending.clear();
    this.scheduled.length = 0;
  }
}
