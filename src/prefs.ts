import { getStorage, setStorage } from './storage';

// Typed accessors for the simple scalar preferences: each owns its key, its
// default, and its parse/serialize. Call sites read/write real values and
// never touch a key string. Keys with bespoke logic stay with their owners —
// the menu's group/sort/groupBy (validation + legacy migration) and diff
// (clamped to the song's max) are not simple scalars.

interface Pref<T> {
  get(): T;
  set(v: T): void;
}

/** Boolean stored as 'true' / 'false'. Absent falls back to `def` — note the
 *  defaults differ per key (autoscroll/themed default on, the rest off). */
function boolPref(key: string, def: boolean): Pref<boolean> {
  return {
    get: () => { const v = getStorage(key); return v == null ? def : v === 'true'; },
    set: (v) => { setStorage(key, String(v)); },
  };
}

function numPref(key: string, def: number, parse: (s: string) => number): Pref<number> {
  return {
    get: () => { const v = getStorage(key); return v == null ? def : parse(v); },
    set: (v) => { setStorage(key, String(v)); },
  };
}

/** String enum stored verbatim; any value other than `on` reads as `off`. */
function enumPref<A extends string, B extends string>(key: string, on: A, off: B): Pref<A | B> {
  return {
    get: () => (getStorage(key) === on ? on : off),
    set: (v) => { setStorage(key, v); },
  };
}

export const prefs = {
  // play.html toggles
  autoscroll: boolPref('autoscroll', true),
  themed: boolPref('themed', true),
  hints: boolPref('hints', false),
  inline: boolPref('inline', false),
  calls: boolPref('calls', false),
  callSFX: boolPref('callSFX', false),
  jpLyrics: boolPref('jpLyrics', false),

  // play.html scalars
  lyricsMode: numPref('lyrics', 0, (s) => parseInt(s, 10)),
  volume: numPref('volume', 0.3, parseFloat),

  // app-wide toggles
  palette: enumPref('palette', 'official', 'default'),
  theme: enumPref('theme', 'dark', 'light'),
};
