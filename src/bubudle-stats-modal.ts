// End-of-game stats dialog for the daily. Builds its own DOM on first open so
// bubudle.html only needs a button, and owns its countdown timer so it stops
// ticking the moment the dialog closes.

import '../css/bubudle-stats.css';
import { DailyStats } from './bubudle-stats';
import { MAX_ATTEMPTS } from './bubudle-share';
import { formatHms, msUntilNextEstMidnight } from './bubudle-daily';
import { trapTab } from './focus-trap';

export interface StatsModalOptions {
  title: string;
  stats: DailyStats;
  /** Today's outcome: guesses used on a win, 'X' on a loss, null if unplayed. */
  outcome: number | 'X' | null;
  /** Only today's daily has a "next" to count down to. */
  showCountdown: boolean;
  onShare?: (btn: HTMLButtonElement) => void;
  onPractice?: () => void;
}

let root: HTMLElement | null = null;
let timer: number | null = null;
let returnFocus: HTMLElement | null = null;

export function isStatsModalOpen(): boolean {
  return !!root && !root.hidden;
}

export function closeStatsModal(): void {
  if (!root || root.hidden) return;
  root.hidden = true;
  if (timer !== null) { clearInterval(timer); timer = null; }
  returnFocus?.focus();
  returnFocus = null;
}

function ensureRoot(): HTMLElement {
  if (root) return root;
  root = document.createElement('div');
  root.id = 'bubudle-stats-modal';
  root.className = 'bbs-backdrop';
  root.hidden = true;
  root.addEventListener('click', (e) => { if (e.target === root) closeStatsModal(); });
  // Capture phase so keys never fall through to the game's own shortcuts
  // (Enter would re-check or advance behind the dialog). stopPropagation
  // leaves a focused button's native Enter/Space activation intact.
  document.addEventListener('keydown', (e) => {
    if (!isStatsModalOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeStatsModal();
    } else if (e.key === 'Tab') {
      trapTab(e, root!);
    }
    e.stopImmediatePropagation();
  }, true);
  document.body.appendChild(root);
  return root;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statTile(value: number | string, label: string): HTMLElement {
  const tile = el('div', 'bbs-stat');
  tile.append(el('div', 'bbs-stat-value', String(value)), el('div', 'bbs-stat-label', label));
  return tile;
}

function headline(outcome: StatsModalOptions['outcome']): string {
  if (outcome === null) return 'Your daily record';
  if (outcome === 'X') return 'Not this time. Tomorrow is a new song.';
  if (outcome === 1) return 'First try!';
  return `Solved in ${outcome}/${MAX_ATTEMPTS}`;
}

export function openStatsModal(opts: StatsModalOptions): void {
  const host = ensureRoot();
  const { stats, outcome } = opts;
  if (!isStatsModalOpen() && document.activeElement instanceof HTMLElement) returnFocus = document.activeElement;

  const dialog = el('div', 'bbs-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'bbs-title');

  const close = el('button', 'bbs-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeStatsModal);

  const title = el('h3', 'bbs-title', opts.title);
  title.id = 'bbs-title';

  const tiles = el('div', 'bbs-stats');
  tiles.append(
    statTile(stats.played, 'Played'),
    statTile(stats.winPct, 'Win %'),
    statTile(stats.currentStreak, 'Daily streak'),
    statTile(stats.maxStreak, 'Best daily streak'),
  );

  const hist = el('div', 'bbs-hist');
  hist.setAttribute('aria-label', 'Guess distribution');
  const buckets: [string, number, boolean][] = stats.distribution.map((n, i) => [String(i + 1), n, outcome === i + 1]);
  buckets.push(['X', stats.losses, outcome === 'X']);
  const peak = Math.max(1, ...buckets.map(([, n]) => n));
  for (const [label, n, mine] of buckets) {
    const row = el('div', 'bbs-hist-row');
    const bar = el('div', `bbs-hist-bar${mine ? ' bbs-hist-mine' : ''}${label === 'X' ? ' bbs-hist-x' : ''}`, String(n));
    // A floor keeps zero rows readable instead of collapsing to nothing.
    bar.style.width = `${Math.max(8, (n / peak) * 100)}%`;
    row.append(el('span', 'bbs-hist-label', label), el('div', 'bbs-hist-track'));
    row.lastElementChild!.appendChild(bar);
    hist.appendChild(row);
  }

  dialog.append(close, title, el('p', 'bbs-headline', headline(outcome)), tiles,
    el('h4', 'bbs-subhead', 'Guess distribution'), hist);

  if (stats.archivePlayed > 0) {
    const plural = stats.archivePlayed === 1 ? 'day' : 'days';
    dialog.appendChild(el('p', 'bbs-note', `+${stats.archivePlayed} archive ${plural} played (not counted in streaks)`));
  }

  const footer = el('div', 'bbs-footer');
  if (opts.showCountdown) {
    const cd = el('div', 'bbs-countdown');
    const value = el('span', 'bbs-countdown-value');
    cd.append(el('span', 'bbs-countdown-label', 'Next daily in'), value);
    footer.appendChild(cd);
    const tick = () => { value.textContent = formatHms(msUntilNextEstMidnight()); };
    tick();
    if (timer !== null) clearInterval(timer);
    timer = window.setInterval(tick, 1000);
  }
  const actions = el('div', 'bbs-actions');
  if (opts.onShare && outcome !== null) {
    const share = el('button', 'btn btn-info bbs-share', 'Share');
    share.type = 'button';
    share.addEventListener('click', () => opts.onShare!(share));
    actions.appendChild(share);
  }
  if (opts.onPractice) {
    const practice = el('button', 'btn btn-default bbs-practice', 'Keep playing (Infinite)');
    practice.type = 'button';
    practice.title = 'Random clips that never touch your daily stats';
    practice.addEventListener('click', () => { closeStatsModal(); opts.onPractice!(); });
    actions.appendChild(practice);
  }
  footer.appendChild(actions);
  dialog.appendChild(footer);

  host.replaceChildren(dialog);
  host.hidden = false;
  (dialog.querySelector<HTMLElement>('.bbs-share') ?? close).focus();
}
