/**
 * Connection to the match server. Owner: NET.
 *
 * A thin typed wrapper over the browser WebSocket. It knows nothing about the
 * game: the lobby listens to room messages, the session to turns.
 */

import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from './protocol';

type Handler = (msg: ServerMessage) => void;

/** Same origin, `/ws`. In development Vite proxies it to the local server. */
export function defaultServerUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/ws`;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<Handler>();
  /** Assigned by the server on `welcome`. */
  id: string | null = null;
  onClose: (() => void) | null = null;

  constructor(private readonly url = defaultServerUrl()) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.id !== null;
  }

  /** Opens the socket and says hello. Resolves once the server has welcomed us. */
  connect(name: string): Promise<void> {
    if (this.connected) return Promise.resolve();
    return this.open({ t: 'hello', name, version: PROTOCOL_VERSION });
  }

  /**
   * Opens a fresh socket and claims a seat in a running match. The server
   * answers with `welcome`, then (from turn 0) `start`, then `history`.
   */
  resume(code: string, token: string, haveTurn: number): Promise<void> {
    this.close();
    return this.open({ t: 'resume', code, token, haveTurn, version: PROTOCOL_VERSION });
  }

  private open(greeting: ClientMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      };
      ws.addEventListener('open', () => ws.send(JSON.stringify(greeting)));
      ws.addEventListener('message', (event) => {
        // A replaced socket may still deliver a last message; it is stale.
        if (ws !== this.ws) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if (msg.t === 'welcome') {
          this.id = msg.id;
          if (!settled) {
            settled = true;
            resolve();
          }
        } else if (msg.t === 'error' && !settled) {
          fail(msg.message);
        }
        // A copy: a handler may subscribe another (the lobby creating the
        // session on `start`), and that one must not receive this message too.
        for (const handler of [...this.handlers]) handler(msg);
      });
      ws.addEventListener('error', () => fail('No se pudo conectar con el servidor de partidas'));
      ws.addEventListener('close', () => {
        fail('Conexión cerrada');
        // Only the live socket closing is news. A socket this client replaced
        // or closed on purpose closing late must not trigger a reconnect.
        if (ws !== this.ws) return;
        this.ws = null;
        this.id = null;
        this.onClose?.();
      });
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Subscribes to every server message. Returns the unsubscribe. */
  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Closes on purpose: `onClose` does not fire. */
  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.id = null;
    ws?.close();
  }
}
