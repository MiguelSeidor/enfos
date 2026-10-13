/**
 * Player commands. Owner: GAMEPLAY.
 *
 * Everything a player does that changes the simulation — walking, attacking,
 * casting, buying, drinking, spending a point — arrives here as a `Command`
 * booked for a specific tick, and nowhere else. That single door is what makes
 * online play possible: every machine books the same commands for the same
 * ticks, so every machine computes the same match. A click that reached into
 * gameplay directly would change one machine's world and not the other's.
 *
 * Solo play goes through the same door, booking each command for the next
 * tick, so the path a solo player exercises is exactly the one online uses.
 *
 * Order 250: after units (200), before movement (300), so an order booked for
 * tick T is already steering the hero on tick T.
 */

import type { EntityId, GameContext, GameModule, Vec2 } from '@/core/contracts';
import type { EconomyModule } from '@/economy/economy';
import type { AbilityModule, AbilityTarget } from './abilities';
import type { MatchModule } from './match';
import { heroOrders, issueOrder } from './movement';
import type { AttributeId, ProgressionModule } from './progression';
import { isInvocationId, type InvocationId, type InvocationModule } from './invocations';
import type { SabotageModule } from './sabotage';

export type Command =
  | { kind: 'move'; pos: Vec2 }
  | { kind: 'attack'; targetId: EntityId }
  | { kind: 'attackMove'; pos: Vec2 }
  | { kind: 'stop' }
  | { kind: 'cast'; index: number; target: AbilityTarget }
  | { kind: 'buy'; itemId: string }
  | { kind: 'use'; itemId: string }
  // Handing things to a team-mate. Gold travels any distance; an item does
  // not, and lands on the ground if the recipient has no room -- see
  // `EconomyModule.giveItem`.
  | { kind: 'giveGold'; toId: EntityId; amount: number }
  | { kind: 'giveItem'; toId: EntityId; itemId: string }
  | { kind: 'pickUp'; dropId: number }
  // Conjure a pack where the player pointed. The position travels with the
  // command, because it is the player's decision and every machine has to
  // resolve it identically.
  | { kind: 'summon'; pos: Vec2 }
  /**
   * Orders conjured creeps to a spot.
   *
   * A list, not one id: the player drags a box over five of them and sends
   * them together, and five separate commands would arrive on five different
   * ticks and scatter the pack.
   */
  | {
      kind: 'herd';
      ids: EntityId[];
      /**
       * `move` walks them to `pos` past anything in the way; `attackMove`
       * walks the same path and stops to fight; `attack` sets `targetId`;
       * `hold` roots them where they stand.
       */
      order: 'move' | 'attackMove' | 'attack' | 'hold';
      pos?: Vec2;
      targetId?: EntityId;
    }
  | { kind: 'attribute'; attribute: AttributeId }
  /** A player power: `Parar el tiempo`, `Ver lo invisible`. */
  | { kind: 'invoke'; id: InvocationId }
  /** The player left or surrendered. Online, the server issues it on a disconnect. */
  | { kind: 'forfeit' };

/** A command and the player slot that issued it. */
export interface SlotCommand {
  slot: number;
  cmd: Command;
}

const ATTRIBUTES: readonly AttributeId[] = ['power', 'vitality', 'focus'];

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const vec = (v: unknown): Vec2 | null => {
  const o = v as { x?: unknown; z?: unknown } | null;
  return o && finite(o.x) && finite(o.z) ? { x: o.x, z: o.z } : null;
};
const shortString = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 64;

/**
 * Rebuilds a command from untrusted data, or returns null.
 *
 * Commands cross the network, so their shape cannot be assumed. Rebuilding
 * rather than checking-and-passing also strips any extra fields, so what the
 * simulation executes is exactly the typed command and nothing else.
 */
