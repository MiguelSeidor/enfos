/**
 * In-game map editor. Owner: TERRAIN.
 *
 * Opened with `?edit=1`. Raise and lower the ground, place props, save the
 * result as `overlay.json`.
 *
 * ## Why it exists
 *
 * Every request of the form "make the ground flat *here*" or "put a torch
 * *there*" has had to be translated into a change to the generator's
 * parameters, and the translation has repeatedly produced something other than
 * what was asked for — torches in the middle of the road, plateaus with knolls
 * in them. The generator is the wrong tool for local, specific intent. This is
 * the right one: the author points at the map and changes it.
 *
 * ## Design
 *
 * The editor never mutates the terrain directly. It edits a `MapOverlay` and
 * asks the terrain module to re-derive from it, which means the edit that is
 * previewed and the edit that is saved are the same object — there is no
 * separate "apply" path that could drift from the preview.
 *
 * Rebuilds are debounced by a frame. A brush stroke touches many cells and a
 * full terrain rebuild per cell would be unusable; per frame it is smooth.
 */

import * as THREE from 'three';
import type { GameContext, GameModule } from '@/core/contracts';
import { RenderKey } from '@/core/services';
import { getField, getOverlay, type TerrainModule } from './terrain';
import type { PropsModule } from './props';
import { cellKey, downloadOverlay, PROP_KINDS, type MapOverlay, type PropKind } from './overlay';
import { CELL, CELLS, MAP_HALF } from './layout';
import './editor.css';

type Tool = 'raise' | 'lower' | 'flatten' | 'prop' | 'erase';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'raise', label: 'Subir', hint: 'Clic izquierdo sube una terraza' },
  { id: 'lower', label: 'Bajar', hint: 'Clic izquierdo baja una terraza' },
  { id: 'flatten', label: 'Aplanar', hint: 'Iguala a la altura del primer clic' },
  { id: 'prop', label: 'Objeto', hint: 'Coloca el objeto elegido' },
  { id: 'erase', label: 'Borrar', hint: 'Quita objetos y edits del terreno' },
];

export class EditorModule implements GameModule {
  readonly id = 'editor';
  // After terrain (100) so the field exists, and after render (900) is not
  // needed — this only reads the camera through the raycast below.
  readonly order = 950;

  /**
   * The terrain module, injected rather than looked up.
   *
   * `GameContext` exposes services, not modules, and rebuilding geometry is not
   * something the runtime `TerrainService` contract should have to carry for
   * the sake of an authoring tool. `createWorldModules` builds both and can
   * simply hand one to the other.
   */
  constructor(
    private readonly terrainModule: TerrainModule,
    private readonly propsModule: PropsModule,
  ) {}

  private ctx!: GameContext;
  private overlay!: MapOverlay;
  private root: HTMLElement | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();

  private tool: Tool = 'raise';
  private prop: PropKind = 'torch';
  private painting = false;
  /** Level the flatten tool is levelling to, captured on press. */
  private flattenTo = 0;

  /**
   * The cell the drag started on, and the cell the cursor is over.
   *
   * Together they define a rectangle. A radius brush was the first design and
   * it was the wrong one: a radius-3 circle is twenty-nine cells, the author
   * could not see which twenty-nine until after committing, and "raise this
   * square" — the actual request — could not be expressed at all. A dragged
   * rectangle is exact, previewable, and degenerates to a single cell on a
   * plain click.
   */
  private anchor: { ix: number; iz: number } | null = null;
  private cursor: { ix: number; iz: number } | null = null;

  /** Translucent overlay showing precisely which cells an edit will touch. */
  private preview: THREE.Mesh | null = null;
  /** Human-readable size of the current selection, for the status line. */
  private selectionInfo = '';
  /** Set when an edit needs a rebuild; consumed once per frame. */
  private dirty = false;
  private statusEl: HTMLElement | null = null;

  init(ctx: GameContext): void {
    this.ctx = ctx;
    this.overlay = getOverlay();
    this.buildUi();
    this.bindInput();
  }

  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.terrainModule.applyOverlay(this.overlay);
    // Props after the terrain: they are placed on its height field, so a
    // terrain edit under a prop has to move the prop too.
    this.propsModule.rebuild(this.overlay);
    this.status();
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  private bindInput(): void {
    // Bound on `window`, not on a canvas. `document.querySelector('canvas')`
    // can return the HUD's 2D overlay rather than the WebGL surface, and then
    // no click ever reaches the editor. Filtering by target is reliable
    // regardless of which canvas is first in the DOM.
    window.addEventListener('pointerdown', (e) => {
      if (this.overUi(e) || e.button !== 0) return;
      const cell = this.pickCell(e.clientX, e.clientY);
      if (!cell) return;
      // Captured before the edit so the whole rectangle levels to one height —
      // sampling per cell would make flatten a no-op.
      this.flattenTo = getField().level[cell.iz * CELLS + cell.ix] ?? 0;
      this.anchor = cell;
      this.cursor = cell;
      this.painting = true;
      this.drawPreview();
    });

    window.addEventListener('pointermove', (e) => {
      if (this.overUi(e)) {
        // Hide the preview while the pointer is over the panel, or a stale
        // rectangle sits on the map suggesting an edit that is not pending.
        if (!this.painting) this.clearPreview();
        return;
      }
      const cell = this.pickCell(e.clientX, e.clientY);
      if (!cell) return;
      this.cursor = cell;
      // Outside a drag the preview follows the cursor as a single cell, so the
      // author always knows what a click would hit before making it.
      if (!this.painting) this.anchor = cell;
      this.drawPreview();
    });

    window.addEventListener('pointerup', (e) => {
      if (!this.painting) return;
      this.painting = false;
      if (!this.overUi(e)) this.applyRect();
      this.anchor = this.cursor;
      this.drawPreview();
    });
  }

