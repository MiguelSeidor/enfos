/**
 * World-space combat feedback: health bars over units and floating damage
 * numbers. Owner: UI agent.
 *
 * Drawn on a single 2D canvas rather than as DOM nodes or 3D sprites.
 *  - DOM would mean one element per unit, and 300 elements with per-frame
 *    transform writes is a layout storm.
 *  - Billboarded sprites would put text through the whole PBR + post chain,
 *    where tone mapping and bloom would eat the contrast that makes a number
 *    readable.
 * One canvas is a few hundred fills per frame and stays perfectly crisp.
 *
 * Damage numbers are pooled; a busy wave produces hundreds per second and
 * allocating an object for each would hand the GC a steady stream of garbage
 * during exactly the moments the frame budget is tightest.
 */

import type { EntityId, MatchState, Vec2 } from '@/core/contracts';
import { isConcealed, summonLifeLeft } from '@/gameplay/units';
import { DamageType, Faction, UnitKind } from '@/core/contracts';
import type { RenderService } from '@/core/services';
import { clamp01 } from '@/core/mathx';

interface FloatingNumber {
  active: boolean;
  x: number;
  z: number;
  height: number;
  text: string;
  color: string;
  scale: number;
  life: number;
  maxLife: number;
  driftX: number;
}

const POOL_SIZE = 256;
const NUMBER_LIFE = 1.05;

/** How long the move-order cross stays on the ground, in seconds. */
const MARKER_LIFE = 1.1;

/** How long a scattered coin lives before fading, in seconds. */
const COIN_LIFE = 1.5;

/** Seconds per breath of a dropped item's pulse. */
const DROP_PULSE = 1.7;

/** Click radius around a dropped item, in CSS pixels. */
const DROP_HIT = 20;

/**
 * Seconds per turn of the hex aura.
 *
 * Slow enough to read as a circling thing rather than a flicker, fast enough
 * that a 15-second hex turns about five times before it lifts.
 */
const HEX_SPIN = 2.8;

/**
 * Coin capacity.
 *
 * A wave clearing at once is the worst case: eight creeps dying in the same
 * second at up to seven coins each. Sized for that rather than for the average,
 * because the failure mode of running out is coins silently not appearing on
 * exactly the kills the player most wants to see.
 */
const COIN_POOL = 72;

const TYPE_COLORS: Record<number, string> = {
  [DamageType.Physical]: '#ffffff',
  [DamageType.Fire]: '#ff8a3c',
  [DamageType.Frost]: '#7fd4ff',
  [DamageType.Shadow]: '#c07fff',
  [DamageType.Nature]: '#8ce05a',
  [DamageType.Arcane]: '#ff7fe0',
  [DamageType.Holy]: '#ffe9a8',
  [DamageType.Pure]: '#ffffff',
};

export class WorldHud {
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly pool: FloatingNumber[] = [];
  private readonly screen = { x: 0, y: 0 };
  private dpr = 1;
  private landmarks: { text: string; pos: Vec2; accent: string }[] = [];
  private moveMark: { x: number; z: number; life: number } | null = null;
  /** Pooled like the numbers: a wave clearing at once allocates nothing. */
  private readonly coins: {
    active: boolean;
    x: number;
    z: number;
    height: number;
    offX: number;
    offY: number;
    offZ: number;
    vx: number;
    vy: number;
    vz: number;
    life: number;
  }[] = [];

  /**
   * `groundAt` is required, not optional. `RenderService.project` takes an
   * absolute world Y, while every offset here is "so many metres above the
   * unit's feet" — and the unit's feet sit on terraced terrain that is nowhere
   * near Y=0. Without adding ground height, bars and numbers render at sea
   * level, which on this map means well below the unit they belong to.
   */
  private drops: { id: number; name: string; pos: Vec2; inRange: boolean }[] = [];
  /** Screen circles the last frame drew, so a click can hit one. */
  private readonly dropHits: { id: number; x: number; y: number }[] = [];
  private dropClock = 0;
  private hexClock = 0;
  /** Set from `update`; see the health-bar skip. */
  private observerTeam = 0;
  /** Set from `update`: the conjured allies under the player's command. */
  private picked: readonly EntityId[] = [];

