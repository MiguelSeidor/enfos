/**
 * Player invocations: powers that belong to the player, not to the hero.
 * Owner: GAMEPLAY.
 *
 * Order 250: before movement, so a freeze that lands this tick is already in
 * force when the creeps it freezes would have stepped.
 *
 * These sit apart from `abilities.ts` on purpose. A hero ability is part of a
 * kit, costs mana, scales with the hero and is one of four the player picked by
 * choosing that hero. These are bought with gold, every hero has the same two,
 * and they answer situations the kit cannot: a wave that arrived while you were
 * at the fountain, and an enemy you are not allowed to see.
 *
 * ## Why the effects live in `units.ts`
 *
 * Both of them change how OTHER modules behave -- movement must not step a
 * frozen creep, combat must not swing for it, and target acquisition must stop
 * hiding a concealed one. Those modules already import `units.ts` and it
 * already owns the per-unit runtime, so the flags go there and this module only
 * decides when to set them. The alternative, every module importing this one,
 * is a cycle: this module needs `runtimeOf` to know which site a creep belongs
 * to.
 */

import type { EntityId, GameContext, GameModule } from '@/core/contracts';
import { EconomyKey, type EconomyService } from '@/core/services';
import { SIM_HZ } from '@/core/engine';
import { freezeSite, grantTrueSight, siteFrozenUntil, trueSightUntil } from './units';

export type InvocationId = 'stopTime' | 'trueSight';

export interface InvocationDef {
  id: InvocationId;
  name: string;
  /** Inline-SVG glyph, used until the painted plate exists. */
  icon: 'frost' | 'eye';
  /**
   * Keyboard letter. Z and X because every other comfortable key is taken --
   * QWER are the kit, A, S and H are orders, F centres the camera -- and
   * because these sit beside the kit in the card and should read as part of the
   * same row of things you press, not as a menu.
   */
  key: string;
  description: string;
  /** Gold. Both are deliberately affordable: they are answers, not luxuries. */
  cost: number;
  /** Seconds before it can be used again. */
  cooldown: number;
  /** Seconds the effect lasts. */
  duration: number;
}

export const INVOCATIONS: Record<InvocationId, InvocationDef> = {
  stopTime: {
    id: 'stopTime',
    name: 'Parar el tiempo',
    icon: 'frost',
    key: 'Z',
    description:
      'Congela durante 60 s a todos los enemigos de tu línea. No detiene el contador de oleadas, ni afecta a la línea del rival.',
    cost: 250,
    cooldown: 300,
    duration: 60,
  },
  trueSight: {
    id: 'trueSight',
    name: 'Ver lo invisible',
    icon: 'eye',
    key: 'X',
    description:
      'Durante 45 s ves y puedes fijar como objetivo a las criaturas ocultas de toda tu línea.',
    // Cheaper and shorter than stopping time, because it answers one creep
    // rather than a whole wave.
    cost: 150,
    cooldown: 300,
    // Not the five minutes first sketched: with a five minute window and a five
    // minute cooldown the effect is simply always on, and a concealment nobody
    // ever experiences is not a mechanic. Three quarters of a minute is long
    // enough to clear an ambush and short enough that the choice of WHEN is the
    // interesting part.
    duration: 45,
  },
};

export const INVOCATION_IDS = Object.keys(INVOCATIONS) as InvocationId[];

export function isInvocationId(value: unknown): value is InvocationId {
  return typeof value === 'string' && value in INVOCATIONS;
}

/** What the HUD needs to draw one button. */
export interface InvocationStatus {
  id: InvocationId;
  name: string;
  icon: 'frost' | 'eye';
  key: string;
  description: string;
  cost: number;
  /** Seconds left on the cooldown; 0 when ready. */
  cooldownLeft: number;
  /** Seconds left on the effect; 0 when it is not running. */
  activeLeft: number;
  affordable: boolean;
}

interface HeroState {
  readyAtTick: Record<InvocationId, number>;
}

