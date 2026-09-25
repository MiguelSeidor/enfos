/**
 * Match server. Owner: NET.
 *
 * Lobby, rooms, and the turn clock for server-paced lockstep (see
 * `src/net/protocol.ts`). It never simulates the game: it decides *when* each
 * player's command happens and relays it to everyone, compares the checksums
 * the clients report, and handles players leaving and coming back.
 *
 * ## Disconnects
 *
 * A player who drops mid-match is not removed. The match pauses for everyone
 * and the player has `RECONNECT_GRACE_SECONDS` to return. Every turn the room
 * has issued is kept, so a returning client — even one that reloaded the page
 * and has nothing — is sent the turns it is missing and replays them to catch
 * up. Only when that client reports it is caught up does the clock resume.
 * A player who does not return in time forfeits.
 *
 * Run with `npm run server` (Node 23.6+ runs this TypeScript directly). In
 * production it also serves the built client from `dist/`, so one process —
 * one Railway service — hosts the whole game. `PORT` comes from the
 * environment, as hosting platforms require.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  HASH_EVERY_TICKS,
  HERO_KEYS,
  PAUSES_PER_PLAYER,
  PAUSE_SECONDS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_SECONDS,
  ROOM_CAPACITY,
  SNAPSHOT_EVERY_TICKS,
  TURN_MS,
  TURN_TICKS,
  type ClientMessage,
  type LobbyPlayer,
  type RoomMode,
  type RoomSummary,
  type RoomView,
  type ServerMessage,
  type TurnRecord,
  type WaitingPlayer,
  type WireCommand,
} from '../src/net/protocol.ts';

const PORT = Number(process.env.PORT ?? 8787);
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? 'dist');
/** Overridable so the forfeit path can be tested without waiting a minute. */
const GRACE_MS = Number(process.env.RECONNECT_GRACE_SECONDS ?? RECONNECT_GRACE_SECONDS) * 1000;
/** A rejoining client replaying a long match gets longer, but not forever. */
const LOADING_LIMIT_MS = 5 * 60 * 1000;
/** How long a pause holds the clock before the match restarts by itself. */
const PAUSE_MS = Number(process.env.PAUSE_SECONDS ?? PAUSE_SECONDS) * 1000;

/** Largest message a client may send, in characters. Commands are tiny. */
const MAX_MESSAGE = 2048;
/** Commands one player may send per turn; more is a stuck key or abuse. */
const MAX_COMMANDS_PER_TURN = 20;
/** Turns the clock keeps running after a forfeit, so the forfeit turn is delivered and played. */
const DRAIN_TURNS = 30;
/** Recoveries a match may need before it is called irrecoverable. */
const MAX_RESYNCS = 3;

interface Client {
  id: string;
  ws: WebSocket;
  name: string;
  greeted: boolean;
  room: Room | null;
  alive: boolean;
}

interface Member {
  client: Client;
  team: 0 | 1;
  hero: string | null;
  ready: boolean;
  slot: number;
  token: string;
  connected: boolean;
  /** Has built the match and is caught up with the turns. */
  loaded: boolean;
  /** Left for good (explicitly, or the grace ran out). Never waited for again. */
  gone: boolean;
  disconnectedAt: number | null;
  loadingSince: number | null;
  sentThisTurn: number;
  /** When this player paused the match, or null. */
  pausedAt: number | null;
  /** Pauses left this match. */
  pauses: number;
}

interface Room {
  code: string;
  mode: RoomMode;
  hostId: string;
  members: Member[];
  started: boolean;
  seed: number;
  turn: number;
  /** Wall-clock time turn 0 would have happened, adjusted after every pause. */
  clockStart: number;
  /** True while the clock is advancing; false before the first load and during pauses. */
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  pending: WireCommand[];
  /** Turns that carried commands, for replaying to a rejoining client. */
  history: TurnRecord[];
  hashes: Map<number, Map<number, number>>;
  desynced: boolean;
  /** True while somebody is replaying the match to get back in step. */
  resyncing: boolean;
  /** How many recoveries this match has needed. */
  resyncs: number;
  drain: number | null;
  /** Serialised last `waiting` broadcast, to send only on change or once a second. */
  lastWaiting: string;
  lastWaitingAt: number;
}

