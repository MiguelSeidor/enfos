/**
 * Gameplay content definitions. Owner: GAMEPLAY.
 *
 * Maps the character catalog (which owns how a unit *looks*) onto stat blocks,
 * behaviour and bounty (which own how it *plays*). The split is deliberate: an
 * art pass never touches balance, and a balance pass never touches art.
 *
 * Numbers here are first-pass and meant to be tuned by simulation, not by
 * intuition. They are data, so a balance worker can rewrite them wholesale.
 */

import type { StatBlock, StatModifier } from '@/core/contracts';

/**
 * Global multiplier on every enemy's move speed, applied at spawn.
 *
 * The route measures 292 world units. At the raw speeds a base creep covered it
 * in about 52 s, which played as a rush: the wave was on the Core before the
 * player had finished dealing with the previous one. 0.62 puts a creep at
 * roughly 84 s on the road (measured, not estimated).
 *
 * Kept as one dial rather than edited into every definition, so a balance pass
 * tunes pacing in a single place without touching relative speeds between
 * archetypes — a duskrunner still outruns a bastion by the same factor.
 */
export const ENEMY_SPEED_SCALE = 0.62;

/** Baseline every stat block starts from, so definitions only state deltas. */
export const BASE_STATS: StatBlock = {
  maxHealth: 100,
  healthRegen: 0,
  maxMana: 0,
  manaRegen: 0,
  attackDamage: 10,
  attackSpeed: 1,
  attackRange: 2.2,
  critChance: 0,
  critMultiplier: 2,
  spellPower: 0,
  cooldownReduction: 0,
  castSpeed: 1,
  armor: 0,
  magicResist: 0,
  moveSpeed: 6,
  evasion: 0,
  lifesteal: 0,
  spellVamp: 0,
  tenacity: 0,
};

export function stats(over: Partial<StatBlock>): StatBlock {
  return { ...BASE_STATS, ...over };
}

export type EnemyBehavior =
  /** Walks the lane to the Core, only stopping to hit what blocks it. */
  | 'marcher'
  /** Breaks off the lane to chase the nearest hero. */
  | 'hunter'
  /** Holds at max range and shoots. */
  | 'skirmisher'
  /** Slow, high health, ignores heroes entirely — a Core threat. */
  | 'siege';

/**
 * Optional abilities that change how a creep must be *answered*, not just how
 * hard it hits.
 *
 * Kept separate from `behavior` because they compose: a flier can be a marcher
 * or a hunter, and a summoner can be either. Scaling health and damage per wave
 * makes creeps take longer to kill; these make the player change what they do.
 */
export interface EnemyTraits {
  /**
   * Ignores terrain. Rides at a fixed altitude and takes the straight line to
   * its goal, so it bypasses the lane entirely — the one creep that does not
   * respect the corridor the whole map is built around.
   */
  flying?: { altitude: number };
  /**
   * Cannot be auto-acquired and renders faint until it attacks. The hero has to
   * target it deliberately, which punishes attack-move play.
   */
  invisible?: { /** Revealed for this long after it strikes. */ revealSeconds: number };
  /** Periodically spawns minions of another def while alive. */
  summons?: { defId: string; everySeconds: number; count: number; maxAlive: number };
  /** Chance per landed hit to stun the target. */
  stunOnHit?: { chance: number; seconds: number };
}

export interface EnemyDef {
  /** Character id in the units catalog; drives the mesh and animation. */
  characterId: string;
  name: string;
  behavior: EnemyBehavior;
  stats: StatBlock;
  bounty: { gold: number; xp: number };
  /** Wave-composer cost. Higher means fewer of them per budget. */
  cost: number;
  scale: number;
  /** Ranged attackers spawn a projectile instead of striking instantly. */
  ranged?: boolean;
  traits?: EnemyTraits;
}

