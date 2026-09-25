/**
 * Options panel. Owner: UI.
 *
 * Every control here is wired to something that actually changes: the entry was
 * greyed out for two builds because a settings menu that only stores values is
 * worse than no settings menu at all. If a setting cannot be applied, it does
 * not belong in this file.
 *
 * Values persist in `localStorage` under one key so a reload keeps the player's
 * choices, and `apply()` is called once at boot as well as on every change —
 * the stored state and the live state are never allowed to disagree.
 */

import { defaultQualityTier, type QualityTier } from '@/render/renderer';
import './options.css';

const STORAGE_KEY = 'nucleo-eterno.settings.v1';

export interface Settings {
  quality: QualityTier;
  edgeScroll: boolean;
  panSpeed: number;
  minimap: boolean;
  damageNumbers: boolean;
  masterVolume: number;
  sfxVolume: number;
  ambientVolume: number;
  musicVolume: number;
}

/**
 * A function rather than a constant because the graphics default is decided by
 * the device: a phone must not boot into the desktop tier while the player
 * waits for the menu to tell them why it is a slideshow. Anything the player
 * picks here is stored and wins over this on every later visit, so the guess is
 * only ever made once.
 */
function defaults(): Settings {
  return {
    quality: defaultQualityTier(),
    edgeScroll: true,
    panSpeed: 0.85,
    minimap: true,
    damageNumbers: true,
    masterVolume: 0.8,
    sfxVolume: 1,
    ambientVolume: 0.6,
    musicVolume: 0.5,
  };
}

const QUALITY_LABELS: Record<QualityTier, string> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  ultra: 'Ultra',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Merge rather than trust: a stored blob from an older build is missing
    // keys, and a missing key must fall back to the default, not to undefined.
    return { ...defaults(), ...parsed };
  } catch {
    return defaults();
  }
}

function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private-browsing quota failures must not take the menu down with them.
  }
}

export class OptionsPanel {
  readonly root: HTMLElement;
  private readonly settings: Settings;
  /** Called whenever a value changes, and once at boot. */
  private readonly onApply: (s: Settings) => void;
  onClose: () => void = () => {};

  constructor(onApply: (s: Settings) => void) {
    this.settings = loadSettings();
    this.onApply = onApply;

    this.root = document.createElement('div');
    this.root.className = 'options is-hidden';

    const panel = document.createElement('div');
    panel.className = 'options-panel ui-panel ui-gilt';

    const head = document.createElement('div');
    head.className = 'options-head';
    const h2 = document.createElement('h2');
    h2.textContent = 'Opciones';
    head.appendChild(h2);

    const body = document.createElement('div');
    body.className = 'options-body';

    body.appendChild(
      this.choice('Calidad gráfica', 'Sombras, oclusión y resolución', (['low', 'medium', 'high', 'ultra'] as QualityTier[]).map((t) => ({ value: t, label: QUALITY_LABELS[t] })), () => this.settings.quality, (v) => {
        this.settings.quality = v as QualityTier;
      }),
    );

    body.appendChild(
      this.toggle('Desplazamiento por bordes', 'Mueve la cámara al llevar el cursor al borde', () => this.settings.edgeScroll, (v) => {
        this.settings.edgeScroll = v;
      }),
    );

    body.appendChild(
      this.slider('Velocidad de cámara', 0.35, 1.8, 0.05, () => this.settings.panSpeed, (v) => {
        this.settings.panSpeed = v;
      }),
    );

    body.appendChild(
      this.toggle('Minimapa', 'Muestra el minimapa en la esquina inferior', () => this.settings.minimap, (v) => {
        this.settings.minimap = v;
      }),
    );

    body.appendChild(
      this.toggle('Números de daño', 'Cifras flotantes sobre los objetivos golpeados', () => this.settings.damageNumbers, (v) => {
        this.settings.damageNumbers = v;
      }),
    );

    body.appendChild(
      this.slider('Volumen general', 0, 1, 0.05, () => this.settings.masterVolume, (v) => {
        this.settings.masterVolume = v;
      }),
    );

    body.appendChild(
      this.slider('Efectos y avisos', 0, 1, 0.05, () => this.settings.sfxVolume, (v) => {
        this.settings.sfxVolume = v;
      }),
    );

    body.appendChild(
      this.slider('Música', 0, 1, 0.05, () => this.settings.musicVolume, (v) => {
        this.settings.musicVolume = v;
      }),
    );

    body.appendChild(
      this.slider('Ambiente', 0, 1, 0.05, () => this.settings.ambientVolume, (v) => {
        this.settings.ambientVolume = v;
      }),
    );

    const foot = document.createElement('div');
    foot.className = 'options-foot';
    const back = document.createElement('button');
    back.className = 'menu-btn is-compact';
    back.textContent = 'Volver';
    back.addEventListener('click', () => this.close());
    foot.appendChild(back);

    panel.append(head, body, foot);
    this.root.appendChild(panel);

    // Esc closes, and a click on the scrim behind the panel does too.
    this.root.addEventListener('click', (e) => {
      if (e.target === this.root) this.close();
    });
  }

