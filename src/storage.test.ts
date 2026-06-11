import { describe, expect, it, beforeEach } from 'vitest';
import { saveMasteryCache, loadMasteryCache, type MasteryCacheEntry } from './storage';

// vitest runs in node with no localStorage — install a minimal in-memory stub.
function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
}

describe('mastery cache', () => {
  beforeEach(installLocalStorage);

  const sample: MasteryCacheEntry[] = [
    { group: 'aqours', id: 1, correct: 8, attempted: 10, totalLines: 20 },
    { group: 'liella', id: 11, correct: 0, attempted: 0, totalLines: 5 },
  ];

  it('round-trips entries through save/load', () => {
    saveMasteryCache(sample);
    expect(loadMasteryCache()).toEqual(sample);
  });

  it('returns [] when nothing has been written', () => {
    expect(loadMasteryCache()).toEqual([]);
  });

  it('returns [] on corrupt JSON instead of throwing', () => {
    (globalThis as { localStorage: { setItem(k: string, v: string): void } })
      .localStorage.setItem('mastery-cache', '{not json');
    expect(() => loadMasteryCache()).not.toThrow();
    expect(loadMasteryCache()).toEqual([]);
  });
});