export function sanitizeCommand(raw: unknown): Command | null {
  const c = raw as { kind?: unknown } & Record<string, unknown>;
  if (!c || typeof c !== 'object') return null;
  switch (c.kind) {
    case 'move':
    case 'attackMove': {
      const pos = vec(c.pos);
      return pos ? { kind: c.kind, pos } : null;
    }
    case 'attack':
      return Number.isInteger(c.targetId) ? { kind: 'attack', targetId: c.targetId as number } : null;
    case 'stop':
      return { kind: 'stop' };
    case 'forfeit':
      return { kind: 'forfeit' };
    case 'cast': {
      if (!Number.isInteger(c.index) || (c.index as number) < 0 || (c.index as number) > 3) return null;
      const t = c.target as { kind?: unknown; id?: unknown; pos?: unknown } | null;
      let target: AbilityTarget | null = null;
      if (t?.kind === 'self') target = { kind: 'self' };
      else if (t?.kind === 'unit' && Number.isInteger(t.id)) target = { kind: 'unit', id: t.id as number };
      else if (t?.kind === 'point') {
        const pos = vec(t.pos);
        if (pos) target = { kind: 'point', pos };
      }
      return target ? { kind: 'cast', index: c.index as number, target } : null;
    }
    case 'buy':
    case 'use':
      return shortString(c.itemId) ? { kind: c.kind, itemId: c.itemId } : null;
    case 'giveGold': {
      // Clamped to a sane integer here rather than trusted: this arrives over
      // the wire and a negative amount would turn a gift into a theft.
      const amount = Math.floor(Number(c.amount));
      return Number.isInteger(c.toId) && Number.isFinite(amount) && amount > 0
        ? { kind: 'giveGold', toId: c.toId as number, amount: Math.min(amount, 1e6) }
        : null;
    }
    case 'giveItem':
      return Number.isInteger(c.toId) && shortString(c.itemId)
        ? { kind: 'giveItem', toId: c.toId as number, itemId: c.itemId }
        : null;
    case 'pickUp':
      return Number.isInteger(c.dropId) ? { kind: 'pickUp', dropId: c.dropId as number } : null;
    case 'summon': {
      const pos = vec(c.pos);
      return pos ? { kind: 'summon', pos } : null;
    }
    case 'herd': {
      if (!Array.isArray(c.ids)) return null;
      const order =
        c.order === 'attack' || c.order === 'hold' || c.order === 'attackMove'
          ? c.order
          : 'move';
      const pos = vec(c.pos);
      // A march with nowhere to go, or an attack with nothing to hit, is not
      // an order. Hold needs neither.
      if ((order === 'move' || order === 'attackMove') && !pos) return null;
      if (order === 'attack' && !Number.isInteger(c.targetId)) return null;
      // Capped: the list arrives over the wire and a selection cannot be
      // larger than what a player can own.
      const ids = c.ids.filter((v) => Number.isInteger(v)).slice(0, 64) as EntityId[];
      if (!ids.length) return null;
      return { kind: 'herd', ids, order, pos: pos ?? undefined, targetId: c.targetId as EntityId };
    }
    case 'invoke':
      return isInvocationId(c.id) ? { kind: 'invoke', id: c.id } : null;
    case 'attribute':
      return ATTRIBUTES.includes(c.attribute as AttributeId)
        ? { kind: 'attribute', attribute: c.attribute as AttributeId }
        : null;
    default:
      return null;
  }
}

export class CommandModule implements GameModule {
  readonly id = 'commands';
  readonly order = 250;

  private ctx!: GameContext;
  private readonly booked = new Map<number, SlotCommand[]>();

  constructor(
    private readonly match: MatchModule,
    private readonly abilities: AbilityModule,
    private readonly economy: EconomyModule,
    private readonly progression: ProgressionModule,
    private readonly invocations: InvocationModule,
  ) {}

  /**
   * Set by `createGameplay` after construction, the way `economy.sabotage` is:
   * the sabotage module is built after this one, and taking it in the
   * constructor would mean reordering the whole bundle for one field.
   */
  sabotage!: SabotageModule;

