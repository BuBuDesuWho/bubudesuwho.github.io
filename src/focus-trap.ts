// Shared by the page's modal dialogs. aria-modal only informs screen readers;
// without this, Tab walks straight out of the dialog into the page behind it.

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Call from a keydown handler on Tab. Wraps focus at either end of
 *  `container`, and pulls it back in if it somehow ended up outside. */
export function trapTab(e: KeyboardEvent, container: HTMLElement): void {
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
    .filter((n) => n.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const inside = active instanceof Node && container.contains(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}