  constructor(private readonly groundAt: (x: number, z: number) => number) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-world';
    this.g = this.canvas.getContext('2d')!;
    for (let i = 0; i < POOL_SIZE; i++) {
      this.pool.push({
        active: false,
        x: 0,
        z: 0,
        height: 0,
        text: '',
        color: '#fff',
        scale: 1,
        life: 0,
        maxLife: NUMBER_LIFE,
        driftX: 0,
      });
    }
    for (let i = 0; i < COIN_POOL; i++) {
      this.coins.push({
        active: false,
        x: 0,
        z: 0,
        height: 0,
        offX: 0,
        offY: 0,
        offZ: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
      });
    }
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(window.innerWidth * this.dpr);
    this.canvas.height = Math.floor(window.innerHeight * this.dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
  }

  /**
   * Player setting. Dropping numbers at the spawn point rather than at draw
   * time means turning them off also stops the pool churn, which is the reason
   * a player would turn them off in the first place.
   */
  showNumbers = true;

  /**
   * Marks where a move order was given.
   *
   * Kept alive for a fixed time rather than until arrival: the point is to
   * confirm the click landed where the player meant, which is answered in the
   * first second. A marker that persisted until the hero arrived would sit on
   * screen through the whole walk and read as a permanent objective.
   */
  markMoveOrder(pos: Vec2): void {
    this.moveMark = { x: pos.x, z: pos.z, life: MARKER_LIFE };
  }

  private drawMoveMarker(dt: number, render: RenderService): void {
    const mark = this.moveMark;
    if (!mark) return;
    mark.life -= dt;
    if (mark.life <= 0) {
      this.moveMark = null;
      return;
    }

    if (!render.project({ x: mark.x, z: mark.z }, this.groundAt(mark.x, mark.z) + 0.15, this.screen)) {
      return;
    }
    const t = 1 - mark.life / MARKER_LIFE;
    const g = this.g;
    // Snaps to full size then settles, so the eye catches it landing.
    const scale = t < 0.18 ? 0.4 + (t / 0.18) * 0.75 : 1.15 - (t - 0.18) * 0.18;
    const size = 13 * scale;
    const alpha = mark.life < 0.4 ? mark.life / 0.4 : 1;

    g.save();
    g.translate(this.screen.x, this.screen.y);
    // Squashed like the selection rings, so it lies on the ground plane rather
    // than facing the camera.
    g.scale(1, 0.5);
    g.globalAlpha = alpha;
    g.lineCap = 'round';
    for (const [colour, width] of [
      ['rgba(0, 0, 0, 0.75)', 5],
      ['#8ce05a', 2.5],
    ] as const) {
      g.strokeStyle = colour;
      g.lineWidth = width;
      g.beginPath();
      g.moveTo(-size, -size);
      g.lineTo(size, size);
      g.moveTo(size, -size);
      g.lineTo(-size, size);
      g.stroke();
    }
    g.globalAlpha = 1;
    g.restore();
  }

