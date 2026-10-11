/**
 * Gameplay layer entry point. Owner: GAMEPLAY.
 *
 * The modules are constructed together because three of them hold direct
 * references to each other (movement needs combat's broad phase, waves needs the
 * unit factory, match wires both). Those are deliberate hard edges inside one
 * layer — everything crossing a layer boundary still goes through a service.
 */

import type { GameModule } from '@/core/contracts';
import { UnitModule } from './units';
import { CombatModule } from './combat';
import { MovementModule } from './movement';
import { WaveModule } from './waves';
import { MatchModule } from './match';
import { AbilityModule } from './abilities';
import { EconomyModule } from '@/economy/economy';
import { ProgressionModule } from './progression';
import { CommandModule } from './commands';
import { SabotageModule } from './sabotage';
import { InvocationModule } from './invocations';
import { LANE_COUNT } from '@/world/layout';
import type { MatchSetup } from './setup';

export interface GameplayBundle {
  modules: GameModule[];
  /** The only door player input may use into the simulation. */
  commands: CommandModule;
  sabotage: SabotageModule;
  match: MatchModule;
  waves: WaveModule;
  abilities: AbilityModule;
  economy: EconomyModule;
  progression: ProgressionModule;
  /** Exposed for the command card's stop/hold orders. */
  movement: MovementModule;
  /** Player powers, read by the HUD and fired by a command. */
  invocations: InvocationModule;
}

export function createGameplay(setup: MatchSetup): GameplayBundle {
  const units = new UnitModule();
  const combat = new CombatModule();
  const movement = new MovementModule();
  const waves = new WaveModule();
  const abilities = new AbilityModule();
  const economy = new EconomyModule();
  const progression = new ProgressionModule();
  const invocations = new InvocationModule();
  const match = new MatchModule(units, combat, movement, waves, setup);
  const commands = new CommandModule(match, abilities, economy, progression, invocations);
  const sabotage = new SabotageModule(match, units, combat);
  sabotage.laneCount = LANE_COUNT;
  economy.sabotage = sabotage;

  return {
    // Economy (600) and progression (610) init after match (550), so the hero
    // they credit already exists.
    // `invocations` after economy (600), because it charges gold through the
    // economy service and so needs it registered.
    modules: [units, combat, movement, abilities, waves, match, economy, progression, invocations, sabotage, commands],
    commands,
    sabotage,
    match,
    waves,
    abilities,
    economy,
    progression,
    movement,
    invocations,
  };
}

export { WAVES_TOTAL, INTERMISSION, intermissionFor, planWave } from './waves';
export { INVOCATIONS, INVOCATION_IDS, type InvocationId, type InvocationStatus } from './invocations';
export { xpToNext, teamSign } from './match';
export {
  soloSetup,
  duoSetup,
  teamsOf,
  type MatchSetup,
  type PlayerSetup,
  type MatchMode,
} from './setup';
export { sanitizeCommand, type Command, type SlotCommand } from './commands';
export { issueOrder, heroOrders, clearOrders } from './movement';
export { HEROES, ENEMIES, BOSSES } from './defs';
export {
  ABILITIES,
  AbilityModule,
  abilityRadius,
  abilityRange,
  grown,
  type AbilityDef,
  type AbilityGrowth,
  type AbilityTarget,
} from './abilities';
export { ATTRIBUTES, ProgressionModule, type AttributeId } from './progression';
