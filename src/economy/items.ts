/**
 * Shop inventory. Owner: ECONOMY.
 *
 * Two shops, two currencies, two purposes (GDD §11–12):
 *
 * - **T1, the hero shop**, spends gold on the buyer's own power.
 * - **T2, the sabotage shop**, spends influence on hurting the other side.
 *
 * Keeping them on separate currencies is the point of the split: if sabotage
 * competed with your own build for the same gold, every offensive play would be
 * a straight self-nerf and nobody would ever use the shop.
 *
 * Everything here is data. Balance passes edit numbers; no code changes.
 */

import type { StatModifier } from '@/core/contracts';
import type { IconId } from '@/ui/icons';

/**
 * What an entry does when bought.
 *
 * - `gear` — a unique permanent item. Occupies one inventory slot, and a hero
 *   may own exactly one. Buying a second is refused.
 * - `potion` — a consumable. Stacks inside a single slot up to `stackSize`.
 * - `book` — consumed the instant it is bought: it grants its effect and never
 *   enters the inventory, so it costs no slot and has no ownership limit.
 * - `action` — a sabotage. Fires immediately, never stored, always repeatable.
 */
export type ItemKind = 'gear' | 'potion' | 'book' | 'action';

export interface ShopItem {
  id: string;
  name: string;
  description: string;
  icon: IconId;
  kind: ItemKind;
  cost: number;
  currency: 'gold' | 'influence';
  /** Tier gates what appears in the shop as the match progresses. */
  tier: number;
  /** Permanent stat changes applied on purchase. Empty for potions. */
  modifiers: StatModifier[];
  /** Potions only: how many fit in one inventory slot. */
  stackSize?: number;
  /** Potions only: instant restoration, as a fraction of the maximum. */
  restore?: { health?: number; mana?: number };
  /** Books only: experience granted on use. */
  experience?: number;
}

/** Inventory slots per hero. Fixed by design. */
export const INVENTORY_SLOTS = 9;

/**
 * Hero shop — gold.
 *
 * The curve is deliberately shallow at tier 1 so the first waves' income buys
 * something immediately; a shop you cannot afford until wave 8 may as well not
 * exist for the opening of the match.
 */