  /**
   * Scatters coins over a corpse.
   *
   * This used to float "+14 oro", which landed in exactly the same place as the
   * killing blow's damage number and covered it — the two most interesting
   * figures of a kill fighting over one spot. The amount now goes to the gold
   * counter instead, and the world keeps a wordless cue that cannot obscure
   * anything because it carries no text at all.
   *
   * Coin count scales with the bounty but is capped: past half a dozen the eye
   * reads "some coins" either way, and a boss would otherwise bury the corpse.
   */
  addBounty(pos: Vec2, gold: number): void {
    const count = Math.max(3, Math.min(7, Math.round(gold / 6)));
    const ground = this.groundAt(pos.x, pos.z);
    for (let i = 0; i < count; i++) {
      const slot = this.coins.find((c) => !c.active);
      if (!slot) return;
      // Deterministic spread seeded off the index, so the same kill scatters
      // the same way on a replay of the same seed.
      const a = (i * 2.39996) % (Math.PI * 2);
      slot.active = true;
      slot.x = pos.x;
      slot.z = pos.z;
      slot.height = ground;
      slot.vx = Math.cos(a) * (0.9 + (i % 3) * 0.45);
      slot.vy = 3.4 + (i % 4) * 0.75;
      slot.vz = Math.sin(a) * (0.9 + (i % 3) * 0.45);
      slot.offX = 0;
      slot.offY = 0;
      slot.offZ = 0;
      slot.life = COIN_LIFE;
    }
  }

  /**
   * Coins: a short ballistic pop, then a fade where they land.
   *
   * Flat ellipses rather than sprites — at this size a texture would be four
   * pixels of gold and a texture bind per frame.
   */
  private drawCoins(dt: number, render: RenderService): void {
    const g = this.g;
    for (const coin of this.coins) {
      if (!coin.active) continue;
      coin.life -= dt;
      if (coin.life <= 0) {
        coin.active = false;
        continue;
      }
      coin.vy -= 9 * dt;
      coin.offX += coin.vx * dt;
      coin.offY += coin.vy * dt;
      coin.offZ += coin.vz * dt;
      // Settle on the ground rather than falling through it.
      if (coin.offY < 0) {
        coin.offY = 0;
        coin.vy = 0;
        coin.vx *= 0.6;
        coin.vz *= 0.6;
      }

      const x = coin.x + coin.offX;
      const z = coin.z + coin.offZ;
      if (!render.project({ x, z }, coin.height + coin.offY + 0.35, this.screen)) continue;

      const t = 1 - coin.life / COIN_LIFE;
      g.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      g.beginPath();
      g.ellipse(this.screen.x, this.screen.y, 3.4, 2.4, 0, 0, Math.PI * 2);
      g.fillStyle = '#ffcc47';
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(70, 45, 8, 0.9)';
      g.stroke();
      // Specular pip, so a coin reads as metal rather than as a dot.
      g.beginPath();
      g.ellipse(this.screen.x - 1, this.screen.y - 0.8, 1.1, 0.8, 0, 0, Math.PI * 2);
      g.fillStyle = 'rgba(255, 248, 214, 0.95)';
      g.fill();
      g.globalAlpha = 1;
    }
  }

  /**
   * "Fallo" over a dodged attack.
   *
   * Follows `showNumbers` like the damage stream does: it is the same channel
   * of per-hit feedback, and a player who has turned the numbers off does not
   * want one word per miss either.
   */
  addMiss(pos: Vec2): void {
    if (!this.showNumbers) return;
    const slot = this.pool.find((n) => !n.active);
    if (!slot) return;
    slot.active = true;
    slot.x = pos.x;
    slot.z = pos.z;
    slot.height = this.groundAt(pos.x, pos.z);
    slot.text = 'Fallo';
    slot.color = '#b9c0cc';
    slot.scale = 0.95;
    slot.life = NUMBER_LIFE;
    slot.maxLife = slot.life;
    slot.driftX = 0;
  }

