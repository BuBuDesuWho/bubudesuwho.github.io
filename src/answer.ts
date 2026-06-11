import { Slot, SlotState } from './types';
import { arrayEqual } from './utils';

/** Grade a guess against a slot's answer. Pure.
 *
 *  Comparison is order-sensitive (via arrayEqual): choices must match `ans`
 *  element-for-element. In practice both are kept sorted ascending — `ans` by
 *  the preprocessor, choices by member id — so equal sets compare equal. */
export function slotState(choices: number[], ans: number[]): SlotState {
  if (choices.length === 0) return SlotState.Idle;
  return arrayEqual(choices, ans) ? SlotState.Correct : SlotState.Wrong;
}

/** Reflect a slot's grade onto its element. The only code that writes the
 *  slot-correct / slot-wrong classes. */
export function applySlotClasses(slot: Slot): void {
  const el = slot.element;
  if (!el) return;
  el.classList.toggle('slot-correct', slot.state === SlotState.Correct);
  el.classList.toggle('slot-wrong', slot.state === SlotState.Wrong);
}
