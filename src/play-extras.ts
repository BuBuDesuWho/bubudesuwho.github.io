// Practice tools and the end-of-song results card for play.html: playback
// speed, looping the current line, the keyboard help overlay, and the
// results card with share text. The scoring lives in play-results.ts; this
// module only owns DOM and player wiring.

import './play-extras.css';
import { Song, Slot } from './types';
import { toTimeStr } from './utils';
import { memberName } from './groups';
import * as player from './player';
import { prefs } from './prefs';
import { loadHistory, HistRecord } from './storage';
import { loadIndex } from './config';
import { playResolver } from './hist';
import { trapTab } from './focus-trap';
import {
  state, checkChoices, getDiffLabel, getSongTitle, getGroupColors,
} from './game';
import {
  scoreLines, bestFromHistory, buildResultShareText, SongResult,
  nextRate, normalizeRate, rateLabel, loopAction, loopStart,
} from './play-results';

export interface PlayExtrasHooks {
  /** Keep the play/pause buttons honest after we start playback. */
  syncPlayPause: () => void;
  /** Clear this song's answers (the Reset button). */
  resetChoices: () => void;
  /** Fallback song order when the sidebar has nothing to step through. */
  songIds: () => string[];
}

let hooks: PlayExtrasHooks;

// A-B loop over one slot. Our own restart seek comes back as a tick with
// didSeek set, and on a slow html5 seek that tick can still report the old
// position, so ignore "seeked away" for a moment after restarting.
let loop: { slot: Slot; range: [number, number] } | null = null;
let loopRestartedAt = 0;
const LOOP_SEEK_GRACE_MS = 400;

// Per-song session info for the results card.
let songHist: HistRecord[] = [];
let selectedId: string | null = null;
let firstPlayAt: number | null = null;

export function initPlayExtras(h: PlayExtrasHooks): void {
  hooks = h;
  applyRate(normalizeRate(prefs.playbackRate.get()));

  document.getElementById('rate-button')?.addEventListener('click', cycleRate);
  document.getElementById('loop-button')?.addEventListener('click', toggleLoop);
  document.getElementById('results-button')?.addEventListener('click', () => showResults());
  document.getElementById('help-button')?.addEventListener('click', toggleHelp);

  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('px-overlay')) hideOverlays();
  });

  // Capture phase, ahead of bindKeyboard: while a card is up, Space and
  // Enter belong to its focused button, not play/pause or Check behind it.
  document.addEventListener('keydown', (e) => {
    const open = openOverlay();
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      hideOverlays();
    } else if (e.key === 'Tab') {
      trapTab(e, open);
    } else if (e.key === '?' && open.id === 'px-help') {
      e.preventDefault();
      hideOverlays();
    }
    e.stopImmediatePropagation();
  }, true);
}

// ─── Song lifecycle ────────────────────────────────────────────────
export function onSongSelected(song: Song): void {
  clearLoop();
  hideOverlays();
  firstPlayAt = null;
  // Snapshot before this visit's Check presses append to `hist`, so "new
  // best" compares against earlier sessions rather than the run itself.
  // Resolving needs the catalog (older records only carry a name, which a
  // hidden variant may share); it's already loaded, so this settles at once.
  const hist = loadHistory();
  songHist = [];
  selectedId = song.id;
  void loadIndex().then((songs) => {
    if (selectedId !== song.id) return;
    const resolve = playResolver(songs);
    songHist = hist.filter((r) => resolve(r)?.id === song.id);
  });
}

export function onTick(time: number, didSeek: boolean): void {
  if (firstPlayAt === null) firstPlayAt = Date.now();
  if (!loop) return;
  const action = loopAction(time, loop.range, didSeek);
  if (action === 'restart') {
    loopRestartedAt = performance.now();
    player.play(loopStart(loop.range));
  } else if (action === 'clear' && performance.now() - loopRestartedAt > LOOP_SEEK_GRACE_MS) {
    clearLoop();
  }
}

export function onSongEnd(): void {
  hooks.syncPlayPause();
  // Rhythm mode shares the player and shows its own results.
  if (document.querySelector('.whosings')) return;
  // Only pop the card if they actually played along.
  if (visibleSlots().some((s) => s.choices.length > 0)) showResults();
}

// ─── Keyboard ──────────────────────────────────────────────────────
/** Returns true when the key was ours, so bindKeyboard can stop there. */
export function handleKey(e: KeyboardEvent): boolean {
  if (e.key === '?') { toggleHelp(); return true; }
  const k = e.key.toLowerCase();
  if (k === 's') { cycleRate(); return true; }
  if (k === 'l') { toggleLoop(); return true; }
  if (k === 'r') { showResults(); return true; }
  return false;
}