  /** Spawns a floating number. Silently drops if the pool is exhausted. */
  addNumber(pos: Vec2, amount: number, crit: boolean, type: DamageType, heal = false): void {
    if (!this.showNumbers) return;
    const slot = this.pool.find((n) => !n.active);
    if (!slot) return;
    slot.active = true;
    slot.x = pos.x;
    slot.z = pos.z;
    // Captured at spawn: the ground under a moving unit changes, but a number
    // already in the air should keep rising from where the hit landed.
    slot.height = this.groundAt(pos.x, pos.z);
    // A crit is the one hit the player should never miss seeing, so it is
    // marked three ways at once — size, colour and an exclamation — rather than
    // by a size bump alone, which is lost in a busy wave.
    slot.text = (heal ? '+' : '') + String(Math.round(amount)) + (crit ? '!' : '');
    slot.color = heal ? '#6fe07a' : crit ? '#ff9a2e' : TYPE_COLORS[type] ?? '#ffffff';
    slot.scale = crit ? 2.1 : 1;
    slot.life = NUMBER_LIFE * (crit ? 1.5 : 1);
    slot.maxLife = slot.life;
    // Deterministic-looking spread without touching the simulation RNG.
    slot.driftX = ((amount * 2654435761) % 100) / 100 - 0.5;
  }

  update(
    dt: number,
    match: MatchState,
    render: RenderService,
    playerHeroId: EntityId | null,
    selectedId: EntityId | null = null,
    hoveredId: EntityId | null = null,
    /** Whose side the screen is on, so a concealed creep stays concealed. */
    observerTeam = 0,
    /** Conjured allies the player has picked out. */
    picked: readonly EntityId[] = [],
  ): void {
    this.observerTeam = observerTeam;
    this.picked = picked;
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, window.innerWidth, window.innerHeight);

