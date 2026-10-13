/**
 * In-game HUD. Owner: UI agent.
 *
 * Reads a `HudModel` rather than reaching into gameplay directly, so the panels
 * exist and are reviewable before combat, economy and progression are wired.
 * When those subsystems land they feed the same model — no HUD rewrite.
 *
 * Everything is plain DOM over the canvas. At the unit counts this game targets,
 * a canvas-drawn UI would compete with the renderer for the same frame budget
 * for no visual gain; the browser composites DOM on its own layer.
 *
 * The refresh path only writes to the DOM when a value actually changed —
 * `refresh()` runs every frame, and unconditional writes to `textContent` would
 * force layout 60 times a second for numbers that change once a wave.
 */

import { clamp01 } from '@/core/mathx';
import type {
  DamageType,
  EntityId,
  GameContext,
  GameModule,
  MatchState,
  TeamId,
  Vec2,
} from '@/core/contracts';
import {
  RenderKey,
  TerrainKey,
  UiKey,
  type RenderService,
  type UiService,
} from '@/core/services';
import { drawCrest, glyph as glyphFor, heroPortrait, icon, type IconId } from './icons';
import { Minimap, type MinimapCallbacks } from './minimap';
import type { AttributeId, InvocationStatus } from '@/gameplay';
import { WorldHud } from './worldHud';
import { LABELLED_LANDMARKS } from '@/world';
import { landmark, type LandmarkKind } from '@/world/layout';
import { Tooltip, setTip } from './tooltip';
import { playback } from '@/core/playback';
import './defeat.css';

/** Label colour per landmark, matching each building's own accent. */
const LABEL_ACCENT: Partial<Record<LandmarkKind, string>> = {
  core: '#5aa9ff',
  fountain: '#37d7ff',
  shopProgression: '#d8b45a',
  shopSabotage: '#b98ce0',
};

export interface AbilitySlot {
  key: string;
  name: string;
  icon: IconId;
  /** Ability id, for the painted plate. Falls back to `icon` without it. */
  art?: string;
  cooldown: number;
  cooldownLeft: number;
}

/** Everything the HUD draws. Gameplay owns the values; the HUD only reads. */
export interface HudModel {
  heroName: string;
  /**
   * Player powers, drawn under the purse. Not hero abilities: every hero has
   * the same two, they cost gold rather than mana, and their cooldown is a
   * countdown the player watches rather than a bar on a kit.
   */
  invocations: InvocationStatus[];
  /**
   * The hero's def id, for the painted portrait. The box used to draw a crest
   * from hardcoded colours and never knew which hero it belonged to.
   */
  heroArt?: string;
  level: number;
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
  xp: number;
  xpToNext: number;
  gold: number;
  influence: number;
  wave: number;
  waveTotal: number;
  /** Seconds until the next wave, or -1 during a wave. */
  countdown: number;
  coreLives: number;
  coreMaxLives: number;
  abilities: AbilitySlot[];
  /** Seconds until the downed hero returns, or -1 while alive. */
  reviveCountdown: number;
  /**
   * Team-mates, for the panel that lets you hand them things.
   *
   * Empty in a one-player match, which is why the panel hides itself rather
   * than reserving a corner: most matches have nobody to give anything to.
   */
  allies: { id: number; name: string; art?: string; health: number; maxHealth: number; alive: boolean }[];
  /**
   * Items lying on the field that this team may pick up.
   *
   * Carried in the model rather than read from the economy, because the HUD
   * reads a model and nothing else — see the note at the top of this file.
   */
  drops: { id: number; name: string; pos: Vec2; inRange: boolean }[];
  /** Items owned, in inventory-slot order. */
  inventory: { name: string; icon: IconId; count: number; itemId: string }[];
  /** What the fourth box shows: the hero's orders, or a shop's stock. */
  command: { title: string; slots: CommandSlot[] };
  /** The match is over and the local team lost. */
  defeated: boolean;
  /** The match is over and the local team won. */
  victorious: boolean;
  /** Online match: the end screen talks about the rival, not only the waves. */
  versus: boolean;
  /** Why the match ended, so the end screen can say so. */
  endCause: 'core' | 'forfeit' | 'waves' | null;
  /**
   * Sabotages in progress. `against` true: the rival did it to this team;
   * false: this team did it to the rival. `seconds` -1 for one without a timer.
   */
  sabotage: { name: string; against: boolean; seconds: number }[];
  /**
   * Combat figures for the stat box, split into what the hero is and what its
   * gear adds. Shown as "50 + 147", which is the only presentation that lets a
   * player tell a good item from a good level.
   */
  stats: {
    attackDamage: number;
    attackSpeed: number;
    armor: number;
    spellPower: number;
    moveSpeed: number;
  };
  /** Same fields, holding `stats − baseStats`. Zeroes render as nothing. */
  statBonus: {
    attackDamage: number;
    attackSpeed: number;
    armor: number;
    spellPower: number;
    moveSpeed: number;
  };
  /** Points spent per attribute, not the derived bonuses. */
  /**
   * Typed from the attribute list rather than spelled out, so a new attribute
   * cannot be added to the game and silently missed here. Adding the fourth
   * needed four separate edits before this.
   */
  attributes: Record<AttributeId, number>;
  /** Unspent attribute points. */
  attributePoints: number;
}

export function createHudModel(): HudModel {
  return {
    heroName: '—',
    invocations: [],
    heroArt: undefined,
    level: 1,
    health: 1,
    maxHealth: 1,
    mana: 1,
    maxMana: 1,
    xp: 0,
    xpToNext: 1,
    gold: 0,
    influence: 0,
    wave: 0,
    waveTotal: 60,
    countdown: -1,
    coreLives: 1,
    coreMaxLives: 1,
    abilities: [],
    reviveCountdown: -1,
    allies: [],
    drops: [],
    inventory: [],
    command: { title: 'Órdenes', slots: [] },
    defeated: false,
    victorious: false,
    versus: false,
    endCause: null,
    sabotage: [],
    stats: { attackDamage: 0, attackSpeed: 0, armor: 0, spellPower: 0, moveSpeed: 0 },
    statBonus: { attackDamage: 0, attackSpeed: 0, armor: 0, spellPower: 0, moveSpeed: 0 },
    attributes: { power: 0, vitality: 0, focus: 0, reach: 0 },
    attributePoints: 0,
  };
}

/** Inventory size. Every hero has exactly this many slots. */
export const INVENTORY_SLOTS = 9;

/**
 * How long a gold gain keeps absorbing further gains, in milliseconds.
 *
 * Long enough to swallow a wave dying together, short enough that two separate
 * kills a second apart still read as two events.
 */
const GOLD_COALESCE_MS = 550;

/** Caches the last written string per element so refresh can skip no-op writes. */
class TextCell {
  private last = '\0';
  constructor(private readonly el: HTMLElement) {}
  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.el.textContent = value;
  }
}

/**
 * The hero's name, written as two parts: the name itself and the epithet that
 * follows the comma. Small layouts hide the epithet, which is why it cannot
 * simply be one string.
 */
class NameCell {
  private last = '\0';
  constructor(
    private readonly main: HTMLElement,
    private readonly title: HTMLElement,
  ) {}
  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    const comma = value.indexOf(',');
    this.main.textContent = comma < 0 ? value : value.slice(0, comma);
    this.title.textContent = comma < 0 ? '' : value.slice(comma);
  }
}