export const HERO_ITEMS: ShopItem[] = [
  {
    id: 'item.whetstone',
    name: 'Piedra de amolar',
    description: '+6 de daño de ataque.',
    icon: 'shield-bash',
    cost: 120,
    currency: 'gold',
    tier: 1,
    modifiers: [{ stat: 'attackDamage', op: 'flat', value: 6, sourceId: 'item.whetstone' }],
    kind: 'gear',
  },
  {
    // Attack speed had no item at all: every damage route was flat power, so a
    // hero could not trade burst for sustained output. Multiplicative because
    // attack speed is a rate — a flat +0.2 would be a 20 % gain on a slow hero
    // and a 60 % gain on a fast one.
    id: 'item.hunterGloves',
    name: 'Guantes del cazador',
    description: '+18 % de velocidad de ataque.',
    icon: 'bolt',
    cost: 175,
    currency: 'gold',
    tier: 1,
    modifiers: [{ stat: 'attackSpeed', op: 'pct', value: 0.18, sourceId: 'item.hunterGloves' }],
    kind: 'gear',
  },
  {
    id: 'item.ironPlate',
    name: 'Placa de hierro',
    description: '+70 de vida máxima y +3 de armadura.',
    icon: 'bulwark-wall',
    cost: 150,
    currency: 'gold',
    tier: 1,
    modifiers: [
      { stat: 'maxHealth', op: 'flat', value: 70, sourceId: 'item.ironPlate' },
      { stat: 'armor', op: 'flat', value: 3, sourceId: 'item.ironPlate' },
    ],
    kind: 'gear',
  },
  {
    id: 'item.runeFocus',
    name: 'Foco rúnico',
    description: '+10 de poder de hechizo y +40 de maná.',
    icon: 'arrow',
    cost: 140,
    currency: 'gold',
    tier: 1,
    modifiers: [
      { stat: 'spellPower', op: 'flat', value: 10, sourceId: 'item.runeFocus' },
      { stat: 'maxMana', op: 'flat', value: 40, sourceId: 'item.runeFocus' },
    ],
    kind: 'gear',
  },
  {
    id: 'item.swiftBoots',
    name: 'Botas veloces',
    description: '+8 % de velocidad de movimiento.',
    icon: 'anchor-shout',
    cost: 200,
    currency: 'gold',
    tier: 1,
    modifiers: [{ stat: 'moveSpeed', op: 'pct', value: 0.08, sourceId: 'item.swiftBoots' }],
    kind: 'gear',
  },
  {
    id: 'item.duelistEdge',
    name: 'Filo del duelista',
    description: '+10 % de probabilidad de crítico y +0,15 de velocidad de ataque.',
    icon: 'shield-bash',
    cost: 420,
    currency: 'gold',
    tier: 2,
    modifiers: [
      { stat: 'critChance', op: 'flat', value: 0.1, sourceId: 'item.duelistEdge' },
      { stat: 'attackSpeed', op: 'flat', value: 0.15, sourceId: 'item.duelistEdge' },
    ],
    kind: 'gear',
  },
  {
    id: 'item.lifedrinker',
    name: 'Bebedor de vida',
    description: '+12 % de robo de vida.',
    icon: 'heal',
    cost: 480,
    currency: 'gold',
    tier: 2,
    modifiers: [{ stat: 'lifesteal', op: 'flat', value: 0.12, sourceId: 'item.lifedrinker' }],
    kind: 'gear',
  },
  {
    id: 'item.wardingSigil',
    name: 'Sigilo de guarda',
    description: '+15 % de resistencia mágica y +2,5 de regeneración.',
    icon: 'frost',
    cost: 460,
    currency: 'gold',
    tier: 2,
    modifiers: [
      { stat: 'magicResist', op: 'flat', value: 0.15, sourceId: 'item.wardingSigil' },
      { stat: 'healthRegen', op: 'flat', value: 2.5, sourceId: 'item.wardingSigil' },
    ],
    kind: 'gear',
  },
  {
    id: 'item.crownOfHours',
    name: 'Corona de las horas',
    description: '+18 % de reducción de enfriamiento.',
    icon: 'unbroken',
    cost: 900,
    currency: 'gold',
    tier: 3,
    modifiers: [
      { stat: 'cooldownReduction', op: 'flat', value: 0.18, sourceId: 'item.crownOfHours' },
    ],
    kind: 'gear',
  },
  {
    id: 'item.titansHeart',
    name: 'Corazón de titán',
    description: '+18 % de vida máxima y +10 de armadura.',
    icon: 'bulwark-wall',
    cost: 1100,
    currency: 'gold',
    tier: 3,
    modifiers: [
      { stat: 'maxHealth', op: 'pct', value: 0.18, sourceId: 'item.titansHeart' },
      { stat: 'armor', op: 'flat', value: 10, sourceId: 'item.titansHeart' },
    ],
    kind: 'gear',
  },
];

/**
 * Consumables and books.
 *
 * Potions stack inside one slot, so carrying four minor healths costs a single
 * slot rather than four — which is what makes a nine-slot inventory workable
 * alongside seven pieces of gear.
 *
 * Books never enter the inventory at all: they are read on purchase. That is
 * what lets attribute growth be a gold sink without competing for the slots a
 * build needs, and it is why they have no ownership limit.
 */
