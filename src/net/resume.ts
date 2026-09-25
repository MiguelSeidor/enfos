/**
 * Rejoin credentials. Owner: NET.
 *
 * Saved when an online match starts, so a player whose connection drops — or
 * whose browser reloads or crashes — can take their seat back.
 *
 * Written to both stores on purpose. `sessionStorage` belongs to the tab, so a
 * reload of *this* tab finds *its* seat even when another tab of the same
 * browser is in the match too. `localStorage` outlives the tab, so a player who
 * closed the window can still come back from a fresh one.
 */

import { clearSnapshots } from './snapshotStore';

const KEY = 'nucleo-eterno.resume.v1';
/** Older than this, the match is certainly over; do not even try. */
const MAX_AGE_MS = 3 * 60 * 60 * 1000;

export interface ResumeInfo {
  code: string;
  token: string;
  savedAt: number;
}

export function saveResume(code: string, token: string): void {
  const value = JSON.stringify({ code, token, savedAt: Date.now() } satisfies ResumeInfo);
  for (const store of stores()) {
    try {
      store.setItem(KEY, value);
    } catch {
      // Storage refused (private mode): rejoining after a reload is lost, play is not.
    }
  }
}

export function loadResume(): ResumeInfo | null {
  for (const store of stores()) {
    try {
      const raw = store.getItem(KEY);
      if (!raw) continue;
      const info = JSON.parse(raw) as ResumeInfo;
      if (typeof info.code === 'string' && typeof info.token === 'string' && Date.now() - info.savedAt < MAX_AGE_MS) {
        return info;
      }
    } catch {
      // Unreadable entry: treat as absent.
    }
  }
  return null;
}

/**
 * Marks the reload about to happen as a desync recovery, so the rejoin knows
 * to fall back to the last snapshot every machine agreed on rather than this
 * browser's newest one. `sessionStorage`, because it concerns this tab only
 * and must not outlive it.
 */
const RESYNC_KEY = 'nucleo-eterno.resync.v1';

export function markResync(): void {
  try {
    sessionStorage.setItem(RESYNC_KEY, '1');
  } catch {
    // Without it the rejoin replays the whole match instead: slower, still correct.
  }
}

/** Reads the flag and clears it: one reload, one recovery. */
export function takeResyncFlag(): boolean {
  try {
    const had = sessionStorage.getItem(RESYNC_KEY) !== null;
    sessionStorage.removeItem(RESYNC_KEY);
    return had;
  } catch {
    return false;
  }
}

export function clearResume(): void {
  // The snapshots belong to the seat being forgotten; without it they are dead weight.
  void clearSnapshots().catch(() => {});
  for (const store of stores()) {
    try {
      store.removeItem(KEY);
    } catch {
      // Nothing to clear.
    }
  }
}

function stores(): Storage[] {
  const out: Storage[] = [];
  try {
    out.push(sessionStorage);
  } catch {
    // Unavailable.
  }
  try {
    out.push(localStorage);
  } catch {
    // Unavailable.
  }
  return out;
}
