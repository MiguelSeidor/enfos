/**
 * Online lobby. Owner: UI.
 *
 * Two states on one panel: outside a room (create one, join by code, or pick
 * from the open list) and inside one (both teams, hero choice, ready). When
 * the server starts the match the lobby hands the setup and the live session
 * to the caller and gets out of the way.
 *
 * Names persist in `localStorage`; nothing else about the lobby does — a room
 * belongs to the server, and a reload that pretended to still be in one would
 * be lying.
 */

import { NetClient } from '@/net/client';
import { NetSession } from '@/net/session';
import { clearResume, saveResume, type ResumeInfo } from '@/net/resume';
import { ROOM_CAPACITY, type LobbyPlayer, type RoomMode, type RoomSummary, type RoomView, type ServerMessage } from '@/net/protocol';
import type { MatchSetup } from '@/gameplay/setup';
import type { HeroCard } from './heroSelect';
import './lobby.css';

const NAME_KEY = 'nucleo-eterno.name.v1';

export interface LobbyCallbacks {
  /** The server started the match. */
  onStart: (setup: MatchSetup, session: NetSession) => void;
  onBack: () => void;
}

export class Lobby {
  readonly root: HTMLElement;
  private readonly client = new NetClient();
  private room: RoomView | null = null;
  private rooms: RoomSummary[] = [];
  private status = '';
  private busy = false;
  private name: string;
  private listTimer = 0;
  private readonly body: HTMLElement;
  /** The open-rooms list, refilled in place so a refresh never wipes what the player is typing. */
  private roomsList: HTMLElement | null = null;
  private codeDraft = '';
  private mode: RoomMode = '1v1';
  private started = false;
  private rejoining = false;

  constructor(
    private readonly heroes: HeroCard[],
    private readonly callbacks: LobbyCallbacks,
  ) {
    this.name = readName();
    this.root = document.createElement('div');
    this.root.className = 'lobby is-hidden';
    const panel = document.createElement('div');
    panel.className = 'lobby-panel ui-panel ui-gilt';
    panel.innerHTML = '<div class="lobby-head"><h2>Partida en línea</h2><p>1v1, 2v2 o 3v3 · cada equipo defiende su Núcleo</p></div>';
    this.body = document.createElement('div');
    this.body.className = 'lobby-body';
    panel.appendChild(this.body);
    this.root.appendChild(panel);

    this.client.on((msg) => this.onMessage(msg));
    this.client.onClose = () => {
      this.room = null;
      this.status = 'Desconectado del servidor';
      this.render();
    };
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('is-hidden');
  }

  /**
   * Takes back a seat in a match this browser was playing — after a reload, or
   * after the window was closed. The server replies with the match setup and
   * every turn so far, which arrives through the same `start` path as a new
   * match. Rejects when the seat is gone.
   */
  async rejoin(info: ResumeInfo): Promise<void> {
    // Set before connecting: `start` arrives straight after `welcome`, and the
    // session it creates must know it is rejoining, to look for a snapshot.
    this.rejoining = true;
    try {
      await this.client.resume(info.code, info.token, 0);
    } catch (error) {
      this.rejoining = false;
      clearResume();
      throw error;
    }
  }

  open(): void {
    this.root.classList.remove('is-hidden');
    this.status = '';
    this.render();
    void this.ensureConnected();
  }

  close(): void {
    window.clearInterval(this.listTimer);
    this.root.classList.add('is-hidden');
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.client.connected) return true;
    this.busy = true;
    this.status = 'Conectando con el servidor…';
    this.render();
    try {
      await this.client.connect(this.name);
      this.status = '';
      this.client.send({ t: 'list' });
      window.clearInterval(this.listTimer);
      // Refreshed while the player browses, so a room that just opened shows up
      // without anyone having to press a button.
      this.listTimer = window.setInterval(() => {
        if (!this.room) this.client.send({ t: 'list' });
      }, 3000);
      return true;
    } catch (error) {
      this.status = `${(error as Error).message}. ¿Está arrancado el servidor (npm run server)?`;
      return false;
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'rooms':
        this.rooms = msg.rooms;
        if (!this.room && this.roomsList) this.fillRooms();
        return;
      case 'room':
        this.room = msg.room;
        this.status = '';
        break;
      case 'error':
        this.status = msg.message;
        break;
      case 'start': {
        // One match per page. A rejoin can send `start` again; the session
        // that already exists handles what follows.
        if (this.started) return;
        this.started = true;
        saveResume(msg.code, msg.token);
        const setup: MatchSetup = {
          seed: msg.seed,
          mode: msg.mode,
          players: msg.players.map((p) => ({ slot: p.slot, team: p.team, heroKey: p.heroKey, name: p.name })),
          localSlot: msg.yourSlot,
          online: true,
        };
        // The session subscribes now, before any turn can arrive, and holds
        // turns until the match is built.
        const session = new NetSession(this.client, setup, msg.code, msg.token, this.rejoining);
        window.clearInterval(this.listTimer);
        this.close();
        this.callbacks.onStart(setup, session);
        return;
      }
      default:
        return;
    }
    if (this.isOpen) this.render();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private render(): void {
    this.body.replaceChildren();
    if (this.room) this.renderRoom(this.room);
    else this.renderBrowse();
    if (this.status) {
      const note = document.createElement('p');
      note.className = 'lobby-status';
      note.textContent = this.status;
      this.body.appendChild(note);
    }
  }