  private pickCell(screenX: number, screenY: number): { ix: number; iz: number } | null {
    const hit = this.pick(screenX, screenY);
    return hit ? getField().cellAt(hit.x, hit.z) : null;
  }

  /** The inclusive cell rectangle between anchor and cursor. */
  private rect(): { x0: number; x1: number; z0: number; z1: number } | null {
    if (!this.anchor || !this.cursor) return null;
    return {
      x0: Math.min(this.anchor.ix, this.cursor.ix),
      x1: Math.max(this.anchor.ix, this.cursor.ix),
      z0: Math.min(this.anchor.iz, this.cursor.iz),
      z1: Math.max(this.anchor.iz, this.cursor.iz),
    };
  }

  /** True when the event landed on the editor's own panel or on game UI. */
  private overUi(e: PointerEvent): boolean {
    const target = e.target as HTMLElement | null;
    return !!target?.closest('.editor, .menu, .options, .shop, .hero-select');
  }

  private pick(screenX: number, screenY: number): { x: number; z: number } | null {
    const ground = this.ctx.scene.getObjectByName('terrain.ground');
    if (!ground) return null;
    const camera = this.ctx.services.get(RenderKey).camera;
    this.ndc.x = (screenX / window.innerWidth) * 2 - 1;
    this.ndc.y = -(screenY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.ndc, camera);
    const hit = this.raycaster.intersectObject(ground, false)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }

  // ── Editing ────────────────────────────────────────────────────────────────

  /**
   * Commits the current rectangle.
   *
   * Applied once on release rather than continuously while dragging, which is
   * what makes the edit predictable: dragging over a cell twice used to raise
   * it twice, so the same gesture produced a different result depending on how
   * the mouse wandered.
   */
  private applyRect(): void {
    const r = this.rect();
    if (!r) return;
    const field = getField();

    if (this.tool === 'prop') {
      // One prop per cell of the rectangle, so a drag lays a row or a patch and
      // a click places exactly one.
      for (let iz = r.z0; iz <= r.z1; iz++) {
        for (let ix = r.x0; ix <= r.x1; ix++) {
          const x = -MAP_HALF + (ix + 0.5) * CELL;
          const z = -MAP_HALF + (iz + 0.5) * CELL;
          this.overlay.props.push({
            kind: this.prop,
            x,
            z,
            // Varied on placement so a row of props is not visibly stamped.
            rot: (Math.random() - 0.5) * Math.PI * 2,
            scale: 0.9 + Math.random() * 0.25,
          });
        }
      }
      this.dirty = true;
      return;
    }

    if (this.tool === 'erase') {
      // Props inside the rectangle go first: erasing over one almost always
      // means that prop, not the terrain under it.
      const x0 = -MAP_HALF + r.x0 * CELL;
      const x1 = -MAP_HALF + (r.x1 + 1) * CELL;
      const z0 = -MAP_HALF + r.z0 * CELL;
      const z1 = -MAP_HALF + (r.z1 + 1) * CELL;
      const before = this.overlay.props.length;
      this.overlay.props = this.overlay.props.filter(
        (p) => p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1,
      );
      if (this.overlay.props.length !== before) {
        this.dirty = true;
        return;
      }
    }

    for (let iz = r.z0; iz <= r.z1; iz++) {
      for (let ix = r.x0; ix <= r.x1; ix++) {
        const key = cellKey(ix, iz);

        if (this.tool === 'erase') {
          delete this.overlay.terrain[key];
          continue;
        }
        if (this.tool === 'raise') {
          this.overlay.terrain[key] = (this.overlay.terrain[key] ?? 0) + 1;
          continue;
        }
        if (this.tool === 'lower') {
          this.overlay.terrain[key] = (this.overlay.terrain[key] ?? 0) - 1;
          continue;
        }
        if (this.tool === 'flatten') {
          // Flatten is expressed as a delta like everything else: the target
          // minus whatever the generator produced here. That keeps the file in
          // one representation instead of mixing deltas and absolutes.
          const generated = field.level[iz * CELLS + ix];
          if (generated === undefined) continue;
          const current = this.overlay.terrain[key] ?? 0;
          this.overlay.terrain[key] = this.flattenTo - (generated - current);
        }
      }
    }
    this.dirty = true;
  }