  /** Current values. Safe to read every frame; nothing is allocated. */
  get values(): Readonly<Settings> {
    return this.settings;
  }

  open(): void {
    this.root.classList.remove('is-hidden');
  }

  close(): void {
    this.root.classList.add('is-hidden');
    this.onClose();
  }

  get isOpen(): boolean {
    return !this.root.classList.contains('is-hidden');
  }

  /** Pushes the stored settings into the live systems. */
  apply(): void {
    this.onApply(this.settings);
  }

  private commit(): void {
    saveSettings(this.settings);
    this.apply();
  }

  private row(label: string, hint?: string): { root: HTMLElement; control: HTMLElement } {
    const root = document.createElement('div');
    root.className = 'options-row';
    const text = document.createElement('div');
    text.className = 'options-label';
    const b = document.createElement('b');
    b.textContent = label;
    text.appendChild(b);
    if (hint) {
      const i = document.createElement('i');
      i.textContent = hint;
      text.appendChild(i);
    }
    const control = document.createElement('div');
    control.className = 'options-control';
    root.append(text, control);
    return { root, control };
  }

  private choice(
    label: string,
    hint: string,
    options: { value: string; label: string }[],
    get: () => string,
    set: (v: string) => void,
  ): HTMLElement {
    const { root, control } = this.row(label, hint);
    const buttons: HTMLButtonElement[] = [];
    const sync = (): void => {
      for (const btn of buttons) btn.classList.toggle('is-active', btn.dataset.value === get());
    };
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'options-seg';
      btn.dataset.value = opt.value;
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        set(opt.value);
        sync();
        this.commit();
      });
      buttons.push(btn);
      control.appendChild(btn);
    }
    sync();
    return root;
  }

  private toggle(
    label: string,
    hint: string,
    get: () => boolean,
    set: (v: boolean) => void,
  ): HTMLElement {
    const { root, control } = this.row(label, hint);
    const btn = document.createElement('button');
    btn.className = 'options-switch';
    const sync = (): void => {
      btn.classList.toggle('is-on', get());
      btn.textContent = get() ? 'Activado' : 'Desactivado';
    };
    btn.addEventListener('click', () => {
      set(!get());
      sync();
      this.commit();
    });
    sync();
    control.appendChild(btn);
    return root;
  }

  private slider(
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
  ): HTMLElement {
    const { root, control } = this.row(label);
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'options-range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(get());
    const read = document.createElement('span');
    read.className = 'options-read';
    const sync = (): void => {
      read.textContent = `${Math.round((get() / max) * 100)}%`;
    };
    input.addEventListener('input', () => {
      set(Number(input.value));
      sync();
      this.commit();
    });
    sync();
    control.append(input, read);
    return root;
  }
}
