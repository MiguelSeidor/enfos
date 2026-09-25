/**
 * Minimap. Owner: UI agent.
 *
 * Two layers on two canvases:
 *  - a static terrain layer baked once at init from the height field, with
 *    slope-based shading so cliffs read as cliffs;
 *  - a dynamic layer redrawn each frame with units, the Core, the lane and the
 *    camera viewport.
 *
 * Baking the terrain once matters: sampling the height field is the expensive
 * part, and it never changes during a match. The per-frame layer only draws a
 * few hundred dots.
 *
 * Click or drag to move the camera. Terrain is sampled in world space and mapped
 * to pixels through one transform used by both drawing and hit-testing, so what
 * you click is where the camera goes.
 */

import type { EntityId, MatchState, Vec2 } from '@/core/contracts';
import { Faction, UnitKind } from '@/core/contracts';
import type { TerrainService } from '@/core/services';

const SIZE = 200;

export interface MinimapCallbacks {
  /** Called when the player clicks or drags on the map. */
  onSeek: (pos: Vec2) => void;
  /** Camera focus and the half-extent it can see, for the viewport box. */
  getView: () => { focus: Vec2; extent: number; yaw: number };
}

export class Minimap {
  readonly root: HTMLElement;
  private readonly base: HTMLCanvasElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly octx: CanvasRenderingContext2D;
  private minX = 0;
  private minZ = 0;
  private span = 1;

  constructor(
    private readonly terrain: TerrainService,
    private readonly callbacks: MinimapCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'hud-minimap ui-panel ui-gilt';

    this.base = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    for (const c of [this.base, this.overlay]) {
      c.width = SIZE;
      c.height = SIZE;
      this.root.appendChild(c);
    }
    this.octx = this.overlay.getContext('2d')!;

    const b = terrain.bounds;
    this.minX = b.minX;
    this.minZ = b.minZ;
    this.span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);