class BarCell {
  private last = -1;
  constructor(
    private readonly fill: HTMLElement,
    private readonly label?: TextCell,
  ) {}
  set(value: number, max: number, text?: string): void {
    const pct = Math.round(clamp01(max > 0 ? value / max : 0) * 1000) / 10;
    if (pct !== this.last) {
      this.last = pct;
      this.fill.style.width = `${pct}%`;
    }
    this.label?.set(text ?? `${Math.ceil(value)} / ${Math.ceil(max)}`);
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

/**
 * One button on the command card.
 *
 * Deliberately flat and presentational: the HUD does not know what an "order"
 * or a "purchase" is, it renders `slots` and reports the clicked `id` back.
 * That is what lets the same card serve the hero and both shops without the
 * HUD growing a branch per case.
 */
export interface CommandSlot {
  id: string;
  kind: 'ability' | 'order' | 'levelup' | 'item';
  label: string;
  icon: IconId;
  /**
   * The ability's or item's own id, which `id` cannot stand in for: it is
   * `ability.0` here because the ability module is index-based, and `buy.x`
   * for a shop row. Absent on orders and level-ups, which have no painted art.
   */
  art?: string;
  tooltip?: string;
  hotkey?: string;
  /** Ability cooldowns; both omitted for orders and items. */
  cooldown?: number;
  cooldownLeft?: number;
  cost?: number;
  currency?: 'gold' | 'influence';
  /** Abilities only. Shown in the tooltip and printed on the button. */
  manaCost?: number;
  /** How an aimed ability is targeted, e.g. "Área de 5,5 m · alcance 16 m". */
  aim?: string;
  /** Greyed out and unclickable — unaffordable, already owned, no points. */
  disabled?: boolean;
  /** Why it is disabled. Shown in the tooltip's warning line. */
  reason?: string;
  /** Draws attention: unspent level-up points, an item already carried. */
  highlight?: boolean;
}

type StatRowId =
  | 'damage'
  | 'attackSpeed'
  | 'armor'
  | 'spellPower'
  | 'moveSpeed'
  | 'power'
  | 'vitality'
  | 'focus';

/**
 * The stat panel's contents.
 *
 * Offence, defence and the three attributes — the numbers a player checks
 * before deciding whether to push or to shop. Regen, crit and the resist
 * soft-caps are deliberately absent: they are derived values that would double
 * the panel's height for information that does not change a decision mid-wave.
 */
const STAT_ROWS: { id: StatRowId; label: string; icon: IconId; tip: string }[] = [
  {
    id: 'damage',
    label: 'Daño',
    icon: 'sword',
    tip: 'Daño de cada ataque básico, antes de restar la armadura del objetivo.',
  },
  {
    id: 'attackSpeed',
    label: 'Vel. ataque',
    icon: 'bolt',
    tip: 'Ataques por segundo. Multiplica tu daño sostenido sin aumentar el golpe.',
  },
  {
    id: 'armor',
    label: 'Armadura',
    icon: 'shield',
    tip: 'Reduce el daño físico recibido. Cada punto vale más cuanta más vida tengas.',
  },
  {
    id: 'spellPower',
    label: 'P. hechizo',
    icon: 'spark',
    tip: 'Aumenta el daño y la curación de tus habilidades Q, W, E y R.',
  },
  {
    id: 'moveSpeed',
    label: 'Velocidad',
    icon: 'boot',
    tip: 'Metros por segundo. Decide si llegas a tiempo a una fuga y si puedes huir.',
  },
  {
    id: 'power',
    label: 'Poder',
    icon: 'fist',
    tip: 'Atributo. Cada punto da +4 de daño de ataque y +6 de poder de hechizo.',
  },
  {
    id: 'vitality',
    label: 'Vitalidad',
    icon: 'heart',
    tip: 'Atributo. Cada punto da +55 de vida máxima y +2 de armadura.',
  },
  {
    id: 'focus',
    label: 'Enfoque',
    icon: 'eye',
    tip: 'Atributo. Cada punto da maná máximo y reduce el enfriamiento de tus habilidades.',
  },
];

/** A class on the HUD root, which mobile.css turns into an open tray. */
type TrayState = 'is-map-open' | 'is-bag-open' | 'is-stats-open';

/**
 * The three boxes a landscape phone cannot keep on screen permanently, and the
 * toggles that bring them back.
 *
 * Every glyph is a 24x24 path drawn in `currentColor`, matching icons.ts so the
 * rail is made of the same line weight as the command card beside it.
 */
const TRAYS: { state: TrayState; label: string; glyph: string }[] = [
  {
    state: 'is-map-open',
    label: 'Mostrar u ocultar el mapa',
    // A framed map with two location pins.
    glyph:
      '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M3 3h18v18H3V3Zm2 2v14h14V5H5Zm3.2 2.4a1.9 1.9 0 0 1 1.9 1.9c0 1.4-1.9 3.6-1.9 3.6' +
      'S6.3 10.7 6.3 9.3a1.9 1.9 0 0 1 1.9-1.9Zm7.6 5a1.9 1.9 0 0 1 1.9 1.9c0 1.4-1.9 3.6-1.9 3.6s-1.9-2.2-1.9-3.6' +
      'a1.9 1.9 0 0 1 1.9-1.9Z"/></svg>',
  },
  {
    state: 'is-bag-open',
    label: 'Abrir o cerrar la mochila',
    // A satchel with its carrying strap.
    glyph:
      '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M6 7V5a6 6 0 0 1 12 0v2h3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7h3Zm2 0h8V5' +
      'a4 4 0 0 0-8 0v2ZM5 9v11h14V9H5Z"/></svg>',
  },
  {
    state: 'is-stats-open',
    label: 'Mostrar u ocultar los atributos',
    // A ruled list, one bullet and one line per attribute.
    glyph:
      '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M4 5h3v3H4V5Zm5 .5h11v2H9v-2ZM4 10.5h3v3H4v-3Zm5 .5h11v2H9v-2ZM4 16h3v3H4v-3Z' +
      'm5 .5h11v2H9v-2Z"/></svg>',
  },
];

/**
 * Two stacked coins, for the button that hands gold to a team-mate.
 *
 * Written here rather than in icons.ts for the reason given above `TRAYS`:
 * that module is the game's `IconId`-indexed set, used by abilities and items,
 * and this is HUD chrome no ability can ever legitimately reference.
 */
const COIN_GLYPH =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<ellipse cx="12" cy="8" rx="7" ry="3.4" fill="currentColor" opacity="0.55"/>' +
  '<path fill="currentColor" d="M5 8v3.2c0 1.9 3.1 3.4 7 3.4s7-1.5 7-3.4V8c0 1.9-3.1 3.4-7 3.4' +
  'S5 9.9 5 8Zm0 5.6v3.2c0 1.9 3.1 3.4 7 3.4s7-1.5 7-3.4v-3.2c0 1.9-3.1 3.4-7 3.4s-7-1.5-7-3.4Z"/></svg>';

export class Hud {
  readonly root: HTMLElement;
  private readonly waveValue: TextCell;
  private readonly waveTimer: TextCell;
  private readonly goldValue: TextCell;
  private readonly influenceValue: TextCell;
  private readonly heroName: NameCell;
  private portraitArt!: HTMLImageElement;
  private portraitArtFor = '';
  private readonly levelValue: TextCell;
  private readonly healthBar: BarCell;
  private readonly manaBar: BarCell;
  private readonly xpBar: BarCell;
  private readonly corePips: HTMLElement;
  private readonly minimapBox: HTMLElement;
  private readonly commandEl: HTMLElement;
  private readonly commandTitle: TextCell;
  private readonly inventoryEl: HTMLElement;
  /**
   * What each slot currently holds, so a click knows what it used and a drag
   * knows what it carries.
   *
   * Every filled slot is recorded, not only the drinkable ones: gear cannot be
   * clicked but it can be handed over, and the earlier version stored `null`
   * for it, which made a sword undraggable.
   */
  private renderedInventoryItems: ({ itemId: string; usable: boolean } | null)[] = [];
  private readonly onUseItem: (itemId: string) => void;
  private readonly onCommand: (id: string) => void;
  private readonly onGiveGold: (toId: number, amount: number) => void;
  private readonly onGiveItem: (toId: number, itemId: string) => void;
  private readonly alliesEl: HTMLElement;
  private allyCards: {
    root: HTMLElement;
    /** Mutated per frame: the card is reused, the hero in it may not be. */
    id: EntityId;
    /** The name in plain text, for the gift dialog's heading. */
    label: string;
    name: TextCell;
    art: HTMLImageElement;
    artFor: string;
    bar: BarCell;
  }[] = [];
  /** When the last drag finished, so the click it produces can be ignored. */
  private dragEndedAt = 0;
  private readonly goldDialog: HTMLElement;
  private readonly goldInput: HTMLInputElement;
  private goldTarget: EntityId = -1;
  /** The player's own gold, so the gift dialog can cap what it offers. */
  private playerGold = 0;
  private commandCells: {
    root: HTMLElement;
    cd: HTMLElement;
    text: TextCell;
    lastReady: boolean;
    lastTurn: number;
    /** Cached tooltip signature, so attributes are written only on change. */
    lastTip: string;
  }[] = [];
  private renderedCommands = '';
  private readonly downed: HTMLElement;
  private readonly downedCount: TextCell;
  private readonly defeat: HTMLElement;
  private readonly defeatWave: TextCell;
  private readonly sabotageStrip: HTMLElement;
  private readonly waveBanner: HTMLElement;
  private renderedSabotage = '';
  private readonly defeatTitle: TextCell;
  private readonly defeatReason: TextCell;
  private readonly toasts: HTMLElement;
  private renderedInventory = '';
  private readonly statsEl: HTMLElement;
  private readonly statCells = new Map<StatRowId, TextCell>();
  private readonly statBonusCells = new Map<StatRowId, TextCell>();
  private readonly statsBox: HTMLElement | null;
  private renderedPips = -1;
  private defeatDelay = 0;
  private readonly goldGain: HTMLElement;
  /**
   * The tally currently being shown, if one is still accumulating.
   *
   * Kills arrive in clusters — a wave dies in a second — and one element per
   * bounty would stack eight overlapping "+12"s. Gains inside the coalesce
   * window are added to the live element instead, so the player sees "+96"
   * once rather than a column of noise.
   */
  private goldGainCell: { el: HTMLElement; total: number; until: number } | null = null;
  /** Rail toggles, kept so `aria-pressed` can follow the open tray. */
  private readonly trayButtons: { el: HTMLButtonElement; state: TrayState }[] = [];

  constructor(
    showStats: boolean,
    callbacks: {
      useItem: (itemId: string) => void;
      command: (id: string) => void;
      giveGold?: (toId: number, amount: number) => void;
      giveItem?: (toId: number, itemId: string) => void;
    } = {
      useItem: () => {},
      command: () => {},
    },
  ) {
    this.onUseItem = callbacks.useItem;
    this.onCommand = callbacks.command;
    this.onGiveGold = callbacks.giveGold ?? (() => {});
    this.onGiveItem = callbacks.giveItem ?? (() => {});
    this.root = el('div', 'hud');

    // ── Top left: the Core, and under it the team-mates.
    //
    // A column rather than two panels each pinned to the corner. The Core box
    // changes height with the root font size, so anything placed below it by a
    // fixed offset either overlaps it or floats away from it at some window
    // size; stacked, they cannot.
    const leftColumn = el('div', 'hud-left');
    const core = el('div', 'hud-core ui-panel ui-gilt');
    core.appendChild(el('div', 'label', 'Integridad del Núcleo'));
    this.corePips = el('div', 'pips');
    core.appendChild(this.corePips);
    leftColumn.appendChild(core);

    // Built empty: most matches are one player and the panel then takes no
    // room at all. `refresh` creates one card per ally the first time the
    // roster has a size, which is also how it copes with a 3v3 without the
    // HUD knowing what the team sizes are.
    this.alliesEl = el('div', 'hud-allies is-hidden');
    leftColumn.appendChild(this.alliesEl);
    this.root.appendChild(leftColumn);

    // ── Wave banner (top centre)
    const wave = el('div', 'hud-wave ui-panel ui-gilt');
    this.waveBanner = wave;
    const waveLabelBox = el('div');
    waveLabelBox.appendChild(el('div', 'label', 'Oleada'));
    const waveValueEl = el('div', 'value', '0 / 60');
    waveLabelBox.appendChild(waveValueEl);
    wave.appendChild(waveLabelBox);
    wave.appendChild(el('div', 'divider'));
    const timerEl = el('div', 'timer', '--:--');
    wave.appendChild(timerEl);
    this.root.appendChild(wave);
    this.waveValue = new TextCell(waveValueEl);
    this.waveTimer = new TextCell(timerEl);

    // ── Sabotage strip, under the banner: what the rival has done to this
    //    team and what this team has done to the rival, with time left.
    this.sabotageStrip = el('div', 'hud-sabotage');
    this.root.appendChild(this.sabotageStrip);

    // ── Resources (top right)
    const res = el('div', 'hud-resources');
    const goldBox = el('div', 'res gold ui-panel');
    goldBox.appendChild(el('span', 'dot'));
    const goldEl = el('span', undefined, '0');
    goldBox.appendChild(goldEl);
    // Influence is what sabotage is bought with, so the counter is also the
    // door to it: the shop can be used from anywhere on the field, and a
    // player who has to walk home to press a button cannot use that.
    const infBox = el('button', 'res influence ui-panel is-shop');
    infBox.type = 'button';
    infBox.appendChild(el('span', 'dot'));
    const infEl = el('span', undefined, '0');
    infBox.appendChild(infEl);
    setTip(infBox, {
      head: 'Influencia',
      body: 'Clic para abrir la tienda de sabotaje, estés donde estés · S',
    });
    infBox.addEventListener('click', () => callbacks.command('shop.sabotage'));
    res.append(goldBox, infBox);
    this.root.appendChild(res);
    this.goldValue = new TextCell(goldEl);
    this.influenceValue = new TextCell(infEl);

    // Bounties are announced here rather than over the corpse, where they used
    // to cover the killing blow's damage number.
    this.goldGain = el('div', 'gold-gain');
    goldBox.appendChild(this.goldGain);

    // ── How much gold to hand over.
    //
    // A dialog rather than a drag like the items use: a quantity has no
    // gesture, and the player asked for a figure typed in with an accept and a
    // cancel. Enter accepts and Escape cancels, because a box with a text
    // field in it that ignores the keyboard reads as broken.
    this.goldDialog = el('div', 'hud-gift is-hidden');
    this.goldDialog.innerHTML =
      '<div class="hud-gift-plate ui-panel ui-gilt">' +
      '<b class="hud-gift-title">Entregar oro</b>' +
      '<i class="hud-gift-to"></i>' +
      '<input class="hud-gift-amount" type="number" min="1" step="1" value="100">' +
      '<span class="hud-gift-purse"></span>' +
      '<div class="hud-gift-row">' +
      '<button class="menu-btn is-compact hud-gift-ok" type="button">Aceptar</button>' +
      '<button class="menu-btn is-compact hud-gift-cancel" type="button">Cancelar</button>' +
      '</div></div>';
    this.goldInput = this.goldDialog.querySelector('.hud-gift-amount') as HTMLInputElement;
    this.goldDialog
      .querySelector('.hud-gift-ok')!
      .addEventListener('click', () => this.confirmGift());
    this.goldDialog
      .querySelector('.hud-gift-cancel')!
      .addEventListener('click', () => this.closeGift());
    this.goldInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') this.confirmGift();
      else if (ev.key === 'Escape') this.closeGift();
      // The match listens for Q/W/E/R and Space on the window. Typing 100 into
      // a box should not also cast and pause the game.
      ev.stopPropagation();
    });
    // Clicking the backdrop dismisses it, the same as cancel.
    this.goldDialog.addEventListener('click', (ev) => {
      if (ev.target === this.goldDialog) this.closeGift();
    });
    this.root.appendChild(this.goldDialog);

    // ── Defeat screen. Covers everything and takes pointer events, so the
    //    match is genuinely over rather than merely announced.
    this.defeat = el('div', 'hud-defeat is-hidden');
    this.defeat.innerHTML =
      '<div class="hud-defeat-plate">' +
      '<b class="hud-defeat-title">HAS PERDIDO</b>' +
      '<i class="hud-defeat-reason">El Núcleo ha sido destruido</i>' +
      '<span class="hud-defeat-wave"></span>' +
      '<button class="menu-btn is-compact hud-defeat-leave">Volver al menú</button>' +
      '</div>';
    this.defeat
      .querySelector('.hud-defeat-leave')!
      .addEventListener('click', () => callbacks.command('match.leave'));
    this.defeatWave = new TextCell(this.defeat.querySelector('.hud-defeat-wave')!);
    this.defeatTitle = new TextCell(this.defeat.querySelector('.hud-defeat-title')!);
    this.defeatReason = new TextCell(this.defeat.querySelector('.hud-defeat-reason')!);
    this.root.appendChild(this.defeat);

    // ── Downed overlay: revive countdown, centre screen
    this.downed = el('div', 'hud-downed is-hidden');
    this.downed.innerHTML =
      '<b>HÉROE CAÍDO</b><span class="hud-downed-count">--</span>' +
      '<i>Reaparece en el Núcleo</i>';
    this.downedCount = new TextCell(this.downed.querySelector('.hud-downed-count')!);
    this.root.appendChild(this.downed);

    // ── The command bar: four boxes along the bottom.
    //
    // Ordered the way the RTS convention established and the player asked for:
    // minimap, hero, inventory, command card. Everything the player acts on is
    // in one strip, so no reading of opposite screen corners mid-wave.
    const bar = el('div', 'hud-bar');

    // Box 1: minimap. `HudModule` mounts the map here once terrain exists — the
    // frame is built now so the bar's layout never reflows mid-match.
    this.minimapBox = el('div', 'hud-box box-minimap ui-panel ui-gilt');
    bar.appendChild(this.minimapBox);

    // Box 2: the hero — portrait, level, name, bars, and the numbers. This is
    // one box, not two: the player asked for the portrait and the stats
    // together, which is also what makes the box self-contained.
    const heroBox = el('div', 'hud-box box-hero ui-panel ui-gilt');
    const portrait = el('div', 'portrait');
    const crest = el('canvas');
    drawCrest(crest, 0x2a3550, 0xc8a253, 7);
    portrait.appendChild(crest);
    this.portraitArt = document.createElement('img');
    this.portraitArt.className = 'portrait-art';
    this.portraitArt.alt = '';
    this.portraitArt.draggable = false;
    this.portraitArt.hidden = true;
    portrait.appendChild(this.portraitArt);
    const levelEl = el('div', 'level', '1');
    portrait.appendChild(levelEl);
    // Clicking the portrait drops whatever else the player was commanding and
    // puts the camera back on the hero. With a pack of conjured creeps under
    // orders there was no way back except clicking the hero's own body, and
    // missing it quietly left the next right-click with the creeps.
    portrait.classList.add('is-focusable');
    setTip(portrait, { head: 'Tu héroe', body: 'Clic para volver a él · F' });
    portrait.addEventListener('click', () => callbacks.command('hero.focus'));
    heroBox.appendChild(portrait);

    const vitals = el('div', 'vitals');
    // Split rather than one string: "Talon, Ojo de la Espesura" has no room on
    // a phone and truncating it to "TALON, OJO DE L..." reads as a bug. The
    // title is its own element so the small layouts can simply drop it and keep
    // the name whole.
    const nameEl = el('div', 'name');
    const nameMainEl = el('b', 'name-main', '—');
    const nameTitleEl = el('span', 'name-title');
    nameEl.append(nameMainEl, nameTitleEl);
    vitals.appendChild(nameEl);

    const healthBarEl = el('div', 'bar health');
    const healthFill = el('i');
    const healthText = el('span');
    healthBarEl.append(healthFill, healthText);
    const manaBarEl = el('div', 'bar mana');
    const manaFill = el('i');
    const manaText = el('span');
    manaBarEl.append(manaFill, manaText);
    const xpBarEl = el('div', 'bar xp');
    const xpFill = el('i');
    xpBarEl.appendChild(xpFill);
    vitals.append(healthBarEl, manaBarEl, xpBarEl);

    this.statsEl = el('div', 'hud-stats');
    for (const row of STAT_ROWS) {
      // A real element per row, not `display: contents`. The row has to be a
      // tooltip host, and a contents box has no rectangle to hover.
      const line = el('div', 'stat-row');
      setTip(line, { head: row.label, body: row.tip });
      const glyph = el('span', 'stat-icon');
      glyph.innerHTML = icon(row.icon, 14);
      line.appendChild(glyph);
      line.appendChild(el('span', 'stat-label', row.label));
      // Base and bonus are separate cells so the "+" only appears when there is
      // something added, and so the two can be coloured differently.
      const value = el('span', 'stat-value', '—');
      const bonus = el('span', 'stat-bonus');
      line.append(value, bonus);
      this.statsEl.appendChild(line);
      this.statCells.set(row.id, new TextCell(value));
      this.statBonusCells.set(row.id, new TextCell(bonus));
    }
    // The list is wrapped rather than appended straight to the vitals column
    // because a phone has to be able to lift it out of the hero box and show it
    // as a tray: an absolutely positioned panel needs a box of its own to be,
    // and the grid cannot both flow inside the column and float above it.
    // Outside the touch layouts the wrapper is `display: contents`, so on a
    // desktop window the grid is still a direct flex child of `.vitals` and the
    // frame classes it carries paint nothing. See mobile.css.
    const statsSheet = el('div', 'hud-stats-sheet ui-panel ui-gilt');
    statsSheet.append(el('div', 'box-title', 'Atributos'), this.statsEl);
    vitals.appendChild(statsSheet);
    heroBox.appendChild(vitals);
    bar.appendChild(heroBox);

    this.heroName = new NameCell(nameMainEl, nameTitleEl);
    this.levelValue = new TextCell(levelEl);
    this.healthBar = new BarCell(healthFill, new TextCell(healthText));
    this.manaBar = new BarCell(manaFill, new TextCell(manaText));
    this.xpBar = new BarCell(xpFill);

    // Box 3: inventory. Clicking a slot uses the item — that is the only way to
    // drink a potion, so the slots are buttons rather than swatches.
    const invBox = el('div', 'hud-box box-inventory ui-panel ui-gilt');
    invBox.appendChild(el('div', 'box-title', 'Inventario'));
    this.inventoryEl = el('div', 'hud-inventory');
    for (let i = 0; i < INVENTORY_SLOTS; i++) {
      const slot = el('button', 'inv-slot');
      slot.appendChild(el('span', 'inv-glyph'));
      slot.appendChild(el('span', 'inv-count'));
      slot.addEventListener('click', () => {
        // A drag that ended back on its own slot still fires a click. Without
        // this, handing a potion over and changing your mind would drink it.
        if (performance.now() - this.dragEndedAt < 250) return;
        const entry = this.renderedInventoryItems[i];
        if (entry?.usable) this.onUseItem(entry.itemId);
      });
      // Handing an item over is a drag onto the team-mate's portrait, which is
      // what the player asked for and also the only gesture that cannot be
      // confused with drinking the potion in the same slot.
      slot.addEventListener('pointerdown', (ev) => {
        const entry = this.renderedInventoryItems[i];
        if (!entry || ev.button !== 0) return;
        this.beginDrag(slot, ev, entry.itemId);
      });
      this.inventoryEl.appendChild(slot);
    }
    invBox.appendChild(this.inventoryEl);
    bar.appendChild(invBox);

    // Box 4: command card. Contents depend on what is selected — the hero's
    // orders and abilities, or a shop's stock. Built empty and filled by
    // `refresh` from `model.command`, so the HUD owns no game rules.
    const cmdBox = el('div', 'hud-box box-command ui-panel ui-gilt');
    this.commandTitle = new TextCell(cmdBox.appendChild(el('div', 'box-title', 'Órdenes')));
    this.commandEl = el('div', 'hud-command');
    cmdBox.appendChild(this.commandEl);
    bar.appendChild(cmdBox);

    // ── The touch rail.
    //
    // A phone in landscape is 390 px tall and the four boxes need 240 of them,
    // so on that screen three of the four stop being permanent boxes and become
    // trays the player opens: the map, the bag and the attribute list. The rail
    // is the three toggles that open them, and it is `display: none` at every
    // other size, so a desktop window is not affected by any of this.
    //
    // The glyphs are written out here rather than added to icons.ts because
    // that module is the game's shared icon set, indexed by `IconId` and used
    // by abilities and items; these three are chrome that only the touch layout
    // ever draws, and adding them there would make every consumer of that union
    // carry three ids it can never legitimately use.
    const rail = el('div', 'hud-rail');
    for (const tray of TRAYS) {
      const btn = el('button', 'hud-rail-btn ui-panel ui-gilt', tray.glyph);
      btn.type = 'button';
      btn.setAttribute('aria-label', tray.label);
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => this.toggleTray(tray.state));
      this.trayButtons.push({ el: btn, state: tray.state });
      rail.appendChild(btn);
    }
    bar.appendChild(rail);