  private renderBrowse(): void {
    const connected = this.client.connected;

    const nameRow = row('Tu nombre');
    const nameInput = document.createElement('input');
    nameInput.className = 'lobby-input';
    nameInput.maxLength = 20;
    nameInput.value = this.name;
    nameInput.addEventListener('change', () => {
      this.name = nameInput.value.trim().slice(0, 20) || 'Jugador';
      writeName(this.name);
      // The server learns names on connect; reconnect so the new one shows.
      if (this.client.connected) {
        this.client.close();
        void this.ensureConnected();
      }
    });
    nameRow.control.appendChild(nameInput);
    this.body.appendChild(nameRow.root);

    const actions = document.createElement('div');
    actions.className = 'lobby-actions';
    // Mode first, then create: the size of the match is the first decision.
    const modes = document.createElement('div');
    modes.className = 'lobby-modes';
    for (const mode of ['1v1', '2v2', '3v3'] as RoomMode[]) {
      const btn = button(mode, 'lobby-mode', () => {
        this.mode = mode;
        this.render();
      });
      btn.classList.toggle('is-active', this.mode === mode);
      modes.appendChild(btn);
    }
    const modeRow = row('Tamaño de la partida');
    modeRow.control.appendChild(modes);
    this.body.appendChild(modeRow.root);

    const create = button('Crear sala', 'lobby-primary', () => this.client.send({ t: 'create', mode: this.mode }));
    create.disabled = !connected || this.busy;
    actions.appendChild(create);

    const code = document.createElement('input');
    code.className = 'lobby-input lobby-code-input';
    code.placeholder = 'CÓDIGO';
    code.maxLength = 4;
    code.value = this.codeDraft;
    code.addEventListener('input', () => {
      code.value = code.value.toUpperCase();
      this.codeDraft = code.value;
    });
    const join = button('Unirse', '', () => {
      if (code.value.trim().length === 4) this.client.send({ t: 'join', code: code.value.trim() });
    });
    join.disabled = !connected || this.busy;
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join.click();
    });
    actions.append(code, join);
    this.body.appendChild(actions);

    const listHead = document.createElement('h3');
    listHead.className = 'lobby-subhead';
    listHead.textContent = 'Salas abiertas';
    this.body.appendChild(listHead);

    const list = document.createElement('div');
    list.className = 'lobby-rooms';
    this.roomsList = list;
    this.fillRooms();
    this.body.appendChild(list);

    const foot = document.createElement('div');
    foot.className = 'lobby-foot';
    if (!connected && !this.busy) foot.appendChild(button('Reintentar', '', () => void this.ensureConnected()));
    foot.appendChild(
      button('Volver', 'subtle', () => {
        this.client.close();
        this.close();
        this.callbacks.onBack();
      }),
    );
    this.body.appendChild(foot);
  }

  private fillRooms(): void {
    const list = this.roomsList;
    if (!list) return;
    list.replaceChildren();
    if (!this.client.connected) {
      list.appendChild(empty(this.busy ? 'Conectando…' : 'Sin conexión'));
      return;
    }
    if (this.rooms.length === 0) {
      list.appendChild(empty('No hay salas abiertas. Crea una y comparte el código.'));
    }
    for (const r of this.rooms) {
      const item = button('', 'lobby-room', () => this.client.send({ t: 'join', code: r.code }));
      item.innerHTML = `<b>${escape(r.host)}</b><span>${r.mode} · ${r.players}/${r.capacity}</span><code>${r.code}</code>`;
      list.appendChild(item);
    }
  }

  private renderRoom(room: RoomView): void {
    this.roomsList = null;
    const me = room.players.find((p) => p.id === this.client.id);

    const codeBox = document.createElement('div');
    codeBox.className = 'lobby-codebox';
    codeBox.innerHTML = `<span>Código de sala</span><b>${room.code}</b><i>Compártelo con el resto</i>`;
    this.body.appendChild(codeBox);

    const teams = document.createElement('div');
    teams.className = 'lobby-teams';
    for (const team of [0, 1] as const) {
      const col = document.createElement('div');
      col.className = `lobby-team team-${team}`;
      col.innerHTML = `<h3>${team === 0 ? 'Oeste' : 'Este'}</h3>`;
      const members = room.players.filter((p) => p.team === team);
      for (const p of members) col.appendChild(this.playerRow(p, room));
      const capacity = ROOM_CAPACITY[room.mode] / 2;
      for (let i = members.length; i < capacity; i++) col.appendChild(empty('Esperando jugador…'));
      // Swapping sides, while the other one has room for you.
      if (me && me.team !== team && members.length < capacity) {
        col.appendChild(button('Cambiarme aquí', 'lobby-swap', () => this.client.send({ t: 'team', team })));
      }
      teams.appendChild(col);
    }
    this.body.appendChild(teams);

    if (me) {
      const heroHead = document.createElement('h3');
      heroHead.className = 'lobby-subhead';
      heroHead.textContent = 'Tu héroe';
      this.body.appendChild(heroHead);

      const heroes = document.createElement('div');
      heroes.className = 'lobby-heroes';
      for (const card of this.heroes) {
        const pick = button('', 'lobby-hero', () => this.client.send({ t: 'pick', hero: card.id }));
        pick.classList.toggle('is-active', me.hero === card.id);
        pick.innerHTML = `<b>${escape(card.name)}</b><span>${escape(card.role)}</span>`;
        heroes.appendChild(pick);
      }
      this.body.appendChild(heroes);
    }

    const foot = document.createElement('div');
    foot.className = 'lobby-foot';
    if (me) {
      const ready = button(me.ready ? 'Cancelar listo' : 'Listo', me.ready ? '' : 'lobby-primary', () =>
        this.client.send({ t: 'ready', ready: !me.ready }),
      );
      ready.disabled = !me.hero;
      if (!me.hero) ready.title = 'Elige un héroe primero';
      foot.appendChild(ready);
    }
    foot.appendChild(button('Salir de la sala', 'subtle', () => this.client.send({ t: 'leave' })));
    this.body.appendChild(foot);

    const full = room.players.length === ROOM_CAPACITY[room.mode];
    const hint = document.createElement('p');
    hint.className = 'lobby-status';
    hint.textContent = !full
      ? 'La partida empieza cuando la sala esté llena y todos estén listos.'
      : room.players.every((p) => p.ready)
        ? 'Empezando…'
        : 'Esperando a que todos marquen «Listo».';
    this.body.appendChild(hint);
  }

  private playerRow(p: LobbyPlayer, room: RoomView): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lobby-player';
    el.classList.toggle('is-me', p.id === this.client.id);
    el.classList.toggle('is-ready', p.ready);
    const hero = this.heroes.find((h) => h.id === p.hero)?.name ?? 'Eligiendo…';
    el.innerHTML =
      `<b>${escape(p.name)}${p.id === room.hostId ? ' <em>anfitrión</em>' : ''}</b>` +
      `<span>${escape(hero)}</span><i>${p.ready ? 'Listo' : ''}</i>`;
    return el;
  }
}

function row(label: string): { root: HTMLElement; control: HTMLElement } {
  const root = document.createElement('div');
  root.className = 'lobby-row';
  const text = document.createElement('span');
  text.textContent = label;
  const control = document.createElement('div');
  root.append(text, control);
  return { root, control };
}

function button(label: string, extra: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = `menu-btn is-compact ${extra}`.trim();
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function empty(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lobby-empty';
  el.textContent = text;
  return el;
}

/** Names come from other players; never trust them as markup. */
function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) || 'Jugador';
  } catch {
    return 'Jugador';
  }
}

function writeName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Private browsing: the name simply is not remembered.
  }
}