export const CONSUMABLE_ITEMS: ShopItem[] = [
  {
    id: 'potion.healthMinor',
    name: 'Poción de vida menor',
    description: 'Restaura un 25 % de la vida al instante.',
    icon: 'heal',
    kind: 'potion',
    cost: 50,
    currency: 'gold',
    tier: 1,
    modifiers: [],
    stackSize: 5,
    restore: { health: 0.25 },
  },
  {
    id: 'potion.healthGreater',
    name: 'Poción de vida mayor',
    description: 'Restaura un 45 % de la vida al instante.',
    icon: 'heal',
    kind: 'potion',
    cost: 120,
    currency: 'gold',
    tier: 2,
    modifiers: [],
    stackSize: 5,
    restore: { health: 0.45 },
  },
  {
    id: 'potion.healthSupreme',
    name: 'Poción de vida suprema',
    description: 'Restaura un 75 % de la vida al instante.',
    icon: 'heal',
    kind: 'potion',
    cost: 260,
    currency: 'gold',
    tier: 3,
    modifiers: [],
    stackSize: 5,
    restore: { health: 0.75 },
  },
  {
    id: 'potion.manaMinor',
    name: 'Poción de maná menor',
    description: 'Restaura un 25 % del maná al instante.',
    icon: 'frost',
    kind: 'potion',
    cost: 50,
    currency: 'gold',
    tier: 1,
    modifiers: [],
    stackSize: 5,
    restore: { mana: 0.25 },
  },
  {
    id: 'potion.manaGreater',
    name: 'Poción de maná mayor',
    description: 'Restaura un 45 % del maná al instante.',
    icon: 'frost',
    kind: 'potion',
    cost: 120,
    currency: 'gold',
    tier: 2,
    modifiers: [],
    stackSize: 5,
    restore: { mana: 0.45 },
  },
  {
    id: 'potion.manaSuperior',
    name: 'Poción de maná superior',
    description: 'Restaura un 75 % del maná al instante.',
    icon: 'frost',
    kind: 'potion',
    cost: 260,
    currency: 'gold',
    tier: 3,
    modifiers: [],
    stackSize: 5,
    restore: { mana: 0.75 },
  },
  {
    id: 'book.power',
    name: 'Tratado de poder',
    description: 'Permanente: +4 daño de ataque y +6 poder de hechizo.',
    icon: 'shield-bash',
    kind: 'book',
    cost: 340,
    currency: 'gold',
    tier: 1,
    modifiers: [
      { stat: 'attackDamage', op: 'flat', value: 4, sourceId: 'book.power' },
      { stat: 'spellPower', op: 'flat', value: 6, sourceId: 'book.power' },
    ],
  },
  {
    id: 'book.vitality',
    name: 'Tratado de vitalidad',
    description: 'Permanente: +55 vida máxima y +2 armadura.',
    icon: 'bulwark-wall',
    kind: 'book',
    cost: 340,
    currency: 'gold',
    tier: 1,
    modifiers: [
      { stat: 'maxHealth', op: 'flat', value: 55, sourceId: 'book.vitality' },
      { stat: 'armor', op: 'flat', value: 2, sourceId: 'book.vitality' },
    ],
  },
  {
    id: 'book.focus',
    name: 'Tratado de concentración',
    description: 'Permanente: +35 maná máximo y +1,2 regeneración de maná.',
    icon: 'arrow',
    kind: 'book',
    cost: 340,
    currency: 'gold',
    tier: 1,
    modifiers: [
      { stat: 'maxMana', op: 'flat', value: 35, sourceId: 'book.focus' },
      { stat: 'manaRegen', op: 'flat', value: 1.2, sourceId: 'book.focus' },
    ],
  },
  {
    id: 'book.reach',
    name: 'Tratado de destreza',
    description: 'Permanente: +6 % velocidad de ataque y +8 % alcance (hasta el tope de alcance).',
    icon: 'arrow',
    kind: 'book',
    // Dearer than the other three. They buy a flat number; this one buys a
    // percentage, so it is worth more to a hero who has already invested in the
    // same axis, and the attack speed compounds with everything else.
    cost: 420,
    currency: 'gold',
    tier: 1,
    modifiers: [
      { stat: 'attackSpeed', op: 'pct', value: 0.06, sourceId: 'book.reach' },
      { stat: 'attackRange', op: 'pct', value: 0.08, sourceId: 'book.reach' },
    ],
  },
  {
    id: 'book.experience',
    name: 'Tomo de experiencia',
    description: 'Otorga 600 de experiencia.',
    icon: 'unbroken',
    kind: 'book',
    cost: 400,
    currency: 'gold',
    tier: 2,
    modifiers: [],
    experience: 600,
  },
];

