import { describe, expect, it } from 'vitest';
import { arrayEqual, escapeRegExp, toTimeStr, parseURLParams } from './utils';

describe('arrayEqual', () => {
  it('true for identical arrays', () => {
    expect(arrayEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it('false for different lengths', () => {
    expect(arrayEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('false when order differs', () => {
    expect(arrayEqual([1, 2, 3], [3, 2, 1])).toBe(false);
  });

  it('true for two empty arrays', () => {
    expect(arrayEqual([], [])).toBe(true);
  });
});

describe('escapeRegExp', () => {
  it('escapes every regex special character it targets', () => {
    expect(escapeRegExp('a.b*c?d')).toBe('a\\.b\\*c\\?d');
  });

  it('leaves plain text untouched', () => {
    expect(escapeRegExp('hello world')).toBe('hello world');
  });

  it('produces a pattern that matches the literal input', () => {
    const raw = 'a+b(c)[d]';
    const re = new RegExp(escapeRegExp(raw));
    expect(re.test(raw)).toBe(true);
  });
});

describe('toTimeStr', () => {
  it('formats whole seconds as M:SS', () => {
    expect(toTimeStr(90)).toBe('1:30');
  });

  it('zero-pads seconds under 10', () => {
    expect(toTimeStr(65)).toBe('1:05');
  });

  it('formats zero as 0:00', () => {
    expect(toTimeStr(0)).toBe('0:00');
  });

  it('rounds up when the fractional part reaches roundAt', () => {
    // Legacy call convention is toTimeStr(t, 1, 0.7): 1.75 truncates to 1,
    // but 1+0.7 <= 1.75, so it rounds up to 2.
    expect(toTimeStr(1.75, 1, 0.7)).toBe('0:02');
  });

  it('does not round up when under roundAt', () => {
    // 1.5: floor is 1, 1+0.7=1.7 > 1.5, so stays at 1.
    expect(toTimeStr(1.5, 1, 0.7)).toBe('0:01');
  });

  it('includes subsecond precision when precision < 1', () => {
    expect(toTimeStr(65.4, 0.1, 0.7)).toBe('1:05.4');
  });
});

describe('parseURLParams', () => {
  it('parses a simple key=value pair', () => {
    expect(parseURLParams('t=30')).toEqual({ t: '30' });
  });

  it('parses multiple params joined by &', () => {
    expect(parseURLParams('t=30&lyrics=on')).toEqual({ t: '30', lyrics: 'on' });
  });

  it('decodes + as a space and percent-encoded characters', () => {
    expect(parseURLParams('name=foo+bar&note=a%26b')).toEqual({ name: 'foo bar', note: 'a&b' });
  });

  it('returns an empty object for an empty string', () => {
    expect(parseURLParams('')).toEqual({});
  });

  it('treats a valueless key as an empty string', () => {
    expect(parseURLParams('flag')).toEqual({ flag: '' });
  });
});