const clients = new Map<string, Client>();
const rooms = new Map<string, Room>();
let nextClientId = 1;

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(client: Client, msg: ServerMessage): void {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const m of room.members) {
    if (m.connected && m.client.ws.readyState === WebSocket.OPEN) m.client.ws.send(data);
  }
}

/** Four letters, no I/O/0/1 look-alikes, so a code read aloud is unambiguous. */
function newCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += alphabet[randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
}

function view(room: Room): RoomView {
  return {
    code: room.code,
    mode: room.mode,
    hostId: room.hostId,
    started: room.started,
    players: room.members.map(
      (m): LobbyPlayer => ({ id: m.client.id, name: m.client.name, team: m.team, hero: m.hero, ready: m.ready }),
    ),
  };
}

function summaries(): RoomSummary[] {
  const out: RoomSummary[] = [];
  for (const room of rooms.values()) {
    if (room.started) continue;
    const capacity = ROOM_CAPACITY[room.mode];
    if (room.members.length >= capacity) continue;
    const host = room.members.find((m) => m.client.id === room.hostId);
    out.push({ code: room.code, mode: room.mode, host: host?.client.name ?? '—', players: room.members.length, capacity });
  }
  return out;
}

function publishRoom(room: Room): void {
  broadcast(room, { t: 'room', room: view(room) });
}

function newRoom(mode: RoomMode, hostId: string): Room {
  return {
    code: newCode(),
    mode,
    hostId,
    members: [],
    started: false,
    seed: 0,
    turn: 0,
    clockStart: 0,
    running: false,
    timer: null,
    pending: [],
    history: [],
    hashes: new Map(),
    desynced: false,
    resyncing: false,
    resyncs: 0,
    drain: null,
    lastWaiting: '',
    lastWaitingAt: 0,
  };
}

// ── Lobby ────────────────────────────────────────────────────────────────────

/** An explicit exit: the lobby button, or leaving a match for good. */
function leaveRoom(client: Client): void {
  const room = client.room;
  if (!room) return;
  client.room = null;
  const member = room.members.find((m) => m.client === client);
  if (!member) return;

  if (!room.started) {
    room.members = room.members.filter((m) => m !== member);
    if (room.members.length === 0) {
      rooms.delete(room.code);
    } else {
      if (room.hostId === client.id) room.hostId = room.members[0]!.client.id;
      publishRoom(room);
    }
    send(client, { t: 'room', room: null });
    return;
  }
  forfeit(room, member);
}

/** A socket closed. In the lobby that is a leave; mid-match, a disconnect with a grace period. */
function dropClient(client: Client): void {
  const room = client.room;
  if (!room) return;
  const member = room.members.find((m) => m.client === client);
  if (!member) return;
  if (!room.started) {
    leaveRoom(client);
    return;
  }
  if (member.gone || !member.connected) return;
  member.connected = false;
  member.loaded = false;
  member.disconnectedAt = Date.now();
  member.loadingSince = null;
  log(`room ${room.code}: ${client.name} disconnected`);
  updateClock(room);
}

/**
 * Removes a player from a running match. The forfeit is itself a command, so
 * every remaining client processes it on the same tick and the match ends
 * identically for all of them.
 */
function forfeit(room: Room, member: Member): void {
  if (member.gone) return;
  member.gone = true;
  member.connected = false;
  member.loaded = false;
  member.disconnectedAt = null;
  // A pause dies with the player who called it; the rest play on.
  member.pausedAt = null;
  if (member.client.room === room) member.client.room = null;
  room.pending.push({ slot: member.slot, cmd: { kind: 'forfeit' } });
  broadcast(room, { t: 'left', slot: member.slot, name: member.client.name });
  log(`room ${room.code}: ${member.client.name} forfeited`);

  if (room.members.every((m) => m.gone)) {
    stopRoom(room);
    return;
  }
  // With a player gone the match cannot continue for long: keep the clock
  // running just long enough for the forfeit turn to be delivered and played.
  if (room.drain === null) room.drain = DRAIN_TURNS;
  updateClock(room);
}