  init(ctx: GameContext): void {
    this.ctx = ctx;
  }

  /** The next tick a command can still be booked for. */
  get nextTick(): number {
    return this.ctx.clock.tick + 1;
  }

  /**
   * Books commands to run at the start of `tick`. Booking for a tick already
   * simulated would apply on one machine and not another, so it is refused
   * loudly rather than silently run late.
   */
  book(tick: number, commands: readonly SlotCommand[]): void {
    if (commands.length === 0) return;
    if (tick <= this.ctx.clock.tick) {
      console.error(`[commands] booked for tick ${tick}, already at ${this.ctx.clock.tick}`);
      return;
    }
    const list = this.booked.get(tick);
    if (list) list.push(...commands);
    else this.booked.set(tick, [...commands]);
  }

  fixedUpdate(_step: number, ctx: GameContext): void {
    const list = this.booked.get(ctx.clock.tick);
    if (!list) return;
    this.booked.delete(ctx.clock.tick);
    for (const entry of list) this.execute(entry);
  }

  private execute({ slot, cmd }: SlotCommand): void {
    const hero = this.match.heroOfSlot(slot);
    if (!hero) return;
    switch (cmd.kind) {
      case 'move':
        issueOrder(hero.id, { kind: 'move', pos: { x: cmd.pos.x, z: cmd.pos.z } });
        return;
      case 'attackMove':
        issueOrder(hero.id, { kind: 'attackMove', pos: { x: cmd.pos.x, z: cmd.pos.z } });
        return;
      case 'attack': {
        // Only something this hero may actually fight. A forged id pointing at
        // a rival hero or at nothing is dropped rather than chased.
        const target = this.ctx.match.units.get(cmd.targetId);
        if (!target || target.team !== -1) return;
        issueOrder(hero.id, { kind: 'attack', targetId: cmd.targetId });
        return;
      }
      case 'stop':
        heroOrders.delete(hero.id);
        hero.targetId = null;
        return;
      case 'cast':
        this.abilities.request(hero.id, cmd.index, cmd.target);
        return;
      case 'buy':
        this.report(hero.id, this.economy.buy(hero.id, cmd.itemId));
        return;
      case 'use':
        this.report(hero.id, this.economy.useItem(hero.id, cmd.itemId));
        return;
      case 'giveGold':
        this.report(hero.id, this.economy.giveGold(hero.id, cmd.toId, cmd.amount));
        return;
      case 'giveItem':
        this.report(hero.id, this.economy.giveItem(hero.id, cmd.toId, cmd.itemId));
        return;
      case 'pickUp':
        this.report(hero.id, this.economy.pickUp(hero.id, cmd.dropId));
        return;
      case 'summon':
        this.report(hero.id, this.sabotage.summon(hero.id, cmd.pos));
        return;
      case 'herd':
        this.sabotage.herd(hero.id, cmd.ids, cmd.order, cmd.pos, cmd.targetId);
        return;
      case 'invoke':
        this.report(hero.id, this.invocations.invoke(hero.id, cmd.id));
        return;
      case 'attribute':
        this.progression.spend(hero.id, cmd.attribute);
        return;
      case 'forfeit':
        this.match.forfeit(slot);
        return;
    }
  }

  /** A refused purchase explains itself — to the player who tried it. */
  private report(heroId: EntityId, result: { ok: boolean; reason?: string }): void {
    if (result.ok || !result.reason) return;
    this.ctx.bus.emit('ui:notify', { text: result.reason, severity: 'warn', heroId });
  }

  /**
   * Booked commands are deliberately not part of a snapshot: every command
   * after the snapshot's tick is booked again from the turns that carry it,
   * so a restore starts with an empty book.
   */
  beforeRestore(): void {
    this.booked.clear();
  }

  dispose(): void {
    this.booked.clear();
  }
}

