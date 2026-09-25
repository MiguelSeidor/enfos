/**
 * Title screen. Owner: UI agent.
 *
 * Deliberately renders *over* the live world rather than over a flat backdrop:
 * the engine is already running behind it, with the camera on a slow orbit, so
 * the first frame the player sees is the actual game rather than a loading
 * screen pretending to be one.
 *
 * Options that depend on subsystems which do not exist yet are present but
 * disabled, with the reason shown. A menu that lies about what it can do is
 * worse than one that admits the state of the build.
 */

export interface MenuAction {
  id: string;
  label: string;
  hint?: string;
  enabled: boolean;
}

const ACTIONS: MenuAction[] = [
  { id: 'play', label: 'Comenzar partida', hint: 'Elige tu héroe y defiende el Núcleo', enabled: true },
  { id: 'online', label: 'Jugar en línea', hint: '1v1, 2v2 o 3v3 · cada equipo defiende su Núcleo', enabled: true },
  { id: 'options', label: 'Opciones', hint: 'Calidad gráfica, cámara e interfaz', enabled: true },
];

export class TitleScreen {
  readonly root: HTMLElement;
  private readonly handlers = new Map<string, () => void>();

  constructor(title: string, subtitle: string, version: string) {
    this.root = document.createElement('div');
    this.root.className = 'menu';

    const titleBox = document.createElement('div');
    titleBox.className = 'menu-title';
    const h1 = document.createElement('h1');
    h1.textContent = title;
    const sub = document.createElement('p');
    sub.textContent = subtitle;
    titleBox.append(h1, sub);

    const rule = document.createElement('div');
    rule.className = 'menu-rule';

    const actions = document.createElement('div');
    actions.className = 'menu-actions';
    for (const action of ACTIONS) {
      const btn = document.createElement('button');
      btn.className = 'menu-btn';
      btn.disabled = !action.enabled;
      btn.textContent = action.label;
      if (action.hint) {
        const hint = document.createElement('small');
        hint.textContent = action.hint;
        btn.appendChild(hint);
      }
      btn.addEventListener('click', () => this.handlers.get(action.id)?.());
      actions.appendChild(btn);
    }

    const foot = document.createElement('div');
    foot.className = 'menu-foot';
    foot.textContent = version;

    this.root.append(titleBox, rule, actions, foot);
  }

  on(id: string, handler: () => void): void {
    this.handlers.set(id, handler);
  }

  /**
   * Hides the title without destroying it, so a screen layered on top (hero
   * selection) can hand control back if the player backs out.
   */
  setHidden(hidden: boolean): void {
    this.root.classList.toggle('is-hidden', hidden);
  }

  /** Permanent teardown, once the match has actually started. */
  hide(): void {
    this.root.classList.add('is-hidden');
    // Keep it in the DOM briefly so the fade can play out.
    setTimeout(() => this.root.remove(), 700);
  }
}