function joinRoom(client: Client, room: Room): void {
  if (room.started) return send(client, { t: 'error', message: 'La partida ya ha empezado' });
  if (room.members.length >= ROOM_CAPACITY[room.mode]) {
    return send(client, { t: 'error', message: 'La sala está llena' });
  }
  leaveRoom(client);
  const onTeam0 = room.members.filter((m) => m.team === 0).length;
  const onTeam1 = room.members.length - onTeam0;
  room.members.push({
    client,
    team: onTeam1 < onTeam0 ? 1 : 0,
    hero: null,
    ready: false,
    slot: -1,
    token: '',
    connected: true,
    loaded: false,
    gone: false,
    disconnectedAt: null,
    loadingSince: null,
    sentThisTurn: 0,
    pausedAt: null,
    pauses: PAUSES_PER_PLAYER,
  });
  client.room = room;
  publishRoom(room);
}

function startMessage(room: Room, member: Member): ServerMessage {
  return {
    t: 'start',
    code: room.code,
    seed: room.seed,
    mode: room.mode,
    players: room.members.map((m) => ({ slot: m.slot, team: m.team, heroKey: m.hero!, name: m.client.name })),
    yourSlot: member.slot,
    token: member.token,
  };
}

function maybeStart(room: Room): void {
  const capacity = ROOM_CAPACITY[room.mode];
  if (room.started || room.members.length !== capacity) return;
  if (!room.members.every((m) => m.ready && m.hero)) return;

  room.started = true;
  room.seed = randomInt(1, 2 ** 31 - 1);
  // Slots in join order; the host is slot 0.
  room.members.forEach((m, i) => {
    m.slot = i;
    m.token = randomBytes(18).toString('hex');
    m.loadingSince = Date.now();
  });
  for (const m of room.members) send(m.client, startMessage(room, m));
  // The timer runs from now on, but turns only advance once everyone has built
  // the match — see `updateClock`.
  room.timer = setInterval(() => tick(room), TURN_MS / 2);
  log(`room ${room.code} started (${room.members.map((m) => `${m.client.name}/${m.hero}/t${m.team}`).join(', ')})`);
}

// ── Turn clock ───────────────────────────────────────────────────────────────

/** Players the match is currently waiting on. */
function waitingOn(room: Room, now: number): WaitingPlayer[] {
  const out: WaitingPlayer[] = [];
  for (const m of room.members) {
    if (m.gone) continue;
    if (!m.connected) {
      const left = Math.max(0, GRACE_MS - (now - (m.disconnectedAt ?? now)));
      out.push({ slot: m.slot, name: m.client.name, reason: 'disconnected', secondsLeft: Math.ceil(left / 1000) });
    } else if (!m.loaded) {
      out.push({ slot: m.slot, name: m.client.name, reason: 'loading', secondsLeft: -1 });
    } else if (m.pausedAt !== null) {
      const left = Math.max(0, PAUSE_MS - (now - m.pausedAt));
      out.push({ slot: m.slot, name: m.client.name, reason: 'paused', secondsLeft: Math.ceil(left / 1000) });
    }
  }
  return out;
}

/**
 * Starts or stops the clock to match who is present, and tells everyone.
 * Resuming re-anchors the clock at the current turn, so the time spent paused
 * is not played back afterwards as a burst of turns.
 */
function updateClock(room: Room): void {
  const now = Date.now();
  const waiting = waitingOn(room, now);
  const shouldRun = waiting.length === 0 || room.drain !== null;
  if (shouldRun && !room.running) {
    room.running = true;
    room.clockStart = performance.now() - room.turn * TURN_MS;
  } else if (!shouldRun && room.running) {
    room.running = false;
  }
  const serial = JSON.stringify(waiting);
  if (serial !== room.lastWaiting || (waiting.length > 0 && now - room.lastWaitingAt >= 1000)) {
    room.lastWaiting = serial;
    room.lastWaitingAt = now;
    broadcast(room, { t: 'waiting', players: waiting });
  }
}

