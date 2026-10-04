// "Who's singing" rhythm mode: the game logic, no DOM. The view (whosings-view.ts)
// feeds it the song clock and member presses; everything here is pure.
//
// Guessing works off the game's own slots (song.slotsBase), so it follows the
// same rules as the quiz: full-cast lines aren't asked, same-singer runs are
// one slot, per-song ignore directives apply, and slot.diff <= the chosen
// difficulty. Guesses here never touch the quiz's history or mastery.
import type { Song } from './types';

export interface WsLine {
  start: number;
  end: number;
  ans: number[];
  lyric: string;
}

export interface RevealHold {
  start: number;
  end: number;
  member: number;
}

export type LineResult = 'right' | 'wrong' | 'none';

/** A click this early still counts for the line about to start. */
export const GRACE = 0.25;
/** Shortest hold worth drawing in reveal mode. */
const MIN_HOLD = 0.3;
/** Back-to-back holds on one lane need a sliver between them. */
const HOLD_GAP = 0.05;

function lyricIndex(song: Song): Map<number, string> {
  const byId = new Map<number, string>();
  for (const tok of song.lyricsBase) {
    if (tok.type === 'lyric' && tok.mapping && tok.text) byId.set(tok.mapping.id, tok.text);
  }
  return byId;
}

/** Guess slots at a difficulty, in time order, with their lyric text
 *  (a combined slot joins its lines' text). */
export function buildLines(song: Song, diff: number): WsLine[] {
  const text = lyricIndex(song);
  return song.slotsBase
    .map((b) => b.mapping)
    .filter((m) => (m.diff ?? 1) <= diff)
    .map((m) => ({
      start: m.range[0],
      end: m.range[1],
      ans: [...(m.ans ?? [])].sort((a, b) => a - b),
      lyric: (m.members ?? [m.id]).map((id) => text.get(id) ?? '').filter(Boolean).join(' / '),
    }))
    .sort((a, b) => a.start - b.start);
}

/** Every timed line with its lyric, full-cast ones included — what reveal
 *  mode shows as the song plays. */
export function revealLines(song: Song): WsLine[] {
  const text = lyricIndex(song);
  return (song.mapping ?? [])
    .filter((m) => m.range)
    .map((m) => ({
      start: m.range[0],
      end: m.range[1],
      ans: [...(m.ans ?? [])].sort((a, b) => a - b),
      lyric: text.get(m.id) ?? '',
    }))
    .sort((a, b) => a.start - b.start);
}

/** Index of the line in play at t (latest-starting wins on overlap), or -1.
 *  Lines count from GRACE before their start. `lines` must be time-sorted. */
export function activeLineAt(lines: WsLine[], t: number): number {
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.start - GRACE > t) break;
    if (t < l.end) best = i;
  }
  return best;
}

// Home row, left to right; the middle slot answers to G, H or Space.
const KEY_SLOT: Record<string, number> = { a: 0, s: 1, d: 2, f: 3, g: 4, h: 4, ' ': 4, j: 5, k: 6, l: 7, ';': 8 };
const SLOTS = 9;
const CENTRE = 4;

/** Which of n left-to-right lanes a key presses, or null. An odd cast takes a
 *  run of slots centred on the middle key; an even cast leaves the middle key
 *  out and splits across the hands. More than nine lanes is pointer-only. */
export function laneForKey(key: string, n: number): number | null {
  const slot = KEY_SLOT[key.toLowerCase()];
  if (slot === undefined || n < 1 || n > SLOTS) return null;
  let lane: number;
  if (n % 2) {
    lane = slot - (SLOTS - n) / 2;
  } else {
    if (slot === CENTRE) return null;
    const half = n / 2;
    lane = slot < CENTRE ? slot - (CENTRE - half) : half + slot - CENTRE - 1;
  }
  return lane >= 0 && lane < n ? lane : null;
}

/** Lowest difficulty that has any slots — where the quiz starts too. */
export function lowestDiff(song: Song): number {
  const diffs = song.slotsBase.map((b) => b.mapping.diff ?? 1);
  return diffs.length ? Math.min(...diffs) : 1;
}

/** Every timed line as one hold per singer, for "Auto play (reveal)". Unlike
 *  guessing this includes full-cast lines — it's showing the whole song. */
export function revealHolds(song: Song): RevealHold[] {
  const singers = new Set(song.singers);
  const freeAt = new Map<number, number>();
  const holds: RevealHold[] = [];
  const lines = (song.mapping ?? [])
    .filter((m) => m.range && m.ans)
    .sort((a, b) => a.range[0] - b.range[0]);
  for (const m of lines) {
    for (const member of m.ans!) {
      if (!singers.has(member)) continue;
      const start = Math.max(m.range[0], freeAt.get(member) ?? -Infinity);
      const end = Math.max(m.range[1], m.range[0] + MIN_HOLD);
      if (end - start < MIN_HOLD) continue;
      freeAt.set(member, end + HOLD_GAP);
      holds.push({ start, end, member });
    }
  }
  return holds.sort((a, b) => a.start - b.start || a.member - b.member);
}

