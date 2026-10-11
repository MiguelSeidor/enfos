/**
 * Hero selection. Owner: UI agent.
 *
 * Shown from the title screen. Picking a hero is what actually starts the match:
 * gameplay cannot be constructed until it knows which hero to spawn, so this
 * screen gates `createGameplay` rather than swapping a hero afterwards.
 *
 * Each card carries the numbers a player needs to tell the two apart — role,
 * vitals, and the ability list with real cooldowns and mana costs read from the
 * gameplay definitions, not retyped here. A hero card that drifts out of sync
 * with the balance table is worse than no card.
 */

import { drawCrest, glyph, heroPortrait, type IconId } from './icons';

export interface HeroCardAbility {
  key: string;
  name: string;
  description: string;
  icon: IconId;
  /** Ability id, for the painted plate. */
  art?: string;
  cooldown: number;
  manaCost: number;
}

export interface HeroCard {
  id: string;
  name: string;
  title: string;
  role: string;
  blurb: string;
  palette: { primary: number; accent: number };
  vitals: { health: number; mana: number; damage: number; armor: number; range: number };
  abilities: HeroCardAbility[];
}

export class HeroSelect {
  readonly root: HTMLElement;
  private resolve: ((id: string) => void) | null = null;
  private selected: string;

  constructor(cards: HeroCard[]) {
    this.selected = cards[0]?.id ?? '';
    this.root = document.createElement('div');
    this.root.className = 'hero-select';

    const heading = document.createElement('div');
    heading.className = 'hero-select-head';
    heading.innerHTML = '<h2>Elige tu héroe</h2><p>Define tu papel en la defensa del Núcleo</p>';
    this.root.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'hero-grid';
    for (const card of cards) grid.appendChild(this.buildCard(card));
    this.root.appendChild(grid);

    const actions = document.createElement('div');
    actions.className = 'hero-select-actions';
    const confirm = document.createElement('button');
    confirm.className = 'menu-btn';
    confirm.textContent = 'Entrar al campo';
    confirm.addEventListener('click', () => this.confirm());
    const back = document.createElement('button');
    back.className = 'menu-btn subtle';
    back.textContent = 'Volver';
    back.addEventListener('click', () => this.close());
    actions.append(confirm, back);
    this.root.appendChild(actions);
  }

  private buildCard(card: HeroCard): HTMLElement {
    const node = document.createElement('button');
    node.className = 'hero-card ui-panel';
    node.dataset.heroId = card.id;
    if (card.id === this.selected) node.classList.add('is-selected');

    // The crest is still drawn underneath. It is what shows for a hero with no
    // painted plate yet, and it costs one canvas.
    const portrait = document.createElement('canvas');
    portrait.className = 'hero-card-portrait';
    drawCrest(portrait, card.palette.primary, card.palette.accent, card.id.length * 7);
    const painted = heroPortrait(card.id);
    const portraitBox = document.createElement('div');
    portraitBox.className = 'hero-card-portrait-box';
    portraitBox.appendChild(portrait);
    if (painted) {
      const img = document.createElement('img');
      img.className = 'hero-card-portrait-art';
      img.src = painted;
      img.alt = '';
      img.draggable = false;
      portraitBox.appendChild(img);
    }

    const header = document.createElement('div');
    header.className = 'hero-card-head';
    header.innerHTML =
      `<strong>${card.name}</strong><span>${card.title}</span><em>${card.role}</em>`;

    const blurb = document.createElement('p');
    blurb.className = 'hero-card-blurb';
    blurb.textContent = card.blurb;

    const vitals = document.createElement('div');
    vitals.className = 'hero-card-vitals';
    vitals.innerHTML =
      `<span><b>${card.vitals.health}</b> vida</span>` +
      `<span><b>${card.vitals.mana}</b> maná</span>` +
      `<span><b>${card.vitals.damage}</b> daño</span>` +
      `<span><b>${card.vitals.armor}</b> armadura</span>` +
      `<span><b>${card.vitals.range}</b> alcance</span>`;

    const abilities = document.createElement('div');
    abilities.className = 'hero-card-abilities';
    for (const a of card.abilities) {
      const row = document.createElement('div');
      row.className = 'hero-ability';
      row.innerHTML =
        `<span class="glyph">${glyph(a.art, a.icon, 20)}</span>` +
        `<span class="body"><b>${a.key} · ${a.name}</b><i>${a.description}</i></span>` +
        `<span class="cost">${a.cooldown}s · ${a.manaCost} mn</span>`;
      abilities.appendChild(row);
    }

    node.append(portraitBox, header, blurb, vitals, abilities);
    node.addEventListener('click', () => this.select(card.id));
    return node;
  }

  private select(id: string): void {
    this.selected = id;
    for (const node of this.root.querySelectorAll<HTMLElement>('.hero-card')) {
      node.classList.toggle('is-selected', node.dataset.heroId === id);
    }
  }

  private confirm(): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.root.classList.add('is-hidden');
    resolve?.(this.selected);
  }

  /** Called when the player backs out; the promise never resolves. */
  private close(): void {
    this.resolve = null;
    this.root.classList.add('is-hidden');
    this.onCancel?.();
  }

  /** Invoked when the player backs out, so the caller can restore the title. */
  onCancel: (() => void) | null = null;

  /**
   * Shows the screen and resolves with the chosen hero id.
   *
   * Deliberately does not resolve on cancel: the caller uses resolution as
   * "start the match", and a cancelled selection must not start anything.
   */
  open(): Promise<string> {
    this.root.classList.remove('is-hidden');
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  get chosen(): string {
    return this.selected;
  }
}
