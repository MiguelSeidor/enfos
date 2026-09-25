/**
 * Network status plate. Owner: UI.
 *
 * Covers the match while it cannot be played: waiting for a disconnected
 * rival, reconnecting this client, or replaying missed turns. Same visual
 * language as the pause plate, because to the player it is the same situation —
 * the game has stopped and says why.
 *
 * Takes pointer events while shown: orders given into a paused lockstep match
 * would be queued and fire in a burst on resume, which the player never meant.
 */

export interface NetOverlayAction {
  label: string;
  run: () => void;
}

export class NetOverlay {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly button: HTMLButtonElement;
  private action: (() => void) | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'pause-overlay net-overlay is-hidden';
    const plate = document.createElement('div');
    plate.className = 'pause-plate';
    this.title = document.createElement('b');
    this.detail = document.createElement('i');
    this.bar = document.createElement('div');
    this.bar.className = 'net-progress';
    this.fill = document.createElement('span');
    this.bar.appendChild(this.fill);
    this.button = document.createElement('button');
    this.button.className = 'menu-btn is-compact net-action';
    this.button.addEventListener('click', () => this.action?.());
    plate.append(this.title, this.detail, this.bar, this.button);
    this.root.appendChild(plate);
  }

  get visible(): boolean {
    return !this.root.classList.contains('is-hidden');
  }

  /** `progress` 0..1 shows a bar; omit it for none. */
  show(title: string, detail: string, opts: { progress?: number; action?: NetOverlayAction } = {}): void {
    this.title.textContent = title;
    this.detail.textContent = detail;
    const hasBar = opts.progress !== undefined;
    this.bar.style.display = hasBar ? '' : 'none';
    if (hasBar) this.fill.style.width = `${Math.round(Math.max(0, Math.min(1, opts.progress!)) * 100)}%`;
    this.button.style.display = opts.action ? '' : 'none';
    if (opts.action) {
      this.button.textContent = opts.action.label;
      this.action = opts.action.run;
    } else {
      // Cleared, not just hidden: a leftover label is still read aloud and
      // still copied with the plate's text.
      this.button.textContent = '';
      this.action = null;
    }
    this.root.classList.remove('is-hidden');
  }

  hide(): void {
    this.root.classList.add('is-hidden');
  }
}