    this.root.appendChild(bar);

    // ── Toasts
    this.toasts = el('div', 'hud-toasts');
    this.root.appendChild(this.toasts);

    // ── Perf readout. Distinct class from the hero stat panel above, which
    // also wants to be called "stats" but is part of the game, not the harness.
    this.statsBox = showStats ? el('div', 'hud-perf ui-panel') : null;
    if (this.statsBox) this.root.appendChild(this.statsBox);
  }

  /**
   * One card per team-mate.
   *
   * Rebuilt rather than reconciled: the roster changes at most once a match,
   * when the second player's hero spawns, so the cheap thing to optimise here
   * is the per-frame path, and that one only writes values that changed.
   */
  private buildAllyCards(count: number): void {
    this.allyCards = [];
    this.alliesEl.textContent = '';
    for (let i = 0; i < count; i++) {
      const root = el('div', 'ally ui-panel ui-gilt');

      const portrait = el('div', 'ally-portrait');
      const crest = el('canvas');
      drawCrest(crest, 0x2a3550, 0xc8a253, 5);
      portrait.appendChild(crest);
      const art = document.createElement('img');
      art.className = 'ally-art';
      art.alt = '';
      // Without this the browser's own image drag starts instead of the
      // slot's, and the drop never arrives.
      art.draggable = false;
      art.hidden = true;
      portrait.appendChild(art);
      // Only visible while an item is in flight: a permanent "drop here" label
      // on a portrait would be noise for the whole match. Three letters,
      // because the portrait is 46 px and "Entregar" rendered as "ENTREG".
      portrait.appendChild(el('span', 'ally-drop', 'Dar'));
      root.appendChild(portrait);

      const info = el('div', 'ally-info');
      const nameEl = el('div', 'ally-name', '—');
      const barEl = el('div', 'bar health');
      const fill = el('i');
      const hpText = el('span');
      barEl.append(fill, hpText);
      info.append(nameEl, barEl);
      root.appendChild(info);

      const coin = el('button', 'ally-gold', COIN_GLYPH);
      coin.type = 'button';
      coin.setAttribute('aria-label', 'Entregar oro');
      root.appendChild(coin);

      const card = {
        root,
        id: -1 as EntityId,
        label: '',
        name: new TextCell(nameEl),
        art,
        artFor: '',
        bar: new BarCell(fill, new TextCell(hpText)),
      };

      setTip(coin, { head: 'Entregar oro', body: 'Elige cuánto le pasas' });
      coin.addEventListener('click', () => this.openGift(card.id, card.label));

      // The drop target is the whole card, not just the portrait: the player
      // described dragging onto the portrait, and a 48 px square is a mean
      // target for a gesture whose failure silently does nothing. `beginDrag`
      // finds it by hit-testing for `.ally`, so nothing is bound here.
      this.allyCards.push(card);
      this.alliesEl.appendChild(root);
    }
  }

  /**
   * Carries one item from a slot to a team-mate's portrait.
   *
   * Pointer events rather than the HTML5 drag API, which does not exist on
   * touch at all — and this game ships a phone layout. One implementation
   * serves the mouse and the finger, and it is the same code path in both,
   * so a bug here cannot hide on one of them.
   */
  private beginDrag(slot: HTMLElement, down: PointerEvent, itemId: string): void {
    const startX = down.clientX;
    const startY = down.clientY;
    let armed = false;
    let hot: HTMLElement | null = null;

    const ghost = el('div', 'drag-ghost');
    ghost.innerHTML = slot.querySelector('.inv-glyph')?.innerHTML ?? '';

    /** The card under the pointer, if it can take the item. */
    const cardAt = (x: number, y: number): HTMLElement | null => {
      // The ghost is `pointer-events: none`, or every sample would hit it.
      const card = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.ally');
      return card instanceof HTMLElement && !card.classList.contains('is-dead') ? card : null;
    };

    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== down.pointerId) return;
      if (!armed) {
        // A few pixels of slop, so a click on a potion stays a click.
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
        armed = true;
        this.alliesEl.classList.add('is-dropping');
        slot.classList.add('is-dragging');
        document.body.appendChild(ghost);
      }
      ghost.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px)`;
      const card = cardAt(ev.clientX, ev.clientY);
      if (card !== hot) {
        hot?.classList.remove('is-over');
        card?.classList.add('is-over');
        hot = card;
      }
    };

    const end = (ev: PointerEvent, drop: boolean): void => {
      if (ev.pointerId !== down.pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (!armed) return;
      hot?.classList.remove('is-over');
      slot.classList.remove('is-dragging');
      this.alliesEl.classList.remove('is-dropping');
      ghost.remove();
      this.dragEndedAt = performance.now();
      const card = drop ? cardAt(ev.clientX, ev.clientY) : null;
      const to = card ? this.allyCards.find((c) => c.root === card) : undefined;
      if (to && to.id >= 0) this.onGiveItem(to.id, itemId);
    };

    const onUp = (ev: PointerEvent): void => end(ev, true);
    const onCancel = (ev: PointerEvent): void => end(ev, false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  /** Opens the amount dialog for one team-mate. */
  private openGift(id: EntityId, label: string): void {
    if (id < 0) return;
    this.goldTarget = id;
    const purse = Math.max(0, Math.floor(this.playerGold));
    this.goldDialog.querySelector('.hud-gift-to')!.textContent = `para ${label}`;
    this.goldDialog.querySelector('.hud-gift-purse')!.textContent = `Llevas ${purse} de oro`;
    this.goldInput.max = String(Math.max(1, purse));
    this.goldInput.value = String(Math.max(1, Math.min(100, purse)));
    this.goldDialog.classList.remove('is-hidden');
    this.goldInput.focus();
    this.goldInput.select();
  }

  private closeGift(): void {
    this.goldDialog.classList.add('is-hidden');
    this.goldTarget = -1;
  }

  /** Sends the gift, if the figure in the box is one. */
  private confirmGift(): void {
    const amount = Math.floor(Number(this.goldInput.value));
    const to = this.goldTarget;
    // Closed first: the economy may refuse this, and its toast should land on
    // the HUD rather than behind a dialog the player has to dismiss.
    this.closeGift();
    if (to >= 0 && Number.isFinite(amount) && amount > 0) this.onGiveGold(to, amount);
  }

  /** Where `HudModule` mounts the minimap canvas. */
  get minimapMount(): HTMLElement {
    return this.minimapBox;
  }

  /**
   * Opens one tray and closes the other two.
   *
   * Mutually exclusive because all three open into the same corner above the
   * vitals, and because two of them at once on a 390 px screen would cover the
   * battlefield the player opened them to read against. Tapping the toggle of
   * the open tray closes it, so the rail is also the way out.
   */
  private toggleTray(state: TrayState): void {
    const opening = !this.root.classList.contains(state);
    for (const tray of TRAYS) this.root.classList.remove(tray.state);
    if (opening) this.root.classList.add(state);
    for (const btn of this.trayButtons) {
      btn.el.setAttribute('aria-pressed', String(opening && btn.state === state));
    }
  }

  show(): void {
    this.root.classList.add('is-visible');
  }

  hide(): void {
    this.root.classList.remove('is-visible');
  }

  /**
   * Floats a gold gain under the counter.
   *
   * The element removes itself when its animation ends rather than on a timer,
   * so the two can never disagree about how long it is on screen.
   */
  showGoldGain(amount: number): void {
    const now = performance.now();
    if (this.goldGainCell && now < this.goldGainCell.until) {
      this.goldGainCell.total += amount;
      this.goldGainCell.el.textContent = `+${Math.round(this.goldGainCell.total)}`;
      // Restart the pop so a fresh kill re-registers on an existing tally.
      this.goldGainCell.el.classList.remove('is-bumped');
      void this.goldGainCell.el.offsetWidth;
      this.goldGainCell.el.classList.add('is-bumped');
      return;
    }

    const node = el('div', 'gold-gain-item', `+${Math.round(amount)}`);
    node.addEventListener('animationend', () => {
      node.remove();
      if (this.goldGainCell?.el === node) this.goldGainCell = null;
    });
    this.goldGain.appendChild(node);
    this.goldGainCell = { el: node, total: amount, until: now + GOLD_COALESCE_MS };
  }

  notify(text: string, severity: 'info' | 'warn' | 'danger' | 'reward'): void {
    const node = el('div', `toast ${severity}`, text);
    this.toasts.appendChild(node);
    setTimeout(() => node.remove(), 2600);
  }

  /**
   * Rebuilds the command card.
   *
   * Only called when the slot *set* changes — cooldown ticks and affordability
   * are applied in place by `refresh`, because a card that rebuilds every frame
   * loses the browser's hover state and cannot be clicked reliably.
   */
  private rebuildCommands(slots: CommandSlot[]): void {
    this.commandEl.replaceChildren();
    this.commandCells = [];
    for (const slot of slots) {
      // `cmd-` prefix, not the bare kind. `ability` and `levelup` are already
      // the class names of the old ability bar and of the level-up panel, and
      // those rules sized these buttons at 42 px and 180 px respectively —
      // which is how the R key and the yellow cross ended up outside the box.
      const node = el('button', `command cmd-${slot.kind}`);
      if (slot.hotkey) node.appendChild(el('div', 'key', slot.hotkey));
      node.appendChild(el('div', 'glyph', glyphFor(slot.art, slot.icon, 28)));
      if (slot.cost !== undefined) {
        node.appendChild(el('div', `cost ${slot.currency ?? 'gold'}`, String(slot.cost)));
      } else if (slot.manaCost) {
        node.appendChild(el('div', 'cost mana', String(slot.manaCost)));
      }
      const cd = el('div', 'cd');
      const cdText = el('div', 'cd-text');
      node.append(cd, cdText);
      node.addEventListener('click', () => this.onCommand(slot.id));
      this.commandEl.appendChild(node);
      this.commandCells.push({
        root: node,
        cd,
        text: new TextCell(cdText),
        lastReady: true,
        lastTurn: -1,
        lastTip: '',
      });
    }
  }

  refresh(model: HudModel, stats?: { fps: number; drawCalls: number; triangles: number }): void {
    // Past the last authored wave the count says nothing; that the match is in
    // overtime says everything.
    const sudden = model.wave > model.waveTotal;
    this.waveValue.set(sudden ? 'MUERTE SÚBITA' : `${model.wave} / ${model.waveTotal}`);
    this.waveBanner.classList.toggle('is-sudden', sudden);
    this.waveTimer.set(
      model.countdown < 0
        ? 'En curso'
        : `${String(Math.floor(model.countdown / 60)).padStart(2, '0')}:${String(
            Math.floor(model.countdown % 60),
          ).padStart(2, '0')}`,
    );
    this.goldValue.set(String(Math.floor(model.gold)));
    this.influenceValue.set(String(Math.floor(model.influence)));

    // Only touch the src when the hero changes: assigning the same URL every
    // frame makes the browser re-decode it.
    const art = heroPortrait(model.heroArt) ?? '';
    if (art !== this.portraitArtFor) {
      this.portraitArtFor = art;
      if (art) this.portraitArt.src = art;
      this.portraitArt.hidden = !art;
    }
    this.heroName.set(model.heroName);
    this.levelValue.set(String(model.level));
    this.healthBar.set(model.health, model.maxHealth);
    this.manaBar.set(model.mana, model.maxMana);
    this.xpBar.set(model.xp, model.xpToNext, '');

    // `TextCell` skips writes that would not change anything, so pushing all
    // eight rows every frame costs eight string compares.
    const s = model.stats;
    const b = model.statBonus;
    // Bonuses are rendered by the same rounding as the base, so "50 + 0" can
    // never appear from a bonus that rounds away to nothing.
    const setStat = (id: StatRowId, base: number, bonus: number, decimals = 0): void => {
      const fmt = (v: number): string => (decimals > 0 ? v.toFixed(decimals) : String(Math.round(v)));
      this.statCells.get(id)!.set(fmt(base));
      const shown = fmt(bonus);
      this.statBonusCells.get(id)!.set(Number(shown) > 0 ? `+ ${shown}` : '');
    };
    setStat('damage', s.attackDamage - b.attackDamage, b.attackDamage);
    setStat('attackSpeed', s.attackSpeed - b.attackSpeed, b.attackSpeed, 2);
    setStat('armor', s.armor - b.armor, b.armor);
    setStat('spellPower', s.spellPower - b.spellPower, b.spellPower);
    setStat('moveSpeed', s.moveSpeed - b.moveSpeed, b.moveSpeed);
    setStat('power', model.attributes.power, 0);
    setStat('vitality', model.attributes.vitality, 0);
    setStat('focus', model.attributes.focus, 0);
    // Unspent points are the one thing here the player must act on, so the box
    // announces them rather than leaving them to the level-up panel alone.
    this.statsEl.classList.toggle('has-points', model.attributePoints > 0);
    this.statsEl.dataset.points = model.attributePoints > 0 ? `+${model.attributePoints}` : '';

    if (model.coreMaxLives !== this.renderedPips) {
      this.renderedPips = model.coreMaxLives;
      this.corePips.replaceChildren();
      for (let i = 0; i < model.coreMaxLives; i++) this.corePips.appendChild(el('div', 'pip'));
    }
    const pips = this.corePips.children;
    for (let i = 0; i < pips.length; i++) {
      (pips[i] as HTMLElement).classList.toggle('spent', i >= model.coreLives);
    }

    // ── Command card
    this.commandTitle.set(model.command.title);
    // Rebuild only when the slot set itself changed, not on cooldown ticks or
    // affordability flips — those are applied in place below.
    const signature = model.command.slots.map((s) => s.id + s.icon + (s.hotkey ?? '')).join('|');
    if (signature !== this.renderedCommands) {
      this.renderedCommands = signature;
      this.rebuildCommands(model.command.slots);
    }
    for (let i = 0; i < this.commandCells.length; i++) {
      const cell = this.commandCells[i]!;
      const slot = model.command.slots[i]!;
      const cooldown = slot.cooldown ?? 0;
      const left = slot.cooldownLeft ?? 0;
      const ready = left <= 0 && !slot.disabled;
      if (ready !== cell.lastReady) {
        cell.lastReady = ready;
        cell.root.classList.toggle('ready', ready);
        cell.root.classList.toggle('is-locked', !!slot.disabled);
        (cell.root as HTMLButtonElement).disabled = !!slot.disabled;
      }
      cell.root.classList.toggle('is-highlight', !!slot.highlight);

      // Tooltip contents, refreshed in place. Cost, cooldown and availability
      // all change while the cursor sits still, and a tip written once at build
      // time would keep insisting an ability is on cooldown after it is ready.
      const meta = [
        slot.hotkey ? `Tecla ${slot.hotkey}` : '',
        slot.aim ?? '',
        slot.manaCost !== undefined && slot.manaCost > 0 ? `${slot.manaCost} de maná` : '',
        slot.cooldown ? `${slot.cooldown} s de enfriamiento` : '',
        slot.cost !== undefined
          ? `${slot.cost} ${slot.currency === 'influence' ? 'influencia' : 'oro'}`
          : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const warn =
        left > 0
          ? `Listo en ${Math.ceil(left)} s`
          : slot.disabled
            ? (slot.reason ?? 'No disponible')
            : '';
      const signature = `${slot.label}|${slot.tooltip ?? ''}|${meta}|${warn}`;
      if (signature !== cell.lastTip) {
        cell.lastTip = signature;
        setTip(cell.root, { head: slot.label, body: slot.tooltip, meta, warn });
      }

      // Quantise the sweep to 1/60 turn so we only touch style on real change.
      const turn = cooldown > 0 && left > 0 ? Math.round((left / cooldown) * 60) / 60 : 0;
      if (turn !== cell.lastTurn) {
        cell.lastTurn = turn;
        cell.cd.style.setProperty('--cd', `${turn}turn`);
      }
      cell.text.set(left > 0 ? String(Math.ceil(left)) : '');
    }

    // Sabotage strip. Rebuilt only when the text changes — the seconds tick
    // once a second, not once a frame.
    const chips = model.sabotage.map((s) => ({
      cls: s.against ? 'is-against' : 'is-ours',
      text: `${s.against ? '⚠ ' : '➤ '}${s.name}${s.against ? '' : ' al rival'}${s.seconds >= 0 ? ` · ${Math.ceil(s.seconds)} s` : ''}`,
    }));
    const sabotageSignature = chips.map((c) => c.cls + c.text).join('|');
    if (sabotageSignature !== this.renderedSabotage) {
      this.renderedSabotage = sabotageSignature;
      this.sabotageStrip.replaceChildren(...chips.map((c) => el('span', `hud-sabotage-chip ${c.cls}`, '')));
      chips.forEach((c, i) => (this.sabotageStrip.children[i]!.textContent = c.text));
    }

    // Defeat. Shown after a beat so the explosion is seen before the screen is
    // covered — announcing the loss over the frame the Core is still intact
    // reads as the UI pre-empting the event.
    if (model.defeated || model.victorious) {
      this.defeatDelay += 1 / 60;
      if (this.defeatDelay > 1.6) {
        this.defeat.classList.remove('is-hidden');
        this.defeat.classList.toggle('is-victory', model.victorious);
        if (model.victorious) {
          this.defeatTitle.set('VICTORIA');
          this.defeatReason.set(
            model.endCause === 'forfeit'
              ? 'Tu rival ha abandonado la partida'
              : model.endCause === 'waves'
                ? model.versus
                  ? 'Tu Núcleo resistió mejor que el del rival'
                  : 'Has resistido todas las oleadas'
                : 'El Núcleo rival ha caído antes que el tuyo',
          );
        } else {
          this.defeatTitle.set('HAS PERDIDO');
          this.defeatReason.set(
            model.endCause === 'forfeit'
              ? 'Has abandonado la partida'
              : model.endCause === 'waves'
                ? 'El Núcleo rival resistió mejor que el tuyo'
                : model.versus
                  ? 'Tu Núcleo ha caído antes que el del rival'
                  : 'El Núcleo ha sido destruido',
          );
        }
        const survived = model.victorious && !model.versus ? model.wave : Math.max(0, model.wave - 1);
        this.defeatWave.set(`Superaste ${survived} de ${model.waveTotal} oleadas`);
      }
    } else {
      this.defeatDelay = 0;
      this.defeat.classList.add('is-hidden');
    }

    // Revive countdown.
    const downed = model.reviveCountdown >= 0;
    this.downed.classList.toggle('is-hidden', !downed);
    if (downed) this.downedCount.set(String(Math.ceil(model.reviveCountdown)));

    // Team-mates. The panel hides itself when there is nobody to give
    // anything to, which is every single-player match.
    this.playerGold = model.gold;
    if (model.allies.length !== this.allyCards.length) this.buildAllyCards(model.allies.length);
    this.alliesEl.classList.toggle('is-hidden', model.allies.length === 0);
    for (let i = 0; i < this.allyCards.length; i++) {
      const ally = model.allies[i]!;
      const card = this.allyCards[i]!;
      card.id = ally.id;
      card.label = ally.name;
      card.name.set(ally.name);
      const allyArt = heroPortrait(ally.art) ?? '';
      if (allyArt !== card.artFor) {
        card.artFor = allyArt;
        if (allyArt) card.art.src = allyArt;
        card.art.hidden = !allyArt;
      }
      card.bar.set(Math.max(0, ally.health), ally.maxHealth);
      card.root.classList.toggle('is-dead', !ally.alive);
    }
    // A dialog left open over a hero who has died or disconnected would send
    // gold nowhere, so it closes itself.
    if (
      this.goldTarget >= 0 &&
      !model.allies.some((a) => a.id === this.goldTarget && a.alive)
    ) {
      this.closeGift();
    }

    // Inventory. Rebuilt only when the contents change, not per frame.
    // The ally count is part of the signature because the tooltip changes when
    // there is somebody to hand things to.
    const invSignature =
      `${model.allies.length}:` + model.inventory.map((i) => `${i.itemId}x${i.count}`).join('|');
    if (invSignature !== this.renderedInventory) {
      this.renderedInventory = invSignature;
      this.renderedInventoryItems = [];
      const slots = this.inventoryEl.children;
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i] as HTMLElement;
        const entry = model.inventory[i];
        const glyph = slot.querySelector('.inv-glyph')!;
        const count = slot.querySelector('.inv-count')!;
        slot.classList.toggle('is-filled', entry !== undefined);
        // Only consumables respond to a click; gear is passive, and a slot that
        // looks pressable but does nothing is worse than one that does not.
        const usable = entry !== undefined && entry.count > 0 && entry.itemId.startsWith('potion.');
        slot.classList.toggle('is-usable', usable);
        const handover = model.allies.length > 0 ? ' · Arrastra al aliado para dárselo' : '';
        setTip(
          slot,
          entry
            ? {
                head: entry.name,
                meta: entry.count > 1 ? `Llevas ${entry.count}` : undefined,
                body: (usable ? 'Clic para usar' : 'Equipado — efecto permanente') + handover,
              }
            : null,
        );
        glyph.innerHTML = entry ? glyphFor(entry.itemId, entry.icon, 26) : '';
        count.textContent = entry && entry.count > 1 ? String(entry.count) : '';
        slot.classList.toggle('is-draggable', entry !== undefined);
        this.renderedInventoryItems.push(entry ? { itemId: entry.itemId, usable } : null);
      }
    }

    if (this.statsBox && stats) {
      this.statsBox.innerHTML =
        `<b>${stats.fps.toFixed(0)}</b> fps · ` +
        `<b>${stats.drawCalls}</b> draws · ` +
        `<b>${(stats.triangles / 1000).toFixed(0)}k</b> tris`;
    }
  }
}

export interface HudOptions {
  mount: HTMLElement;
  model: HudModel;
  showStats: boolean;
  statsSource: () => { fps: number; drawCalls: number; triangles: number };
  /** Minimap click target and camera viewport source. */
  minimap: MinimapCallbacks;
  /** Id of the hero the local player controls, for bar and mana highlighting. */
  playerHeroId: () => EntityId | null;
  /** Hands gold to a team-mate. */
  giveGold: (toId: EntityId, amount: number) => void;
  /** Hands one item to a team-mate; it lands at their feet if they are full. */
  giveItem: (toId: EntityId, itemId: string) => void;
  /** The local player's team; messages addressed to the other team are hidden. */
  localTeam: () => TeamId;
  /** Unit the player has clicked, drawn with a target reticle. */
  selectedUnitId?: () => EntityId | null;
  /** Unit under the cursor, outlined so hovering reads without a cursor swap. */
  hoveredUnitId?: () => EntityId | null;
  /** Conjured allies the player has picked out, for their ground rings. */
  pickedSummons?: () => EntityId[];
  /** An inventory slot was clicked; the id is the item to consume. */
  useItem: (itemId: string) => void;
  /** A command-card button was clicked; the id is the slot's own id. */
  command: (id: string) => void;
}

/**
 * HUD module. Owns the DOM and republishes it as `UiService` so gameplay can
 * push notifications without importing the UI layer.
 *
 * Runs at order 870 — after `hudSync` (860) has mirrored simulation state into
 * the model, and after the camera (850) has settled, so the world overlay
 * projects against the transform that is about to be rendered rather than the
 * previous frame's.
 */
export class HudModule implements GameModule {
  readonly id = 'hud';
  readonly order = 870;

  private hud!: Hud;
  private tooltip!: Tooltip;
  private minimap!: Minimap;
  private world!: WorldHud;
  private lanes: Vec2[][] = [];

  /**
   * Player settings applied to the HUD's own widgets.
   *
   * Stored rather than read from a settings object each frame because `init`
   * runs after the options panel is built: the panel calls this before the
   * widgets exist, and the values have to survive until they do.
   */
  private pending: { minimap: boolean; damageNumbers: boolean } = {
    minimap: true,
    damageNumbers: true,
  };

  /** The dropped item under a screen point, for the click that picks it up. */
  dropAt(x: number, y: number): number | null {
    return this.world?.dropAt(x, y) ?? null;
  }

  /** Drops the move-order cross on the ground. Ignored before the world exists. */
  markMoveOrder(pos: { x: number; z: number }): void {
    this.world?.markMoveOrder(pos);
  }

  applySettings(s: { minimap: boolean; damageNumbers: boolean }): void {
    this.pending = { minimap: s.minimap, damageNumbers: s.damageNumbers };
    if (this.minimap) this.minimap.root.classList.toggle('is-hidden', !s.minimap);
    if (this.world) this.world.showNumbers = s.damageNumbers;
  }
  private match!: MatchState;
  private hint!: HTMLElement;
  private ctx!: GameContext;
  /**
   * Resolved on first use, not in `init`. The render pipeline registers at
   * order 900 and this module inits at 870, so `get(RenderKey)` here would
   * throw. Anything a module needs from a *later* order must be looked up
   * lazily or injected — see the order table in ARCHITECTURE.md.
   */
  private renderService: RenderService | null = null;

  constructor(private readonly opts: HudOptions) {}

  private get render(): RenderService {
    if (!this.renderService) this.renderService = this.ctx.services.get(RenderKey);
    return this.renderService;
  }

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.match = ctx.match;
    const terrain = ctx.services.get(TerrainKey);
    // Every fork of both sites, so the minimap shows each team's approach.
    this.lanes = [];
    for (const team of [0, 1] as const) {
      for (let route = 0; ; route++) {
        const path = terrain.lanePath(team, route);
        if (path.length === 0) break;
        this.lanes.push(path);
      }
    }

    this.hud = new Hud(this.opts.showStats, {
      useItem: (itemId) => this.opts.useItem(itemId),
      command: (id) => this.opts.command(id),
      giveGold: (toId, amount) => this.opts.giveGold(toId, amount),
      giveItem: (toId, itemId) => this.opts.giveItem(toId, itemId),
    });
    this.opts.mount.appendChild(this.hud.root);

    // Mounted on the UI root rather than inside the HUD, so it floats above
    // every panel including the shop card and the options screen.
    this.tooltip = new Tooltip(this.opts.mount);

    this.world = new WorldHud((x, z) => terrain.heightAt(x, z));
    this.hud.root.appendChild(this.world.canvas);
    this.setHomeTeam(0);

    // Into the bar's first box, not loose in the corner: the minimap is one of
    // the four boxes now, so it must share their baseline and frame.
    this.minimap = new Minimap(terrain, this.opts.minimap);
    this.hud.minimapMount.appendChild(this.minimap.root);

    // The panel may have applied settings before these widgets existed.
    this.applySettings(this.pending);

    this.hint = document.createElement('div');
    this.hint.className = 'hud-hint ui-panel';
    this.hint.innerHTML =
      '<b>Clic derecho</b> mover o atacar · <b>Q W E R</b> habilidades · ' +
      '<b>S</b> tienda de sabotaje · <b>H</b> mantener posición · ' +
      '<b>Flechas</b> / bordes desplazar · <b>Rueda</b> zoom · ' +
      '<b>Espacio</b> pausa · <b>A</b> atacar en movimiento · <b>F</b> centrar en héroe';
    this.hud.root.appendChild(this.hint);

    window.addEventListener('resize', () => this.world.resize());

    const service: UiService = {
      setPhase: () => {},
      openShop: () => {},
      closeShop: () => {},
      notify: (text, severity) => this.hud.notify(text, severity),
      refresh: (dt) => this.refreshAll(dt),
    };
    ctx.services.register(UiKey, service);

    // Several players share one simulation: a message addressed to a hero or a
    // team is shown only to that hero's owner or that team.
    ctx.bus.on('ui:notify', ({ text, severity, heroId, team }) => {
      if (playback.fastForward) return;
      if (heroId !== undefined && heroId !== this.opts.playerHeroId()) return;
      if (team !== undefined && team !== this.opts.localTeam()) return;
      this.hud.notify(text, severity);
    });
    ctx.bus.on('unit:damage', ({ amount, crit, type, pos }) => {
      if (playback.fastForward) return;
      this.world.addNumber(pos, amount, crit, type);
    });
    ctx.bus.on('unit:heal', ({ amount, pos }) => {
      if (playback.fastForward) return;
      this.world.addNumber(pos, amount, false, 0 as DamageType, true);
    });
    ctx.bus.on('unit:miss', ({ pos }) => {
      if (!playback.fastForward) this.world.addMiss(pos);
    });
    // Split deliberately: coins in the world so the kill reads, the figure on
    // the counter so it never covers the damage number.
    ctx.bus.on('unit:bounty', ({ pos, gold, heroIds }) => {
      if (playback.fastForward) return;
      this.world.addBounty(pos, gold);
      const me = this.opts.playerHeroId();
      // The counter only rises for gold this player actually received.
      if (me !== null && heroIds.includes(me)) this.hud.showGoldGain(gold);
    });
  }

  /**
   * Points the Core, fountain and shop markers at a team's half. Landmarks are
   * authored once, mirrored: team 0 holds −X, team 1 holds +X.
   */
  setHomeTeam(team: TeamId): void {
    const sign = team === 1 ? 1 : -1;
    this.world.setLandmarks(
      LABELLED_LANDMARKS.map((l) => {
        const mark = landmark(l.kind);
        return {
          text: l.text,
          pos: { x: sign * mark.u, z: mark.v },
          accent: LABEL_ACCENT[l.kind] ?? '#c8a253',
        };
      }),
    );
  }

  show(): void {
    this.hud.show();
    // The hint has done its job once the player has had time to read it.
    setTimeout(() => this.hint.classList.add('is-faded'), 11000);
  }

  private refreshAll(dt: number): void {
    this.hud.refresh(this.opts.model, this.opts.statsSource());
    // After the HUD, so a tip that is open over a button reflects the values
    // that button was just repainted with.
    this.tooltip.refresh();
    this.world.setDrops(this.opts.model.drops);
    this.world.update(
      dt,
      this.match,
      this.render,
      this.opts.playerHeroId(),
      this.opts.selectedUnitId?.() ?? null,
      this.opts.hoveredUnitId?.() ?? null,
      this.opts.localTeam(),
      this.opts.pickedSummons?.() ?? [],
    );
    this.minimap.refresh(this.match, this.lanes);
  }

  update(dt: number): void {
    this.refreshAll(dt);
  }

  dispose(): void {
    this.hud.root.remove();
  }
}
