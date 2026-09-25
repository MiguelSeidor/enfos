/**
 * Online match session. Owner: NET.
 *
 * Drives the local simulation from the server's turns (see `protocol.ts`):
 *
 * - each `turn` books its commands for the turn's first tick and lets the
 *   engine simulate up to the turn's last tick — never further;
 * - the local player's commands go to the server instead of straight into the
 *   simulation, and come back in a turn like everyone else's;
 * - every `HASH_EVERY_TICKS` the state checksum is reported, so a desync is
 *   caught the moment it happens rather than when the players notice.
 *
 * ## Losing the connection
 *
 * When the socket drops, the session reconnects on its own, presenting the
 * seat token and the last turn it has. The server pauses the match for the
 * other players meanwhile, sends back the turns this client missed, and waits
 * for it to catch up before resuming. Nothing is replayed: the state never left
 * memory.
 *
 * A reloaded page has lost that memory. Every 10 seconds of play the session
 * saves a snapshot of the whole simulation to this browser (`snapshotStore`);
 * rejoining restores the latest one and replays only the turns after it —
 * seconds, however long the match has run. Without a snapshot (another device,
 * cleared storage) it falls back to rebuilding from turn 0 and replaying every
 * turn, silently and as fast as the machine allows.
 *
 * The cost of this model is input delay: a click takes effect on the next turn
 * the server issues after it arrives — about 100 ms plus the round trip. The
 * click's visual feedback (the ground marker, the cursor) is immediate, so the
 * delay reads as the hero reacting rather than the game ignoring the player.
 */

import { SNAPSHOT_VERSION, type Engine } from '@/core/engine';
import { clearSnapshots, loadSnapshot, saveSnapshot, type SnapshotRecord } from './snapshotStore';
import { playback } from '@/core/playback';
import type { CommandModule, Command, SlotCommand } from '@/gameplay/commands';
import { sanitizeCommand } from '@/gameplay/commands';
import type { MatchSetup } from '@/gameplay/setup';
import { checksum } from './checksum';
import type { NetClient } from './client';
import { clearResume, takeResyncFlag } from './resume';
import {
  HASH_EVERY_TICKS,
  RECONNECT_GRACE_SECONDS,
  SNAPSHOT_EVERY_TICKS,
  TURN_TICKS,
  type ServerMessage,
  type WaitingPlayer,
  type WireCommand,
} from './protocol';

/** A backlog larger than this is replayed in a silent fast-forward rather than played. */
const FAST_FORWARD_TICKS = 90;
/** Ticks simulated per slice of a fast-forward; the page repaints between slices. */
const FAST_FORWARD_SLICE = 300;
const RECONNECT_EVERY_MS = 2000;

export interface SessionEvents {
  /** Checksums disagreed: the machines are no longer playing the same match. */
  onDesync?: (tick: number) => void;
  /**
   * Checksums disagreed and the server chose who has to rebuild. `mine` says
   * whether this client is one of them.
   */
  onResync?: (info: { tick: number; mine: boolean; attempt: number }) => void;
  /** A player left the match for good. */
  onPlayerLeft?: (name: string) => void;
  /** Someone paused or resumed the match. */
  onPaused?: (info: { slot: number; name: string; paused: boolean }) => void;
  /** The match is paused waiting for these players; empty when it resumes. */
  onWaiting?: (players: WaitingPlayer[]) => void;
  /** This client lost its connection and is trying to get it back. */
  onConnectionLost?: (attempt: number) => void;
  onReconnected?: () => void;
  /** Gave up: the seat is gone. */
  onReconnectFailed?: (reason: string) => void;
  /** Replaying missed turns, 0..1. Called with 1 when done. */
  onCatchUp?: (progress: number) => void;
}

