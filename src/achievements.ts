// Achievements, streaks and the activity heatmap for the stats page.
//
// Everything here is pure: stats.ts reads localStorage, boils it down to a
// flat `ProgressStats` record, and these functions turn that into badges and
// grids. Nothing is ever written back, so achievements can't drift from the
// saved data they're derived from; deleting a play un-earns its badge.

export type ProgressStats = Record<string, number>;

export type AchievementCategory = 'quiz' | 'mastery' | 'groups' | 'streak' | 'bubudle' | 'live';

export interface AchievementRule {
  id: string;
  title: string;
  description: string;
  category: AchievementCategory;
  /** Key into ProgressStats. Missing keys read as 0, so a rule for a stat
   *  that isn't tracked yet simply stays locked. */
  stat: string;
  goal: number;
}

export interface AchievementResult {
  rule: AchievementRule;
  value: number;
  unlocked: boolean;
  /** 0..1, for the progress bar. */
  progress: number;
}

export const CATEGORY_LABELS: Record<AchievementCategory, string> = {
  quiz: 'Quiz',
  mastery: 'Member mastery',
  groups: 'Groups',
  streak: 'Streaks',
  bubudle: 'Bubudle',
  live: 'Live',
};

// Stat keys produced by stats.ts. Kept as constants so a typo in a rule is a
// compile error rather than a badge that can never unlock.
export const STAT = {
  songsPlayed: 'songsPlayed',
  totalPlays: 'totalPlays',
  perfectSongs: 'perfectSongs',
  linesCorrect: 'linesCorrect',
  bestMemberPct: 'bestMemberPct',
  membersAt25: 'membersAt25',
  membersAt50: 'membersAt50',
  groupsTried: 'groupsTried',
  groupsCompleted: 'groupsCompleted',
  bestGroupPct: 'bestGroupPct',
  bestPlayStreak: 'bestPlayStreak',
  activeDays: 'activeDays',
  dailySolved: 'dailySolved',
  bestDailyStreak: 'bestDailyStreak',
  bubudleStreak: 'bubudleStreak',
  liveSongs: 'liveSongs',
  livePerfect: 'livePerfect',
} as const;

const tier = (
  idPrefix: string, category: AchievementCategory, stat: string,
  tiers: [goal: number, title: string, description: string][],
): AchievementRule[] =>
  tiers.map(([goal, title, description]) => ({ id: `${idPrefix}-${goal}`, title, description, category, stat, goal }));

export const ACHIEVEMENTS: AchievementRule[] = [
  ...tier('songs', 'quiz', STAT.songsPlayed, [
    [1, 'First Step', 'Play your first song'],
    [10, 'Setlist Builder', 'Play 10 different songs'],
    [50, 'Deep Cuts', 'Play 50 different songs'],
    [100, 'Encyclopedia', 'Play 100 different songs'],
    [250, 'Completionist', 'Play 250 different songs'],
  ]),
  ...tier('plays', 'quiz', STAT.totalPlays, [
    [25, 'Encore', 'Finish 25 plays'],
    [100, 'Regular', 'Finish 100 plays'],
  ]),
  ...tier('perfect', 'quiz', STAT.perfectSongs, [
    [1, 'Full Combo', 'Get every line right in a song'],
    [10, 'Perfectionist', 'Get every line right in 10 songs'],
    [50, 'Flawless', 'Get every line right in 50 songs'],
  ]),
  ...tier('lines', 'quiz', STAT.linesCorrect, [
    [100, 'Good Ears', 'Get 100 different lines right'],
    [1000, 'Perfect Pitch', 'Get 1,000 different lines right'],
  ]),
  ...tier('member', 'mastery', STAT.bestMemberPct, [
    [10, 'Getting Acquainted', 'Reach 10% Total Mastery with any member'],
    [25, 'Fan', 'Reach 25% Total Mastery with any member'],
    [50, 'Oshi', 'Reach 50% Total Mastery with any member'],
    [80, 'Kamioshi', 'Reach 80% Total Mastery with any member'],
  ]),
  ...tier('members25', 'mastery', STAT.membersAt25, [
    [5, 'Box Pusher', 'Reach 25% Total Mastery with 5 members'],
  ]),
  ...tier('members50', 'mastery', STAT.membersAt50, [
    [9, 'Whole Unit', 'Reach 50% Total Mastery with 9 members'],
  ]),
  ...tier('groups', 'groups', STAT.groupsTried, [
    [3, 'Explorer', 'Play songs from 3 groups'],
    [6, 'Multi-Oshi', 'Play songs from 6 groups'],
  ]),
  ...tier('grouppct', 'groups', STAT.bestGroupPct, [
    [50, 'Halfway There', 'Play half of a group\'s songs'],
  ]),
  ...tier('groupdone', 'groups', STAT.groupsCompleted, [
    [1, 'Discography', 'Play every song by a group'],
  ]),
  ...tier('streak', 'streak', STAT.bestPlayStreak, [
    [3, 'Warming Up', 'Play on 3 days in a row'],
    [7, 'Weekly Idol', 'Play on 7 days in a row'],
    [30, 'Unstoppable', 'Play on 30 days in a row'],
  ]),
  ...tier('days', 'streak', STAT.activeDays, [
    [10, 'Frequent Flyer', 'Play on 10 different days'],
    [50, 'Lifer', 'Play on 50 different days'],
  ]),
  ...tier('daily', 'bubudle', STAT.dailySolved, [
    [1, 'Daily Debut', 'Solve a daily Bubudle'],
    [10, 'Daily Habit', 'Solve 10 daily Bubudles'],
    [50, 'Daily Devotee', 'Solve 50 daily Bubudles'],
  ]),
  ...tier('dailystreak', 'bubudle', STAT.bestDailyStreak, [
    [7, 'Week of Wins', 'Solve the daily Bubudle 7 days in a row'],
  ]),
  ...tier('bubstreak', 'bubudle', STAT.bubudleStreak, [
    [10, 'On a Roll', 'Have a Bubudle streak of 10'],
  ]),
  ...tier('live', 'live', STAT.liveSongs, [
    [1, 'Stage Debut', 'Finish a song in Live mode'],
    [10, 'Touring', 'Finish 10 songs in Live mode'],
  ]),
  ...tier('liveperfect', 'live', STAT.livePerfect, [
    [1, 'Perfect Live', 'Get every line right in a full Live run'],
    [10, 'Center Stage', 'Get every line right in 10 full Live runs'],
  ]),
];