/**
 * Sabotage shop — influence.
 *
 * Every entry must have counterplay (GDD §11); the field is not decoration, and
 * `validateShops()` fails the build if one is missing. A sabotage the victim
 * cannot answer is not tension, it is just damage.
 */
export interface SabotageItem extends ShopItem {
  counterplay: string;
}

export const SABOTAGE_ITEMS: SabotageItem[] = [
  {
    id: 'sab.reinforcements',
    name: 'Refuerzos',
    description: 'Envía 4 enemigos más, del tipo de la oleada actual, contra el Núcleo del rival.',
    counterplay: 'Llegan por el mismo carril: se pueden interceptar en el cuello de botella.',
    icon: 'anchor-shout',
    cost: 120,
    currency: 'influence',
    tier: 1,
    modifiers: [],
    kind: 'action',
  },
  {
    id: 'sab.frenzy',
    name: 'Frenesí',
    description: 'Los enemigos del rival se mueven un 25 % más rápido durante 20 s, también los que aparezcan entretanto.',
    counterplay: 'Menos tiempo de reacción, pero también llegan separados y sin apoyo.',
    icon: 'frost',
    cost: 180,
    currency: 'influence',
    tier: 1,
    modifiers: [],
    kind: 'action',
  },
  {
    id: 'sab.elite',
    name: 'Invocar élite',
    description:
      'El enemigo más fuerte del rival se vuelve élite: triple de vida, +50 % de daño y +6 de armadura. Si no hay ninguno, lo será el siguiente en aparecer.',
    counterplay: 'Un solo objetivo de alto valor: concentrar daño lo derriba antes.',
    icon: 'unbroken',
    cost: 340,
    currency: 'influence',
    tier: 2,
    modifiers: [],
    kind: 'action',
  },
  {
    id: 'sab.hex',
    name: 'Maleficio',
    description: 'El daño y el poder de hechizo del héroe rival bajan un 20 % durante 15 s.',
    counterplay: 'Dura poco: retirarse a la fuente y volver lo agota.',
    icon: 'flame',
    cost: 260,
    currency: 'influence',
    tier: 2,
    modifiers: [],
    kind: 'action',
  },
];

/** Everything the hero shop sells: gear first, then consumables and books. */
export const T1_STOCK: ShopItem[] = [...HERO_ITEMS, ...CONSUMABLE_ITEMS];

/** Every purchasable, for lookup by id. */
export const ALL_ITEMS: ShopItem[] = [...T1_STOCK, ...SABOTAGE_ITEMS];

export function findItem(id: string): ShopItem | undefined {
  return ALL_ITEMS.find((i) => i.id === id);
}

/**
 * Content validation, run at boot.
 *
 * Catches the failure modes that are invisible until a player hits them: a
 * duplicate id silently shadowing another item, a free item, a sabotage with no
 * documented counterplay.
 */
export function validateShops(): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const item of ALL_ITEMS) {
    if (seen.has(item.id)) issues.push(`duplicate item id: ${item.id}`);
    seen.add(item.id);
    if (item.cost <= 0) issues.push(`${item.id}: cost must be positive`);
    if (item.kind === 'potion' && !(item.stackSize && item.stackSize > 0)) {
      issues.push(`${item.id}: a potion needs a positive stackSize`);
    }
    if (item.kind === 'potion' && !item.restore) {
      issues.push(`${item.id}: a potion needs a restore effect`);
    }
    if (item.kind === 'book' && item.modifiers.length === 0 && !item.experience) {
      issues.push(`${item.id}: a book must grant something`);
    }
  }
  for (const item of SABOTAGE_ITEMS) {
    if (!item.counterplay?.trim()) {
      issues.push(`${item.id}: sabotage without counterplay (GDD §11)`);
    }
  }
  return issues;
}
