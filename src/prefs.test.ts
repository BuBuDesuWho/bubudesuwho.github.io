import { describe, expect, it, beforeEach } from 'vitest';
import { prefs } from './prefs';

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  return store;
}

describe('prefs', () => {
  let store: Map<string, string>;
  beforeEach(() => { store = installLocalStorage(); });

  it('defaults autoscroll and themed ON when unset', () => {
    expect(prefs.autoscroll.get()).toBe(true);
    expect(prefs.themed.get()).toBe(true);
  });

  it('defaults the other toggles OFF when unset', () => {
    expect(prefs.hints.get()).toBe(false);
    expect(prefs.inline.get()).toBe(false);
    expect(prefs.calls.get()).toBe(false);
    expect(prefs.callSFX.get()).toBe(false);
    expect(prefs.jpLyrics.get()).toBe(false);
  });

  it('round-trips a boolean and writes the raw string form', () => {
    prefs.autoscroll.set(false);
    expect(store.get('autoscroll')).toBe('false');
    expect(prefs.autoscroll.get()).toBe(false);
  });

  it('defaults lyricsMode to 0 and volume to 0.3', () => {
    expect(prefs.lyricsMode.get()).toBe(0);
    expect(prefs.volume.get()).toBe(0.3);
  });

  it('parses stored numbers (int for lyricsMode, float for volume)', () => {
    prefs.lyricsMode.set(2);
    prefs.volume.set(0.55);
    expect(store.get('lyrics')).toBe('2');   // note: the key is 'lyrics'
    expect(prefs.lyricsMode.get()).toBe(2);
    expect(prefs.volume.get()).toBe(0.55);
  });

  it('reads enum prefs as the "on" value only on exact match, else "off"', () => {
    expect(prefs.palette.get()).toBe('default');
    expect(prefs.theme.get()).toBe('light');
    prefs.palette.set('official');
    prefs.theme.set('dark');
    expect(prefs.palette.get()).toBe('official');
    expect(prefs.theme.get()).toBe('dark');
  });
});
