import { describe, expect, it, beforeEach } from 'vitest';
import { getFavorite, setFavorite, clearFavorite, isFavorite } from './favorite';

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

describe('favorite', () => {
  let store: Map<string, string>;
  beforeEach(() => { store = installLocalStorage(); });

  it('returns null when nothing is stored', () => {
    expect(getFavorite()).toBeNull();
  });

  it('round-trips group + id through setFavorite/getFavorite', () => {
    setFavorite('aqours', 5);
    expect(getFavorite()).toEqual({ group: 'aqours', id: 5 });
  });

  it('stores as JSON under the favorite-member key', () => {
    setFavorite('muse', 2);
    expect(store.get('favorite-member')).toBe(JSON.stringify({ group: 'muse', id: 2 }));
  });

  it('clearFavorite removes the stored value', () => {
    setFavorite('aqours', 5);
    clearFavorite();
    expect(getFavorite()).toBeNull();
  });

  it('getFavorite returns null on malformed JSON instead of throwing', () => {
    store.set('favorite-member', '{not json');
    expect(getFavorite()).toBeNull();
  });

  it('getFavorite returns null when the shape is wrong', () => {
    store.set('favorite-member', JSON.stringify({ group: 'aqours' })); // missing id
    expect(getFavorite()).toBeNull();
  });

  it('isFavorite matches only the exact stored group+id', () => {
    setFavorite('aqours', 5);
    expect(isFavorite('aqours', 5)).toBe(true);
    expect(isFavorite('aqours', 6)).toBe(false);
    expect(isFavorite('muse', 5)).toBe(false);
  });

  it('isFavorite is false when nothing is set', () => {
    expect(isFavorite('aqours', 5)).toBe(false);
  });
});