export const ENEMIES: Record<string, EnemyDef> = {
  cleaver: {
    characterId: 'creep.cleaver',
    name: 'Orco carnicero',
    behavior: 'marcher',
    stats: stats({ maxHealth: 190, attackDamage: 16, attackSpeed: 0.85, moveSpeed: 5.6, armor: 4 }),
    bounty: { gold: 12, xp: 14 },
    cost: 10,
    scale: 1,
  },
  duskrunner: {
    characterId: 'creep.duskrunner',
    name: 'Devorador',
    behavior: 'hunter',
    stats: stats({
      maxHealth: 120,
      attackDamage: 13,
      attackSpeed: 1.5,
      moveSpeed: 9.4,
      armor: 1,
      evasion: 0.08,
    }),
    bounty: { gold: 14, xp: 16 },
    cost: 11,
    scale: 0.95,
  },
  spinebolt: {
    characterId: 'creep.spinebolt',
    name: 'Arquera',
    behavior: 'skirmisher',
    stats: stats({
      maxHealth: 105,
      attackDamage: 18,
      attackSpeed: 0.7,
      attackRange: 13,
      moveSpeed: 5.2,
    }),
    bounty: { gold: 15, xp: 17 },
    cost: 12,
    scale: 0.95,
    ranged: true,
  },
  hexwright: {
    characterId: 'creep.hexwright',
    name: 'Hechicero',
    behavior: 'skirmisher',
    stats: stats({
      maxHealth: 135,
      attackDamage: 26,
      attackSpeed: 0.5,
      attackRange: 15,
      moveSpeed: 4.8,
      magicResist: 0.2,
    }),
    bounty: { gold: 20, xp: 24 },
    cost: 18,
    scale: 1,
    ranged: true,
  },
  bastion: {
    characterId: 'creep.bastion',
    name: 'Ogro',
    behavior: 'siege',
    stats: stats({
      maxHealth: 620,
      attackDamage: 34,
      attackSpeed: 0.5,
      moveSpeed: 3.6,
      armor: 14,
    }),
    bounty: { gold: 34, xp: 40 },
    cost: 32,
    scale: 1.15,
  },

  // ── Trait creeps ──────────────────────────────────────────────────────────
  // Each of these asks a different question of the player. They are costed
  // above their raw stats because the answer is attention, not damage.

  /**
   * Hovers above the lane, seeing and being seen over the ridges.
   *
   * It used to fly straight at the Core and ignore the corridor entirely, which
   * is what made it a repositioning problem rather than a fight. That was cut
   * on 2026-10-04: it asked the player to hold two places at once, and the
   * creature has no art yet, so it arrived invisible. Deliberately fragile —
   * it is a timer, not a fight — and right now that is all it is.
   */
  wraith: {
    characterId: 'creep.stalker',
    name: 'Espectro alado',
    behavior: 'siege',
    stats: stats({
      maxHealth: 210,
      attackDamage: 18,
      attackSpeed: 0.8,
      moveSpeed: 6.2,
      armor: 2,
    }),
    bounty: { gold: 22, xp: 26 },
    cost: 22,
    scale: 0.95,
    traits: { flying: { altitude: 6.5 } },
  },

  /**
   * Unseen until it strikes.
   *
   * Beats attack-move: the hero will not acquire it on its own, so it walks
   * past a distracted player and reaches the Core. Low health so that noticing
   * it is the whole difficulty.
   */
  prowler: {
    characterId: 'creep.stalker',
    name: 'Acechador velado',
    behavior: 'hunter',
    stats: stats({
      maxHealth: 240,
      attackDamage: 22,
      attackSpeed: 1.05,
      moveSpeed: 6.4,
      armor: 3,
    }),
    bounty: { gold: 24, xp: 28 },
    cost: 24,
    scale: 0.95,
    traits: { invisible: { revealSeconds: 2.5 } },
  },

  /**
   * Raises skeletons while it lives.
   *
   * Turns a wave into a priority problem: kill the summoner and the wave
   * shrinks, ignore it and it grows. `maxAlive` caps the swarm so a summoner
   * left alone is a mounting cost, not a runaway one.
   */
  necromancer: {
    characterId: 'creep.cleaver',
    name: 'Nigromante',
    behavior: 'skirmisher',
    stats: stats({
      maxHealth: 300,
      attackDamage: 14,
      attackSpeed: 0.7,
      moveSpeed: 4.8,
      armor: 5,
      attackRange: 9,
    }),
    bounty: { gold: 30, xp: 36 },
    cost: 30,
    scale: 1.05,
    ranged: true,
    traits: { summons: { defId: 'skeleton', everySeconds: 6, count: 2, maxAlive: 6 } },
  },

  /** The summoner's product. Cheap, weak, and never composed into a wave. */
  skeleton: {
    characterId: 'creep.cleaver',
    name: 'Esqueleto',
    behavior: 'marcher',
    stats: stats({
      maxHealth: 90,
      attackDamage: 9,
      attackSpeed: 1,
      moveSpeed: 5.8,
      armor: 0,
    }),
    bounty: { gold: 3, xp: 4 },
    // Never picked by the wave composer — it only exists as a summon.
    cost: 0,
    scale: 0.8,
  },

  /**
   * Stuns on hit.
   *
   * The only creep that can take the hero's control away, which makes standing
   * in the middle of a pack a real decision rather than a free damage window.
   */
  breaker: {
    // Its own art slot, not the Ogro's: this one ships as authored art and the
    // Ogro does not.
    characterId: 'creep.breaker',
    name: 'Rompehuesos',
    behavior: 'hunter',
    stats: stats({
      maxHealth: 480,
      attackDamage: 30,
      attackSpeed: 0.6,
      moveSpeed: 4.6,
      armor: 10,
    }),
    bounty: { gold: 32, xp: 38 },
    cost: 30,
    scale: 1.1,
    traits: { stunOnHit: { chance: 0.22, seconds: 0.9 } },
  },
};

