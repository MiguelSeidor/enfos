/**
 * Economy and purchasing. Owner: ECONOMY. Module order 600.
 *
 * Owns the two currencies, the purchase rules, and the "is the hero standing at
 * a shop" test the UI gates on.
 *
 * Runs at 600 — after waves (500) and the match module (550) have settled the
 * tick, so a purchase made on the same tick a bounty lands sees the gold.
 *
 * Purchases are applied as permanent `StatModifier`s on the hero and the stat
 * block is recomputed through `CombatService`, which is the same path buffs use.
 * Nothing here writes a stat directly: if it did, the next `recomputeStats` from
 * an expiring buff would wipe the purchase.
 */

import type { EntityId, GameContext, GameModule, HeroState } from '@/core/contracts';
import {
  CombatKey,
  EconomyKey,
  TerrainKey,
  type CombatService,
  type EconomyService,
} from '@/core/services';
import { dist2 } from '@/core/mathx';
import { landmark } from '@/world/layout';
import { findItem, INVENTORY_SLOTS, validateShops, type ShopItem } from './items';
import type { SabotageModule } from '@/gameplay/sabotage';

/**
 * How close the hero must stand to a shop to be able to use it.
 *
 * 10 m. This was 12, which opened the panel the instant the match began because
 * the hero spawned within range of T1; then 5, which was tight enough that the
 * player had to nudge the hero repeatedly to keep the card open. Opening now
 * requires a deliberate click on the building, so the range only has to be
 * generous enough not to close on its own while shopping.
 */
const SHOP_RANGE = 10;

/**
 * Shops a hero can use from anywhere on the map.
 *
 * Sabotage is bought with influence and spends it on the OTHER side's half of
 * the field; there is nothing to collect and nothing to carry back, so making
 * a player walk home to press it only punishes them for holding a lane. The
 * hero shop stays physical: it hands over gear that then has to be carried.
 */
const REMOTE_SHOPS: ReadonlySet<ShopKind> = new Set<ShopKind>(['sabotage']);

/**
 * How close two heroes must stand to hand something over, in metres.
 *
 * Gold has no such limit and items do, on purpose. Coin is a message; a
 * shield is an object, and an object changing hands across the map would make
 * the courier errand this exists for pointless -- the whole scenario is one
 * hero holding a lane while the other fetches, and the fetching is the cost.
 */
const HANDOVER_RANGE = 6;

/** An item lying on the ground, waiting for someone to pick it up. */
export interface Drop {
  id: number;
  itemId: string;
  pos: { x: number; z: number };
  /** Only this team can pick it up. */
  team: number;
}

export type ShopKind = 'hero' | 'sabotage';

export interface PurchaseResult {
  ok: boolean;
  reason?: string;
}

export class EconomyModule implements GameModule {
  readonly id = 'economy';
  readonly order = 600;

  private ctx!: GameContext;
  private combat!: CombatService;
  /** Set by the gameplay bundle; sabotage items are launched through it. */
  sabotage: Pick<SabotageModule, 'launch'> | null = null;
  /**
   * Shop positions per team. Each site has its own pair of buildings, and a
   * hero may only trade at its own team's — the rival's shops are on the far
   * side of the map and belong to them.
   */
  private shops: Record<ShopKind, { x: number; z: number }>[] = [];

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.combat = ctx.services.get(CombatKey);
    void ctx.services.get(TerrainKey);

    const issues = validateShops();
    for (const issue of issues) console.error(`[economy] ${issue}`);

    // Team 0 plays the -X half, team 1 the +X half; landmarks are authored
    // once, in mirrored space.
    const t1 = landmark('shopProgression');
    const t2 = landmark('shopSabotage');
    this.shops = [-1, 1].map((sign) => ({
      hero: { x: sign * t1.u, z: t1.v },
      sabotage: { x: sign * t2.u, z: t2.v },
    }));

