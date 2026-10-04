// End-of-song results + practice helpers for the play page. Kept free of DOM
// and player imports so the scoring, "new best" and share text are unit
// testable; play-extras.ts does the wiring.

import type { HistRecord } from './storage';
import { isLineRight, gradePlay } from './hist';

export type LineMark = 'correct' | 'wrong' | 'blank';

/** One graded line, as the results card sees it. */
export interface GradedLine {
  choices: number[];
  ans: number[];
}

export interface MemberStat {
  id: number;
  /** Lines this member sings that the player got fully right. */
  hit: number;
  /** Lines this member sings. */
  total: number;
}

export interface SongResult {
  correct: number;
  total: number;
  pct: number;
  marks: LineMark[];
  members: MemberStat[];
}

export function markLine(line: GradedLine): LineMark {
  if (line.choices.length === 0) return 'blank';
  return isLineRight(line.choices, line.ans) ? 'correct' : 'wrong';
}

export function pctOf(correct: number, total: number): number {
  return total < 1 ? 0 : Math.round((correct / total) * 100);
}

export function scoreLines(lines: GradedLine[]): SongResult {
  const marks = lines.map(markLine);
  const correct = marks.filter((m) => m === 'correct').length;
  const byMember = new Map<number, MemberStat>();
  lines.forEach((line, i) => {
    for (const id of line.ans) {
      const stat = byMember.get(id) ?? { id, hit: 0, total: 0 };
      stat.total++;
      if (marks[i] === 'correct') stat.hit++;
      byMember.set(id, stat);
    }
  });
  const members = [...byMember.values()].sort((a, b) => a.id - b.id);
  return { correct, total: lines.length, pct: pctOf(correct, lines.length), marks, members };
}

/** Best previous score at this line count among one song's `hist` records.
 *  Matching on line count stands in for difficulty, since `hist` doesn't
 *  record it and each difficulty exposes a different number of lines. */
export function bestFromHistory(songHist: HistRecord[], total: number): number | null {
  let best: number | null = null;
  for (const rec of songHist) {
    if (rec.slots.length !== total) continue;
    const c = gradePlay(rec.slots).correct;
    if (best === null || c > best) best = c;
  }
  return best;
}

const MARK_EMOJI: Record<LineMark, string> = {
  correct: '\u{1F7E9}', // 🟩
  wrong: '\u{1F7E5}',   // 🟥
  blank: '⬜',
};

export const SHARE_ROW = 10;

export interface ResultShareInfo {
  brand: string;
  songTitle: string;
  diffLabel: string;
  result: SongResult;
  newBest: boolean;
  /** Protocol-less song link, e.g. "bubudesuwho.github.io/play.html#aozora". */
  url: string;
}

export function buildResultShareText(info: ResultShareInfo): string {
  const { result } = info;
  const emoji = result.marks.map((m) => MARK_EMOJI[m]);
  const rows: string[] = [];
  for (let i = 0; i < emoji.length; i += SHARE_ROW) rows.push(emoji.slice(i, i + SHARE_ROW).join(''));
  const fc = result.total > 0 && result.correct === result.total ? ' · FULL COMBO' : '';
  return [
    `${info.brand} · ${info.songTitle} (${info.diffLabel})`,
    `${result.correct}/${result.total} · ${result.pct}%${fc}${info.newBest ? ' · new best!' : ''}`,
    '',
    ...rows,
    '',
    info.url,
  ].join('\n');
}

// ─── Practice ───────────────────────────────────────────────────────

export const RATES = [0.5, 0.75, 1] as const;

/** Next speed in the cycle; an unknown value (hand-edited storage) restarts at the slowest. */
export function nextRate(rate: number): number {
  const i = RATES.indexOf(rate as (typeof RATES)[number]);
  return RATES[(i + 1) % RATES.length];
}

export function normalizeRate(rate: number): number {
  return (RATES as readonly number[]).includes(rate) ? rate : 1;
}

export function rateLabel(rate: number): string {
  return `${rate}x`;
}

/** Lead-in before the looped line so its first syllable isn't clipped. */
export const LOOP_PREROLL = 0.4;

export type LoopAction = 'none' | 'restart' | 'clear';

/** What the A-B loop should do on this tick. A user seek that lands outside
 *  the loop cancels it (they've clearly moved on); playing past the end jumps
 *  back to the start. */
export function loopAction(time: number, range: [number, number], didSeek: boolean): LoopAction {
  const start = Math.max(0, range[0] - LOOP_PREROLL);
  if (didSeek && (time < start - 0.05 || time > range[1])) return 'clear';
  if (time >= range[1]) return 'restart';
  return 'none';
}

export function loopStart(range: [number, number]): number {
  return Math.max(0, range[0] - LOOP_PREROLL);
}