/**
 * One stage of a boss fight.
 *
 * Phases are what stop a boss being a creep with a large health bar: the fight
 * has to change shape as it goes, so the answer that worked at full health is
 * the wrong answer at a third. Each phase can rewrite the boss's stats and hand
 * it a new trait — reusing the same trait system the wave creeps use, so a
 * phase that summons adds and a summoner creep are the same code path.
 *
 * Ordered from highest threshold to lowest; the module walks them in order.
 */
export interface BossPhaseDef {
  /** Entered when the boss's health fraction falls to or below this. */
  at: number;
  /** Shown to the player when the phase begins. */
  announce: string;
  /**
   * Applied on entry and never removed.
   *
   * Cumulative on purpose: a boss that reached its last phase carries every
   * earlier phase's changes, so the fight escalates instead of swapping between
   * unrelated stat blocks.
   */
  modifiers?: StatModifier[];
  /** Traits gained for the rest of the fight. Replaces the previous set. */
  traits?: EnemyTraits;
}

export interface BossDef extends EnemyDef {
  /** Stages the fight moves through, in descending health order. */
  phases: BossPhaseDef[];
}

export const BOSSES: Record<string, BossDef> = {
  marrowTitan: {
    characterId: 'boss.marrowTitan',
    name: 'Dragón',
    behavior: 'siege',
    stats: stats({
      maxHealth: 5200,
      attackDamage: 78,
      attackSpeed: 0.55,
      attackRange: 4.2,
      moveSpeed: 3.4,
      armor: 22,
      magicResist: 0.25,
    }),
    bounty: { gold: 320, xp: 420 },
    cost: 0,
    scale: 1.5,
    // Three stages, each asking a different question.
    //
    // Opening: a slow siege wall. The player's problem is raw damage.
    // At 70 %: it raises bone spawn, so the problem becomes attention — kill
    //   the adds and lose tempo on the boss, or ignore them and get surrounded.
    // At 35 %: it enrages and starts stunning, so the problem becomes
    //   positioning. Standing in melee to finish it is now a real risk.
    //
    // Thresholds sit at 0.7 and 0.35 rather than at even thirds because the
    // last phase should be shorter than it feels — an enraged boss that lasts
    // as long as the opening is a slog, not a climax.
    phases: [
      {
        at: 0.7,
        announce: 'El Titán llama a los muertos',
        modifiers: [
          { stat: 'moveSpeed', op: 'pct', value: 0.25, sourceId: 'boss.phase2' },
          { stat: 'armor', op: 'flat', value: 8, sourceId: 'boss.phase2' },
        ],
        traits: { summons: { defId: 'skeleton', everySeconds: 7, count: 3, maxAlive: 9 } },
      },
      {
        at: 0.35,
        announce: '¡El Titán entra en cólera!',
        modifiers: [
          { stat: 'attackSpeed', op: 'pct', value: 0.75, sourceId: 'boss.phase3' },
          { stat: 'attackDamage', op: 'pct', value: 0.3, sourceId: 'boss.phase3' },
          { stat: 'moveSpeed', op: 'pct', value: 0.3, sourceId: 'boss.phase3' },
        ],
        // Keeps summoning — the adds from phase two do not stop — and adds a
        // stun, so the last third is the one where the hero can be locked down.
        traits: {
          summons: { defId: 'skeleton', everySeconds: 5, count: 3, maxAlive: 9 },
          stunOnHit: { chance: 0.3, seconds: 1.1 },
        },
      },
    ],
  },
};

