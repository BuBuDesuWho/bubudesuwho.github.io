import { describe, expect, it } from 'vitest';
import { buildIndex, slotFor } from './slot-graph';
import { state } from './game-state';
import { SlotState, type Slot, type MappingEntry } from './types';

function slot(mapping: MappingEntry & { members?: number[] }): Slot {
  return {
    id: mapping.id,
    mapping,
    range: mapping.range,
    ans: mapping.ans ?? [],
    diff: 1,
    active: false,
    revealed: false,
    choices: [],
    state: SlotState.Idle,
    element: null,
  };
}

describe('buildIndex', () => {
  it('keys an ungrouped slot by its mapping id', () => {
    const s = slot({ range: [0, 1], ans: [3], id: 7 });
    const index = buildIndex([s]);
    expect(index[7]).toBe(s);
  });

  it('keys a grouped slot by each member id', () => {
    const s = slot({ range: [0, 1], ans: [1, 2], id: 0, members: [1, 2] });
    const index = buildIndex([s]);
    expect(index[1]).toBe(s);
    expect(index[2]).toBe(s);
  });
});

describe('slotFor freshness', () => {
  it('rebuilds when state.slots is replaced, never returning a stale slot', () => {
    const a = slot({ range: [0, 1], ans: [1], id: 10 });
    const b = slot({ range: [1, 2], ans: [2], id: 20 });

    state.slots = [a];
    expect(slotFor(10)).toBe(a);
    expect(slotFor(20)).toBeUndefined();

    // Replacing the array (as load / edit ops do) must invalidate the index.
    state.slots = [b];
    expect(slotFor(20)).toBe(b);
    expect(slotFor(10)).toBeUndefined();
  });
});
