/**
 * In-game tooltips. Owner: UI.
 *
 * Replaces the browser's `title` attribute everywhere in the HUD. The native
 * tooltip is wrong here for three reasons: it takes about half a second to
 * appear, it is drawn in the OS's chrome rather than the game's, and it cannot
 * carry structure — an ability needs a name, a description and a cost, and a
 * single line of grey system text flattens all three into one.
 *
 * ## How elements opt in
 *
 * Data attributes, read at hover time rather than at build time, so a button
 * whose cost or state changes each frame only has to write the attribute:
 *
 * - `data-tip`      — the heading. Required; its absence means "no tooltip".
 * - `data-tip-body` — the description line.
 * - `data-tip-meta` — a short trailing line: cost, hotkey, "already owned".
 * - `data-tip-warn` — a line rendered in the danger colour, for refusals.
 *
 * ## Why one delegated listener
 *
 * Attaching handlers per element would mean rebinding every time the command
 * card rebuilds, and the card rebuilds whenever its slot set changes. One
 * listener on the UI root survives all of that and costs nothing.
 */

import './tooltip.css';

/** Distance from the cursor, in pixels. */
const OFFSET = 16;

export class Tooltip {
  private readonly root: HTMLElement;
  private readonly headEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly warnEl: HTMLElement;
  private current: HTMLElement | null = null;
  private x = 0;
  private y = 0;

  constructor(mount: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'tip is-hidden';
    this.headEl = document.createElement('b');
    this.bodyEl = document.createElement('i');
    this.metaEl = document.createElement('span');
    this.metaEl.className = 'tip-meta';
    this.warnEl = document.createElement('span');
    this.warnEl.className = 'tip-warn';
    this.root.append(this.headEl, this.bodyEl, this.metaEl, this.warnEl);
    mount.appendChild(this.root);

    // Pointer events, not mouseenter: the card rebuilds under the cursor and a
    // pointerenter that already fired never fires again for the replacement.
    window.addEventListener('pointermove', (e) => this.onMove(e), { passive: true });
    // Anything that changes what is under the cursor without moving it.
    window.addEventListener('pointerdown', () => this.hide(), { passive: true });
    window.addEventListener('blur', () => this.hide());
  }

  private onMove(e: PointerEvent): void {
    this.x = e.clientX;
    this.y = e.clientY;

    const target = e.target as HTMLElement | null;
    const host = target?.closest<HTMLElement>('[data-tip]') ?? null;

    if (host === null) {
      this.hide();
      return;
    }
    if (host !== this.current) {
      this.current = host;
      this.fill(host);
      this.root.classList.remove('is-hidden');
    }
    // Reposition every move, not only on entry: the tooltip trails the cursor
    // within a wide button, which is what makes it feel attached to the pointer
    // rather than pinned to the element.
    this.place();
  }

  /**
   * Re-reads the hovered element's attributes.
   *
   * Called on every frame the HUD refreshes, because a cost or an availability
   * line can change while the cursor sits still — an ability coming off
   * cooldown under a stationary pointer must not keep claiming it is not ready.
   */
  refresh(): void {
    if (this.current === null) return;
    if (!this.current.isConnected) {
      this.hide();
      return;
    }
    this.fill(this.current);
  }

  private fill(host: HTMLElement): void {
    const head = host.dataset.tip ?? '';
    const body = host.dataset.tipBody ?? '';
    const meta = host.dataset.tipMeta ?? '';
    const warn = host.dataset.tipWarn ?? '';

    if (this.headEl.textContent !== head) this.headEl.textContent = head;
    if (this.bodyEl.textContent !== body) this.bodyEl.textContent = body;
    if (this.metaEl.textContent !== meta) this.metaEl.textContent = meta;
    if (this.warnEl.textContent !== warn) this.warnEl.textContent = warn;
    this.bodyEl.classList.toggle('is-empty', body === '');
    this.metaEl.classList.toggle('is-empty', meta === '');
    this.warnEl.classList.toggle('is-empty', warn === '');
  }

  /** Keeps the panel on screen, flipping rather than clamping at the edges. */
  private place(): void {
    const rect = this.root.getBoundingClientRect();
    let left = this.x + OFFSET;
    let top = this.y + OFFSET;

    // Flip left of the cursor rather than sliding, so the panel never covers
    // the thing being described.
    if (left + rect.width > window.innerWidth - 4) left = this.x - OFFSET - rect.width;
    // The HUD bar lives at the bottom, which is where most tips are triggered,
    // so flipping above the cursor is the common case rather than the edge one.
    if (top + rect.height > window.innerHeight - 4) top = this.y - OFFSET - rect.height;

    this.root.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, top)}px)`;
  }

  private hide(): void {
    if (this.current === null) return;
    this.current = null;
    this.root.classList.add('is-hidden');
  }
}

/**
 * Writes tooltip data onto an element.
 *
 * A helper rather than four assignments at each call site: the attribute names
 * are an implementation detail of this module, and `undefined` has to clear the
 * attribute rather than write the string "undefined".
 */
export function setTip(
  el: HTMLElement,
  tip: { head: string; body?: string; meta?: string; warn?: string } | null,
): void {
  if (tip === null) {
    delete el.dataset.tip;
    delete el.dataset.tipBody;
    delete el.dataset.tipMeta;
    delete el.dataset.tipWarn;
    return;
  }
  el.dataset.tip = tip.head;
  if (tip.body) el.dataset.tipBody = tip.body;
  else delete el.dataset.tipBody;
  if (tip.meta) el.dataset.tipMeta = tip.meta;
  else delete el.dataset.tipMeta;
  if (tip.warn) el.dataset.tipWarn = tip.warn;
  else delete el.dataset.tipWarn;
}
