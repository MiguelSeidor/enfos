/**
 * Ability and interface iconography. Owner: UI agent.
 *
 * Inline SVG, not emoji. Emoji depend on a system emoji font, which headless
 * Chromium does not have and which differs between Windows, macOS and Linux —
 * an ability bar that renders three different glyph sets on three machines is
 * not shippable, and it fails the review capture outright.
 *
 * Each icon is a single path on a 24×24 grid using `currentColor`, so tint,
 * disabled state and cooldown desaturation are pure CSS.
 */

export type IconId =
  | 'shield-bash'
  | 'anchor-shout'
  | 'bulwark-wall'
  | 'unbroken'
  | 'flame'
  | 'frost'
  | 'arrow'
  | 'net'
  | 'arrow-rain'
  | 'wind-step'
  | 'heal'
  | 'crest'
  // Stat-panel glyphs. Kept simple: they render at 13 px, where anything with
  // interior detail turns to mush.
  | 'sword'
  | 'bolt'
  | 'shield'
  | 'spark'
  | 'boot'
  | 'fist'
  | 'heart'
  | 'eye'
  // Command-card orders.
  | 'plus'
  | 'stop'
  | 'close';

const PATHS: Record<IconId, string> = {
  // Shield with an impact crack — a defensive strike.
  'shield-bash':
    'M12 2 4 5v6.5c0 4.9 3.4 9 8 10.5 4.6-1.5 8-5.6 8-10.5V5l-8-3Zm0 3.4 5 1.9v4.2c0 3.3-2.1 6.3-5 7.6-2.9-1.3-5-4.3-5-7.6V7.3l5-1.9Zm.9 2.6-3.3 4.4h2.2l-1 3.6 3.4-4.6h-2.3l1-3.4Z',
  // Downward war-cry chevrons radiating from a mouth-like arc.
  'anchor-shout':
    'M12 2a5 5 0 0 0-5 5v3a5 5 0 0 0 10 0V7a5 5 0 0 0-5-5Zm0 2.2A2.8 2.8 0 0 1 14.8 7v3a2.8 2.8 0 0 1-5.6 0V7A2.8 2.8 0 0 1 12 4.2ZM4 11.5h2a6 6 0 0 0 12 0h2a8 8 0 0 1-7 7.9V22h-2v-2.6a8 8 0 0 1-7-7.9Z',
  // Interlocked stone blocks forming a barrier.
  'bulwark-wall':
    'M2 5h9v5H2V5Zm11 0h9v5h-9V5ZM2 12h5v5H2v-5Zm7 0h6v5H9v-5Zm8 0h5v5h-5v-5ZM2 19h9v2H2v-2Zm11 0h9v2h-9v-2Z',
  // Sunburst over a shield boss — the ultimate.
  unbroken:
    'M12 1.6 13.4 5l3.5-1.3-1.3 3.5L19 8.6l-3.4 1.4 1.3 3.5-3.5-1.3L12 15.6 10.6 12.2l-3.5 1.3 1.3-3.5L5 8.6l3.4-1.4L7.1 3.7 10.6 5 12 1.6Zm0 4.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 0 0 0-4.2ZM5 16h14v2.2c0 2-1.6 3.8-3.6 3.8H8.6C6.6 22 5 20.2 5 18.2V16Z',
  flame:
    'M12 2c1.6 3.2.7 5-.6 6.6-1.4 1.7-3 3.2-3 5.9A5.6 5.6 0 0 0 14 22a5.9 5.9 0 0 0 4-5.6c0-3.4-2.2-5-3.3-7.7-.4 1-.9 1.6-1.6 2.1.4-3-.5-6.2-1.1-8.8Z',
  frost:
    'M11 2h2v5.3l2.2-2.2 1.4 1.4L13 10.1v3.8l3.6-3.5-1.9-.5.5-1.9 4.3 1.2-1.2 4.3-1.9-.5.5-1.9L13 14.6V22h-2v-7.4l-3.9 3.8.5 1.9-1.9.5L4.5 16.5l4.3-1.2.5 1.9-1.9.5L11 13.9v-3.8L7.4 6.5l1.4-1.4L11 7.3V2Z',
  arrow:
    'M21 3 10.5 13.5 8 11l-5 8 8-5-2.5-2.5L21 3Zm-6.8 3.5L21 3l-.6 4.8-3.2-1.5-3 3.2Z',
  heal: 'M10 2h4v6h6v4h-6v10h-4V12H4V8h6V2Z',
  // Net: a mesh of crossed cords with weighted corners, for the snare trap.
  net: 'M3 3h2.5L12 9.5 18.5 3H21v2.5L14.5 12 21 18.5V21h-2.5L12 14.5 5.5 21H3v-2.5L9.5 12 3 5.5V3Zm9 5.1L8.6 4.7 12 8.1l3.4-3.4L12 8.1Zm0 7.8 3.4 3.4L12 15.9l-3.4 3.4L12 15.9ZM4.2 4.2a1.2 1.2 0 1 0 0 .01ZM19.8 4.2a1.2 1.2 0 1 0 0 .01ZM4.2 19.8a1.2 1.2 0 1 0 0 .01ZM19.8 19.8a1.2 1.2 0 1 0 0 .01Z',
  // Three arrows falling: the ultimate's rain.
  'arrow-rain': 'M5 2h2v12.2l2.3-2.3 1.4 1.4L6 18 1.3 13.3l1.4-1.4L5 14.2V2Zm6 4h2v8.2l2.3-2.3 1.4 1.4L12 18l-4.7-4.7 1.4-1.4L11 14.2V6Zm6-4h2v12.2l2.3-2.3 1.4 1.4L18 18l-4.7-4.7 1.4-1.4L17 14.2V2Z',
  // A boot trailing speed lines: the sidestep.
  'wind-step': 'M9 2h3l.6 6.4 5.1 3.1c1.2.7 1.9 2 1.9 3.4V19H8.5c-1.9 0-3.5-1.6-3.5-3.5V12h3l-2-4h3L9 2Zm-7 5h4v2H2V7Zm-1 4h4v2H1v-2Zm1 4h4v2H2v-2Z',
  // Interface crest used as the hero portrait backdrop.
  crest:
    'M12 2 3 6v7c0 5 3.8 8.7 9 9.9 5.2-1.2 9-4.9 9-9.9V6l-9-4Zm0 2.4 6.8 3v5.6c0 3.7-2.7 6.6-6.8 7.7-4.1-1.1-6.8-4-6.8-7.7V7.4L12 4.4Z',

  // ── Stat panel
  // Blade with a crossguard and pommel.
  sword: 'M19.5 2 21 3.5 11.6 13l-1.4-1.4L19.5 2ZM8.8 12.9l2.3 2.3-1.4 1.4-.7-.7-4.6 4.6-1.4-1.4L7.6 14l-.7-.7 1.9-1.9v1.5Z',
  // Lightning bolt — attacks per second.
  bolt: 'M13 2 4 13h6l-1 9 9-11h-6l1-9Z',
  // Plain heater shield.
  shield: 'M12 2 4 5v6.5c0 4.9 3.4 9 8 10.5 4.6-1.5 8-5.6 8-10.5V5l-8-3Zm0 2.2 6 2.2v5.1c0 3.8-2.4 7-6 8.3-3.6-1.3-6-4.5-6-8.3V6.4l6-2.2Z',
  // Four-point star — spell power.
  spark: 'M12 2c.8 4.4 1.8 7.2 4.4 8-2.6.8-3.6 3.6-4.4 8-.8-4.4-1.8-7.2-4.4-8 2.6-.8 3.6-3.6 4.4-8Zm7 10c.4 2 .9 3.3 2 3.7-1.1.4-1.6 1.7-2 3.7-.4-2-.9-3.3-2-3.7 1.1-.4 1.6-1.7 2-3.7Z',
  // Winged boot — movement.
  boot: 'M6 3h4v9.5l5.4 2.8A4 4 0 0 1 17.6 19v2H6V3Zm2 2v14h7.4a2 2 0 0 0-1.1-1.9L8 13.7V5Zm-6 5h3v2H2v-2Zm-1 4h4v2H1v-2Z',
  // Clenched fist — the power attribute.
  fist: 'M7 6a2 2 0 0 1 4 0V5a2 2 0 0 1 4 0v.6A2 2 0 0 1 18 7v1.2c.6.4 1 1 1 1.8v4a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6V9a2 2 0 0 1 2-2V6Zm2 3V6a.5.5 0 0 0-1 0v3H9Z',
  heart: 'M12 21C6.5 17 3 13.7 3 9.8A4.8 4.8 0 0 1 12 7a4.8 4.8 0 0 1 9 2.8C21 13.7 17.5 17 12 21Z',
  // Thick cross — the level-up button.
  plus: 'M9.5 2h5v7.5H22v5h-7.5V22h-5v-7.5H2v-5h7.5V2Z',
  // Filled square — stop.
  stop: 'M5 5h14v14H5V5Z',
  // Thick X — close the shop.
  close:
    'M6.2 3.4 12 9.2l5.8-5.8 2.8 2.8L14.8 12l5.8 5.8-2.8 2.8L12 14.8l-5.8 5.8-2.8-2.8L9.2 12 3.4 6.2Z',
  // Eye — focus.
  eye: 'M12 5c5 0 9 4.4 10 7-1 2.6-5 7-10 7S3 14.6 2 12c1-2.6 5-7 10-7Zm0 2c-3.4 0-6.4 2.8-7.7 5 1.3 2.2 4.3 5 7.7 5s6.4-2.8 7.7-5C18.4 9.8 15.4 7 12 7Zm0 1.8a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4Z',
};