/** Holds starting this close together land "at the same time" and get SIF's linking bar. */
export const SAME_TIME = 0.05;

/** Sets of reveal holds that land together on different faces, as indices into
 *  `holds` ordered by member (the arc's left-to-right order). `holds` must be
 *  sorted by start, as revealHolds returns them. */
export function sameTimeGroups(holds: readonly RevealHold[], eps = SAME_TIME): number[][] {
  const groups: number[][] = [];
  let i = 0;
  while (i < holds.length) {
    const members = new Set<number>();
    const group: number[] = [];
    let j = i;
    for (; j < holds.length && holds[j].start - holds[i].start <= eps; j++) {
      if (members.has(holds[j].member)) continue;
      members.add(holds[j].member);
      group.push(j);
    }
    if (group.length > 1) groups.push(group.sort((a, b) => holds[a].member - holds[b].member));
    i = j;
  }
  return groups;
}

/** Indices of holds whose start falls in (from, to], written into `out` so a
 *  frame loop can reuse one array. `holds` must be sorted by start. */
export function landingsBetween(holds: readonly RevealHold[], from: number, to: number, out: number[] = []): number[] {
  out.length = 0;
  for (let i = 0; i < holds.length; i++) {
    const s = holds[i].start;
    if (s > to) break;
    if (s > from) out.push(i);
  }
  return out;
}

// Scoring is SIF-flavoured: every right line is worth BASE_POINTS, plus a combo
// bonus that ramps up and then plateaus so one early slip doesn't decide the rank.
export const BASE_POINTS = 100;
const COMBO_BONUS = 10;
const COMBO_CAP = 10;

/** Points for a right line that brings the combo to `combo`. */
export function linePoints(combo: number): number {
  return BASE_POINTS + COMBO_BONUS * Math.min(Math.max(combo - 1, 0), COMBO_CAP);
}

/** Best possible score over n asked lines: all right, one unbroken combo. */
export function maxScore(n: number): number {
  let total = 0;
  for (let k = 1; k <= n; k++) total += linePoints(k);
  return total;
}

export type Rank = 'C' | 'B' | 'A' | 'S';
/** Share of the song's max score needed for each rank. S sits below a perfect
 *  run so a couple of misses can still get there, like SIF. */
const RANK_SHARE: [Rank, number][] = [['C', 0.3], ['B', 0.5], ['A', 0.7], ['S', 0.85]];

export function rankThresholds(max: number): { rank: Rank; score: number }[] {
  return RANK_SHARE.map(([rank, share]) => ({ rank, score: Math.round(max * share) }));
}

export function rankFor(score: number, max: number): Rank | null {
  let out: Rank | null = null;
  for (const th of rankThresholds(max)) if (max > 0 && score >= th.score) out = th.rank;
  return out;
}

export interface RunStats {
  score: number;
  /** Right lines in a row, up to the latest judged line. */
  combo: number;
  maxCombo: number;
}

/** Score and combo from per-line results in time order. A wrong or unguessed
 *  line breaks the combo; lines never reached (skipped by a seek, or still to
 *  come) are left out rather than counted against you. */
export function runStats(results: readonly (LineResult | null)[]): RunStats {
  const out: RunStats = { score: 0, combo: 0, maxCombo: 0 };
  for (const r of results) {
    if (r === null) continue;
    if (r === 'right') {
      out.combo++;
      out.score += linePoints(out.combo);
      out.maxCombo = Math.max(out.maxCombo, out.combo);
    } else {
      out.combo = 0;
    }
  }
  return out;
}

/** Fewest judged lines a run needs before it can call itself a full combo. */
export const FULL_COMBO_MIN = 3;

/** Every line playback reached was right, and there were enough of them to
 *  mean something. Unreached lines (skipped or still to come) don't count;
 *  an unguessed line breaks it just as it breaks the combo. */
export function isFullCombo(results: readonly (LineResult | null)[], min = FULL_COMBO_MIN): boolean {
  let judged = 0;
  for (const r of results) {
    if (r === null) continue;
    if (r !== 'right') return false;
    judged++;
  }
  return judged >= Math.max(1, min);
}

/** Length of the count-in after a pause. */
export const COUNTDOWN_MS = 3000;

/** The number to show with msLeft of the count-in to go (3, 2, 1), or null
 *  once it's over and the music should start. */
export function countdownStep(msLeft: number, total = COUNTDOWN_MS): number | null {
  if (!(msLeft > 0)) return null;
  const steps = Math.round(total / 1000);
  return Math.min(steps, Math.ceil(msLeft / 1000));
}

/** Whole-number percentage, 0 when there's nothing to divide by. */
export function accuracyPct(hit: number, of: number): number {
  return of > 0 ? Math.round((100 * hit) / of) : 0;
}

export interface MemberStat {
  member: number;
  /** Judged lines this member sings. */
  lines: number;
  /** Of those, how many had them picked. */
  caught: number;
  /** Judged lines they were picked for but don't sing. */
  wrongPicks: number;
}

/** Per-member breakdown of a run: how often each singer was spotted, and how
 *  often they were blamed for someone else's line. Only judged lines count, so
 *  a partial run isn't penalised for the part it skipped. Order follows
 *  `members`. */
