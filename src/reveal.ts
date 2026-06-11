import { MappingEntry } from './types';
import { arrayEqual } from './utils';

/** How a revealed lyric should look. The result of the reveal decision —
 *  pure data, no DOM. `applyClasses` is the only thing that renders it. */
export type Reveal =
  | { kind: 'hidden' }
  | { kind: 'solo'; member: number; color?: string; title: string }
  | { kind: 'all'; title: string }
  | { kind: 'subgroup'; colors: string[]; title: string };

/** Everything the reveal decision needs, supplied as plain data so the
 *  decision stays pure and testable. See CONTEXT.md for song roster vs pool. */
export interface RevealContext {
  /** The song's full singer roster — defines an "all-members" line. */
  songRoster: number[];
  /** The members in play for the current mode (song roster in the play page,
   *  a curated set in Bubudle). A line reveals when its `ans` equals this. */
  activePool: number[];
  /** Whether the owning slot is already revealed or answered correctly. */
  slotRevealed: boolean;
  /** Member id → colour for the active group + palette. */
  colors: Record<number, string>;
  /** Pre-resolved label for the answer (e.g. "Yoshiko + Riko"). */
  title: string;
}

/** Decide the reveal treatment for a mapping. Pure. */
export function revealClasses(mapping: MappingEntry, ctx: RevealContext): Reveal {
  const ans = mapping.ans;
  if (!ans) return { kind: 'hidden' };

  const isSolo = ans.length === 1;
  const isAllMembers = ans.length > 1 && arrayEqual(ctx.songRoster, ans);
  const isSubGroup = ans.length > 1 && !isAllMembers;

  const revealed = isAllMembers || arrayEqual(ctx.activePool, ans) || ctx.slotRevealed;
  if (!revealed) return { kind: 'hidden' };

  if (isSolo) {
    return { kind: 'solo', member: ans[0], color: ctx.colors[ans[0]], title: ctx.title };
  }
  if (isAllMembers) {
    return { kind: 'all', title: ctx.title };
  }
  // Subgroup (and the degenerate empty-ans-but-revealed case): colour the
  // gradient only when at least two members resolve to a colour; otherwise
  // the line is revealed with a title but no colouring — matching the original.
  const colors = isSubGroup ? ans.map((a) => ctx.colors[a]).filter(Boolean) : [];
  return { kind: 'subgroup', colors, title: ctx.title };
}

// ─── DOM adapter — the only code that writes reveal classes/styles ──────

/** Strip any reveal colouring (ansN / ans-all / solo / gradient) from a node. */
function clearRevealClasses(element: HTMLElement): void {
  const existing = Array.from(element.classList)
    .filter((c) => /^ans\d+$/.test(c) || c === 'ans-all');
  if (existing.length) element.classList.remove(...existing);
  element.classList.remove('lyric-gradient', 'lyric-solo');
  element.style.removeProperty('--solo-color');
  element.style.removeProperty('--gradient');
  element.style.removeProperty('--glow1');
  element.style.removeProperty('--glow2');
  element.style.removeProperty('--glow3');
}

/** Render a Reveal onto a lyric element. */
export function applyClasses(element: HTMLElement, reveal: Reveal): void {
  clearRevealClasses(element);

  if (reveal.kind === 'hidden') {
    element.removeAttribute('title');
    return;
  }

  if (reveal.kind === 'solo') {
    element.classList.add('ans' + reveal.member);
    if (reveal.color) {
      element.classList.add('lyric-solo');
      element.style.setProperty('--solo-color', reveal.color);
    }
  } else if (reveal.kind === 'all') {
    element.classList.add('ans-all');
  } else if (reveal.kind === 'subgroup' && reveal.colors.length >= 2) {
    const colors = reveal.colors;
    element.classList.add('lyric-gradient');
    element.style.setProperty('--gradient', `linear-gradient(90deg, ${colors.join(', ')})`);
    element.style.setProperty('--glow1', colors[0]);
    element.style.setProperty('--glow2', colors[Math.floor(colors.length / 2)]);
    element.style.setProperty('--glow3', colors[colors.length - 1]);
  }

  element.title = reveal.title;
}