export function icon(id: IconId, size = 24): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `<path fill="currentColor" d="${PATHS[id]}"/></svg>`
  );
}

/**
 * Procedural hero crest for the portrait slot.
 *
 * A real portrait wants an off-screen render of the hero's head, which needs a
 * second camera and render target. Until that exists this draws a deterministic
 * heraldic device from the hero's palette so the slot reads as authored rather
 * than as an empty black square.
 */
export function drawCrest(
  canvas: HTMLCanvasElement,
  primary: number,
  accent: number,
  seed: number,
): void {
  const size = 128;
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return;

  const hex = (v: number): string => `#${v.toString(16).padStart(6, '0')}`;

  const bg = g.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, hex(primary));
  bg.addColorStop(1, '#0d1117');
  g.fillStyle = bg;
  g.fillRect(0, 0, size, size);

  // Radial rays, count derived from the seed so each hero differs.
  const rays = 6 + (seed % 5);
  g.save();
  g.translate(size / 2, size / 2);
  g.globalAlpha = 0.16;
  g.fillStyle = hex(accent);
  for (let i = 0; i < rays; i++) {
    g.rotate((Math.PI * 2) / rays);
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(size * 0.6, -size * 0.06);
    g.lineTo(size * 0.6, size * 0.06);
    g.closePath();
    g.fill();
  }
  g.restore();

  // Shield device.
  g.globalAlpha = 1;
  g.strokeStyle = hex(accent);
  g.lineWidth = 4;
  g.beginPath();
  const cx = size / 2;
  g.moveTo(cx, size * 0.16);
  g.lineTo(size * 0.78, size * 0.3);
  g.lineTo(size * 0.78, size * 0.58);
  g.quadraticCurveTo(size * 0.78, size * 0.8, cx, size * 0.88);
  g.quadraticCurveTo(size * 0.22, size * 0.8, size * 0.22, size * 0.58);
  g.lineTo(size * 0.22, size * 0.3);
  g.closePath();
  g.stroke();

  const inner = g.createLinearGradient(0, size * 0.16, 0, size * 0.88);
  inner.addColorStop(0, 'rgba(255,255,255,0.16)');
  inner.addColorStop(1, 'rgba(0,0,0,0.35)');
  g.fillStyle = inner;
  g.fill();

  // Vignette so the crest sits into the frame instead of floating on it.
  const vig = g.createRadialGradient(cx, cx, size * 0.2, cx, cx, size * 0.7);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = vig;
  g.fillRect(0, 0, size, size);
}
