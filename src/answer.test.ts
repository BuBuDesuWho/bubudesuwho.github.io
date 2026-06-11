import { describe, expect, it } from 'vitest';
import { slotState, applySlotClasses } from './answer';
import { SlotState, type Slot } from './types';

describe('slotState', () => {
  it('is Idle when there are no choices', () => {
    expect(slotState([], [1, 2])).toBe(SlotState.Idle);
  });

  it('is Correct when choices match the answer exactly', () => {
    expect(slotState([1, 2, 3], [1, 2, 3])).toBe(SlotState.Correct);
  });

  it('is Wrong on a different member set', () => {
    expect(slotState([1, 4], [1, 2])).toBe(SlotState.Wrong);
  });

  it('is Wrong for a subset and for a superset', () => {
    expect(slotState([1], [1, 2])).toBe(SlotState.Wrong);
    expect(slotState([1, 2, 3], [1, 2])).toBe(SlotState.Wrong);
  });

  // Documents the pre-existing order-sensitivity of the comparison: the app
  // keeps both arrays sorted, so equal sets compare equal — but out-of-order
  // input grades Wrong. Preserved exactly from the original checkSlot.
  it('is order-sensitive (relies on both arrays being sorted)', () => {
    expect(slotState([2, 1], [1, 2])).toBe(SlotState.Wrong);
  });
});

describe('applySlotClasses', () => {
  function fakeSlot(state: SlotState, initial: string[] = []) {
    const classes = new Set<string>(initial);
    const slot = {
      state,
      element: {
        classList: {
          toggle: (c: string, force: boolean) => { force ? classes.add(c) : classes.delete(c); },
        },
      },
    } as unknown as Slot;
    return { slot, classes };
  }

  it('marks a correct slot and clears any wrong marker', () => {
    const { slot, classes } = fakeSlot(SlotState.Correct, ['slot-wrong']);
    applySlotClasses(slot);
    expect(classes.has('slot-correct')).toBe(true);
    expect(classes.has('slot-wrong')).toBe(false);
  });

  it('marks a wrong slot and clears any correct marker', () => {
    const { slot, classes } = fakeSlot(SlotState.Wrong, ['slot-correct']);
    applySlotClasses(slot);
    expect(classes.has('slot-wrong')).toBe(true);
    expect(classes.has('slot-correct')).toBe(false);
  });

  it('clears both markers when Idle', () => {
    const { slot, classes } = fakeSlot(SlotState.Idle, ['slot-correct', 'slot-wrong']);
    applySlotClasses(slot);
    expect(classes.has('slot-correct')).toBe(false);
    expect(classes.has('slot-wrong')).toBe(false);
  });

  it('is a no-op when the slot has no element', () => {
    const slot = { state: SlotState.Correct, element: null } as unknown as Slot;
    expect(() => applySlotClasses(slot)).not.toThrow();
  });
});
