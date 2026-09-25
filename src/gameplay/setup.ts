/**
 * Who is in a match. Owner: GAMEPLAY.
 *
 * Plain data, identical on every machine in an online match: the server sends
 * it once, and every client builds the same simulation from it. Nothing here
 * may depend on which machine is reading it except `localSlot`, which is only
 * ever consulted by presentation.
 */

import type { TeamId } from '@/core/contracts';

export type MatchMode = '1v1' | '2v2' | '3v3';

export interface PlayerSetup {
  /** Stable index, 0..n-1. Heroes are spawned in slot order, so ids agree everywhere. */
  slot: number;
  team: TeamId;
  heroKey: string;
  name: string;
}

export interface MatchSetup {
  seed: number;
  mode: MatchMode;
  players: PlayerSetup[];
  /** The slot this machine controls. Presentation only. */
  localSlot: number;
  online: boolean;
}

/** A single player against the waves, as the game has been played so far. */
export function soloSetup(heroKey: string, seed: number): MatchSetup {
  return {
    seed,
    mode: '1v1',
    players: [{ slot: 0, team: 0, heroKey, name: 'Jugador' }],
    localSlot: 0,
    online: false,
  };
}

/** Distinct teams in slot order. */
export function teamsOf(setup: MatchSetup): TeamId[] {
  const teams: TeamId[] = [];
  for (const p of [...setup.players].sort((a, b) => a.slot - b.slot)) {
    if (!teams.includes(p.team)) teams.push(p.team);
  }
  return teams;
}