  /**
   * Redraws the selection overlay.
   *
   * One quad per cell, lifted clear of the ground and drawn without depth
   * testing. Without `depthTest: false` the preview z-fights the terrain it is
   * describing, which is worse than no preview at all — the author cannot tell
   * whether a flickering cell is selected.
   */
  private drawPreview(): void {
    const r = this.rect();
    if (!r) {
      this.clearPreview();
      return;
    }

    const field = getField();
    const positions: number[] = [];
    const push = (x: number, y: number, z: number): void => {
      positions.push(x, y, z);
    };

    for (let iz = r.z0; iz <= r.z1; iz++) {
      for (let ix = r.x0; ix <= r.x1; ix++) {
        const x0 = -MAP_HALF + ix * CELL;
        const x1 = x0 + CELL;
        const z0 = -MAP_HALF + iz * CELL;
        const z1 = z0 + CELL;
        // Sampled per corner so the sheet follows a terraced surface instead of
        // slicing through it.
        const lift = 0.12;
        const yA = field.heightAt(x0, z0) + lift;
        const yB = field.heightAt(x1, z0) + lift;
        const yC = field.heightAt(x1, z1) + lift;
        const yD = field.heightAt(x0, z1) + lift;
        push(x0, yA, z0); push(x1, yB, z0); push(x1, yC, z1);
        push(x0, yA, z0); push(x1, yC, z1); push(x0, yD, z1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

    if (!this.preview) {
      this.preview = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({
          color: 0x7fd4ff,
          transparent: true,
          opacity: 0.35,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      this.preview.renderOrder = 999;
      this.preview.frustumCulled = false;
      this.ctx.scene.add(this.preview);
    } else {
      this.preview.geometry.dispose();
      this.preview.geometry = geo;
    }

    const cells = (r.x1 - r.x0 + 1) * (r.z1 - r.z0 + 1);
    this.selectionInfo = `${r.x1 - r.x0 + 1} × ${r.z1 - r.z0 + 1} celdas (${cells})`;
    this.status();
  }

  private clearPreview(): void {
    if (!this.preview) return;
    this.preview.geometry.dispose();
    (this.preview.material as THREE.Material).dispose();
    this.preview.removeFromParent();
    this.preview = null;
    this.selectionInfo = '';
    this.status();
  }

  // ── UI ─────────────────────────────────────────────────────────────────────

  private buildUi(): void {
    const root = document.createElement('div');
    root.className = 'editor';
    root.innerHTML = `
      <h4>Editor de mapa</h4>
      <div class="editor-tools"></div>
      <div class="editor-props"></div>
      <div class="editor-status"></div>
      <div class="editor-actions">
        <button data-act="save">Guardar overlay.json</button>
        <button data-act="clear">Vaciar todo</button>
      </div>
      <p class="editor-help">
        <b>Clic</b> una celda · <b>Arrastra</b> para seleccionar un rectángulo<br>
        El área azul es exactamente lo que se va a modificar<br>
        Guarda y copia el archivo a <code>public/map/overlay.json</code>
      </p>`;

    const tools = root.querySelector('.editor-tools')!;
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.textContent = t.label;
      b.title = t.hint;
      b.dataset.tool = t.id;
      b.addEventListener('click', () => {
        this.tool = t.id;
        this.syncButtons(root);
        this.status();
      });
      tools.appendChild(b);
    }

    const props = root.querySelector('.editor-props')!;
    for (const kind of PROP_KINDS) {
      const b = document.createElement('button');
      b.textContent = kind;
      b.dataset.prop = kind;
      b.addEventListener('click', () => {
        this.prop = kind;
        this.tool = 'prop';
        this.syncButtons(root);
        this.status();
      });
      props.appendChild(b);
    }

    root.querySelector('[data-act="save"]')!.addEventListener('click', () => {
      downloadOverlay(this.overlay);
    });
    root.querySelector('[data-act="clear"]')!.addEventListener('click', () => {
      this.overlay.terrain = {};
      this.overlay.props = [];
      this.dirty = true;
    });

    this.statusEl = root.querySelector('.editor-status');
    document.body.appendChild(root);
    this.root = root;
    this.syncButtons(root);
    this.status();
  }

  private syncButtons(root: HTMLElement): void {
    for (const b of root.querySelectorAll<HTMLElement>('[data-tool]')) {
      b.classList.toggle('is-active', b.dataset.tool === this.tool);
    }
    for (const b of root.querySelectorAll<HTMLElement>('[data-prop]')) {
      b.classList.toggle('is-active', this.tool === 'prop' && b.dataset.prop === this.prop);
    }
  }

  private status(): void {
    if (!this.statusEl) return;
    const cells = Object.keys(this.overlay.terrain).length;
    // Selection first: it is the thing that changes as the author drags, and
    // the totals only matter when deciding to save.
    this.statusEl.textContent =
      (this.selectionInfo ? `Selección ${this.selectionInfo}\n` : '') +
      `${cells} celdas editadas · ${this.overlay.props.length} objetos`;
  }

  dispose(): void {
    this.clearPreview();
    this.root?.remove();
  }
}