    this.drawLandmarkLabels(render);
    this.drawMoveMarker(dt, render);
    // Under the units: a creep walking over a dropped shield should cover it.
    this.drawDrops(dt, render);
    // Under the selection ring, which is the thing the player is steering by.
    this.drawHexAuras(dt, match, render);
    // Hover under selection: a unit that is both keeps the stronger red ring.
    if (hoveredId !== null && hoveredId !== selectedId) {
      this.drawRing(match, render, hoveredId, 'rgba(255, 214, 122, 0.95)', 2);
    }
    this.drawSelection(match, render, selectedId, playerHeroId);
    this.drawHealthBars(match, render, playerHeroId, hoveredId);
    // Coins under the numbers: they are scenery, the numbers are information.
    this.drawCoins(dt, render);
    this.drawNumbers(dt, render);
  }

  /** Landmark markers the player needs to find: Core, fountain, both shops. */
  setLandmarks(marks: { text: string; pos: Vec2; accent: string }[]): void {
    this.landmarks = marks;
  }

  /** Items lying on the ground, from the economy. Replaced, not accumulated. */
  setDrops(drops: { id: number; name: string; pos: Vec2; inRange: boolean }[]): void {
    this.drops = drops;
  }

  /**
   * The dropped item under a screen point, or null.
   *
   * Hit-tested against the circles the last frame drew rather than by
   * projecting again: the player clicks what they can see, and a marker that
   * has scrolled off since is not something they could have aimed at.
   */
  dropAt(x: number, y: number): number | null {
    for (const hit of this.dropHits) {
      const dx = x - hit.x;
      const dy = y - hit.y;
      if (dx * dx + dy * dy <= DROP_HIT * DROP_HIT) return hit.id;
    }
    return null;
  }

  /**
   * Items on the ground: a pouch and the item's name.
   *
   * Out of reach they are dimmed rather than hidden — the player has to be
   * able to see where the thing they dropped went from across the lane, or
   * "it falls on the ground" is indistinguishable from "it is gone".
   */
  private drawDrops(dt: number, render: RenderService): void {
    this.dropHits.length = 0;
    if (this.drops.length === 0) return;
    this.dropClock += dt;
    const g = this.g;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = "600 11px 'Trebuchet MS', system-ui, sans-serif";
    // A slow breath, so the eye catches it without the field flashing.
    const pulse = 0.5 + 0.5 * Math.sin((this.dropClock / DROP_PULSE) * Math.PI * 2);

    for (const drop of this.drops) {
      const ground = this.groundAt(drop.pos.x, drop.pos.z);
      if (!render.project(drop.pos, ground + 1.15, this.screen)) continue;
      const x = this.screen.x;
      const y = this.screen.y;
      this.dropHits.push({ id: drop.id, x, y });

      g.globalAlpha = drop.inRange ? 1 : 0.55;

      // The glow first, so the pouch sits on top of its own light.
      const halo = 9 + pulse * 3;
      const grad = g.createRadialGradient(x, y, 0, x, y, halo);
      grad.addColorStop(0, drop.inRange ? 'rgba(255, 220, 140, 0.55)' : 'rgba(180, 190, 210, 0.3)');
      grad.addColorStop(1, 'rgba(255, 220, 140, 0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, halo, 0, Math.PI * 2);
      g.fill();

      // A pouch: a rounded body with a drawn neck. Six lines, and it reads as
      // a thing somebody left rather than as a quest marker.
      g.beginPath();
      g.moveTo(x - 4.5, y + 1);
      g.quadraticCurveTo(x - 6, y + 6, x, y + 6.5);
      g.quadraticCurveTo(x + 6, y + 6, x + 4.5, y + 1);
      g.lineTo(x + 2.4, y - 2.6);
      g.lineTo(x - 2.4, y - 2.6);
      g.closePath();
      g.fillStyle = drop.inRange ? '#c8a253' : '#8a8f9b';
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(28, 20, 8, 0.9)';
      g.stroke();
      g.beginPath();
      g.moveTo(x - 2.8, y - 2.6);
      g.lineTo(x + 2.8, y - 2.6);
      g.strokeStyle = drop.inRange ? '#f5dda2' : '#c3c8d2';
      g.lineWidth = 1.6;
      g.stroke();

      // The name above it, on the same plate the landmarks use.
      const w = g.measureText(drop.name).width + 12;
      const ly = y - 16;
      g.fillStyle = 'rgba(6, 9, 14, 0.72)';
      g.fillRect(x - w / 2, ly - 8, w, 16);
      g.strokeStyle = drop.inRange ? '#c8a253' : 'rgba(170, 178, 192, 0.8)';
      g.lineWidth = 1;
      g.strokeRect(x - w / 2 + 0.5, ly - 7.5, w - 1, 15);
      g.fillStyle = drop.inRange ? '#f5dda2' : '#c3c8d2';
      g.fillText(drop.name, x, ly + 0.5);

      g.globalAlpha = 1;
    }
  }

  private drawLandmarkLabels(render: RenderService): void {
    if (this.landmarks.length === 0) return;
    const g = this.g;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = "600 12px 'Trebuchet MS', system-ui, sans-serif";

    for (const mark of this.landmarks) {
      const height = this.groundAt(mark.pos.x, mark.pos.z) + 9.5;
      if (!render.project(mark.pos, height, this.screen)) continue;
      const x = this.screen.x;
      const y = this.screen.y;

      const w = g.measureText(mark.text).width + 14;
      g.fillStyle = 'rgba(6, 9, 14, 0.66)';
      g.fillRect(x - w / 2, y - 9, w, 18);
      g.strokeStyle = mark.accent;
      g.lineWidth = 1;
      g.strokeRect(x - w / 2 + 0.5, y - 8.5, w - 1, 17);
      g.fillStyle = mark.accent;
      g.fillText(mark.text, x, y + 0.5);
    }
  }

  /**
   * A turning purple ring under every hexed hero.
   *
   * Maleficio hits both of the rival team's heroes at once, and the only sign
   * of it was a line in the sabotage strip that named the effect but not who
   * was carrying it. In a 2v2 that is not enough to play around.
   *
   * Read off the modifier the sabotage leaves on the unit rather than from a
   * message, so the aura cannot outlive or precede the effect itself: it is
   * drawn from the same state that is reducing the damage. 'sab.hex' is the
   * `sourceId` in gameplay/sabotage.ts, named here the way 'status.elite' is
   * in `drawHealthBars` — the HUD reads the simulation, it does not import it.
   *
   * Drawn for anyone hexed, friend or rival: being hexed yourself is the one
   * case where you most need to know.
   */
  private drawHexAuras(dt: number, match: MatchState, render: RenderService): void {
    this.hexClock += dt;
    const g = this.g;
    const spin = ((this.hexClock / HEX_SPIN) % 1) * Math.PI * 2;

    for (const unit of match.units.values()) {
      if (!unit.alive || unit.kind !== UnitKind.Hero) continue;
      if (!unit.modifiers.some((m) => m.sourceId === 'sab.hex')) continue;

      const ground = this.groundAt(unit.pos.x, unit.pos.z);
      if (!render.project(unit.pos, ground + 0.12, this.screen)) continue;
      // The same trick `drawRing` uses: size the ring off the unit's projected
      // height, so it holds its proportions at every zoom.
      const top = { x: 0, y: 0 };
      render.project(unit.pos, ground + 2.2, top);
      // Tight to the feet. A wider ring was the first attempt and it read as a
      // scratch on the ground near the hero rather than as something on them.
      const r = Math.max(13, Math.abs(this.screen.y - top.y) * 0.6);

      g.save();
      g.translate(this.screen.x, this.screen.y);
      // Squashed, so it lies on the ground instead of standing up like a hoop.
      g.scale(1, 0.42);

      // The ground inside the ring glows, which is what separates an aura from
      // a line. It breathes slowly so a stationary hero still reads as cursed.
      const breath = 0.82 + 0.18 * Math.sin(this.hexClock * 2.2);
      const glow = g.createRadialGradient(0, 0, 0, 0, 0, r);
      glow.addColorStop(0, `rgba(150, 80, 230, ${0.34 * breath})`);
      glow.addColorStop(0.65, `rgba(150, 80, 230, ${0.16 * breath})`);
      glow.addColorStop(1, 'rgba(150, 80, 230, 0)');
      g.fillStyle = glow;
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.fill();

      // A dim full circle holds the shape when the arcs are at the back.
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(168, 108, 236, 0.5)';
      g.lineWidth = 2;
      g.stroke();

      // Three bright arcs, evenly spaced and turning: a solid ring that spins
      // looks exactly like a ring that does not.
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(214, 170, 255, 0.98)';
      g.lineWidth = 4;
      for (let i = 0; i < 3; i++) {
        const from = spin + (i * Math.PI * 2) / 3;
        g.beginPath();
        g.arc(0, 0, r, from, from + 0.8);
        g.stroke();
      }

      // Two motes orbiting against the arcs, to sell the rotation from above,
      // where an ellipse's turn is hardest to see. Haloed, because a 3 px dot
      // on grass at this zoom is a dead pixel.
      for (let i = 0; i < 2; i++) {
        const a = -spin * 1.4 + i * Math.PI;
        const mx = Math.cos(a) * r;
        const my = Math.sin(a) * r;
        g.beginPath();
        g.arc(mx, my, 6, 0, Math.PI * 2);
        g.fillStyle = 'rgba(190, 130, 255, 0.35)';
        g.fill();
        g.beginPath();
        g.arc(mx, my, 3.2, 0, Math.PI * 2);
        g.fillStyle = 'rgba(240, 220, 255, 1)';
        g.fill();
      }
      g.restore();
    }
  }

  /** Reticle around the unit the player has picked as their attack target. */
  private drawSelection(
    match: MatchState,
    render: RenderService,
    selectedId: EntityId | null,
    playerHeroId: EntityId | null,
  ): void {
    // The hero gets a ring whenever nothing else has the player's orders, so
    // "who am I driving" is always answered on the ground rather than by
    // elimination. Green, the colour its own health bar already uses, against
    // the gold of a conjured pack and the red of an attack target.
    if (this.picked.length === 0 && playerHeroId !== null) {
      this.drawRing(match, render, playerHeroId, 'rgba(74, 208, 106, 0.9)', 2, 0.7);
    }
    // Gold under the conjured allies the player is commanding, red under the
    // unit the hero is attacking. Two different questions — "who obeys me" and
    // "what am I hitting" — so two colours, and the gold goes down first so a
    // summon that is also the attack target still reads as the target.
    for (const id of this.picked) {
      this.drawRing(match, render, id, 'rgba(245, 221, 162, 0.95)', 2, 0.62);
    }
    if (selectedId === null) return;
    this.drawRing(match, render, selectedId, 'rgba(255, 82, 60, 0.95)', 2.5);
  }

  /** Ground ring under a unit, sized from its own projected height. */
  private drawRing(
    match: MatchState,
    render: RenderService,
    id: EntityId,
    colour: string,
    width: number,
    /** Tightens the ring. The attack reticle wants room; a selection does not. */
    scale = 1,
  ): void {
    const unit = match.units.get(id);
    if (!unit || !unit.alive) return;
    const ground = this.groundAt(unit.pos.x, unit.pos.z);
    if (!render.project(unit.pos, ground + 0.15, this.screen)) return;

    // Radius follows the unit's projected height so the ring keeps its size
    // relative to the target at every zoom level.
    const top = { x: 0, y: 0 };
    render.project(unit.pos, ground + 2.2, top);
    const r = Math.max(14, Math.abs(this.screen.y - top.y) * 0.85) * scale;

    const g = this.g;
    g.save();
    g.translate(this.screen.x, this.screen.y);
    // Squashed to read as a ring lying on the ground under the target.
    g.scale(1, 0.42);
    g.beginPath();
    g.arc(0, 0, r, 0, Math.PI * 2);
    g.strokeStyle = colour;
    g.lineWidth = width;
    g.stroke();
    g.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    g.lineWidth = 1;
    g.stroke();
    g.restore();
  }

  private drawHealthBars(
    match: MatchState,
    render: RenderService,
    playerHeroId: EntityId | null,
    hoveredId: EntityId | null = null,
  ): void {
    const g = this.g;
    for (const unit of match.units.values()) {
      if (!unit.alive) continue;
      // A bar over a creep nobody can see is the creep. The mesh hides itself
      // in `AuthoredView.setConcealed` and the raycast skips it for free,
      // because an invisible object is not a hit; this one is drawn from match
      // state rather than from the scene, so it has to ask.
      if (isConcealed(unit.id, this.observerTeam, match.tick)) continue;
      const fraction = clamp01(unit.health / Math.max(1, unit.stats.maxHealth));
      // A full-health creep bar is visual noise; heroes and bosses always show,
      // and so does whatever the cursor is over — asking "how hurt is this one"
      // by pointing at it is the whole reason to hover a unit.
      // An elite (a rival's sabotage) always shows its bar, in gold, so the
      // player can find the one creep that is worth focusing.
      // 'status.elite' is `ELITE_STATUS` in gameplay/sabotage.ts.
      const elite = unit.statuses.some((s) => s.defId === 'status.elite');
      // A picked summon always shows, whole or not: its bar is where its
      // remaining time is drawn, and a clock that only appears once the thing
      // is hurt is no clock at all.
      const picked = this.picked.includes(unit.id);
      const always =
        unit.kind === UnitKind.Hero ||
        unit.kind === UnitKind.Boss ||
        elite ||
        picked ||
        unit.id === hoveredId;
      if (!always && fraction >= 0.999) continue;

      const clearance = unit.kind === UnitKind.Boss ? 4.2 : unit.kind === UnitKind.Hero ? 2.9 : 2.3;
      const height = this.groundAt(unit.pos.x, unit.pos.z) + clearance;
      if (!render.project(unit.pos, height, this.screen)) continue;

      const w = unit.kind === UnitKind.Boss ? 64 : unit.kind === UnitKind.Hero ? 46 : elite ? 40 : 30;
      const h = unit.kind === UnitKind.Boss ? 7 : elite ? 5 : 4;
      const x = this.screen.x - w / 2;
      const y = this.screen.y;

      g.fillStyle = 'rgba(0,0,0,0.72)';
      g.fillRect(x - 1, y - 1, w + 2, h + 2);

      const hostile = unit.faction === Faction.Hostile;
      g.fillStyle = unit.id === playerHeroId ? '#4ad06a' : elite ? '#e2b13c' : hostile ? '#d8452f' : '#4a9ad0';
      g.fillRect(x, y, w * fraction, h);

      g.strokeStyle = elite ? 'rgba(255, 220, 120, 0.9)' : 'rgba(255,255,255,0.28)';
      g.lineWidth = 1;
      g.strokeRect(x - 0.5, y - 0.5, w + 1, h + 1);

      // The conjuring's clock, a thinner bar sitting on top of the health one.
      // Only for the ones the player has picked out: ten of these draining at
      // once, unasked, would be noise over the fight they were bought for.
      const life = picked ? summonLifeLeft(unit.id, match.tick) : null;
      if (life !== null) {
        const ly = y - h - 3;
        g.fillStyle = 'rgba(0,0,0,0.72)';
        g.fillRect(x - 1, ly - 1, w + 2, 4);
        // Gold while there is time, red once it is nearly out, so the player
        // can see which half of the pack is about to leave without reading it.
        g.fillStyle = life > 0.25 ? '#f5dda2' : '#d8452f';
        g.fillRect(x, ly, w * life, 2);
      }

      // Exact figures for the hovered unit only. On every bar at once this is
      // unreadable at wave size; on one it answers "can I finish this".
      if (unit.id === hoveredId && unit.id !== playerHeroId) {
        const text = `${Math.ceil(unit.health)} / ${Math.round(unit.stats.maxHealth)}`;
        g.textAlign = 'center';
        g.textBaseline = 'bottom';
        g.font = "700 11px 'Trebuchet MS', system-ui, sans-serif";
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        g.strokeText(text, this.screen.x, y - 3);
        g.fillStyle = '#ffe9a8';
        g.fillText(text, this.screen.x, y - 3);
        g.lineWidth = 1;
      }

      // Mana strip for the player's hero only — everyone else's is noise.
      if (unit.id === playerHeroId && unit.stats.maxMana > 0) {
        const mana = clamp01(unit.mana / unit.stats.maxMana);
        g.fillStyle = 'rgba(0,0,0,0.72)';
        g.fillRect(x - 1, y + h + 1, w + 2, 3);
        g.fillStyle = '#3f87e0';
        g.fillRect(x, y + h + 2, w * mana, 2);
      }
    }
  }

  private drawNumbers(dt: number, render: RenderService): void {
    const g = this.g;
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    for (const n of this.pool) {
      if (!n.active) continue;
      n.life -= dt;
      if (n.life <= 0) {
        n.active = false;
        continue;
      }
      const t = 1 - n.life / n.maxLife;
      // Rises fast then eases out, so the peak of the arc is where the eye lands.
      const rise = n.height + 1.9 + Math.sqrt(t) * 2.6;
      if (!render.project({ x: n.x, z: n.z }, rise, this.screen)) continue;

      const alpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
      const size = 15 * n.scale * (1 + (1 - Math.min(1, t * 5)) * 0.35);

      g.globalAlpha = alpha;
      g.font = `700 ${size.toFixed(1)}px 'Trebuchet MS', system-ui, sans-serif`;
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      const x = this.screen.x + n.driftX * 26 * t;
      g.strokeText(n.text, x, this.screen.y);
      g.fillStyle = n.color;
      g.fillText(n.text, x, this.screen.y);
    }
    g.globalAlpha = 1;
  }
}