export interface HeroDef {
  characterId: string;
  name: string;
  title: string;
  stats: StatBlock;
  /** Per-level growth, applied through a diminishing curve — never linear. */
  growth: Partial<StatBlock>;
  scale: number;
  ranged?: boolean;
}

export const HEROES: Record<string, HeroDef> = {
  bulwark: {
    characterId: 'hero.bulwark',
    name: 'Bulwark',
    title: 'Guardián del Vado',
    stats: stats({
      maxHealth: 640,
      healthRegen: 3.2,
      maxMana: 240,
      manaRegen: 2.4,
      attackDamage: 26,
      attackSpeed: 0.95,
      attackRange: 2.6,
      moveSpeed: 6.6,
      armor: 9,
      critChance: 0.08,
    }),
    growth: { maxHealth: 78, attackDamage: 4.2, armor: 1.1, maxMana: 22, spellPower: 3.4 },
    scale: 1,
  },
  oracle: {
    characterId: 'hero.oracle',
    name: 'Oracle',
    title: 'Voz del Umbral',
    stats: stats({
      maxHealth: 430,
      healthRegen: 1.9,
      maxMana: 480,
      manaRegen: 5.2,
      attackDamage: 21,
      attackSpeed: 0.8,
      attackRange: 12,
      moveSpeed: 6.2,
      armor: 3,
      spellPower: 28,
    }),
    growth: { maxHealth: 46, attackDamage: 2.6, maxMana: 44, spellPower: 7.5, armor: 0.6 },
    scale: 1,
    ranged: true,
  },
  /**
   * The marksman. Where the Oracle converts mana into bursts of area damage,
   * Talon's damage is her *attack*: the kit exists to keep her shooting — a
   * pierce to open, a trap and a root to hold the wave off her, a step to get
   * out of it, and a rain that covers the lane while her arrows do the work.
   * Frail, fast, and the only hero who can leave a fight at will.
   */
  talon: {
    characterId: 'hero.talon',
    name: 'Talon',
    title: 'Ojo de la Espesura',
    stats: stats({
      maxHealth: 495,
      healthRegen: 2.3,
      maxMana: 300,
      manaRegen: 3.4,
      attackDamage: 31,
      attackSpeed: 1.2,
      attackRange: 11,
      moveSpeed: 6.9,
      armor: 5,
      critChance: 0.16,
    }),
    growth: { maxHealth: 54, attackDamage: 5.2, maxMana: 26, armor: 0.7, spellPower: 2.2 },
    scale: 1,
    ranged: true,
  },
  /**
   * The healer. Tougher than the Oracle and far less bursty: her spell power
   * buys life back as often as it spends it, so the longer a fight runs the
   * more she is worth. Alone she trades slowly and never dies; beside a
   * teammate she decides how long that teammate can stand in the lane.
   */
  vesper: {
    characterId: 'hero.vesper',
    name: 'Vesper',
    title: 'Custodia del Alba',
    stats: stats({
      maxHealth: 520,
      healthRegen: 3.4,
      maxMana: 460,
      manaRegen: 5.6,
      attackDamage: 22,
      attackSpeed: 0.85,
      attackRange: 9,
      moveSpeed: 6.3,
      armor: 6,
      spellPower: 24,
    }),
    growth: { maxHealth: 58, attackDamage: 2.8, maxMana: 40, spellPower: 6.4, armor: 0.9 },
    scale: 1,
    ranged: true,
  },
};
