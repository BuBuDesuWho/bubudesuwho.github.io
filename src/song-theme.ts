// Generated per-song palettes (scripts/generate-themes.py). Each mode's table
// is a lazy chunk and only the current song's rules are ever in the document.
// The rules use the same selectors the old themes-generated.css did, so they
// rank against css/themes.css (hand-made themes, dark-mode resets) exactly as
// before.

export interface ThemeTable {
  vars: string[];
  bar: string[];
  /** song id -> values for `vars` then `bar`, space-separated */
  themes: Record<string, string>;
}

export function themeRules(table: ThemeTable, id: string): string {
  const packed = table.themes[id];
  if (!packed) return '';
  const vals = packed.split(' ');
  const decls = (names: string[], from: number) =>
    names.map((n, i) => `${n}: ${vals[from + i]};`).join(' ');
  return `html.theme-${id} { ${decls(table.vars, 0)} }\n`
    + `#player-bar.theme-${id} { ${decls(table.bar, table.vars.length)} }`;
}

let table: ThemeTable | null = null;
let pending: (() => void) | null = null;
let styleEl: HTMLStyleElement | null = null;

// Kicked off when ui.ts loads (play + bubudle only) so it races the song
// fetch instead of queueing behind it.
(import.meta.env.VITE_APP_MODE === 'kpop'
  ? import('./themes.kpop.json')
  : import('./themes.anime.json')
).then((m) => {
  table = m.default as ThemeTable;
  pending?.();
}, (err) => {
  console.warn('song themes failed to load', err);
});

function write(id: string | null): void {
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'song-theme';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = id && table ? themeRules(table, id) : '';
}

/** Put `id`'s generated palette in the document (null clears it), then call
 *  `applied`. Synchronous once the table has loaded; before that only the
 *  latest request runs, when the table arrives. */
export function applyThemePalette(id: string | null, applied: () => void): void {
  pending = null;
  if (table || id == null) {
    write(id);
    applied();
    return;
  }
  pending = () => {
    pending = null;
    write(id);
    applied();
  };
}
