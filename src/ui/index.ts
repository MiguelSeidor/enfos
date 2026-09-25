/**
 * UI layer entry point. Owner: UI agent.
 * `src/main.ts` consumes these; add new UI modules to `createUiModules()`.
 */

import './ui.css';
// Ornament layered on top: ui.css owns layout and palette, medieval.css owns
// how things are framed. Imported second so its rules win the cascade.
import './medieval.css';
import './pause.css';
// Last, so the touch layouts win every cascade tie against the three files
// above without having to reach for !important to do it.
import './mobile.css';

export {
  Hud,
  HudModule,
  createHudModel,
  type HudModel,
  type AbilitySlot,
  type HudOptions,
  type CommandSlot,
} from './hud';
export { Minimap, type MinimapCallbacks } from './minimap';
export { WorldHud } from './worldHud';
export { TitleScreen, type MenuAction } from './menu';
export { icon, drawCrest, type IconId } from './icons';
export { HeroSelect, type HeroCard, type HeroCardAbility } from './heroSelect';
export { ShopPanel, type ShopCallbacks } from './shop';
export { OptionsPanel, loadSettings, type Settings } from './options';

/** Creates the container every UI component mounts into. */
export function createUiRoot(): HTMLElement {
  const existing = document.getElementById('ui-root');
  const root = existing ?? document.createElement('div');
  root.id = 'ui-root';
  root.className = 'ui-root';
  if (!existing) document.body.appendChild(root);
  installRotateGate();
  return root;
}

/**
 * The portrait gate, for touch devices held the wrong way round.
 *
 * This is a landscape game: the command card, the world and the wave banner
 * cannot share a 390 px wide column, and every stacking of them we tried was a
 * worse game rather than a smaller one. So a portrait phone is asked to turn
 * rather than served a layout nobody would want to play.
 *
 * Mounted on <body> instead of inside the UI root because it has to outrank the
 * HUD, the menus and the boot screen alike, and #ui-root's own z-index would
 * otherwise cap how high anything inside it can paint. Built once and left in
 * the document: mobile.css decides when it is visible, so there is no resize
 * listener here to disagree with the media query.
 */
function installRotateGate(): void {
  if (document.querySelector('.rotate-gate')) return;
  const gate = document.createElement('div');
  gate.className = 'rotate-gate';
  // `alertdialog` rather than a plain region: it is modal in effect, since it
  // covers the canvas and takes every pointer event that lands on it.
  gate.setAttribute('role', 'alertdialog');
  gate.setAttribute('aria-label', 'Gira el dispositivo para jugar');
  gate.innerHTML =
    '<div class="rotate-gate-plate ui-panel ui-gilt">' +
    '<div class="rotate-gate-device" aria-hidden="true">' +
    '<svg viewBox="0 0 64 64" width="64" height="64" focusable="false">' +
    '<rect x="19" y="5" width="26" height="54" rx="5" fill="none" stroke="currentColor" stroke-width="2.4"/>' +
    '<rect x="23" y="12" width="18" height="36" rx="1.5" fill="currentColor" opacity="0.22"/>' +
    '<circle cx="32" cy="53.5" r="2.1" fill="currentColor"/>' +
    '<path d="M28 9h8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' +
    '</svg>' +
    '</div>' +
    '<b>Gira el dispositivo</b>' +
    '<div class="rotate-gate-rule"></div>' +
    '<i>Núcleo Eterno se juega en horizontal. Pon el teléfono de lado ' +
    'para ver el campo de batalla entero.</i>' +
    '<em>Modo apaisado</em>' +
    '</div>';
  document.body.appendChild(gate);
}

/**
 * Scales the whole interface with the viewport so the HUD keeps its proportions
 * from 720p to 4K (GDD §17). Clamped so it never becomes unreadably small or
 * cartoonishly large.
 *
 * On a phone this bottoms out at the 12 px floor and stays there, which is why
 * every touch target in mobile.css is stated in absolute pixels: a 3rem button
 * would be 36 px on exactly the screens that need it to be 56. The floor is
 * left where it is rather than raised for touch, because the rem sizes the rest
 * of the HUD uses were tuned against it and raising it would make the top
 * chrome grow on the shortest screens instead of the targets.
 */
export function installUiScaling(): () => void {
  const apply = (): void => {
    const base = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    const size = Math.max(12, Math.min(20, 16 * base));
    document.documentElement.style.fontSize = `${size}px`;
  };
  apply();
  window.addEventListener('resize', apply);
  return () => window.removeEventListener('resize', apply);
}
