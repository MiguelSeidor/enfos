/**
 * Attribute spending panel. Owner: UI.
 *
 * Only appears when there is something to spend, and pulses while points are
 * waiting. An always-visible panel with "0 points" is noise; a panel that shows
 * up exactly when a decision is available is a prompt.
 *
 * The panel is a thin view: it never tracks its own point count, it reads the
 * progression module every frame. Two sources of truth for the same number is
 * how a UI ends up letting a player spend points they no longer have.
 */

import { ATTRIBUTES, type AttributeId } from '@/gameplay/progression';

export interface LevelPanelCallbacks {
  unspent: () => number;
  allocated: () => Record<AttributeId, number>;
  spend: (attribute: AttributeId) => boolean;
  level: () => number;
}

export class LevelPanel {
  readonly root: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly rows: { id: AttributeId; tally: HTMLElement }[] = [];
  private lastUnspent = -1;

  constructor(private readonly callbacks: LevelPanelCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'levelup ui-panel ui-gilt is-hidden';

    const head = document.createElement('div');
    head.className = 'levelup-head';
    const title = document.createElement('h3');
    title.textContent = 'Puntos de atributo';
    this.countEl = document.createElement('span');
    this.countEl.className = 'levelup-count';
    head.append(title, this.countEl);
    this.root.appendChild(head);

    for (const attr of ATTRIBUTES) {
      const row = document.createElement('button');
      row.className = 'levelup-row';

      const body = document.createElement('span');
      body.className = 'levelup-body';
      const name = document.createElement('b');
      name.textContent = attr.name;
      const desc = document.createElement('i');
      desc.textContent = attr.description;
      body.append(name, desc);

      const tally = document.createElement('span');
      tally.className = 'levelup-tally';

      row.append(body, tally);
      row.addEventListener('click', () => {
        this.callbacks.spend(attr.id);
        this.refresh();
      });
      this.root.appendChild(row);
      this.rows.push({ id: attr.id, tally });
    }
  }

  /**
   * Opened from the command card's yellow cross, not automatically.
   *
   * It used to appear the instant a level landed, which stole the screen
   * mid-fight. The cross lights up instead and the player chooses when to spend.
   */
  open(): void {
    if (this.callbacks.unspent() > 0) this.root.classList.remove('is-hidden');
  }

  close(): void {
    this.root.classList.add('is-hidden');
  }

  refresh(): void {
    const unspent = this.callbacks.unspent();
    if (unspent !== this.lastUnspent) {
      this.lastUnspent = unspent;
      // Only ever auto-closes. Opening is the player's call.
      if (unspent <= 0) this.root.classList.add('is-hidden');
      this.countEl.textContent = String(unspent);
    }
    if (unspent <= 0) return;

    const allocated = this.callbacks.allocated();
    for (const row of this.rows) {
      const value = String(allocated[row.id] ?? 0);
      if (row.tally.textContent !== value) row.tally.textContent = value;
    }
  }
}