export class NetSession {
  private engine: Engine | null = null;
  private commands: CommandModule | null = null;
  private lastTurn = 0;
  /** Turns received before the match finished building; booked on `begin`. */
  private readonly early: { n: number; cmds: SlotCommand[] }[] = [];
  private readonly off: () => void;
  private pingTimer = 0;
  private drainTimer = 0;
  private reconnecting = false;
  private closed = false;
  private catchingUp = false;
  /** Round trip to the server, in milliseconds, smoothed. For the HUD. */
  latency = 0;
  events: SessionEvents = {};

  constructor(
    private readonly client: NetClient,
    readonly setup: MatchSetup,
    private readonly code: string,
    private readonly token: string,
    /** True when this page is taking back a seat in a match already under way. */
    private readonly rejoining = false,
  ) {
    this.off = client.on((msg) => this.onMessage(msg));
    client.onClose = () => void this.reconnect();
  }

  /** The match is built: start following the server's turns. */
  begin(engine: Engine, commands: CommandModule): void {
    this.commands = commands;
    void this.attach(engine);
  }

  private async attach(engine: Engine): Promise<void> {
    // Until the engine is attached, arriving turns wait in `early`. That matters
    // here: restoring a snapshot clears the command book, so nothing may be
    // booked before the restore has happened.
    if (this.rejoining) {
      await this.historyArrived;
      await this.restoreLocal(engine);
    }
    if (this.closed) return;
    this.engine = engine;
    engine.onStep = (tick) => {
      if (playback.fastForward) return;
      if (tick % HASH_EVERY_TICKS === 0) {
        this.client.send({ t: 'hash', tick, hash: checksum(engine.ctx.match, engine.ctx.rng.state()) });
      }
      if (tick % SNAPSHOT_EVERY_TICKS === 0) this.saveLocal();
    };
    for (const turn of this.early.splice(0)) this.book(turn.n, turn.cmds);
    engine.setStepLimit(this.lastTurn * TURN_TICKS);

    // A hidden tab receives no animation frames, so its simulation would stall
    // while turns keep arriving. This keeps it playing in the background.
    this.drainTimer = window.setInterval(() => {
      if (document.hidden && !this.catchingUp) engine.drainToLimit();
    }, 250);
    this.pingTimer = window.setInterval(() => this.client.send({ t: 'ping', at: performance.now() }), 2000);
    // One last save on the way out, so a reload loses seconds rather than the
    // whole interval since the periodic one.
    window.addEventListener('pagehide', this.onPageHide);

    this.catchUpThenReport();
  }

  private readonly onPageHide = (): void => this.saveLocal();

  private get snapshotKey(): string {
    return `${this.code}:${this.token}`;
  }

  /**
   * The last snapshot every machine agreed on. A reload restores the newest
   * one; a *desync* recovery restores this one instead, because the newest may
   * already belong to the timeline that went wrong.
   */
  private get agreedKey(): string {
    return `${this.code}:${this.token}:agreed`;
  }

  /** Saves the simulation to this browser. Fire and forget: a failed save only costs replay time. */
  private saveLocal(): void {
    const engine = this.engine;
    if (!engine || this.closed || this.catchingUp) return;
    const record: SnapshotRecord = {
      version: SNAPSHOT_VERSION,
      seed: this.setup.seed,
      tick: engine.tick,
      hash: checksum(engine.ctx.match, engine.ctx.rng.state()),
      savedAt: Date.now(),
      data: engine.snapshot(),
    };
    // Held as well as stored: the server confirms this tick a moment later,
    // and only then is the snapshot known to be the same one everyone else
    // has. See `agreed` in `onMessage`.
    this.unconfirmed = record;
    void saveSnapshot(this.snapshotKey, record).catch((error) => console.warn('[net] snapshot not saved', error));
  }

  /** The most recent snapshot taken, until the server confirms its tick. */
  private unconfirmed: SnapshotRecord | null = null;