export class InvocationModule implements GameModule {
  readonly id = 'invocations';
  readonly order = 250;

  private ctx!: GameContext;
  private economy!: EconomyService;
  private readonly byHero = new Map<EntityId, HeroState>();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.economy = ctx.services.get(EconomyKey);
  }

  saveState(): unknown {
    // The effect deadlines belong to the save as much as the cooldowns do: a
    // client that joins or rewinds mid-freeze has to know the creeps are still
    // frozen, or it will step them and desync.
    return {
      byHero: [...this.byHero.entries()],
      frozen: [...siteFrozenUntil().entries()],
      sight: [...trueSightUntil().entries()],
    };
  }

  loadState(state: unknown): void {
    const s = state as {
      byHero: [EntityId, HeroState][];
      frozen: [number, number][];
      sight: [number, number][];
    };
    this.byHero.clear();
    for (const [id, v] of s.byHero) this.byHero.set(id, v);
    siteFrozenUntil().clear();
    for (const [team, tick] of s.frozen) siteFrozenUntil().set(team, tick);
    trueSightUntil().clear();
    for (const [team, tick] of s.sight) trueSightUntil().set(team, tick);
  }

  fixedUpdate(): void {
    // Nothing to tick. Both effects and both cooldowns are deadlines compared
    // against `ctx.clock.tick`, so they expire by being in the past rather than
    // by being counted down, which is one less thing to keep in sync.
  }

  /** Seconds left, for the HUD. Negative deadlines read as zero. */
  private secondsLeft(tick: number): number {
    return Math.max(0, (tick - this.ctx.clock.tick) / SIM_HZ);
  }

  status(heroId: EntityId): InvocationStatus[] {
    const hero = this.ctx.match.heroes.get(heroId);
    const state = this.byHero.get(heroId);
    const team = hero?.team ?? -1;
    return INVOCATION_IDS.map((id) => {
      const def = INVOCATIONS[id];
      const activeUntil =
        id === 'stopTime' ? (siteFrozenUntil().get(team) ?? 0) : (trueSightUntil().get(team) ?? 0);
      return {
        id,
        name: def.name,
        icon: def.icon,
        key: def.key,
        description: def.description,
        cost: def.cost,
        cooldownLeft: this.secondsLeft(state?.readyAtTick[id] ?? 0),
        activeLeft: this.secondsLeft(activeUntil),
        affordable: (hero?.gold ?? 0) >= def.cost,
      };
    });
  }

  /**
   * Spend and fire. Returns a reason when it refuses, which the HUD shows: a
   * button that does nothing and says nothing reads as a bug.
   */
  invoke(heroId: EntityId, id: InvocationId): { ok: boolean; reason?: string } {
    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero) return { ok: false, reason: 'Sin héroe' };
    if (!hero.alive) return { ok: false, reason: 'Estás caído' };

    const def = INVOCATIONS[id];
    const state =
      this.byHero.get(heroId) ?? { readyAtTick: { stopTime: 0, trueSight: 0 } as Record<InvocationId, number> };
    const tick = this.ctx.clock.tick;
    if (state.readyAtTick[id] > tick) {
      return { ok: false, reason: `Aún no, faltan ${Math.ceil(this.secondsLeft(state.readyAtTick[id]))} s` };
    }
    if (hero.gold < def.cost) return { ok: false, reason: 'Oro insuficiente' };

    this.economy.addGold(heroId, -def.cost, `invocación: ${def.name}`);
    state.readyAtTick[id] = tick + Math.round(def.cooldown * SIM_HZ);
    this.byHero.set(heroId, state);

    const until = tick + Math.round(def.duration * SIM_HZ);
    if (id === 'stopTime') freezeSite(hero.team, until);
    else grantTrueSight(hero.team, until);

    this.ctx.bus.emit('ui:notify', { text: def.name, severity: 'info', heroId });
    return { ok: true };
  }
}