function tick(room: Room): void {
  const now = Date.now();
  // Deadlines first: a player out of time forfeits, which may unpause.
  for (const m of room.members) {
    if (m.gone) continue;
    // A pause that runs out lets go on its own, so a player who walked away
    // cannot hold the match hostage.
    if (m.pausedAt !== null && now - m.pausedAt > PAUSE_MS) {
      m.pausedAt = null;
      broadcast(room, { t: 'paused', slot: m.slot, name: m.client.name, paused: false });
    }
    if (!m.connected && m.disconnectedAt !== null && now - m.disconnectedAt > GRACE_MS) forfeit(room, m);
    else if (m.connected && !m.loaded && m.loadingSince !== null && now - m.loadingSince > LOADING_LIMIT_MS) {
      forfeit(room, m);
    }
  }
  if (!rooms.has(room.code)) return;
  updateClock(room);
  if (!room.running) return;

  const due = Math.floor((performance.now() - room.clockStart) / TURN_MS);
  while (room.turn < due) {
    room.turn++;
    const cmds = room.pending;
    room.pending = [];
    if (cmds.length > 0) room.history.push({ n: room.turn, cmds });
    for (const m of room.members) m.sentThisTurn = 0;
    broadcast(room, { t: 'turn', n: room.turn, cmds });
    if (room.drain !== null && --room.drain <= 0) {
      stopRoom(room);
      return;
    }
  }
}

function stopRoom(room: Room): void {
  if (room.timer) clearInterval(room.timer);
  room.timer = null;
  rooms.delete(room.code);
  for (const m of room.members) if (m.client.room === room) m.client.room = null;
  log(`room ${room.code} closed`);
}

function recordHash(room: Room, member: Member, tick: number, hash: number): void {
  // Nothing to compare while somebody is rebuilding their simulation: their
  // reports belong to the old, wrong timeline.
  if (room.desynced || room.resyncing || tick % HASH_EVERY_TICKS !== 0) return;
  let byTick = room.hashes.get(tick);
  if (!byTick) {
    byTick = new Map();
    room.hashes.set(tick, byTick);
  }
  byTick.set(member.slot, hash >>> 0);
  const expected = room.members.filter((m) => !m.gone).length;
  if (byTick.size >= expected) {
    const groups = new Map<number, number[]>();
    for (const [slot, h] of byTick) groups.set(h, [...(groups.get(h) ?? []), slot]);
    room.hashes.delete(tick);
    if (groups.size > 1) startResync(room, tick, byTick, groups);
    // Everyone agrees: tell the clients, so each one can mark its own snapshot
    // of this tick as trustworthy ground to fall back to.
    else if (tick % SNAPSHOT_EVERY_TICKS === 0) broadcast(room, { t: 'agreed', tick });
  }
  // A player who was away never reports some ticks; do not keep them forever.
  for (const t of room.hashes.keys()) if (t < tick - HASH_EVERY_TICKS * 40) room.hashes.delete(t);
}

/**
 * Puts the machines that disagree back on the majority's timeline.
 *
 * Commands are the only input to the simulation and the server keeps every
 * turn, so replaying the match from turn 0 recomputes the canonical state —
 * which is what a resyncing client does, the same way a reloaded page rejoins.
 * The clock stops for everyone meanwhile (the odd ones out count as loading).
 *
 * The majority is the state to keep; a tie goes to the group holding the
 * lowest slot, so the choice never depends on message order.
 */
function startResync(room: Room, tick: number, byTick: Map<number, number>, groups: Map<number, number[]>): void {
  const report = [...byTick.entries()].map(([s, h]) => `${s}:${h}`).join(' ');
  let best: number[] = [];
  for (const slots of groups.values()) {
    const sorted = [...slots].sort((a, b) => a - b);
    if (sorted.length > best.length || (sorted.length === best.length && (best[0] ?? Infinity) > sorted[0]!)) {
      best = sorted;
    }
  }
  const odd = room.members.filter((m) => !m.gone && !best.includes(m.slot));
  room.resyncs++;
  log(`room ${room.code} DESYNC at tick ${tick}: ${report} — resync ${room.resyncs} for slot(s) ${odd.map((m) => m.slot).join(',')}`);

  // A match that keeps diverging is diverging for a reason a replay cannot
  // fix; say so once rather than reloading everyone forever.
  if (room.resyncs > MAX_RESYNCS) {
    room.desynced = true;
    broadcast(room, { t: 'desync', tick });
    return;
  }

  room.hashes.clear();
  room.resyncing = true;
  for (const m of odd) {
    m.loaded = false;
    m.loadingSince = Date.now();
  }
  broadcast(room, { t: 'resync', tick, slots: odd.map((m) => m.slot), attempt: room.resyncs });
  updateClock(room);
}

