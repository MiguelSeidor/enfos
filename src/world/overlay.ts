/**
 * The authored map overlay. Owner: TERRAIN.
 *
 * ## Why this exists
 *
 * The map is generated: `layout.ts` describes it as a field of functions and
 * `field.ts` quantises that into terraces. That is good for producing a whole
 * coherent world from nothing, and bad for saying "put a torch *there*" — every
 * request of that shape has had to be translated into a parameter change, and
 * the translation has been wrong more often than right.
 *
 * The overlay is the authored half. It is applied *after* generation and wins
 * over it, so the two coexist: the generator lays down a world, a human edits
 * the parts that matter, and neither has to know about the other.
 *
 * ## Shape of the data
 *
 * Terrain edits are stored as **deltas in terrace levels**, not absolute
 * heights, and keyed by cell. A delta survives a change to the generator: if
 * the underlying map is regenerated with different noise, a dug hollow is still
 * a hollow rather than becoming a spike at a stale absolute height. It also
 * makes the file sparse — untouched cells are simply absent.
 *
 * Props are stored in world metres with a rotation, because they are placed by
 * eye and have no grid.
 *
 * ## Persistence
 *
 * The browser cannot write into the repository, so saving downloads a JSON file
 * that the author drops into `public/map/overlay.json`. Loading is a plain
 * fetch of that path, and its absence is not an error — it means "no edits
 * yet", which is exactly the state of a fresh checkout.
 */

/** Everything the editor can place. */
export type PropKind = 'torch' | 'brazier' | 'rock' | 'pillar' | 'banner';

export const PROP_KINDS: readonly PropKind[] = ['torch', 'brazier', 'rock', 'pillar', 'banner'];

/**
 * Props solid enough to stop a shot, with the footprint and height the
 * simulation should treat them as having (metres, at scale 1).
 *
 * Only the two masses that read as cover: a rock is chest-high, so it blocks a
 * ground unit and not a flier, and a broken pillar blocks everything that is
 * not above it. A torch or a banner is a pole — shooting past one is fine, and
 * pretending otherwise would make the map feel arbitrary.
 */
export const SIGHT_BLOCKERS: Partial<Record<PropKind, { radius: number; height: number }>> = {
  rock: { radius: 1.35, height: 1.3 },
  pillar: { radius: 0.55, height: 4.2 },
};

export interface PropPlacement {
  kind: PropKind;
  x: number;
  z: number;
  /** Yaw in radians. */
  rot: number;
  /** 1 is the prop's authored size. */
  scale: number;
}

export interface MapOverlay {
  version: 1;
  /**
   * Terrace-level deltas, keyed `"cellX,cellZ"`.
   *
   * A sparse record rather than a full array: a hand-edited map touches a few
   * hundred cells out of a quarter million, and a dense array would be a
   * megabyte of zeroes in the repository.
   */
  terrain: Record<string, number>;
  props: PropPlacement[];
}

export function emptyOverlay(): MapOverlay {
  return { version: 1, terrain: {}, props: [] };
}

/** Where the authored file lives, relative to the site root. */
export const OVERLAY_URL = '/map/overlay.json';

/**
 * Loads the authored overlay.
 *
 * A missing file is the normal case for a fresh checkout and returns an empty
 * document. A malformed one is not: it is reported and then also returns empty,
 * because booting into a broken map is worse than booting into a generated one.
 */
export async function loadOverlay(): Promise<MapOverlay> {
  try {
    const res = await fetch(OVERLAY_URL, { cache: 'no-cache' });
    if (!res.ok) return emptyOverlay();
    const raw = (await res.json()) as Partial<MapOverlay>;
    if (raw.version !== 1) {
      console.warn(`[overlay] unsupported version ${String(raw.version)}, ignoring`);
      return emptyOverlay();
    }
    return {
      version: 1,
      terrain: raw.terrain ?? {},
      props: Array.isArray(raw.props) ? raw.props : [],
    };
  } catch (err) {
    console.warn('[overlay] failed to load, using generated map only', err);
    return emptyOverlay();
  }
}

/**
 * Offers the overlay as a download.
 *
 * Deliberately not silent: the author has to put the file somewhere, and a save
 * that appeared to work but changed nothing on disk would be the worst possible
 * outcome for a tool whose entire job is persistence.
 */
export function downloadOverlay(overlay: MapOverlay): void {
  const json = JSON.stringify(overlay, null, 1);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'overlay.json';
  a.click();
  // Revoked on the next frame: revoking immediately races the download in
  // some browsers and silently produces an empty file.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

/** Cell key used by `MapOverlay.terrain`. */
export function cellKey(ix: number, iz: number): string {
  return `${ix},${iz}`;
}
