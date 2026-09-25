/**
 * Wire protocol between game clients and the match server. Owner: NET.
 *
 * Shared verbatim by the browser client and the Node server, so it may hold
 * only types and plain constants — no imports through the `@/` alias, no
 * syntax Node's type stripping cannot erase.
 *
 * ## Model: server-paced lockstep
 *
 * The server never simulates. It runs a clock of *turns*, one every
 * `TURN_MS`, each covering `TURN_TICKS` simulation ticks. Commands that reach
 * it during a turn are stamped into that turn and broadcast to everyone. A
 * client may simulate up to the end of the last turn it has received, and
 * books each turn's commands for that turn's first tick.
 *
 * Every client therefore runs the same commands on the same ticks, and — the
 * simulation being deterministic — computes the same match. The server's
 * only authority is *when* a command happens, which is exactly the part two
 * clients could never agree on by themselves.
 */

/** Bumped whenever a message or the simulation changes incompatibly. */
export const PROTOCOL_VERSION = 2;

/**
 * Seconds a disconnected player has to come back before forfeiting. The match
 * is paused for everyone meanwhile: in a 1v1 there is nothing fair to play
 * while one side cannot defend its Core.
 */
export const RECONNECT_GRACE_SECONDS = 60;

/**
 * How long one pause lasts before the match starts again on its own, and how
 * many a player gets per match. Waves keep their own clock, so a pause is time
 * every side gains equally — but an unlimited one is a way to deny the rival
 * their match, so it is rationed.
 */
export const PAUSE_SECONDS = 90;
export const PAUSES_PER_PLAYER = 3;

/** Simulation ticks per turn. At 30 Hz this is 100 ms. */
export const TURN_TICKS = 3;
export const TURN_MS = 100;
/** Ticks between checksum reports. */
export const HASH_EVERY_TICKS = 30;
/**
 * Ticks between local snapshots: 10 seconds. A rejoin after a reload replays
 * at most this much, whatever the length of the match. A multiple of
 * `HASH_EVERY_TICKS`, so every snapshot lands on a tick the server compares —
 * which is what lets a snapshot be *confirmed* rather than merely saved.
 */
export const SNAPSHOT_EVERY_TICKS = 300;

export type RoomMode = '1v1' | '2v2' | '3v3';

/**
 * Heroes a player may pick. The server validates against this list because a
 * key the simulation does not know would crash every client at match start.
 * The client checks at boot that it matches the game's own hero table.
 */
export const HERO_KEYS: readonly string[] = ['bulwark', 'oracle', 'talon', 'vesper'];

export const ROOM_CAPACITY: Record<RoomMode, number> = { '1v1': 2, '2v2': 4, '3v3': 6 };

export interface LobbyPlayer {
  id: string;
  name: string;
  team: 0 | 1;
  hero: string | null;
  ready: boolean;
}

export interface RoomView {
  code: string;
  mode: RoomMode;
  hostId: string;
  players: LobbyPlayer[];
  /** True once the match has started; nobody can join after that. */
  started: boolean;
}

export interface RoomSummary {
  code: string;
  mode: RoomMode;
  host: string;
  players: number;
  capacity: number;
}

export interface StartPlayer {
  slot: number;
  team: 0 | 1;
  heroKey: string;
  name: string;
}

/** A command as it travels: the slot is stamped by the server, never trusted from a client. */
export interface WireCommand {
  slot: number;
  cmd: unknown;
}

/** A turn that carried commands; turns with none are implied by their number. */
export interface TurnRecord {
  n: number;
  cmds: WireCommand[];
}

export interface WaitingPlayer {
  slot: number;
  name: string;
  /** Lost connection, back and replaying the match to catch up, or paused. */
  reason: 'disconnected' | 'loading' | 'paused';
  /**
   * Seconds before a disconnected player forfeits or a pause runs out; -1
   * while loading, which has no deadline the player can see.
   */
  secondsLeft: number;
}

export type ClientMessage =
  | { t: 'hello'; name: string; version: number }
  /**
   * Instead of `hello`: rejoin a running match. `haveTurn` is the last turn
   * this client already has — 0 after a page reload, when it has nothing.
   */
  | { t: 'resume'; code: string; token: string; haveTurn: number; version: number }
  | { t: 'list' }
  | { t: 'create'; mode: RoomMode }
  | { t: 'join'; code: string }
  | { t: 'leave' }
  | { t: 'pick'; hero: string }
  /** Move to the other side of the lobby, while it has room. */
  | { t: 'team'; team: 0 | 1 }
  | { t: 'ready'; ready: boolean }
  /**
   * Stop the match for everyone, or start it again. The clock lives on the
   * server, so a pause has to be asked for rather than taken: a client that
   * simply stopped stepping would fall behind while the rest played on.
   */
  | { t: 'pause'; paused: boolean }
  /** The match is built and waiting for its first turn. */
  | { t: 'loaded' }
  | { t: 'cmd'; cmd: unknown }
  | { t: 'hash'; tick: number; hash: number }
  | { t: 'ping'; at: number };

export type ServerMessage =
  | { t: 'welcome'; id: string }
  | { t: 'error'; message: string }
  | { t: 'rooms'; rooms: RoomSummary[] }
  /** The room this client is in, after any change; null after leaving. */
  | { t: 'room'; room: RoomView | null }
  | {
      t: 'start';
      code: string;
      seed: number;
      mode: RoomMode;
      players: StartPlayer[];
      yourSlot: number;
      /** Secret that lets this player rejoin the match after a disconnect. */
      token: string;
    }
  | { t: 'turn'; n: number; cmds: WireCommand[] }
  /** Turns a rejoining client missed, up to and including `last`. */
  | { t: 'history'; turns: TurnRecord[]; last: number }
  /** The match is paused waiting for these players; an empty list means it resumed. */
  | { t: 'waiting'; players: WaitingPlayer[] }
  /**
   * Someone paused or resumed the match. The stop itself is carried by
   * `waiting`; this is the announcement, so every client can say who did it.
   */
  | { t: 'paused'; slot: number; name: string; paused: boolean }
  /**
   * Every client reported the same checksum for this tick. Sent on snapshot
   * ticks only: it marks the client's own snapshot of that tick as one the
   * whole match agreed on, and so the one to fall back to after a desync.
   */
  | { t: 'agreed'; tick: number }
  /**
   * Checksums disagreed and the named slots have to rebuild their simulation
   * from the turn history. The rest of the match waits for them.
   */
  | { t: 'resync'; tick: number; slots: number[]; attempt: number }
  /** The match diverged again after every recovery: it cannot be saved. */
  | { t: 'desync'; tick: number }
  | { t: 'left'; slot: number; name: string }
  | { t: 'pong'; at: number };