export function memberStats(
  members: readonly number[],
  lines: readonly WsLine[],
  results: readonly (LineResult | null)[],
  guesses: readonly ReadonlySet<number>[],
): MemberStat[] {
  const out = new Map<number, MemberStat>(members.map((m) => [m, { member: m, lines: 0, caught: 0, wrongPicks: 0 }]));
  lines.forEach((l, i) => {
    if (results[i] === null) return;
    const picked = guesses[i];
    for (const m of l.ans) {
      const st = out.get(m);
      if (!st) continue;
      st.lines++;
      if (picked.has(m)) st.caught++;
    }
    for (const m of picked) {
      const st = out.get(m);
      if (st && !l.ans.includes(m)) st.wrongPicks++;
    }
  });
  return members.map((m) => out.get(m)!);
}

export interface Tally {
  right: number;
  guessed: number;
  /** Lines that were actually played through (skipped ones don't count). */
  total: number;
}

/**
 * One run through a song. A line is scored only if playback ran into its
 * start, so lines jumped past by a seek never count as wrong. Picks made
 * between lines wait in `pending` and become the next line's guess.
 */
export class GuessSession {
  readonly lines: WsLine[];
  private guesses: Set<number>[];
  private live: boolean[];
  private results: (LineResult | null)[];
  private pending = new Set<number>();
  private lastActive = -1;
  private lastT: number;
  private judged: number[] = [];
  private stats: RunStats | null = null;
  /** True once any part of the song was skipped; such runs can't set a best. */
  seeked: boolean;

  constructor(lines: WsLine[], startAt = 0) {
    this.lines = lines;
    this.guesses = lines.map(() => new Set());
    this.live = lines.map(() => false);
    this.results = lines.map(() => null);
    this.seeked = startAt > 0;
    // From the top, every line counts once reached; from startAt, earlier ones were skipped.
    this.lastT = startAt > 0 ? startAt : -Infinity;
  }

  /** Index of the line in play at t (latest-starting wins on overlap), or -1. */
  activeLine(t: number): number {
    return activeLineAt(this.lines, t);
  }

  toggle(member: number, t: number): void {
    const i = this.activeLine(t);
    const set = i < 0 ? this.pending : this.guesses[i];
    if (set.has(member)) set.delete(member);
    else set.add(member);
  }

  /** Members to light up at t: the current line's guess, or the gap's picks. */
  picksAt(t: number): ReadonlySet<number> {
    const i = this.activeLine(t);
    return i < 0 ? this.pending : this.guesses[i];
  }

  /** Advance to t: hand gap picks to a line that just came up, mark lines
   *  playback ran into, and score lines that just ended. Returns the lines
   *  judged by this call (the array is reused, so read it before the next one). */
  update(t: number): readonly number[] {
    this.judged.length = 0;
    const active = this.activeLine(t);
    if (active !== this.lastActive) {
      this.lastActive = active;
      if (active >= 0 && this.pending.size) {
        if (this.guesses[active].size === 0) this.guesses[active] = this.pending;
        this.pending = new Set();
      }
    }
    for (let i = 0; i < this.lines.length; i++) {
      const l = this.lines[i];
      const cue = l.start - GRACE;
      if (this.lastT < cue && cue <= t) this.live[i] = true;
      if (this.results[i] === null && this.live[i] && l.end <= t) {
        this.results[i] = this.score(i);
        this.judged.push(i);
      }
    }
    this.lastT = t;
    if (this.judged.length) this.stats = null;
    return this.judged;
  }

  private score(i: number): LineResult {
    const picked = [...this.guesses[i]].sort((a, b) => a - b);
    if (!picked.length) return 'none';
    const ans = this.lines[i].ans;
    return picked.length === ans.length && picked.every((m, k) => m === ans[k]) ? 'right' : 'wrong';
  }

  /** Jump to t. Lines from t on get a fresh chance; earlier ones keep their result. */
  seek(t: number): void {
    this.seeked = true;
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].end > t) {
        this.guesses[i] = new Set();
        this.live[i] = false;
        this.results[i] = null;
      }
    }
    this.pending = new Set();
    this.lastActive = -1;
    this.lastT = t;
    this.stats = null;
  }

  result(i: number): LineResult | null {
    return this.results[i];
  }

  /** What the player picked for line i. */
  guessOf(i: number): ReadonlySet<number> {
    return this.guesses[i];
  }

  /** Score and combo so far; recomputed only when a result changes. */
  runStats(): RunStats {
    return (this.stats ??= runStats(this.results));
  }

  maxScore(): number {
    return maxScore(this.lines.length);
  }

  memberStats(members: readonly number[]): MemberStat[] {
    return memberStats(members, this.lines, this.results, this.guesses);
  }

  fullCombo(): boolean {
    return isFullCombo(this.results);
  }

  tally(): Tally {
    const out: Tally = { right: 0, guessed: 0, total: 0 };
    for (const r of this.results) {
      if (!r) continue;
      out.total++;
      if (r !== 'none') out.guessed++;
      if (r === 'right') out.right++;
    }
    return out;
  }
}
