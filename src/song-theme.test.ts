import { describe, expect, it } from 'vitest';
import { themeRules, type ThemeTable } from './song-theme';
import anime from './themes.anime.json';
import kpop from './themes.kpop.json';

describe('themeRules', () => {
  const table: ThemeTable = {
    vars: ['--t-a', '--t-b'],
    bar: ['--play-btn-bg'],
    themes: { aozora: '#111111 white #222222' },
  };

  it('expands a packed entry into the html and player-bar rules', () => {
    expect(themeRules(table, 'aozora')).toBe(
      'html.theme-aozora { --t-a: #111111; --t-b: white; }\n'
      + '#player-bar.theme-aozora { --play-btn-bg: #222222; }',
    );
  });

  it('returns nothing for songs without a generated theme', () => {
    expect(themeRules(table, 'koiaqua')).toBe('');
  });
});

describe.each([['anime', anime], ['kpop', kpop]])('themes.%s.json', (_mode, raw) => {
  const t = raw as ThemeTable;

  it('packs exactly one value per declared variable', () => {
    const width = t.vars.length + t.bar.length;
    const bad = Object.entries(t.themes).filter(([, v]) => v.split(' ').length !== width);
    expect(bad).toEqual([]);
  });
});