// ─── Speed ─────────────────────────────────────────────────────────
function applyRate(rate: number): void {
  player.setRate(rate);
  const btn = document.getElementById('rate-button');
  if (btn) {
    btn.textContent = rateLabel(rate);
    btn.classList.toggle('active', rate !== 1);
  }
}

function cycleRate(): void {
  const rate = nextRate(player.getRate());
  applyRate(rate);
  prefs.playbackRate.set(rate);
}

// ─── Loop ──────────────────────────────────────────────────────────
function visibleSlots(): Slot[] {
  return state.slots.filter((s) => s.diff <= state.diff);
}

/** The line to loop: the one playing now, else the last one that started
 *  before the playhead (so pausing just after a line still grabs it). */
function slotAtPlayhead(): Slot | null {
  const slots = visibleSlots();
  const active = slots.find((s) => s.active);
  if (active) return active;
  const t = player.getCurrentTime();
  let best: Slot | null = null;
  for (const s of slots) if (s.range[0] <= t && (!best || s.range[0] > best.range[0])) best = s;
  return best ?? slots[0] ?? null;
}

function toggleLoop(): void {
  if (loop) { clearLoop(); return; }
  const slot = slotAtPlayhead();
  if (!slot) return;
  loop = { slot, range: [slot.range[0], slot.range[1]] };
  slot.element?.classList.add('px-looping');
  document.getElementById('loop-button')?.classList.add('active');
  loopRestartedAt = performance.now();
  player.play(loopStart(loop.range));
  hooks.syncPlayPause();
}

function clearLoop(): void {
  loop?.slot.element?.classList.remove('px-looping');
  loop = null;
  document.getElementById('loop-button')?.classList.remove('active');
}

// ─── Overlays ──────────────────────────────────────────────────────
let returnFocus: HTMLElement | null = null;

function openOverlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.px-overlay:not([hidden])');
}

function hideOverlays(): void {
  const wasOpen = openOverlay() !== null;
  document.querySelectorAll<HTMLElement>('.px-overlay').forEach((el) => { el.hidden = true; });
  if (wasOpen) returnFocus?.focus();
  returnFocus = null;
}

/** Shows `el` as the only overlay and moves focus into it, remembering
 *  where focus came from so closing hands it back. */
function showOverlay(el: HTMLElement): void {
  const from = document.activeElement;
  const keep = openOverlay() ? returnFocus : (from instanceof HTMLElement && from !== document.body ? from : null);
  hideOverlays();
  returnFocus = keep;
  el.hidden = false;
  el.querySelector<HTMLElement>('.px-close')?.focus();
}

function overlay(id: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'px-overlay';
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['← / →', 'Seek back / forward 2s'],
  ['1-9', 'Toggle a member on the current line'],
  ['C', 'Check answers'],
  ['Ctrl+A', 'Reveal all singers'],
  ['S', 'Playback speed (0.5x / 0.75x / 1x)'],
  ['L', 'Loop the current line'],
  ['R', 'Results'],
  ['?', 'This help'],
  ['Esc', 'Close'],
];

function toggleHelp(): void {
  const el = overlay('px-help');
  if (!el.hidden) { hideOverlays(); return; }
  el.replaceChildren(card('Keyboard shortcuts', (body) => {
    const dl = document.createElement('dl');
    dl.className = 'px-keys';
    for (const [key, what] of SHORTCUTS) {
      const dt = document.createElement('dt');
      for (const part of key.split(' / ')) {
        if (dt.childNodes.length) dt.append(' / ');
        const kbd = document.createElement('kbd');
        kbd.textContent = part;
        dt.append(kbd);
      }
      const dd = document.createElement('dd');
      dd.textContent = what;
      dl.append(dt, dd);
    }
    body.append(dl);
  }));
  showOverlay(el);
}

let cardSeq = 0;

function card(title: string, fill: (body: HTMLElement) => void): HTMLElement {
  const c = document.createElement('div');
  c.className = 'px-card';
  c.setAttribute('role', 'dialog');
  c.setAttribute('aria-modal', 'true');
  // Both overlays keep their last card in the DOM, so the id must be unique.
  const titleId = `px-card-title-${++cardSeq}`;
  c.setAttribute('aria-labelledby', titleId);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'px-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', hideOverlays);
  const h = document.createElement('h3');
  h.id = titleId;
  h.textContent = title;
  c.append(close, h);
  fill(c);
  return c;
}

