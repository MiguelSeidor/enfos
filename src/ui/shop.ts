/**
 * Shop panel. Owner: UI.
 *
 * Opens when the hero stands at a shop and closes when they walk away, so the
 * base has a reason to be a place you go rather than a menu you summon. There is
 * no hotkey to open it from the lane on purpose: walking back to shop is a real
 * decision that costs wave time, which is what makes gold interesting.
 *
 * Rows are built once and then only their affordability state is updated, so an
 * open shop costs nothing per frame beyond a handful of class toggles.
 */

import { glyph as paint } from './icons';
import { setTip } from './tooltip';
import type { ShopItem } from '@/economy/items';

export interface ShopCallbacks {
  buy: (itemId: string) => { ok: boolean; reason?: string };
  owned: (itemId: string) => number;
  purse: (currency: 'gold' | 'influence') => number;
}

interface Row {
  root: HTMLElement;
  item: ShopItem;
  cost: HTMLElement;
  owned: HTMLElement;
  affordable: boolean | null;
}

export class ShopPanel {
  readonly root: HTMLElement;
  /** Closing is proximity-driven; opening is not. See `open`. */
  private readonly listEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly purseEl: HTMLElement;
  private rows: Row[] = [];
  private currentKind: 'hero' | 'sabotage' | null = null;

  constructor(private readonly callbacks: ShopCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'shop ui-panel ui-gilt is-hidden';

    const head = document.createElement('div');
    head.className = 'shop-head';
    this.titleEl = document.createElement('h3');
    this.purseEl = document.createElement('span');
    this.purseEl.className = 'shop-purse';
    head.append(this.titleEl, this.purseEl);

    this.listEl = document.createElement('div');
    this.listEl.className = 'shop-list';

    const foot = document.createElement('div');
    foot.className = 'shop-foot';
    foot.textContent = 'Aléjate de la tienda para cerrar';

    this.root.append(head, this.listEl, foot);
  }

  get isOpen(): boolean {
    return this.currentKind !== null;
  }

  /** Rebuilds the list only when the shop actually changes. */
  open(kind: 'hero' | 'sabotage', items: ShopItem[]): void {
    if (this.currentKind === kind) return;
    this.currentKind = kind;
    this.titleEl.textContent = kind === 'hero' ? 'T1 · Pertrechos del héroe' : 'T2 · Cámara del sabotaje';
    this.root.classList.remove('is-hidden');
    this.root.classList.toggle('is-sabotage', kind === 'sabotage');
    this.build(items);
  }

  close(): void {
    if (this.currentKind === null) return;
    this.currentKind = null;
    this.root.classList.add('is-hidden');
  }

  private build(items: ShopItem[]): void {
    this.listEl.replaceChildren();
    this.rows = [];

    for (const item of items) {
      const row = document.createElement('button');
      row.className = 'shop-item';

      const glyph = document.createElement('span');
      glyph.className = 'shop-icon';
      glyph.innerHTML = paint(item.id, item.icon, 22);

      const body = document.createElement('span');
      body.className = 'shop-body';
      const name = document.createElement('b');
      name.textContent = item.name;
      const desc = document.createElement('i');
      desc.textContent = item.description;
      body.append(name, desc);

      // Sabotage entries carry their counterplay in the tooltip: the GDD
      // requires every sabotage to have one, so the player should be able to
      // read it before spending.
      const counter = (item as { counterplay?: string }).counterplay;
      setTip(row, {
        head: item.name,
        body: item.description,
        meta: `${item.cost} ${item.currency === 'influence' ? 'influencia' : 'oro'}`,
        warn: counter ? `Contrajuego: ${counter}` : undefined,
      });

      const cost = document.createElement('span');
      cost.className = 'shop-cost';

      const owned = document.createElement('span');
      owned.className = 'shop-owned';

      row.append(glyph, body, cost, owned);
      row.addEventListener('click', () => this.onBuy(item));
      this.listEl.appendChild(row);

      this.rows.push({ root: row, item, cost, owned, affordable: null });
    }
  }

  private onBuy(item: ShopItem): void {
    const result = this.callbacks.buy(item.id);
    if (!result.ok && result.reason) {
      // Flash the row rather than opening a dialog: the reason is short and the
      // player's attention belongs on the lane, not on a modal.
      const row = this.rows.find((r) => r.item.id === item.id);
      if (row) {
        row.root.classList.remove('is-denied');
        // Reflow so the animation restarts on a repeated click.
        void row.root.offsetWidth;
        row.root.classList.add('is-denied');
        row.root.dataset.reason = result.reason;
      }
    }
    this.refresh();
  }

  /** Called each frame while open; only writes when a value changed. */
  refresh(): void {
    if (this.currentKind === null) return;

    const currency = this.currentKind === 'hero' ? 'gold' : 'influence';
    const purse = this.callbacks.purse(currency);
    const label = currency === 'gold' ? 'oro' : 'influencia';
    const purseText = `${Math.floor(purse)} ${label}`;
    if (this.purseEl.textContent !== purseText) this.purseEl.textContent = purseText;

    for (const row of this.rows) {
      const held = this.callbacks.owned(row.item.id);
      // Only gear can be "already owned" — it is unique. Potions and books have
      // no ownership limit, so they never grey out for that reason.
      const maxed = row.item.kind === 'gear' && held > 0;
      const affordable = !maxed && purse >= row.item.cost;

      if (row.affordable !== affordable) {
        row.affordable = affordable;
        row.root.classList.toggle('is-affordable', affordable);
        row.root.classList.toggle('is-locked', !affordable);
      }

      const costText = maxed ? 'EN USO' : String(row.item.cost);
      if (row.cost.textContent !== costText) row.cost.textContent = costText;

      // Potions show how many are carried; gear and books show nothing, because
      // a count of 1 next to a unique item is noise.
      const ownedText = row.item.kind === 'potion' && held > 0 ? `×${held}` : '';
      if (row.owned.textContent !== ownedText) row.owned.textContent = ownedText;
    }
  }
}
