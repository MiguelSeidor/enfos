/**
 * Hero progression. Owner: GAMEPLAY. Module order 610.
 *
 * Turns levels into choices. Levelling already happens in `MatchModule`; this
 * owns what the player *does* with a level.
 *
 * ## Why attributes rather than a new skill every level
 *
 * The GDD is explicit that there is no level cap (§9) and equally explicit that
 * a new ability every level is not required (§9, "No es necesario desbloquear
 * una skill nueva en cada nivel"). Attributes are the shape that survives
 * unbounded levels: they keep giving the player a decision at level 300 without
 * demanding 300 hand-authored abilities.
 *
 * Growth per point is constant, but the *stat curves* it feeds are not — armour
 * runs through `armorMitigation` and resistances through soft caps, so raw
 * points never turn into raw immunity. That is the "diminishing returns" the GDD
 * asks for, applied where it belongs: in the stat, not in the reward.
 */

import type { EntityId, GameContext, GameModule, HeroState, StatModifier } from '@/core/contracts';
import { CombatKey, type CombatService } from '@/core/services';

export type AttributeId = 'power' | 'vitality' | 'focus';

export interface AttributeDef {
  id: AttributeId;
  name: string;
  description: string;
  modifiers: StatModifier[];
}

export const ATTRIBUTES: AttributeDef[] = [
  {
    id: 'power',
    name: 'Poder',
    description: '+4 daño de ataque, +6 poder de hechizo',
    modifiers: [
      { stat: 'attackDamage', op: 'flat', value: 4, sourceId: 'attr.power' },
      { stat: 'spellPower', op: 'flat', value: 6, sourceId: 'attr.power' },
    ],
  },
  {
    id: 'vitality',
    name: 'Vitalidad',
    description: '+55 vida máxima, +2 armadura',
    modifiers: [
      { stat: 'maxHealth', op: 'flat', value: 55, sourceId: 'attr.vitality' },
      { stat: 'armor', op: 'flat', value: 2, sourceId: 'attr.vitality' },
    ],
  },
  {
    id: 'focus',
    name: 'Concentración',
    description: '+35 maná máximo, +1,2 regeneración de maná',
    modifiers: [
      { stat: 'maxMana', op: 'flat', value: 35, sourceId: 'attr.focus' },
      { stat: 'manaRegen', op: 'flat', value: 1.2, sourceId: 'attr.focus' },
    ],
  },
];

/**
 * Points granted per level, plus a bonus on milestones.
 *
 * Which levels count as milestones is decided by `MatchModule` (every fifth)
 * and arrives on the `hero:levelUp` event, so the rule lives in one place
 * rather than being duplicated — and re-derived slightly differently — here.
 */
const POINTS_PER_LEVEL = 1;
const MILESTONE_BONUS = 2;

export class ProgressionModule implements GameModule {
  readonly id = 'progression';
  readonly order = 610;

  private ctx!: GameContext;
  private combat!: CombatService;
  /** Unspent points and the spend history, per hero. */
  private readonly points = new Map<EntityId, number>();
  private readonly spent = new Map<EntityId, Record<AttributeId, number>>();

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.combat = ctx.services.get(CombatKey);

    ctx.bus.on('hero:levelUp', ({ id, level, milestone }) => {
      const gain = POINTS_PER_LEVEL + (milestone ? MILESTONE_BONUS : 0);
      this.points.set(id, (this.points.get(id) ?? 0) + gain);
      ctx.bus.emit('ui:notify', {
        text: milestone
          ? `Nivel ${level} — hito: ${gain} puntos`
          : `Nivel ${level} — ${gain} punto`,
        severity: 'reward',
        heroId: id,
      });
    });
  }

  unspent(heroId: EntityId): number {
    return this.points.get(heroId) ?? 0;
  }

  allocated(heroId: EntityId): Record<AttributeId, number> {
    return this.spent.get(heroId) ?? { power: 0, vitality: 0, focus: 0 };
  }

  /**
   * Spends one point. Returns false when there is nothing to spend, so the UI
   * can stay a thin view over this rather than tracking its own count.
   */
  spend(heroId: EntityId, attribute: AttributeId): boolean {
    const available = this.points.get(heroId) ?? 0;
    if (available <= 0) return false;

    const hero = this.ctx.match.heroes.get(heroId);
    if (!hero) return false;

    const def = ATTRIBUTES.find((a) => a.id === attribute);
    if (!def) return false;

    this.points.set(heroId, available - 1);
    const tally = this.spent.get(heroId) ?? { power: 0, vitality: 0, focus: 0 };
    tally[attribute]++;
    this.spent.set(heroId, tally);

    this.applyAttribute(hero, def);
    this.ctx.bus.emit('ui:notify', { text: `+1 ${def.name}`, severity: 'reward', heroId });
    return true;
  }

  /**
   * Pushes the modifiers and tops up the pools by the amount the maxima grew.
   *
   * Same rule the shop uses: spending a point on vitality mid-fight has to be
   * an immediate benefit, not a longer empty bar.
   */
  private applyAttribute(hero: HeroState, def: AttributeDef): void {
    const beforeHealth = hero.stats.maxHealth;
    const beforeMana = hero.stats.maxMana;

    for (const mod of def.modifiers) hero.modifiers.push({ ...mod });
    this.combat.recomputeStats(hero);

    hero.health = Math.min(
      hero.stats.maxHealth,
      hero.health + Math.max(0, hero.stats.maxHealth - beforeHealth),
    );
    hero.mana = Math.min(
      hero.stats.maxMana,
      hero.mana + Math.max(0, hero.stats.maxMana - beforeMana),
    );
  }

  saveState(): unknown {
    return { points: this.points, spent: this.spent };
  }

  loadState(state: unknown): void {
    const s = state as { points: Map<EntityId, number>; spent: Map<EntityId, Record<AttributeId, number>> };
    this.points.clear();
    for (const [id, n] of s.points) this.points.set(id, n);
    this.spent.clear();
    for (const [id, tally] of s.spent) this.spent.set(id, tally);
  }

  dispose(): void {
    this.points.clear();
    this.spent.clear();
  }
}
