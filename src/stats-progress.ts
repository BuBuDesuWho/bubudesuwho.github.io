// Stats page progression: streaks + activity heatmap, achievements, and
// per-group completion. Reads saved data only; the rules and date math live
// in achievements.ts so they stay testable without a DOM.
import '../css/stats-progress.css';
import { hasLocalStorage, getStorage, WhosingsResults } from './storage';
import { getGroup } from './groups';
import { getGroupColor } from './labels';
import { MenuSong, GroupName } from './types';
import {
  ACHIEVEMENTS, CATEGORY_LABELS, STAT, AchievementCategory, AchievementResult, ProgressStats,
  evaluateAchievements, parseStoredDate, localeDateOrder, isoDay, longestStreak,
  currentStreak, buildHeatmap,
} from './achievements';

export interface QuizPlay {
  songId?: string;
  songName: string;
  group?: GroupName;
  date: string;
  allCorrect: boolean;
}

export interface ProgressInput {
  songs: MenuSong[];
  quizPlays: QuizPlay[];
  /** Distinct lines ever answered right (same set as the ribbon's "Lines completed"). */
  linesCorrect: number;
  /** Total Mastery % per member with enough catalog lines to count. */
  memberPcts: number[];
  whosings: WhosingsResults;
}

interface DailySolve { date: string; correct: boolean }

const HEATMAP_WEEKS = 26;
const DAILY_KEY = /^bubudle-daily-(.+)-(\d{4}-\d{2}-\d{2})$/;

// One key per (scope, date): `bubudle-daily-<scope>-<YYYY-MM-DD>`, written by
// bubudle-daily.ts. Scanned rather than enumerated because scopes are
// open-ended (any group can have its own daily).
function loadDailySolves(): DailySolve[] {
  if (!hasLocalStorage()) return [];
  const out: DailySolve[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const m = key?.match(DAILY_KEY);
    if (!key || !m) continue;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) ?? '') as { correct?: unknown };
      out.push({ date: m[2], correct: parsed.correct === true });
    } catch { /* skip a corrupt entry rather than drop the whole page */ }
  }
  return out;
}

interface GroupCompletion { slug: GroupName; name: string; played: number; total: number }

function groupCompletion(songs: MenuSong[], playedIds: Set<string>): GroupCompletion[] {
  const byGroup = new Map<GroupName, GroupCompletion>();
  for (const s of songs) {
    if (s.hidden) continue;
    const g = getGroup(s.group);
    if (!g) continue;
    let row = byGroup.get(s.group);
    if (!row) { row = { slug: s.group, name: g.name, played: 0, total: 0 }; byGroup.set(s.group, row); }
    row.total++;
    if (playedIds.has(s.id)) row.played++;
  }
  return [...byGroup.values()].sort((a, b) =>
    (b.played / b.total) - (a.played / a.total) || b.played - a.played || a.name.localeCompare(b.name));
}

export function renderProgress(input: ProgressInput): void {
  const order = localeDateOrder();
  const today = isoDay(new Date());

  // Activity per day across every mode that stores a date. Live keeps only
  // last/best per song, so older Live runs are invisible here; that's a limit
  // of what's saved, not something to paper over.
  const activity = new Map<string, number>();
  const bump = (day: string | null) => { if (day) activity.set(day, (activity.get(day) ?? 0) + 1); };
  for (const p of input.quizPlays) bump(parseStoredDate(p.date, order));
  const liveRuns = Object.values(input.whosings);
  for (const r of liveRuns) {
    bump(parseStoredDate(r.last.date, order));
    if (r.best && r.best.date !== r.last.date) bump(parseStoredDate(r.best.date, order));
  }
  const dailies = loadDailySolves();
  for (const d of dailies) bump(d.date);

  const songKeys = new Set(input.quizPlays.map(p => p.songId ?? p.songName));
  const perfectKeys = new Set(input.quizPlays.filter(p => p.allCorrect).map(p => p.songId ?? p.songName));
  const playedIds = new Set<string>([
    ...input.quizPlays.flatMap(p => p.songId ? [p.songId] : []),
    ...Object.keys(input.whosings),
  ]);
  const groups = groupCompletion(input.songs, playedIds);
  const solvedDays = dailies.filter(d => d.correct).map(d => d.date);

  const stats: ProgressStats = {
    [STAT.songsPlayed]: songKeys.size,
    [STAT.totalPlays]: input.quizPlays.length,
    [STAT.perfectSongs]: perfectKeys.size,
    [STAT.linesCorrect]: input.linesCorrect,
    [STAT.bestMemberPct]: Math.max(0, ...input.memberPcts),
    [STAT.membersAt25]: input.memberPcts.filter(p => p >= 25).length,
    [STAT.membersAt50]: input.memberPcts.filter(p => p >= 50).length,
    [STAT.groupsTried]: groups.filter(g => g.played > 0).length,
    [STAT.groupsCompleted]: groups.filter(g => g.played === g.total).length,
    [STAT.bestGroupPct]: Math.max(0, ...groups.map(g => Math.floor((g.played / g.total) * 100))),
    [STAT.bestPlayStreak]: longestStreak(activity.keys()),
    [STAT.activeDays]: activity.size,
    [STAT.dailySolved]: solvedDays.length,
    [STAT.bestDailyStreak]: longestStreak(solvedDays),
    [STAT.bubudleStreak]: parseInt(getStorage('bubudle-streak') ?? '0', 10) || 0,
    [STAT.liveSongs]: liveRuns.length,
    [STAT.livePerfect]: liveRuns.filter(r => r.best && !r.best.partial && r.best.total > 0 && r.best.correct === r.best.total).length,
  };

  renderStreaks(activity, today, stats);
  renderAchievements(evaluateAchievements(ACHIEVEMENTS, stats));
  renderGroups(groups);
}

