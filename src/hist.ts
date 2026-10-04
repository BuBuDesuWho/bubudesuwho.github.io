// Reading play history: which song a record belongs to, and how it scored.
// Every page that folds `hist` goes through here so the menu, stats and the
// results card can't disagree about either.

import type { HistRecord } from './storage';
import { SlotState } from './types';
import { slotState } from './answer';
import { isoDay } from './achievements';

interface HistSong {
  id: string;
  name: string;
  hidden?: boolean;
}

export type PlayResolver<S extends HistSong> = (rec: Pick<HistRecord, 'songId' | 'songName'>) => S | undefined;

/** Map a history record to its song: by id when the record has one, else by
 *  name. Records saved before ids were stored only carry the display name,
 *  and a few songs share one (hidden test variants sit next to the real
 *  song), so a name prefers the first non-hidden song that has it. A record
 *  whose id no longer exists also falls back to its name. */
export function playResolver<S extends HistSong>(songs: readonly S[]): PlayResolver<S> {
  const byId = new Map<string, S>();
  const byName = new Map<string, S>();
  for (const s of songs) {
    byId.set(s.id, s);
    const prev = byName.get(s.name);
    if (!prev || (prev.hidden && !s.hidden)) byName.set(s.name, s);
  }
  return (rec) => (rec.songId ? byId.get(rec.songId) : undefined) ?? byName.get(rec.songName);
}

/** Was this line answered exactly right? Same rule as the play page's Check. */
export function isLineRight(chosen: number[], ans: number[]): boolean {
  return slotState(chosen, ans) === SlotState.Correct;
}

export interface PlayGrade {
  /** Lines in the play, answered or not. */
  total: number;
  /** Lines with at least one pick. */
  attempted: number;
  correct: number;
}

export function gradePlay(slots: HistRecord['slots']): PlayGrade {
  let attempted = 0;
  let correct = 0;
  for (const [chosen, ans] of slots) {
    if (chosen.length === 0) continue;
    attempted++;
    if (isLineRight(chosen, ans)) correct++;
  }
  return { total: slots.length, attempted, correct };
}

/** Today as a local-time YYYY-MM-DD (not UTC, so a late-night play lands on
 *  the day the player saw). */
export function histDate(d: Date = new Date()): string {
  return isoDay(d);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A stored date for display. New records are ISO days, shown in the
 *  browser's locale like the older toLocaleDateString() records already are. */
export function formatHistDate(raw: string): string {
  const m = ISO_DAY.exec(raw);
  if (!m) return raw;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString();
}
