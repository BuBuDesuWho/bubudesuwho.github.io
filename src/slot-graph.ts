import { Slot } from './types';
import { state } from './game-state';

type SlotIndex = Record<number, Slot>;

/** Build the id→slot join. Grouped slots are keyed by each member id;
 *  ungrouped slots by their mapping id. Pure — derived from the slot list,
 *  written by no caller. */
export function buildIndex(slots: Slot[]): SlotIndex {
  const map: SlotIndex = {};
  for (const slot of slots) {
    const m = slot.mapping;
    if ('members' in m && m.members) {
      for (const memberId of m.members) map[memberId] = slot;
    } else {
      map[m.id] = slot;
    }
  }
  return map;
}

// ─── Cached lazy index over the live slot list ──────────────────────
// Rebuilt whenever `state.slots` is replaced with a different array, so a
// stale read is unrepresentable: callers can't reach the index directly, and
// any mutation that swaps the array (load, edit ops, bubudle) is picked up on
// the next lookup. Mutators must produce a *new* slots array, never splice in
// place — see game-edit.ts.
let _index: SlotIndex = {};
let _slotsRef: Slot[] | null = null;

/** The slot owning the given mapping/member id, or undefined. */
export function slotFor(id: number): Slot | undefined {
  if (state.slots !== _slotsRef) {
    _index = buildIndex(state.slots);
    _slotsRef = state.slots;
  }
  return _index[id];
}