// ─── Streaks + heatmap ──────────────────────────────────────────────

function renderStreaks(activity: Map<string, number>, today: string, stats: ProgressStats): void {
  const section = document.getElementById('streak-section');
  const grid = document.getElementById('activity-heatmap');
  if (!section || !grid) return;
  if (activity.size === 0) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  setText('streak-current', String(currentStreak(activity.keys(), today)));
  setText('streak-best', String(stats[STAT.bestPlayStreak]));
  setText('streak-days', String(stats[STAT.activeDays]));

  const fmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const cols = buildHeatmap(activity, today, HEATMAP_WEEKS);
  grid.replaceChildren();
  for (const col of cols) {
    const colEl = document.createElement('div');
    colEl.className = 'heat-col';
    for (const cell of col) {
      const c = document.createElement('span');
      c.className = `heat-cell heat-${cell.level}`;
      if (cell.future) c.classList.add('heat-future');
      else {
        const [y, m, d] = cell.date.split('-').map(Number);
        const label = `${fmt.format(new Date(y, m - 1, d))}: ${cell.count} ${cell.count === 1 ? 'play' : 'plays'}`;
        c.title = label;
        c.setAttribute('aria-label', label);
      }
      colEl.appendChild(c);
    }
    grid.appendChild(colEl);
  }
  // Newest week is on the right; on narrow screens start scrolled there.
  grid.scrollLeft = grid.scrollWidth;
}

// ─── Achievements ───────────────────────────────────────────────────

function renderAchievements(results: AchievementResult[]): void {
  const container = document.getElementById('achievements');
  if (!container) return;
  const unlocked = results.filter(r => r.unlocked).length;
  setText('achievements-count', `${unlocked} of ${results.length} unlocked`);

  container.replaceChildren();
  const byCategory = new Map<AchievementCategory, AchievementResult[]>();
  for (const r of results) {
    const list = byCategory.get(r.rule.category) ?? [];
    list.push(r);
    byCategory.set(r.rule.category, list);
  }
  for (const [cat, list] of byCategory) {
    const heading = document.createElement('h3');
    heading.className = 'ach-category';
    heading.textContent = CATEGORY_LABELS[cat];
    const grid = document.createElement('ul');
    grid.className = 'ach-grid';
    for (const r of list) grid.appendChild(buildBadge(r));
    container.append(heading, grid);
  }
}

function buildBadge(r: AchievementResult): HTMLElement {
  const li = document.createElement('li');
  li.className = 'ach-badge' + (r.unlocked ? ' is-unlocked' : '');
  li.dataset.id = r.rule.id;

  const icon = document.createElement('span');
  icon.className = 'ach-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = r.unlocked ? '★' : '☆';

  const body = document.createElement('div');
  body.className = 'ach-body';
  const title = document.createElement('div');
  title.className = 'ach-title';
  title.textContent = r.rule.title;
  const desc = document.createElement('div');
  desc.className = 'ach-desc';
  desc.textContent = r.rule.description;
  body.append(title, desc);

  if (!r.unlocked) {
    const bar = document.createElement('div');
    bar.className = 'ach-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(r.rule.goal));
    bar.setAttribute('aria-valuenow', String(Math.min(r.value, r.rule.goal)));
    const fill = document.createElement('span');
    fill.style.width = `${Math.round(r.progress * 100)}%`;
    bar.appendChild(fill);
    const count = document.createElement('div');
    count.className = 'ach-count';
    count.textContent = `${Math.min(r.value, r.rule.goal).toLocaleString()} / ${r.rule.goal.toLocaleString()}`;
    body.append(bar, count);
  }
  li.setAttribute('aria-label', `${r.rule.title}: ${r.rule.description}${r.unlocked ? ' (unlocked)' : ''}`);
  li.append(icon, body);
  return li;
}

// ─── Group completion ───────────────────────────────────────────────

function renderGroups(groups: GroupCompletion[]): void {
  const section = document.getElementById('group-completion-section');
  const list = document.getElementById('group-completion');
  if (!section || !list) return;
  if (groups.length === 0) { section.classList.add('hidden'); return; }
  list.replaceChildren();
  for (const g of groups) {
    const li = document.createElement('li');
    li.className = 'group-row' + (g.played === 0 ? ' is-untouched' : '');
    const color = getGroupColor(g.slug);

    const name = document.createElement('span');
    name.className = 'group-row-name';
    if (color) name.classList.add(color);
    name.textContent = g.name;

    const bar = document.createElement('span');
    bar.className = 'group-row-bar';
    if (color) bar.classList.add(color);
    const fill = document.createElement('span');
    fill.style.width = `${(g.played / g.total) * 100}%`;
    bar.appendChild(fill);

    const count = document.createElement('span');
    count.className = 'group-row-count';
    count.textContent = `${g.played}/${g.total}`;
    if (g.played === g.total) count.classList.add('is-complete');

    li.title = `${g.name}: played ${g.played} of ${g.total} songs`;
    li.append(name, bar, count);
    list.appendChild(li);
  }
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