    this.bakeTerrain();
    this.bindInput();
  }

  private toPixel(x: number, z: number): { px: number; py: number } {
    return {
      px: ((x - this.minX) / this.span) * SIZE,
      py: ((z - this.minZ) / this.span) * SIZE,
    };
  }

  private toWorld(px: number, py: number): Vec2 {
    return {
      x: (px / SIZE) * this.span + this.minX,
      z: (py / SIZE) * this.span + this.minZ,
    };
  }

  /** Height + slope shading, sampled once. Cliffs come out as dark edges. */
  private bakeTerrain(): void {
    const g = this.base.getContext('2d')!;
    const img = g.createImageData(SIZE, SIZE);
    const step = this.span / SIZE;

    let lo = Infinity;
    let hi = -Infinity;
    const heights = new Float32Array(SIZE * SIZE);
    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        const w = this.toWorld(px + 0.5, py + 0.5);
        const h = this.terrain.heightAt(w.x, w.z);
        heights[py * SIZE + px] = h;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    const range = Math.max(1e-3, hi - lo);

    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        const i = py * SIZE + px;
        const h = heights[i]!;
        const t = (h - lo) / range;

        // Slope from the neighbouring samples, used to darken cliff faces.
        const hx = heights[py * SIZE + Math.min(SIZE - 1, px + 1)]!;
        const hz = heights[Math.min(SIZE - 1, py + 1) * SIZE + px]!;
        const slope = Math.min(1, (Math.abs(hx - h) + Math.abs(hz - h)) / (step * 2.5));

        const w = this.toWorld(px + 0.5, py + 0.5);
        const walkable = this.terrain.isWalkable(w.x, w.z);

        // Green where a unit can walk, grey stone where it cannot.
        let r = walkable ? 46 + t * 60 : 60 + t * 55;
        let gg = walkable ? 68 + t * 74 : 62 + t * 58;
        let b = walkable ? 34 + t * 40 : 70 + t * 66;

        const shade = 1 - slope * 0.65;
        r *= shade;
        gg *= shade;
        b *= shade;

        const o = i * 4;
        img.data[o] = r;
        img.data[o + 1] = gg;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }

  private bindInput(): void {
    let dragging = false;
    const seek = (e: PointerEvent): void => {
      const rect = this.overlay.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * SIZE;
      const py = ((e.clientY - rect.top) / rect.height) * SIZE;
      this.callbacks.onSeek(this.toWorld(px, py));
    };
    this.overlay.addEventListener('pointerdown', (e) => {
      dragging = true;
      this.overlay.setPointerCapture(e.pointerId);
      seek(e);
      e.preventDefault();
    });
    this.overlay.addEventListener('pointermove', (e) => {
      if (dragging) seek(e);
    });
    this.overlay.addEventListener('pointerup', (e) => {
      dragging = false;
      this.overlay.releasePointerCapture(e.pointerId);
    });
    this.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Draws lane, Core, units and the camera box. Called once per rendered frame. */
  refresh(match: MatchState, lanes: Vec2[][]): void {
    const g = this.octx;
    g.clearRect(0, 0, SIZE, SIZE);

    // Every enemy route. The forks share a head and a tail, so the shared
    // stretches simply get drawn twice and read as a brighter trunk — which is
    // the correct emphasis: that is where the whole wave converges.
    g.strokeStyle = 'rgba(230, 200, 130, 0.35)';
    g.lineWidth = 2;
    for (const lane of lanes) {
      if (lane.length < 2) continue;
      g.beginPath();
      for (let i = 0; i < lane.length; i++) {
        const p = this.toPixel(lane[i]!.x, lane[i]!.z);
        if (i === 0) g.moveTo(p.px, p.py);
        else g.lineTo(p.px, p.py);
      }
      g.stroke();
    }

    // Core.
    for (const core of match.cores) {
      const p = this.toPixel(core.pos.x, core.pos.z);
      const health = core.maxLives > 0 ? core.lives / core.maxLives : 0;
      g.beginPath();
      g.arc(p.px, p.py, 5, 0, Math.PI * 2);
      g.fillStyle = health > 0.5 ? '#5aa9ff' : health > 0.25 ? '#e0b64a' : '#ff5a3c';
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(255,255,255,0.75)';
      g.stroke();
    }

    // Units. Heroes drawn last so they are never hidden under a creep dot.
    const heroes: EntityId[] = [];
    for (const unit of match.units.values()) {
      if (!unit.alive) continue;
      if (unit.kind === UnitKind.Hero) {
        heroes.push(unit.id);
        continue;
      }
      const p = this.toPixel(unit.pos.x, unit.pos.z);
      const boss = unit.kind === UnitKind.Boss;
      g.fillStyle = unit.faction === Faction.Hostile ? (boss ? '#ff3b2f' : '#e0553f') : '#6fc44a';
      g.fillRect(p.px - (boss ? 2.5 : 1.5), p.py - (boss ? 2.5 : 1.5), boss ? 5 : 3, boss ? 5 : 3);
    }
    for (const id of heroes) {
      const unit = match.units.get(id)!;
      const p = this.toPixel(unit.pos.x, unit.pos.z);
      g.beginPath();
      g.arc(p.px, p.py, 3.6, 0, Math.PI * 2);
      g.fillStyle = '#f0d089';
      g.fill();
      g.lineWidth = 1.2;
      g.strokeStyle = '#3a2f14';
      g.stroke();
    }

    // Camera viewport, drawn as a rotated box so it matches a rotated camera.
    const view = this.callbacks.getView();
    const c = this.toPixel(view.focus.x, view.focus.z);
    const r = (view.extent / this.span) * SIZE;
    g.save();
    g.translate(c.px, c.py);
    g.rotate(-view.yaw);
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 1.4;
    g.strokeRect(-r, -r * 0.62, r * 2, r * 1.24);
    g.restore();
  }
}