export function evaluateAchievements(rules: AchievementRule[], stats: ProgressStats): AchievementResult[] {
  return rules.map(rule => {
    const value = stats[rule.stat] ?? 0;
    const unlocked = value >= rule.goal;
    const progress = rule.goal <= 0 ? 1 : Math.max(0, Math.min(1, value / rule.goal));
    return { rule, value, unlocked, progress };
  });
}

// ─── Dates ──────────────────────────────────────────────────────────

export type DateOrder = 'mdy' | 'dmy' | 'ymd';

/** Field order of the browser's `toLocaleDateString()`, which is what the
 *  quiz wrote into `hist` before it switched to ISO days. The same browser
 *  reads it back, so its locale is the best available guess at how those
 *  older strings are laid out. */
export function localeDateOrder(locale?: string): DateOrder {
  try {
    const parts = new Intl.DateTimeFormat(locale).formatToParts(new Date(2001, 10, 22));
    const order = parts.filter(p => p.type === 'year' || p.type === 'month' || p.type === 'day').map(p => p.type[0]).join('');
    if (order === 'dmy' || order === 'ymd') return order;
  } catch { /* fall through */ }
  return 'mdy';
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Parse a stored date string to a local YYYY-MM-DD, or null if unreadable.
 *  Handles full ISO timestamps (Live results), bare ISO days (Bubudle keys,
 *  newer quiz `hist`), and numeric locale dates like "9/27/2026" or
 *  "27.09.2026" (older quiz `hist`). */
export function parseStoredDate(raw: string, order: DateOrder): string | null {
  if (!raw) return null;
  // Already a local day: no locale guessing needed.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [, m, d] = raw.split('-').map(Number);
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? raw : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : isoDay(d);
  }
  const nums = raw.match(/\d+/g);
  if (!nums || nums.length < 3) return null;
  const [a, b, c] = nums.slice(0, 3).map(Number);
  let y: number, m: number, d: number;
  // A 4-digit leading field is unambiguous regardless of locale.
  if (nums[0].length === 4 || order === 'ymd') [y, m, d] = [a, b, c];
  else if (order === 'dmy') [d, m, y] = [a, b, c];
  else [m, d, y] = [a, b, c];
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** Longest run of consecutive calendar days in `days` (any order, dupes ok). */
export function longestStreak(days: Iterable<string>): number {
  const nums = [...new Set([...days].map(dayNumber))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  for (let i = 0; i < nums.length; i++) {
    run = i > 0 && nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

/** Streak ending today, or ending yesterday (today isn't over, so a streak
 *  you haven't extended yet today still counts as alive). */
export function currentStreak(days: Iterable<string>, today: string): number {
  const set = new Set([...days].map(dayNumber));
  let n = dayNumber(today);
  if (!set.has(n)) n -= 1;
  let run = 0;
  while (set.has(n)) { run++; n--; }
  return run;
}

export interface HeatCell {
  date: string;
  count: number;
  /** 0 = none, 1..4 = intensity bucket. */
  level: number;
  /** Past `today`, rendered blank so the last column doesn't show future days as idle. */
  future: boolean;
}

/** GitHub-style grid: `weeks` columns of Sunday-to-Saturday, last column
 *  containing `today`. Levels are relative to the busiest day shown. */
export function buildHeatmap(counts: Map<string, number>, today: string, weeks: number): HeatCell[][] {
  const end = dayNumber(today);
  const endDow = new Date(end * 86400000).getUTCDay();
  const start = end - endDow - (weeks - 1) * 7;
  let max = 0;
  for (let n = start; n <= end; n++) max = Math.max(max, counts.get(isoFromDayNumber(n)) ?? 0);
  const cols: HeatCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      const n = start + w * 7 + dow;
      const date = isoFromDayNumber(n);
      const count = counts.get(date) ?? 0;
      const level = count === 0 || max === 0 ? 0 : Math.max(1, Math.ceil((count / max) * 4));
      col.push({ date, count, level, future: n > end });
    }
    cols.push(col);
  }
  return cols;
}

function isoFromDayNumber(n: number): string {
  const d = new Date(n * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