// ── Messages ─────────────────────────────────────────────────────────────────

function resume(client: Client, msg: Extract<ClientMessage, { t: 'resume' }>): void {
  const fail = (message: string): void => {
    send(client, { t: 'error', message });
    client.ws.close();
  };
  if (msg.version !== PROTOCOL_VERSION) return fail('Versión del juego distinta a la del servidor. Recarga la página.');
  const room = rooms.get(String(msg.code ?? '').toUpperCase());
  const member = room?.members.find((m) => m.token !== '' && m.token === msg.token);
  if (!room || !member || member.gone) return fail('La partida ya no está disponible');
  const have = Number.isInteger(msg.haveTurn) ? Math.max(0, Math.min(msg.haveTurn, room.turn)) : 0;

  // Takes over the seat. If the old socket is somehow still open (a second
  // tab), it is closed: one seat, one connection.
  const old = member.client;
  if (old !== client && old.ws.readyState === WebSocket.OPEN) {
    old.room = null;
    old.ws.close();
  }
  client.name = old.name;
  client.greeted = true;
  client.room = room;
  member.client = client;
  member.connected = true;
  member.loaded = false;
  member.disconnectedAt = null;
  member.loadingSince = Date.now();

  send(client, { t: 'welcome', id: client.id });
  // A client with nothing (a reloaded page) must rebuild the match first.
  if (have === 0) send(client, startMessage(room, member));
  send(client, { t: 'history', turns: room.history.filter((r) => r.n > have), last: room.turn });
  log(`room ${room.code}: ${client.name} resumed from turn ${have} of ${room.turn}`);
  updateClock(room);
}

function handle(client: Client, msg: ClientMessage): void {
  if (msg.t === 'resume') {
    if (!client.greeted) resume(client, msg);
    return;
  }
  if (!client.greeted && msg.t !== 'hello') return;
  const room = client.room;
  const member = room?.members.find((m) => m.client === client);

  switch (msg.t) {
    case 'hello': {
      if (msg.version !== PROTOCOL_VERSION) {
        send(client, { t: 'error', message: 'Versión del juego distinta a la del servidor. Recarga la página.' });
        client.ws.close();
        return;
      }
      client.name = String(msg.name ?? '').trim().slice(0, 20) || 'Jugador';
      client.greeted = true;
      send(client, { t: 'welcome', id: client.id });
      return;
    }
    case 'list':
      send(client, { t: 'rooms', rooms: summaries() });
      return;
    case 'create': {
      const mode: RoomMode = msg.mode in ROOM_CAPACITY ? msg.mode : '1v1';
      leaveRoom(client);
      const created = newRoom(mode, client.id);
      rooms.set(created.code, created);
      joinRoom(client, created);
      return;
    }
    case 'join': {
      const target = rooms.get(String(msg.code ?? '').trim().toUpperCase());
      if (!target) return send(client, { t: 'error', message: 'No existe ninguna sala con ese código' });
      joinRoom(client, target);
      return;
    }
    case 'leave':
      leaveRoom(client);
      return;
    case 'pick': {
      if (!room || !member || room.started) return;
      if (!HERO_KEYS.includes(msg.hero)) return;
      member.hero = msg.hero;
      publishRoom(room);
      return;
    }
    case 'team': {
      if (!room || !member || room.started) return;
      const team = msg.team === 1 ? 1 : 0;
      if (member.team === team) return;
      // Sides stay even: a 2v2 with three on one side is not a 2v2.
      if (room.members.filter((m) => m.team === team).length >= ROOM_CAPACITY[room.mode] / 2) {
        return send(client, { t: 'error', message: 'Ese equipo está completo' });
      }
      member.team = team;
      // Changing sides is a decision worth confirming again.
      member.ready = false;
      publishRoom(room);
      return;
    }
    case 'ready': {
      if (!room || !member || room.started) return;
      member.ready = msg.ready === true && member.hero !== null;
      publishRoom(room);
      maybeStart(room);
      return;
    }
    case 'pause': {
      if (!room || !member || !room.started || member.gone) return;
      if (msg.paused === true) {
        if (member.pausedAt !== null) return;
        // Pausing while the match is already stopped for a disconnect would
        // spend a pause on time the player is not losing anyway.
        if (waitingOn(room, Date.now()).length > 0) {
          return send(client, { t: 'error', message: 'La partida ya está detenida' });
        }
        if (member.pauses <= 0) return send(client, { t: 'error', message: 'No te quedan pausas' });
        member.pauses--;
        member.pausedAt = Date.now();
        log(`room ${room.code}: ${member.client.name} paused (${member.pauses} left)`);
      } else {
        // Only the player who paused can start the match again — until the
        // pause runs out on its own.
        if (member.pausedAt === null) return;
        member.pausedAt = null;
      }
      broadcast(room, { t: 'paused', slot: member.slot, name: member.client.name, paused: member.pausedAt !== null });
      updateClock(room);
      return;
    }
    case 'loaded': {
      if (!room || !member || !room.started || member.loaded) return;
      member.loaded = true;
      member.loadingSince = null;
      // Once everyone is caught up the checksums mean something again.
      if (room.members.every((m) => m.gone || m.loaded)) room.resyncing = false;
      updateClock(room);
      return;
    }
    case 'cmd': {
      if (!room || !member || !room.started || !member.connected || member.gone) return;
      if (++member.sentThisTurn > MAX_COMMANDS_PER_TURN) return;
      const cmd = msg.cmd as { kind?: unknown } | null;
      // Shape is validated by every client identically when the command is
      // booked; the server only refuses what is obviously not a command, and
      // never lets a client act for anyone but itself.
      if (!cmd || typeof cmd !== 'object' || typeof cmd.kind !== 'string') return;
      room.pending.push({ slot: member.slot, cmd });
      return;
    }
    case 'hash':
      if (room && member && room.started && Number.isInteger(msg.tick) && Number.isInteger(msg.hash)) {
        recordHash(room, member, msg.tick, msg.hash);
      }
      return;
    case 'ping':
      send(client, { t: 'pong', at: msg.at });
      return;
  }
}