  /**
   * Loads this browser's latest snapshot of the match, if it has one, so only
   * the turns after it need replaying. The restored state is checked against
   * the checksum taken when it was saved; a mismatch means the snapshot cannot
   * be trusted, and the page starts over with a full replay instead.
   */
  private async restoreLocal(engine: Engine): Promise<void> {
    let record: SnapshotRecord | null = null;
    // After a desync this client's own recent state is exactly what is not to
    // be trusted; fall back to the last one the whole match agreed on.
    const key = takeResyncFlag() ? this.agreedKey : this.snapshotKey;
    try {
      record = await loadSnapshot(key);
    } catch (error) {
      console.warn('[net] snapshot unavailable', error);
      return;
    }
    if (!record || record.version !== SNAPSHOT_VERSION || record.seed !== this.setup.seed) return;
    // Never ahead of what the server has confirmed: that would be a future the
    // other players have not played.
    if (record.tick > this.lastTurn * TURN_TICKS) return;
    engine.restore(record.data);
    if (checksum(engine.ctx.match, engine.ctx.rng.state()) !== record.hash) {
      console.error(`[net] snapshot at tick ${record.tick} failed verification; replaying the match instead`);
      await clearSnapshots().catch(() => {});
      location.reload();
      return;
    }
    this.restoredTick = record.tick;
  }

  /** The tick a local snapshot put this client at, or null when none was used. For QA. */
  restoredTick: number | null = null;

  /** Settles once the server's `history` has arrived (or after a timeout, if it never does). */
  private resolveHistory: (() => void) | null = null;
  private readonly historyArrived = new Promise<void>((resolve) => {
    this.resolveHistory = resolve;
    window.setTimeout(resolve, 8000);
  });

  send(cmd: Command): void {
    this.client.send({ t: 'cmd', cmd });
  }

  /**
   * Asks the server to stop the match for everyone, or to start it again.
   * Never a command: a pause is not part of the simulation, it is the clock
   * that feeds it, and only the server owns that.
   */
  setPaused(paused: boolean): void {
    this.client.send({ t: 'pause', paused });
  }

  /** Leaves the room for good. Mid-match, the server turns this into a forfeit. */
  leave(): void {
    this.closed = true;
    clearResume();
    this.client.send({ t: 'leave' });
    this.client.close();
  }

  /** How many confirmed ticks are waiting to be simulated. For diagnostics. */
  get backlog(): number {
    return this.engine ? this.lastTurn * TURN_TICKS - this.engine.tick : 0;
  }

