import { describe, it, expect } from 'vitest';
import {
  ACHIEVEMENTS, STAT, evaluateAchievements, parseStoredDate, longestStreak,
  currentStreak, buildHeatmap, AchievementRule,
} from './achievements';

describe('evaluateAchievements', () => {
  const rules: AchievementRule[] = [
    { id: 'a', title: 'A', description: '', category: 'quiz', stat: 'x', goal: 10 },
    { id: 'b', title: 'B', description: '', category: 'quiz', stat: 'missing', goal: 1 },
  ];

  it('unlocks at the goal and reports clamped progress', () => {
    const [a] = evaluateAchievements(rules, { x: 4 });
    expect(a.unlocked).toBe(false);
    expect(a.progress).toBeCloseTo(0.4);
    const [a2] = evaluateAchievements(rules, { x: 25 });
    expect(a2.unlocked).toBe(true);
    expect(a2.progress).toBe(1);
  });

  it('treats an untracked stat as 0', () => {
    const [, b] = evaluateAchievements(rules, {});
    expect(b.value).toBe(0);
    expect(b.unlocked).toBe(false);
  });

  it('starts fully locked for a brand-new player', () => {
    expect(evaluateAchievements(ACHIEVEMENTS, {}).every(r => !r.unlocked)).toBe(true);
  });

  it('has unique ids and only references known stats', () => {
    const ids = ACHIEVEMENTS.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const known = new Set<string>(Object.values(STAT));
    for (const r of ACHIEVEMENTS) expect(known.has(r.stat)).toBe(true);
  });
});

describe('parseStoredDate', () => {
  it('reads en-US hist dates', () => {
    expect(parseStoredDate('9/27/2026', 'mdy')).toBe('2026-09-27');
  });
  it('reads day-first locales', () => {
    expect(parseStoredDate('27.09.2026', 'dmy')).toBe('2026-09-27');
    expect(parseStoredDate('27/9/2026', 'dmy')).toBe('2026-09-27');
  });
  it('reads year-first strings regardless of locale order', () => {
    expect(parseStoredDate('2026/9/27', 'mdy')).toBe('2026-09-27');
    expect(parseStoredDate('2026-09-27', 'dmy')).toBe('2026-09-27');
  });
  it('reads ISO timestamps as a local day', () => {
    const iso = new Date(2026, 8, 27, 12).toISOString();
    expect(parseStoredDate(iso, 'mdy')).toBe('2026-09-27');
  });
  it('rejects garbage', () => {
    expect(parseStoredDate('', 'mdy')).toBeNull();
    expect(parseStoredDate('yesterday', 'mdy')).toBeNull();
    expect(parseStoredDate('13/13/2026', 'mdy')).toBeNull();
  });
});

describe('streaks', () => {
  const days = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-25', '2026-09-26', '2026-09-26'];

  it('finds the longest consecutive run', () => {
    expect(longestStreak(days)).toBe(3);
    expect(longestStreak([])).toBe(0);
  });

  it('crosses month boundaries', () => {
    expect(longestStreak(['2026-08-31', '2026-09-01', '2026-09-02'])).toBe(3);
  });

  it('keeps a streak alive until the end of today', () => {
    expect(currentStreak(days, '2026-09-26')).toBe(2);
    expect(currentStreak(days, '2026-09-27')).toBe(2);
    expect(currentStreak(days, '2026-09-28')).toBe(0);
  });
});

describe('buildHeatmap', () => {
  it('ends on the week containing today, Sunday first', () => {
    // 2026-09-27 is a Sunday: the last column holds only today, then future days.
    const grid = buildHeatmap(new Map([['2026-09-27', 2], ['2026-09-20', 4]]), '2026-09-27', 2);
    expect(grid).toHaveLength(2);
    expect(grid[0][0].date).toBe('2026-09-20');
    expect(grid[1][0].date).toBe('2026-09-27');
    expect(grid[1][0].future).toBe(false);
    expect(grid[1][1].future).toBe(true);
    expect(grid[0][0].level).toBe(4);
    expect(grid[1][0].level).toBe(2);
    expect(grid[0][1].level).toBe(0);
  });
});