// ── HTTP: the built client, for a single-service deployment ─────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  // Two pages are served from here: the landing at `/` and the game at
  // `/play/`. A directory request resolves to the `index.html` inside it, which
  // is what turns `/play/` into the game rather than into a read of a folder.
  const asDirectory = rel === '' || url.pathname.endsWith('/');
  const path = resolve(STATIC_DIR, asDirectory ? `${rel}${rel === '' ? '' : '/'}index.html` : rel);
  // Never serve anything outside the build directory.
  if (path !== STATIC_DIR && !path.startsWith(STATIC_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' }).end(body);
  } catch {
    // Unknown paths fall back to the page they belong to: anything under
    // `/play` is the game, everything else is the landing. Falling back to the
    // landing for a game URL would drop a reconnecting player on the marketing
    // site instead of back into their match.
    try {
      const fallback = rel.startsWith('play') ? 'play/index.html' : 'index.html';
      const index = await readFile(resolve(STATIC_DIR, fallback));
      res.writeHead(200, { 'content-type': MIME['.html'] }).end(index);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Servidor de partidas activo. Cliente no compilado.');
    }
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function log(text: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
}

const http = createServer((req, res) => void serveStatic(req, res));
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_MESSAGE });

wss.on('connection', (ws) => {
  const client: Client = { id: `p${nextClientId++}`, ws, name: 'Jugador', greeted: false, room: null, alive: true };
  clients.set(client.id, client);

  ws.on('pong', () => (client.alive = true));
  ws.on('message', (data) => {
    const text = data.toString();
    if (text.length > MAX_MESSAGE) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    handle(client, msg);
  });
  ws.on('close', () => {
    dropClient(client);
    clients.delete(client.id);
  });
});

// Dead connections (a closed laptop lid, a pulled cable) never send `close`;
// ping them out so the disconnect is noticed within seconds, not minutes.
setInterval(() => {
  for (const client of clients.values()) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, 5000);

http.listen(PORT, () => {
  log(`servidor de partidas en http://localhost:${PORT} (ws: /ws, turno ${TURN_MS} ms = ${TURN_TICKS} ticks, gracia ${GRACE_MS / 1000} s)`);
});
