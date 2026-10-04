// Wordle-style guess feedback + share text for Bubudle dailies.
//
// A guess is a set of member ids checked against the line's `ans`. Each
// guessed member gets a mark: hit (sings this line), near (sings in the
// song but not this line), miss (not in the song at all). The same marks
// drive the colored history chips and the emoji share grid, so they can
// never disagree.

export type GuessMark = 'hit' | 'near' | 'miss';

export const MAX_ATTEMPTS = 4;

const MARK_EMOJI: Record<GuessMark, string> = {
  hit: '\u{1F7E9}',   // 🟩
  near: '\u{1F7E8}',  // 🟨
  miss: '⬜',     // ⬜
};

/** "1,3,5" (sorted member-id guess key) → [1, 3, 5] */
export function parseGuessKey(key: string): number[] {
  return key.split(',').map(Number);
}

export function classifyGuess(
  members: number[],
  ans: number[],
  songSingers: number[],
): GuessMark[] {
  return members.map((m) => {
    if (ans.includes(m)) return 'hit';
    if (songSingers.includes(m)) return 'near';
    return 'miss';
  });
}

export interface ShareInfo {
  /** Scope label, e.g. "Aqours" or "K-pop". */
  label: string;
  /** Daily date as YYYY-MM-DD (EST). */
  date: string;
  /** Guesses in order, each as member ids. */
  guesses: number[][];
  ans: number[];
  songSingers: number[];
  correct: boolean;
  /** Omitted for archive plays, which don't move the streak. */
  streak?: number;
  /** Protocol-less daily link, e.g. "bubudesuwho.github.io/bubudle.html?daily=aqours". */
  url: string;
}

export function buildShareText(info: ShareInfo): string {
  const result = info.correct ? `${info.guesses.length}/${MAX_ATTEMPTS}` : `X/${MAX_ATTEMPTS}`;
  const rows = info.guesses.map((g) =>
    classifyGuess(g, info.ans, info.songSingers).map((m) => MARK_EMOJI[m]).join(''));
  return [
    `Bubudle (${info.label}) ${info.date} · ${result}`,
    '',
    ...rows,
    '',
    ...(info.streak === undefined ? [] : [`Streak: ${info.streak}`]),
    info.url,
  ].join('\n');
}
