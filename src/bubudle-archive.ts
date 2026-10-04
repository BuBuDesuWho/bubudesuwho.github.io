// Snapshot of which lyric line each past daily actually served.
//
// The daily pick is `seed(scopeKey|date) % poolSize` indexed into the *current*
// lyric pool, so every song added or edited silently changes what a past date
// resolves to. The manifest pins each day to the line it served, so the archive
// keeps showing the puzzle people actually played.
//
// Built by scripts/backfill-daily-manifest.mjs (git history) and appended to
// daily by twitter/gen_daily.sh. It's also what the no-repeat rotation reads to
// know which lines have already been served, so from ROTATION_START onward the
// daily needs it too, not just the archive.

import { contentUrl } from './config';
import { lineKey, walkRotation } from './bubudle-rotation';
import { DailyScope, ROTATION_START, pickDailyIndex, scopeKey, shiftDate } from './bubudle-daily';

/** Compact on purpose: this file grows by one entry per scope per day. */
export interface ArchiveEntry {
  /** Song id. */
  s: string;
  /** The line's [start, end], which identifies it within the song. */
  r: [number, number];
  /**
   * Rotation cycle this day belongs to; absent means 0. Only lines from the
   * current cycle count as "already used", so the exclusion set doesn't union
   * across a reset once the pool has been exhausted once.
   */
  c?: number;
}

export type DailyManifest = Record<string, Record<string, ArchiveEntry>>;

let manifest: DailyManifest | null = null;
let inFlight: Promise<DailyManifest> | null = null;

/**
 * Load the manifest once. A miss is not fatal — callers fall back to computing
 * the pick live, which is correct for every date since the library last changed.
 */
export function loadDailyManifest(): Promise<DailyManifest> {
  if (manifest) return Promise.resolve(manifest);
  if (!inFlight) {
    inFlight = fetch(contentUrl('songs/daily-manifest.json'))
      .then((r) => (r.ok ? r.json() as Promise<DailyManifest> : {}))
      .catch(() => ({} as DailyManifest))
      .then((m) => { manifest = m; return m; });
  }
  return inFlight;
}

/** The pinned pick for a day, or null to fall back to a live compute. */
export function archiveEntry(scopeKey: string, date: string): ArchiveEntry | null {
  return manifest?.[scopeKey]?.[date] ?? null;
}

/** True once a load has been attempted and produced something usable. */
export function manifestLoaded(): boolean {
  return manifest !== null && Object.keys(manifest).length > 0;
}

export interface RotationHistory {
  /** Lines already served in the current cycle, as lineKey strings. */
  used: Set<string>;
  /** Highest cycle the manifest records for this scope. */
  cycle: number;
  /** Latest recorded day, or null if the scope has no history at all. */
  lastDate: string | null;
}

/**
 * Replay what the manifest records for a scope, up to but excluding `date`.
 * Only the current cycle's lines count as used — earlier cycles were reset.
 */
export function rotationHistory(scopeKey: string, date: string): RotationHistory {
  const days = manifest?.[scopeKey];
  if (!days) return { used: new Set(), cycle: 0, lastDate: null };

  const past = Object.entries(days).filter(([d]) => d < date);
  const cycle = past.reduce((max, [, e]) => Math.max(max, e.c ?? 0), 0);

  const used = new Set<string>();
  let lastDate: string | null = null;
  for (const [d, e] of past) {
    if ((e.c ?? 0) === cycle) used.add(lineKey(e.s, e.r));
    if (!lastDate || d > lastDate) lastDate = d;
  }
  return { used, cycle, lastDate };
}

/**
 * The line a scope's daily serves on `date`, from `pool` in pool order.
 * Resolution order: a day the manifest records is pinned to the line it actually
 * served; anything it hasn't caught up to is drawn by the rotation, or by the
 * legacy draw when the manifest didn't load (better a valid line computed the
 * old way than an empty board). An archived day whose line is gone is null:
 * x'd out rather than silently swapped. Today's is better served by a live draw.
 */
export function pickDailyLine<T>(
  pool: T[],
  keyOf: (item: T) => string,
  scope: DailyScope,
  date: string,
  archive: boolean,
): T | null {
  const key = scopeKey(scope);
  const pinned = archiveEntry(key, date);
  if (pinned) {
    const found = pool.find((c) => keyOf(c) === lineKey(pinned.s, pinned.r));
    if (found) return found;
    if (archive) return null;
  }
  return rotationPick(pool, keyOf, key, date) ?? pool[pickDailyIndex(scope, date, pool.length)] ?? null;
}

// Draws the day from the lines not yet used this cycle.
function rotationPick<T>(pool: T[], keyOf: (item: T) => string, key: string, date: string): T | null {
  if (date < ROTATION_START || !manifestLoaded()) return null;
  const { used, cycle, lastDate } = rotationHistory(key, date);
  const from = lastDate ? shiftDate(lastDate, 1) : ROTATION_START;
  return walkRotation(pool, keyOf, key, used, cycle, from, date).pick;
}