// ─── Results ───────────────────────────────────────────────────────
function showResults(): void {
  const song = state.song;
  if (!song) return;
  // Grade everything so the slots show right/wrong behind the card, same as
  // pressing Check. Skipped when nothing's picked: checkChoices would reset.
  const slots = visibleSlots();
  if (slots.some((s) => s.choices.length > 0)) checkChoices();

  const result = scoreLines(slots.map((s) => ({ choices: s.choices, ans: s.ans })));
  const prevBest = bestFromHistory(songHist, result.total);
  const newBest = prevBest !== null && result.correct > prevBest;

  const el = overlay('px-results');
  el.replaceChildren(card(getSongTitle(song), (body) => {
    body.classList.add('px-results-card');
    const sub = document.createElement('div');
    sub.className = 'px-sub';
    sub.textContent = getDiffLabel();
    body.append(sub);

    const score = document.createElement('div');
    score.className = 'px-score';
    score.innerHTML = `<span class="px-big">${result.correct}</span><span class="px-of">/ ${result.total}</span><span class="px-pct">${result.pct}%</span>`;
    body.append(score);

    const badges = document.createElement('div');
    badges.className = 'px-badges';
    const badge = (text: string, cls: string) => {
      const b = document.createElement('span');
      b.className = `px-badge ${cls}`;
      b.textContent = text;
      badges.append(b);
    };
    if (result.total > 0 && result.correct === result.total) badge('Full combo', 'px-badge-fc');
    if (newBest) badge('New best!', 'px-badge-best');
    else if (prevBest !== null) badge(`Best ${prevBest}/${result.total}`, 'px-badge-plain');
    else badge('First run', 'px-badge-plain');
    if (firstPlayAt !== null) badge(`Time ${toTimeStr((Date.now() - firstPlayAt) / 1000)}`, 'px-badge-plain');
    body.append(badges);

    body.append(gridEl(result), membersEl(result));
    body.append(actionsEl(song, result, newBest));
  }));
  showOverlay(el);
}

function gridEl(result: SongResult): HTMLElement {
  const grid = document.createElement('div');
  grid.className = 'px-grid';
  result.marks.forEach((m, i) => {
    const cell = document.createElement('span');
    cell.className = `px-cell px-${m}`;
    cell.title = `Line ${i + 1}: ${m === 'blank' ? 'no answer' : m}`;
    grid.append(cell);
  });
  return grid;
}

function membersEl(result: SongResult): HTMLElement {
  const colors = getGroupColors(state.group);
  const list = document.createElement('div');
  list.className = 'px-members';
  for (const m of result.members) {
    const row = document.createElement('div');
    row.className = 'px-member';
    const name = document.createElement('span');
    name.className = 'px-member-name';
    name.textContent = memberName(state.group, m.id) ?? `#${m.id}`;
    const bar = document.createElement('span');
    bar.className = 'px-bar';
    const fill = document.createElement('span');
    fill.className = 'px-bar-fill';
    fill.style.width = `${m.total ? (m.hit / m.total) * 100 : 0}%`;
    if (colors[m.id]) fill.style.background = colors[m.id];
    bar.append(fill);
    const num = document.createElement('span');
    num.className = 'px-member-num';
    num.textContent = `${m.hit}/${m.total}`;
    row.append(name, bar, num);
    list.append(row);
  }
  return list;
}

function actionsEl(song: Song, result: SongResult, newBest: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'px-actions';
  const btn = (text: string, cls: string, onClick: (b: HTMLButtonElement) => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${cls}`;
    b.textContent = text;
    b.addEventListener('click', () => onClick(b));
    row.append(b);
  };

  btn('Copy result', 'btn-success', (b) => {
    const brand = import.meta.env.VITE_APP_MODE === 'kpop' ? 'Whoranghae' : 'BubuDesuWho';
    const text = buildResultShareText({
      brand,
      songTitle: getSongTitle(song),
      diffLabel: getDiffLabel(),
      result,
      newBest,
      url: `${location.host}${location.pathname}#${song.id}`,
    });
    copyText(text, () => {
      b.textContent = 'Copied!';
      setTimeout(() => { b.textContent = 'Copy result'; }, 1500);
    });
  });
  btn('Replay', 'btn-default', () => {
    hideOverlays();
    hooks.resetChoices();
    firstPlayAt = null;
    player.play(0);
    hooks.syncPlayPause();
  });
  btn('Next song', 'btn-primary', () => {
    const next = nextSongId(song.id);
    if (next) location.hash = next;
    else hideOverlays();
  });
  return row;
}

/** Next song in the sidebar as currently filtered and sorted, falling back to
 *  index order, wrapping at the end. */
function nextSongId(current: string): string | null {
  const fromMenu = [...document.querySelectorAll<HTMLElement>('.sidebar-nav a[data-song-id]')]
    .filter((a) => a.offsetParent !== null)
    .map((a) => a.dataset.songId!);
  const ids = fromMenu.length > 1 ? fromMenu : hooks.songIds();
  if (ids.length < 2) return null;
  const i = ids.indexOf(current);
  return ids[(i + 1) % ids.length];
}

function copyText(text: string, done: () => void): void {
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } finally { ta.remove(); }
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(fallback);
  else fallback();
}