    const service: EconomyService = {
      addGold: (heroId, amount, reason) => this.addGold(heroId, amount, reason),
      addInfluence: (heroId, amount, reason) => this.addInfluence(heroId, amount, reason),
      canAfford: (heroId, cost, currency) => {
        const hero = ctx.match.heroes.get(heroId);
        if (!hero) return false;
        return (currency === 'gold' ? hero.gold : hero.influence) >= cost;
      },
      buyItem: (heroId, itemId) => this.buy(heroId, itemId).ok,
      sellItem: () => false,
      launchSabotage: (heroId, sabotageId) => this.buy(heroId, sabotageId).ok,
    };
    ctx.services.register(EconomyKey, service);

    // Influence is earned alongside gold rather than instead of it, so playing
    // well funds both economies (GDD §12) and sabotage never competes with the
    // player's own build for the same coin.
    ctx.bus.on('economy:gold', ({ heroId, delta, reason }) => {
      if (reason === 'bounty' && delta > 0) {
        this.addInfluence(heroId, Math.max(1, Math.round(delta * 0.35)), 'bounty');
      }
    });
  }

  /**
   * Which shop the hero can currently use, or null.
   *
   * Physical shops first: standing at a building opens that one even though
   * sabotage is reachable from anywhere, or a player at the sabotage counter
   * could never open the counter they are standing at.
   */
  shopInRange(hero: HeroState | null): ShopKind | null {
    if (!hero || !hero.alive) return null;
    const shops = this.shops[hero.team === 1 ? 1 : 0]!;
    for (const kind of ['hero', 'sabotage'] as ShopKind[]) {
      if (dist2(hero.pos, shops[kind]) <= SHOP_RANGE * SHOP_RANGE) return kind;
    }
    for (const kind of REMOTE_SHOPS) return kind;
    return null;
  }

  /** Whether this particular shop is usable from where the hero stands. */
  canUse(hero: HeroState | null, kind: ShopKind): boolean {
    if (!hero || !hero.alive) return false;
    if (REMOTE_SHOPS.has(kind)) return true;
    const shops = this.shops[hero.team === 1 ? 1 : 0]!;
    return dist2(hero.pos, shops[kind]) <= SHOP_RANGE * SHOP_RANGE;
  }

  /**
   * Items on the ground.
   *
   * A handover to a full inventory does not fail and does not vanish: it
   * lands at the recipient's feet and either hero can take it later. That is
   * the owner's rule, and it is also the only behaviour that cannot lose a
   * player's purchase to a mistimed click.
   */
  readonly drops: Drop[] = [];
  private nextDropId = 1;

  /**
   * Moves gold between two heroes of the same team.
   *
   * No range check: the point of sending gold is that the other hero is
   * somewhere else, on their way to a shop.
   */
  giveGold(fromId: EntityId, toId: EntityId, amount: number): { ok: boolean; reason?: string } {
    const from = this.ctx.match.heroes.get(fromId);
    const to = this.ctx.match.heroes.get(toId);
    if (!from || !to) return { ok: false, reason: 'Héroe desconocido' };
    if (from.id === to.id) return { ok: false, reason: 'A ti mismo no' };
    if (from.team !== to.team) return { ok: false, reason: 'No es de tu equipo' };
    if (!to.alive) return { ok: false, reason: 'Está muerto' };
    const give = Math.floor(amount);
    if (!(give > 0)) return { ok: false, reason: 'Cantidad inválida' };
    if (from.gold < give) return { ok: false, reason: 'Oro insuficiente' };
    from.gold -= give;
    to.gold += give;
    this.ctx.bus.emit('ui:notify', {
      text: `Has recibido ${give} de oro`, severity: 'info', heroId: to.id,
    });
    return { ok: true };
  }

  /**
   * Hands one item from `fromId` to `toId`, or drops it at their feet.
   *
   * Books never reach here -- they are consumed at the counter and never
   * enter an inventory -- but the kind is checked anyway, because the rule the
   * owner set is about what MAY be traded and a future consumable could be
   * neither gear nor potion.
   */
  giveItem(fromId: EntityId, toId: EntityId, itemId: string): { ok: boolean; reason?: string } {
    const from = this.ctx.match.heroes.get(fromId);
    const to = this.ctx.match.heroes.get(toId);
    if (!from || !to) return { ok: false, reason: 'Héroe desconocido' };
    if (from.id === to.id) return { ok: false, reason: 'A ti mismo no' };
    if (from.team !== to.team) return { ok: false, reason: 'No es de tu equipo' };
    if (!to.alive) return { ok: false, reason: 'Está muerto' };

    const at = from.items.indexOf(itemId);
    if (at < 0) return { ok: false, reason: 'No lo llevas' };
    const item = findItem(itemId);
    if (!item || (item.kind !== 'gear' && item.kind !== 'potion')) {
      return { ok: false, reason: 'Ese objeto no se puede pasar' };
    }
    if (dist2(from.pos, to.pos) > HANDOVER_RANGE * HANDOVER_RANGE) {
      return { ok: false, reason: 'Está demasiado lejos' };
    }

    from.items.splice(at, 1);
    if (this.canTake(to, itemId)) {
      to.items.push(itemId);
      this.ctx.bus.emit('ui:notify', {
        text: `Has recibido ${item.name}`, severity: 'info', heroId: to.id,
      });
    } else {
      this.drops.push({
        id: this.nextDropId++,
        itemId,
        pos: { x: to.pos.x, z: to.pos.z },
        team: to.team,
      });
      this.ctx.bus.emit('ui:notify', {
        text: `${item.name} ha caído al suelo`, severity: 'warn', heroId: from.id,
      });
    }
    return { ok: true };
  }

  /**
   * Whether this hero stands close enough to take a dropped item.
   *
   * Public so the HUD can light the marker by the same test `pickUp` applies:
   * a marker that invites a click the economy then refuses is a lie, and the
   * only way to be sure it never happens is for there to be one test.
   */
  inReach(hero: HeroState, drop: Drop): boolean {
    return (
      hero.team === drop.team && dist2(hero.pos, drop.pos) <= HANDOVER_RANGE * HANDOVER_RANGE
    );
  }

  /** The display name of an item id, for markers and messages. */
  nameOf(itemId: string): string {
    return findItem(itemId)?.name ?? itemId;
  }

  /** Takes an item off the ground. */
  pickUp(heroId: EntityId, dropId: number): { ok: boolean; reason?: string } {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero || !hero.alive) return { ok: false, reason: 'Sin héroe' };
    const at = this.drops.findIndex((d) => d.id === dropId);
    if (at < 0) return { ok: false, reason: 'Ya no está ahí' };
    const drop = this.drops[at]!;
    if (drop.team !== hero.team) return { ok: false, reason: 'No es de tu equipo' };
    if (dist2(hero.pos, drop.pos) > HANDOVER_RANGE * HANDOVER_RANGE) {
      return { ok: false, reason: 'Acércate al objeto' };
    }
    if (!this.canTake(hero, drop.itemId)) return { ok: false, reason: 'Inventario lleno' };
    this.drops.splice(at, 1);
    hero.items.push(drop.itemId);
    return { ok: true };
  }

  /**
   * Whether one more of `itemId` fits, by the same rules a purchase uses: gear
   * takes a slot, a potion only takes one when it starts a fresh stack.
   */
  private canTake(hero: HeroState, itemId: string): boolean {
    const item = findItem(itemId);
    if (!item) return false;
    if (item.kind === 'gear') {
      if (this.owned(hero, itemId) > 0) return false;
      return this.slotsUsed(hero) < INVENTORY_SLOTS;
    }
    if (item.kind === 'potion') {
      const stack = item.stackSize ?? 1;
      if (this.owned(hero, itemId) % stack !== 0) return true;
      return this.slotsUsed(hero) < INVENTORY_SLOTS;
    }
    return false;
  }

  /**
   * Items on the ground are module state, so they have to be saved.
   *
   * Everything else this module owns lives on the heroes and travels with the
   * match state. A drop does not, and a replay that lost one would diverge the
   * moment somebody picked it up.
   */
  saveState(): unknown {
    return { drops: this.drops, nextDropId: this.nextDropId };
  }

  loadState(state: unknown): void {
    const s = state as { drops?: Drop[]; nextDropId?: number };
    this.drops.length = 0;
    if (s?.drops) this.drops.push(...s.drops);
    this.nextDropId = s?.nextDropId ?? 1;
  }

  /** How many of `itemId` the hero already owns. */
  owned(hero: HeroState, itemId: string): number {
    return hero.items.filter((i) => i === itemId).length;
  }

  /**
   * Inventory slots in use.
   *
   * Gear takes one slot each; potions of the same kind share slots up to their
   * stack size, so four minor healths cost one slot, not four. Books and
   * sabotage actions are consumed on purchase and never occupy anything.
   */
  slotsUsed(hero: HeroState): number {
    const counts = new Map<string, number>();
    for (const id of hero.items) counts.set(id, (counts.get(id) ?? 0) + 1);

    let slots = 0;
    for (const [id, count] of counts) {
      const item = findItem(id);
      if (!item) continue;
      if (item.kind === 'potion') slots += Math.ceil(count / (item.stackSize ?? 1));
      else slots += count;
    }
    return slots;
  }

  /** Inventory contents grouped for display, in insertion order. */
  inventory(hero: HeroState): { item: ShopItem; count: number }[] {
    const order: string[] = [];
    const counts = new Map<string, number>();
    for (const id of hero.items) {
      if (!counts.has(id)) order.push(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const out: { item: ShopItem; count: number }[] = [];
    for (const id of order) {
      const item = findItem(id);
      if (item) out.push({ item, count: counts.get(id)! });
    }
    return out;
  }

  /**
   * Consumes one carried item.
   *
   * Buying a potion used to be the only way to get its effect, which made the
   * inventory a receipt rather than a kit: you could hold five potions and die
   * at full stock. This is the other half — the slot is clickable and drinking
   * removes exactly one from the stack.
   */
  useItem(heroId: EntityId, itemId: string): PurchaseResult {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero) return { ok: false, reason: 'Sin héroe' };
    if (!hero.alive) return { ok: false, reason: 'Estás caído' };

    const item = findItem(itemId);
    if (!item) return { ok: false, reason: 'Objeto desconocido' };
    if (item.kind !== 'potion') return { ok: false, reason: 'No se puede usar' };

    const index = hero.items.indexOf(itemId);
    if (index < 0) return { ok: false, reason: 'No lo llevas' };

    // Refuse a no-op rather than spending the potion: drinking a health potion
    // at full health is a misclick, not a decision.
    const needsHealth = (item.restore?.health ?? 0) > 0 && hero.health < hero.stats.maxHealth;
    const needsMana = (item.restore?.mana ?? 0) > 0 && hero.mana < hero.stats.maxMana;
    if (!needsHealth && !needsMana) return { ok: false, reason: 'Ya estás al máximo' };

    hero.items.splice(index, 1);
    this.applyItem(hero, item);
    this.ctx.bus.emit('hero:itemUsed', { id: heroId, itemId });
    this.ctx.bus.emit('ui:notify', { text: `Usado: ${item.name}`, severity: 'info', heroId });
    return { ok: true };
  }

  buy(heroId: EntityId, itemId: string): PurchaseResult {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero) return { ok: false, reason: 'Sin héroe' };

    const item = findItem(itemId);
    if (!item) return { ok: false, reason: 'Objeto desconocido' };

    const kind: ShopKind = item.currency === 'gold' ? 'hero' : 'sabotage';
    if (!this.canUse(hero, kind)) {
      return { ok: false, reason: 'Acércate a la tienda' };
    }

    // Gear is unique. Potions stack but still need a free slot when the current
    // stack is full. Books and sabotage actions are consumed on purchase, so
    // they need neither.
    if (item.kind === 'gear') {
      if (this.owned(hero, itemId) > 0) return { ok: false, reason: 'Ya lo tienes' };
      if (this.slotsUsed(hero) >= INVENTORY_SLOTS) {
        return { ok: false, reason: 'Inventario lleno' };
      }
    } else if (item.kind === 'potion') {
      const held = this.owned(hero, itemId);
      const stack = item.stackSize ?? 1;
      const startsNewSlot = held % stack === 0;
      if (startsNewSlot && this.slotsUsed(hero) >= INVENTORY_SLOTS) {
        return { ok: false, reason: 'Inventario lleno' };
      }
    }

    const purse = item.currency === 'gold' ? hero.gold : hero.influence;
    if (purse < item.cost) {
      return { ok: false, reason: item.currency === 'gold' ? 'Oro insuficiente' : 'Influencia insuficiente' };
    }

    // A sabotage fires before it is paid for, so one that cannot land (no
    // rival left standing) costs nothing.
    if (item.kind === 'action') {
      const launched = this.sabotage?.launch(heroId, itemId) ?? { ok: false, reason: 'Sabotaje no disponible' };
      if (!launched.ok) return launched;
    }

    if (item.currency === 'gold') hero.gold -= item.cost;
    else hero.influence -= item.cost;

    // Books and sabotage actions resolve immediately and are never stored.
    if (item.kind === 'gear' || item.kind === 'potion') hero.items.push(itemId);
    this.applyItem(hero, item);
    if (item.experience) {
      this.ctx.bus.emit('hero:xp', { id: heroId, amount: item.experience, total: hero.xp });
    }

    this.ctx.bus.emit('hero:itemBought', { id: heroId, itemId, cost: item.cost });
    // The sabotage announces itself; "Comprado: Frenesí" on top would say it twice.
    if (item.kind !== 'action') {
      this.ctx.bus.emit('ui:notify', { text: `Comprado: ${item.name}`, severity: 'reward', heroId });
    }
    return { ok: true };
  }

  /**
   * Applies an item's modifiers.
   *
   * Health and mana are topped up by the same amount the maximum grew, so buying
   * a health item mid-wave is an immediate benefit rather than a bigger empty
   * bar — the alternative punishes buying at exactly the moment you need it.
   */
  private applyItem(hero: HeroState, item: ShopItem): void {
    // Potions restore immediately and change no stats. They are bought for the
    // inventory, but drinking is the point, so a purchase made while hurt takes
    // effect at once rather than sitting in a slot.
    if (item.restore) {
      if (item.restore.health) {
        hero.health = Math.min(
          hero.stats.maxHealth,
          hero.health + hero.stats.maxHealth * item.restore.health,
        );
      }
      if (item.restore.mana) {
        hero.mana = Math.min(
          hero.stats.maxMana,
          hero.mana + hero.stats.maxMana * item.restore.mana,
        );
      }
      return;
    }

    const beforeHealth = hero.stats.maxHealth;
    const beforeMana = hero.stats.maxMana;

    for (const mod of item.modifiers) hero.modifiers.push({ ...mod });
    this.combat.recomputeStats(hero);

    hero.health += Math.max(0, hero.stats.maxHealth - beforeHealth);
    hero.mana += Math.max(0, hero.stats.maxMana - beforeMana);
    hero.health = Math.min(hero.health, hero.stats.maxHealth);
    hero.mana = Math.min(hero.mana, hero.stats.maxMana);
  }

  private addGold(heroId: EntityId, amount: number, reason: string): void {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero) return;
    hero.gold = Math.max(0, hero.gold + amount);
    this.ctx.bus.emit('economy:gold', { heroId, delta: amount, total: hero.gold, reason });
  }

  private addInfluence(heroId: EntityId, amount: number, reason: string): void {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero) return;
    hero.influence = Math.max(0, hero.influence + amount);
    this.ctx.bus.emit('economy:influence', {
      heroId,
      delta: amount,
      total: hero.influence,
      reason,
    });
  }
}
