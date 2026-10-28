import { describe, expect, it } from 'vitest';
import { ARCHIVE_START, clampDailyDate, dailyNeighbors, shiftDate, formatDailyDate, type DailyScope } from './bubudle-daily';

const TODAY = '2026-08-25';

describe('clampDailyDate', () => {
  it('accepts a date inside the archive window', () => {
    expect(clampDailyDate('2026-08-24', TODAY)).toBe('2026-08-24');
  });

  it('accepts today itself', () => {
    expect(clampDailyDate(TODAY, TODAY)).toBe(TODAY);
  });

  it('accepts the first archived daily', () => {
    expect(clampDailyDate(ARCHIVE_START, TODAY)).toBe(ARCHIVE_START);
  });

  it('falls back to today for a missing param', () => {
    expect(clampDailyDate(null, TODAY)).toBe(TODAY);
  });

  it('falls back to today for a future date', () => {
    expect(clampDailyDate('2026-08-26', TODAY)).toBe(TODAY);
  });

  it('falls back to today for a date before Daily shipped', () => {
    expect(clampDailyDate('2026-04-24', TODAY)).toBe(TODAY);
  });

  it.each(['nonsense', '2026-8-24', '08-24-2026', '2026-08-24T00:00:00', ''])(
    'falls back to today for malformed input %j',
    (raw) => {
      expect(clampDailyDate(raw, TODAY)).toBe(TODAY);
    },
  );

  it('falls back to today for a shape-valid but impossible date', () => {
    expect(clampDailyDate('2026-02-31', TODAY)).toBe(TODAY);
  });
});

describe('shiftDate', () => {
  it('steps back a day', () => {
    expect(shiftDate('2026-08-25', -1)).toBe('2026-08-24');
  });

  it('steps forward a day', () => {
    expect(shiftDate('2026-08-24', 1)).toBe('2026-08-25');
  });

  it('crosses a month boundary', () => {
    expect(shiftDate('2026-08-01', -1)).toBe('2026-07-31');
  });

  it('crosses a year boundary', () => {
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles a leap day', () => {
    expect(shiftDate('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('formatDailyDate', () => {
  // Parsed as UTC midnight and formatted in UTC, so it never slips a day for
  // visitors west of Greenwich.
  it('renders the calendar day it was given', () => {
    expect(formatDailyDate('2026-08-24')).toBe('Mon, Aug 24, 2026');
  });
});

describe('dailyNeighbors', () => {
  const aqours: DailyScope = { kind: 'group', group: 'aqours' };
  const muse: DailyScope = { kind: 'group', group: 'muse' };
  const all: DailyScope = { kind: 'mode', mode: 'anime' };
  const scopes = [muse, aqours, all];
  const label = (r: { scope: DailyScope; date: string }) =>
    `${r.scope.kind === 'group' ? r.scope.group : 'all'}@${r.date}`;

  it('orders the same day in other scopes, then this scope either side, then the rest', () => {
    const out = dailyNeighbors({ scope: aqours, date: '2026-08-20' }, scopes, TODAY).map(label);
    expect(out).toEqual([
      'muse@2026-08-20', 'all@2026-08-20',
      'aqours@2026-08-19', 'aqours@2026-08-21',
      'muse@2026-08-19', 'muse@2026-08-21', 'all@2026-08-19', 'all@2026-08-21',
    ]);
  });

  it('never reaches past today', () => {
    const out = dailyNeighbors({ scope: all, date: TODAY }, scopes, TODAY).map(label);
    expect(out).toEqual(['muse@2026-08-25', 'aqours@2026-08-25', 'all@2026-08-24', 'muse@2026-08-24', 'aqours@2026-08-24']);
  });

  it('never reaches before the archive starts', () => {
    const out = dailyNeighbors({ scope: muse, date: ARCHIVE_START }, [muse], TODAY).map(label);
    expect(out).toEqual(['muse@2026-04-26']);
  });
});