  get turn(): number {
    return this.lastTurn;
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'turn':
        this.receive(msg.n, msg.cmds);
        return;
      case 'history': {
        // Turns with no commands are not listed; only the numbers in between
        // matter, and `last` says how far they go.
        for (const record of msg.turns) this.receive(record.n, record.cmds, true);
        if (msg.last > this.lastTurn) this.lastTurn = msg.last;
        this.resolveHistory?.();
        if (this.engine) {
          this.engine.setStepLimit(this.lastTurn * TURN_TICKS);
          this.catchUpThenReport();
        }
        return;
      }
      case 'waiting':
        this.events.onWaiting?.(msg.players);
        return;
      case 'paused':
        this.events.onPaused?.({ slot: msg.slot, name: msg.name, paused: msg.paused });
        return;
      case 'agreed': {
        const record = this.unconfirmed;
        if (!record || record.tick !== msg.tick) return;
        this.unconfirmed = null;
        void saveSnapshot(this.agreedKey, record).catch(() => {});
        return;
      }
      case 'resync': {
        const mine = msg.slots.includes(this.setup.localSlot);
        // Stop where we are: every tick simulated from here is more of the
        // wrong match, and the page is about to rebuild it anyway.
        if (mine) this.engine?.setStepLimit(this.engine.tick);
        this.events.onResync?.({ tick: msg.tick, mine, attempt: msg.attempt });
        return;
      }
      case 'desync':
        this.events.onDesync?.(msg.tick);
        return;
      case 'left':
        if (msg.slot === this.setup.localSlot) clearResume();
        this.events.onPlayerLeft?.(msg.name);
        return;
      case 'pong': {
        const rtt = performance.now() - msg.at;
        this.latency = this.latency === 0 ? rtt : this.latency * 0.8 + rtt * 0.2;
        return;
      }
    }
  }

  private receive(n: number, wire: WireCommand[], fromHistory = false): void {
    if (n <= this.lastTurn && !fromHistory) return;
    const cmds: SlotCommand[] = [];
    for (const w of wire) {
      // Sanitised here, identically on every client, so a malformed command
      // is dropped everywhere or nowhere.
      const cmd = sanitizeCommand(w.cmd);
      if (cmd && Number.isInteger(w.slot)) cmds.push({ slot: w.slot, cmd });
    }
    if (!this.engine) {
      this.early.push({ n, cmds });
      if (n > this.lastTurn) this.lastTurn = n;
      return;
    }
    this.book(n, cmds);
    if (n > this.lastTurn) {
      this.lastTurn = n;
      this.engine.setStepLimit(n * TURN_TICKS);
    }
  }

  private book(n: number, cmds: SlotCommand[]): void {
    const tick = (n - 1) * TURN_TICKS + 1;
    // A turn this client already simulated (a history overlap) was booked the
    // first time round; booking it again would run its commands twice.
    if (cmds.length === 0 || tick <= this.engine!.tick) return;
    this.commands!.book(tick, cmds);
  }

  /**
   * Brings the simulation up to the last confirmed turn, then tells the server
   * this client is ready so the clock can run. A small backlog just plays out
   * at the normal catch-up pace; a large one is fast-forwarded in slices, with
   * presentation muted, so the page stays responsive and shows progress.
   */
  private catchUpThenReport(): void {
    const engine = this.engine;
    if (!engine || this.catchingUp) return;
    const target = this.lastTurn * TURN_TICKS;
    if (target - engine.tick <= FAST_FORWARD_TICKS) {
      this.client.send({ t: 'loaded' });
      return;
    }
    this.catchingUp = true;
    playback.fastForward = true;
    const start = engine.tick;
    const slice = (): void => {
      if (this.closed) return;
      const ran = engine.drainToLimit(FAST_FORWARD_SLICE);
      const total = Math.max(1, target - start);
      this.events.onCatchUp?.(Math.min(1, (engine.tick - start) / total));
      // `ran > 0` guards against spinning forever should the limit ever sit
      // below the target.
      if (engine.tick < target && ran > 0) {
        window.setTimeout(slice, 0);
        return;
      }
      playback.fastForward = false;
      this.catchingUp = false;
      this.events.onCatchUp?.(1);
      this.client.send({ t: 'loaded' });
    };
    window.setTimeout(slice, 0);
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    // A little past the server's grace: if the seat is still held, the server
    // is the one that decides it is too late, and says so.
    const deadline = Date.now() + (RECONNECT_GRACE_SECONDS + 5) * 1000;
    let attempt = 0;
    while (!this.closed && Date.now() < deadline) {
      attempt++;
      this.events.onConnectionLost?.(attempt);
      try {
        await this.client.resume(this.code, this.token, this.lastTurn);
        this.reconnecting = false;
        this.client.onClose = () => void this.reconnect();
        this.events.onReconnected?.();
        return;
      } catch (error) {
        const message = (error as Error).message;
        // The server answered and refused: no amount of retrying helps.
        if (message.includes('ya no está disponible') || message.includes('Versión')) {
          this.reconnecting = false;
          clearResume();
          this.events.onReconnectFailed?.(message);
          return;
        }
      }
      await new Promise((r) => window.setTimeout(r, RECONNECT_EVERY_MS));
    }
    this.reconnecting = false;
    if (!this.closed) {
      clearResume();
      this.events.onReconnectFailed?.('No se pudo recuperar la conexión');
    }
  }

  dispose(): void {
    this.closed = true;
    window.removeEventListener('pagehide', this.onPageHide);
    this.off();
    window.clearInterval(this.drainTimer);
    window.clearInterval(this.pingTimer);
    if (this.engine) this.engine.onStep = null;
    playback.fastForward = false;
  }
}
