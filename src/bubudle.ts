import { Song, Slot, SlotState, MappingEntry, GroupName, MEMBER_MAPPING } from './types';
import { loadIndex, loadSongById, loadBubudlePool } from './config';
import { state, initGameState, loadSong, checkSlot, toggleChoice, toggleReveal, getSongTitle, getActivePool, setActivePool } from './game';
import { initThemeToggle } from './ui-about';
import { switchTheme, buildSlotSkeleton } from './ui';
import { initKofi } from './kofi';
import { buildMenu, toggleMenu } from './ui-menu';
import { hasGroup, getGroup, isExcludedFrom } from './groups';
import * as player from './player';
import { getStorage, setStorage } from './storage';
import {
  MEMBER_NICKNAMES,
  SHORTCUT_GROUPS,
  MEMBER_COLUMNS,
  HINT_SUBUNITS,
  HINT_YEARS,
  BubudleDifficulty,
  SongDifficulty,
  parseBubudleDiff,
  parseSongDiff,
} from './bubudle-config';
import { eligibleCandidates as filterEligible, PoolCandidate, poolCandidates, resolvePoolLine } from './candidate-pool';
import type { PoolSong, SongLine } from './bubudle-lines';
import { bubudleGridLayout } from './bubudle-grid';
import { appendToLog, renderLog, hasLogEntries } from './bubudle-log';
import {
  AppMode, DailyScope,
  currentDateEst, msUntilNextEstMidnight, formatHms,
  loadDailyResult, saveDailyResult,
  ARCHIVE_START, clampDailyDate, shiftDate, formatDailyDate, scopeKey,
} from './bubudle-daily';
import { loadDailyManifest, pickDailyLine } from './bubudle-archive';
import { computeDailyStats, loadScopeResults } from './bubudle-stats';
import { openStatsModal } from './bubudle-stats-modal';
import { lineKey } from './bubudle-rotation';
import { classifyGuess, parseGuessKey, buildShareText } from './bubudle-share';

const APP_MODE: AppMode = import.meta.env.VITE_APP_MODE === 'kpop' ? 'kpop' : 'anime';
type BubudleMode = 'infinite' | 'daily';

/** A pool line with its song fetched: what a puzzle renders from. */
interface LyricCandidate extends SongLine {
  song: Song;
  allSingers: number[];
}

function createBubudleSlot(slot: Slot, singers: number[]): HTMLElement {
  const singerSet = new Set(singers);

  // Groups without a hand-authored MEMBER_COLUMNS layout use the same
  // registry-driven skeleton the play page uses (dynamic grid of members
  // + subunit buttons). This avoids Bootstrap push/pull overlap when there
  // are no interleaved shortcut columns (e.g. K-pop groups).
  if (!MEMBER_COLUMNS[bubudleGroup]) {
    const el = buildSlotSkeleton(bubudleGroup);
    el.id = `slot${slot.id}`;
    el.dataset.diff = String(slot.diff);
    const hdr = el.querySelector<HTMLElement>('.slot-header');
    if (hdr) hdr.style.display = 'none';

    el.querySelectorAll<HTMLElement>('.slot-body button[data-value]').forEach((btn) => {
      const members = btn.dataset.value!.split(',').map(Number);
      const disabled = members.some(m => !singerSet.has(m));
      if (disabled) {
        btn.classList.add('disabled');
      } else {
        btn.addEventListener('click', () => toggleChoice(btn, slot));
      }
      btn.addEventListener('mouseup', () => btn.blur());
    });

    return el;
  }

  const el = document.createElement('div');
  el.className = 'row slot';
  el.id = `slot${slot.id}`;
  el.dataset.diff = String(slot.diff);

  // Header (hidden in bubudle, but needed for toggleReveal structure)
  const header = document.createElement('div');
  header.className = 'col-xs-12 col-md-2 slot-header';
  header.style.display = 'none';
  header.innerHTML = `
    <span class="label label-default timerange"></span>
    <span class="jump-button glyphicon glyphicon-play" title="Jump" aria-hidden="true"></span>
    <span class="check-slot-button glyphicon glyphicon-ok" aria-hidden="true" title="Check this line"></span>
    <span class="reveal-button glyphicon glyphicon-search" title="Reveal answer" aria-hidden="true"></span>
    <span class="reveal-off-button glyphicon glyphicon-search" title="Unreveal" aria-hidden="true" style="display:none"></span>
    <span class="show-lyrics glyphicon glyphicon-question-sign" aria-hidden="true"></span>`;
  el.appendChild(header);

  // Body with member buttons
  const body = document.createElement('div');
  body.className = 'col-xs-12 col-md-10 slot-body';
  const row = document.createElement('div');
  row.className = 'row';
  body.appendChild(row);
  el.appendChild(body);

  const layout = bubudleGridLayout(bubudleGroup, singers, Object.keys(MEMBER_MAPPING[bubudleGroup] ?? {}).map(Number));
  const hasSubunits = layout.hasSubunits;
  const memberMapping = MEMBER_MAPPING[state.group] ?? MEMBER_MAPPING[bubudleGroup];

  const labelFor = (id: number): string => {
    const name = memberMapping[id] ?? `#${id}`;
    const nick = (MEMBER_NICKNAMES[bubudleGroup] ?? {})[id];
    return nick ? `${name} (${nick})` : name;
  };

  function makeBtn(value: string, label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary';
    btn.dataset.value = value;
    btn.textContent = label;
    return btn;
  }

  function makeCol(classes: string, buttons: HTMLButtonElement[]): HTMLElement {
    const col = document.createElement('div');
    col.className = classes;
    for (const btn of buttons) col.appendChild(btn);
    return col;
  }

  // Member columns (3 cols of individual members)
  const memberCols = layout.memberCols.map(ids => ids.map(id => makeBtn(String(id), labelFor(id))));

  // Extra member buttons
  const extraBtns = layout.extras.map(id => makeBtn(String(id), labelFor(id)));

  // Shortcut buttons
  const leftShortcutBtns = layout.leftShortcuts.map(g => makeBtn(g.members.join(','), g.label));
  const rightShortcutBtns = layout.rightShortcuts.map(g => makeBtn(g.members.join(','), g.label));

  // Add extra member buttons to whichever shortcut column has room
  if (extraBtns.length > 0) {
    if (!hasSubunits) {
      leftShortcutBtns.unshift(...extraBtns);
    } else {
      leftShortcutBtns.push(...extraBtns);
    }
  }

  // Build layout: col1 | shortcutsLeft | col2 | shortcutsRight | col3.
  // With shortcut cols: 3 member cols at col-sm-2 + 2 shortcut cols at col-sm-2
  // = 10/12 grid width. Pulls on cols 1 and 2 slide them past the inserted
  // shortcut cols so visual order stays members-shortcuts-members-shortcuts-members.
  // Without shortcut cols (e.g. liella): widen member cols to col-sm-3 so the row
  // still fills 10/12 and stays centered, and drop the pulls (nothing to slide past).
  const hasShortcutCols = leftShortcutBtns.length > 0 || rightShortcutBtns.length > 0;
  const memberW = hasShortcutCols ? 'col-sm-2' : 'col-sm-3';
  const col1Pull = leftShortcutBtns.length > 0 ? ' col-sm-pull-2' : '';
  const col2Pull = (leftShortcutBtns.length > 0 ? 2 : 0) + (rightShortcutBtns.length > 0 ? 2 : 0);
  const col2PullCls = col2Pull > 0 ? ` col-sm-pull-${col2Pull}` : '';
  row.appendChild(makeCol(`col-xs-4 col-sm-offset-1 ${memberW} btn-group-vertical`, memberCols[0]));
  if (leftShortcutBtns.length > 0) {
    row.appendChild(makeCol('hidden-xs col-sm-push-4 col-sm-2 btn-group-vertical', leftShortcutBtns));
  }
  row.appendChild(makeCol(`col-xs-4${col1Pull} ${memberW} btn-group-vertical`, memberCols[1]));
  if (rightShortcutBtns.length > 0) {
    row.appendChild(makeCol('hidden-xs col-sm-push-2 col-sm-2 btn-group-vertical', rightShortcutBtns));
  }
  row.appendChild(makeCol(`col-xs-4${col2PullCls} ${memberW} btn-group-vertical`, memberCols[2]));

  // Mobile-only row: shortcuts laid out horizontally below the member grid.
  // Desktop uses the hidden-xs shortcut cols above; xs swaps to this block.
  const leftBtnsMobile = leftShortcutBtns.map(b => b.cloneNode(true) as HTMLButtonElement);
  const rightBtnsMobile = rightShortcutBtns.map(b => b.cloneNode(true) as HTMLButtonElement);
  if (leftBtnsMobile.length + rightBtnsMobile.length > 0) {
    const mobileRow = document.createElement('div');
    mobileRow.className = 'row visible-xs-block bubudle-mobile-shortcuts';
    if (leftBtnsMobile.length > 0) {
      mobileRow.appendChild(makeCol('col-xs-12 bubudle-mobile-shortcut-group', leftBtnsMobile));
    }
    if (rightBtnsMobile.length > 0) {
      mobileRow.appendChild(makeCol('col-xs-12 bubudle-mobile-shortcut-group', rightBtnsMobile));
    }
    body.appendChild(mobileRow);
  }

  // Bind click handlers + disable non-singers
  el.querySelectorAll<HTMLElement>('.slot-body button[data-value]').forEach((btn) => {
    const members = btn.dataset.value!.split(',').map(Number);
    const disabled = members.some(m => !singerSet.has(m));
    if (disabled) {
      btn.classList.add('disabled');
    } else {
      btn.addEventListener('click', () => toggleChoice(btn, slot));
    }
    btn.addEventListener('mouseup', () => btn.blur());
  });

  // Bind reveal buttons
  el.querySelector('.reveal-button')!.addEventListener('click', () => toggleReveal(slot, true));
  const revealOffBtn = el.querySelector<HTMLElement>('.reveal-off-button')!;
  revealOffBtn.addEventListener('click', () => toggleReveal(slot, false));

  return el;
}

let bubudleGroup: GroupName = 'aqours';
let candidates: PoolCandidate[] = [];
let current: LyricCandidate | null = null;
let recentHistory: Set<string> = new Set();
let checked = false;
let streak = 0;
let currentSlot: Slot | null = null;
let clipEnd: number | null = null;
let wrongCount = 0;
let previousGuesses: string[] = [];
let clipRange: [number, number] = [0, 0];
let songSingers: number[] = [];
let dailyResultCorrect: boolean | null = null;

let bubudleDiff: BubudleDifficulty = 'normal';

let songDiff: SongDifficulty = 'all';

let subunitInclude: string[] = [];
let subunitExclude: string[] = [];

let bubudleMode: BubudleMode = 'infinite';
let dailyScope: DailyScope = { kind: 'group', group: 'aqours' };
/** The daily being shown. Equal to today except while browsing the archive. */
let dailyDate: string = currentDateEst();
/** That day's line is pinned to a song/timestamp the library no longer has. */
let dailyUnavailable = false;
let infiniteAll = false;
let poolSongs: PoolSong[] = [];
let countdownTimer: number | null = null;
let lastInfiniteGroup: GroupName = 'aqours';

/** Groups intentionally excluded from Bubudle (still playable via play.html). */
function isExcluded(group: string | undefined): boolean {
  return isExcludedFrom(group, 'bubudle');
}

function isAllScope(): boolean {
  return bubudleMode === 'daily' ? dailyScope.kind === 'mode' : infiniteAll;
}

function populateAllButton(): void {
  const btn = document.getElementById('bubudle-all-group-button');
  if (!btn) return;
  const sources: string[] = [];
  document.querySelectorAll<HTMLElement>('.group-button[data-value]').forEach((gb) => {
    const slug = gb.dataset.value!;
    if (!hasGroup(slug)) return;   // off-mode group — skip its icon
    if (isExcluded(slug)) return;
    const img = gb.querySelector<HTMLImageElement>('img.group-icon');
    if (img?.src) sources.push(img.getAttribute('src')!);
  });
  if (sources.length === 0) return;
  btn.innerHTML = '';
  const grid = document.createElement('span');
  grid.className = 'group-button-all-grid';
  for (const src of sources) {
    const im = document.createElement('img');
    im.className = 'group-icon-mini';
    im.src = src;
    im.alt = '';
    grid.appendChild(im);
  }
  btn.appendChild(grid);
}

// A shared/bookmarked daily link can pin the scope via ?daily=<group> (e.g.
// ?mode=daily&daily=nijigasaki) or ?daily=all for the whole-mode daily. This
// takes precedence over the visitor's saved scope so the link lands on exactly
// the daily it advertises.
function readDailyScopeFromUrl(): DailyScope | null {
  const param = new URLSearchParams(location.search).get('daily');
  if (!param) return null;
  if (param === 'all') return { kind: 'mode', mode: APP_MODE };
  if (hasGroup(param) && !isExcluded(param)) return { kind: 'group', group: param as GroupName };
  return null;
}

function loadDailyScope(): DailyScope {
  const fromUrl = readDailyScopeFromUrl();
  if (fromUrl) return fromUrl;
  const raw = getStorage('bubudle-daily-scope');
  if (!raw) return { kind: 'group', group: bubudleGroup };
  if (raw.startsWith('mode:')) {
    const mode = raw.slice(5);
    if (mode === 'anime' || mode === 'kpop') return { kind: 'mode', mode };
  }
  if (raw.startsWith('group:')) return { kind: 'group', group: raw.slice(6) };
  return { kind: 'group', group: bubudleGroup };
}

function saveDailyScope(): void {
  const key = dailyScope.kind === 'mode' ? `mode:${dailyScope.mode}` : `group:${dailyScope.group}`;
  setStorage('bubudle-daily-scope', key);
}

// ?date=YYYY-MM-DD pins the archive to a past daily. Deliberately not persisted
// to storage — the archive is somewhere you visit, not a mode you get stuck in.
function readDailyDateFromUrl(): string {
  const param = new URLSearchParams(location.search).get('date');
  return clampDailyDate(param, currentDateEst());
}

// Pinned is tracked explicitly rather than derived from `dailyDate !== today`,
// because at EST midnight today's date moves out from under us — and "the clock
// rolled over" must roll the daily forward, while "the visitor chose Aug 24"
// must not.
let archivePinned = false;

function pinDailyDate(date: string): void {
  dailyDate = date;
  archivePinned = date !== currentDateEst();
}

/** True while showing a past daily rather than today's. */
function isArchive(): boolean {
  return bubudleMode === 'daily' && archivePinned;
}

export async function initBubudlePage(): Promise<void> {
  player.initPlayer({
    onTick(currentTime, _duration, _didSeek) {
      if (clipEnd !== null && currentTime >= clipEnd) {
        clipEnd = null;
        // A paused element keeps downloading the track (1-3 MB a clip). Drop
        // it; a replay reloads from the clip's start, which it seeks to anyway.
        player.pause();
        player.release();
      }
      updateSeekSlider(currentTime);
    },
  });

  initGameState();
  initBubudleDifficulty();
  initSongDifficulty();
  initProgressToggle();
  loadSubunitFilter();
  // The pool says which lines exist; a puzzle fetches just its own song.
  const [menuSongs, pool] = await Promise.all([loadIndex(), loadBubudlePool()]);
  if (menuSongs.length === 0) return;
  poolSongs = pool;

  // Build sidebar menu (links go to play.html#song)
  buildMenu(menuSongs);
  bubudleGroup = state.group;

  // Hide excluded groups from the bubudle sidebar.
  document.querySelectorAll<HTMLElement>('.group-button[data-value]').forEach((btn) => {
    if (isExcluded(btn.dataset.value)) btn.style.display = 'none';
  });

  // If state.group landed on an excluded group (e.g. saved 'wug' from before), snap to first allowed group.
  if (isExcluded(bubudleGroup)) {
    const firstAllowed = Array.from(document.querySelectorAll<HTMLElement>('.group-button[data-value]'))
      .map(b => b.dataset.value!)
      .find(slug => hasGroup(slug) && !isExcluded(slug));
    if (firstAllowed) bubudleGroup = firstAllowed as GroupName;
  }
  applyGroupClass(bubudleGroup);
  toggleMenu(window.innerWidth >= 1200);
  initThemeToggle();
  initKofi();
  initVolume();
  initSeekSlider();

  populateAllButton();
  lastInfiniteGroup = bubudleGroup;
  infiniteAll = getStorage('bubudle-infinite-all') === '1';
  bubudleMode = readModeFromUrlOrStorage();
  dailyScope = loadDailyScope();
  if (dailyScope.kind === 'group' && isExcluded(dailyScope.group)) {
    dailyScope = { kind: 'group', group: bubudleGroup };
  }
  pinDailyDate(readDailyDateFromUrl());

  if (bubudleMode === 'infinite' && infiniteAll) {
    buildCandidatePoolAll(poolSongs);
  } else {
    buildCandidatePool(poolSongs);
  }
  rebuildSingerPicker();
  rebuildSubunitFilter();

  // Switch bubudle group when sidebar group button is clicked
  document.querySelectorAll<HTMLElement>('.group-button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.value;
      if (!value) return;   // 'All' button has no data-value; handled separately
      if (bubudleMode === 'daily') {
        dailyScope = { kind: 'group', group: value as GroupName };
        saveDailyScope();
        void loadDailyWithManifest();
      } else {
        infiniteAll = false;
        setStorage('bubudle-infinite-all', '');
        bubudleGroup = value as GroupName;
        lastInfiniteGroup = bubudleGroup;
        applyGroupClass(bubudleGroup);
        loadSubunitFilter();
        buildCandidatePool(poolSongs);
        rebuildSingerPicker();
        rebuildSubunitFilter();
        recentHistory.clear();
        applyModeUI();
        pickRandom(false, true);
      }
    });
  });

  document.querySelectorAll<HTMLElement>('.bubudle-mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode as BubudleMode));
  });

  document.getElementById('bubudle-all-group-button')?.addEventListener('click', () => {
    if (bubudleMode === 'daily') {
      dailyScope = { kind: 'mode', mode: APP_MODE };
      saveDailyScope();
      void loadDailyWithManifest();
    } else {
      infiniteAll = true;
      setStorage('bubudle-infinite-all', '1');
      buildCandidatePoolAll(poolSongs);
      rebuildSubunitFilter();
      recentHistory.clear();
      applyModeUI();
      pickRandom();
    }
  });

  streak = parseInt(getStorage('bubudle-streak') ?? '0', 10) || 0;
  updateStreak();

  // Bind controls
  document.getElementById('bubudle-check-bottom')!.addEventListener('click', checkAnswer);
  document.getElementById('bubudle-skip-bottom')!.addEventListener('click', skipAnswer);
  document.getElementById('bubudle-next-bottom')!.addEventListener('click', () => pickRandom());
  document.getElementById('bubudle-share')?.addEventListener('click', () => shareDailyResult());
  document.getElementById('bubudle-daily-stats')?.addEventListener('click', showDailyStats);
  document.getElementById('bubudle-daily-prev')?.addEventListener('click', () => stepDailyDate(-1));
  document.getElementById('bubudle-daily-next')?.addEventListener('click', () => stepDailyDate(1));
  document.getElementById('bubudle-daily-today')?.addEventListener('click', goToTodaysDaily);
  document.getElementById('bubudle-play')!.addEventListener('click', () => playClip());
  document.getElementById('bubudle-bad-timestamp')!.addEventListener('click', reportBadTimestamp);
  document.getElementById('bubudle-flag-diff')!.addEventListener('click', () => {
    const opts = document.getElementById('bubudle-diff-options')!;
    opts.style.display = opts.style.display === 'none' ? '' : 'none';
    document.getElementById('bubudle-singer-options')!.style.display = 'none';
  });
  document.querySelectorAll<HTMLElement>('.bubudle-diff-pick').forEach((btn) => {
    btn.addEventListener('click', () => flagDifficulty(parseInt(btn.dataset.diff!, 10)));
  });
  document.getElementById('bubudle-flag-singer')!.addEventListener('click', () => {
    const opts = document.getElementById('bubudle-singer-options')!;
    opts.style.display = opts.style.display === 'none' ? '' : 'none';
    document.getElementById('bubudle-diff-options')!.style.display = 'none';
  });
  document.getElementById('bubudle-singer-submit')!.addEventListener('click', flagSinger);
  document.getElementById('bubudle-singer-idk')!.addEventListener('click', flagSingerUnknown);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (!checked) checkAnswer();
      else if (bubudleMode === 'infinite') pickRandom();
    } else if (e.key === 'c') {
      if (!checked) checkAnswer();
      else if (bubudleMode === 'infinite') pickRandom();
    } else if (e.key === ' ') {
      e.preventDefault();
      playClip();
    }
  });

  applyModeUI();
  if (bubudleMode === 'daily') void loadDailyWithManifest();
  else pickRandom(true);

  if (hasLogEntries()) renderLog();
}

function applyGroupClass(group: GroupName): void {
  const html = document.documentElement;
  html.classList.remove('group-muse', 'group-aqours', 'group-wug', 'group-nijigasaki', 'group-liella');
  html.classList.add(`group-${group}`);
}

function buildCandidatePool(songs: PoolSong[]): void {
  candidates = poolCandidates(songs, (s) => {
    const menu = (s.menu ?? s.group) as string;
    return menu === bubudleGroup && !isExcluded(menu);
  });
  updatePoolCount();
}

function buildCandidatePoolAll(songs: PoolSong[]): void {
  candidates = poolCandidates(songs, (s) => !isExcluded((s.menu ?? s.group) as string));
  updatePoolCount();
}

const PICKER_EXTRA_MEMBERS: Partial<Record<GroupName, Record<number, string>>> = {
  aqours: { 10: 'Sarah', 11: 'Leah', 12: 'Miku' },
};

function rebuildSingerPicker(): void {
  const container = document.getElementById('bubudle-singer-options');
  if (!container) return;
  const submitBtn = document.getElementById('bubudle-singer-submit');
  container.querySelectorAll('.bubudle-singer-pick').forEach(b => b.remove());
  const mapping: Record<number, string> = {
    ...(MEMBER_MAPPING[bubudleGroup] ?? {}),
    ...(PICKER_EXTRA_MEMBERS[bubudleGroup] ?? {}),
  };
  for (const id of Object.keys(mapping).map(Number).sort((a, b) => a - b)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-xs bubudle-singer-pick';
    btn.dataset.singer = String(id);
    btn.textContent = mapping[id];
    btn.addEventListener('click', () => btn.classList.toggle('active'));
    container.insertBefore(btn, submitBtn);
  }
}

function currentStorageKey(): string {
  const inc = subunitInclude.length > 0 ? [...subunitInclude].sort().join('|') : '';
  const exc = subunitExclude.length > 0 ? [...subunitExclude].sort().join('|') : '';
  return `bubudle-current-${bubudleGroup}-${bubudleDiff}-${songDiff}-${inc}-${exc}`;
}

function subunitStorageKey(): string {
  return `bubudle-subunits-${bubudleGroup}`;
}

function loadSubunitFilter(): void {
  subunitInclude = [];
  subunitExclude = [];
  const raw = getStorage(subunitStorageKey());
  if (!raw) return;
  const valid = new Set((SHORTCUT_GROUPS[bubudleGroup] ?? []).filter(g => g.subunit).map(g => g.members.join(',')));
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.i)) subunitInclude = parsed.i.filter((k: string) => valid.has(k));
    if (Array.isArray(parsed.e)) subunitExclude = parsed.e.filter((k: string) => valid.has(k));
  } catch { /* legacy/invalid — ignore */ }
}

function saveSubunitFilter(): void {
  if (subunitInclude.length === 0 && subunitExclude.length === 0) {
    setStorage(subunitStorageKey(), '');
  } else {
    setStorage(subunitStorageKey(), JSON.stringify({ i: subunitInclude, e: subunitExclude }));
  }
}

type SubunitState = 'off' | 'include' | 'exclude';

function subunitStateFor(key: string): SubunitState {
  if (subunitInclude.includes(key)) return 'include';
  if (subunitExclude.includes(key)) return 'exclude';
  return 'off';
}

function cycleSubunit(key: string): void {
  const s = subunitStateFor(key);
  subunitInclude = subunitInclude.filter(k => k !== key);
  subunitExclude = subunitExclude.filter(k => k !== key);
  if (s === 'off') subunitInclude.push(key);
  else if (s === 'include') subunitExclude.push(key);
  // 'exclude' → off (already removed)
}

function rebuildSubunitFilter(): void {
  const container = document.getElementById('bubudle-subunit-filter');
  if (!container) return;
  container.querySelectorAll('button').forEach(b => b.remove());

  const subunits = (SHORTCUT_GROUPS[bubudleGroup] ?? []).filter(g => g.subunit);
  if (subunits.length === 0) {
    container.style.display = 'none';
    return;
  }
  container.style.display = '';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'btn btn-xs bubudle-diff-btn bubudle-subunit-btn';
  allBtn.textContent = 'All';
  allBtn.title = 'Clear subunit filter';
  allBtn.classList.toggle('active', subunitInclude.length === 0 && subunitExclude.length === 0);
  allBtn.addEventListener('click', () => {
    subunitInclude = [];
    subunitExclude = [];
    saveSubunitFilter();
    recentHistory.clear();
    rebuildSubunitFilter();
    pickRandom(false, true);
  });
  container.appendChild(allBtn);

  for (const g of subunits) {
    const key = g.members.join(',');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-xs bubudle-diff-btn bubudle-subunit-btn';
    btn.textContent = g.label;
    btn.title = 'Click: include, again: exclude, again: off';
    const state = subunitStateFor(key);
    btn.classList.toggle('active', state === 'include');
    btn.classList.toggle('excluded', state === 'exclude');
    btn.addEventListener('click', () => {
      cycleSubunit(key);
      saveSubunitFilter();
      recentHistory.clear();
      rebuildSubunitFilter();
      pickRandom(false, true);
    });
    container.appendChild(btn);
  }
}

function saveCurrent(c: LyricCandidate, answered = false): void {
  setStorage(currentStorageKey(), JSON.stringify({
    songId: c.song.id,
    lyric: c.lyric,
    range: c.range,
    answered,
  }));
}

// Matched on song + range (the line's identity everywhere else too): the pool
// doesn't carry lyric text, which was the third key before the pool existed.
function restoreCurrent(): { candidate: PoolCandidate; answered: boolean } | null {
  const raw = getStorage(currentStorageKey());
  if (!raw) return null;
  try {
    const { songId, range, answered } = JSON.parse(raw);
    const candidate = candidates.find(c =>
      c.song.id === songId && c.range[0] === range[0] && c.range[1] === range[1]
    );
    if (!candidate) return null;
    return { candidate, answered: !!answered };
  } catch { return null; }
}

function candidateKey(c: { song: { id: string }; range: readonly number[] }): string {
  return lineKey(c.song.id, c.range);
}

// Bumped by every puzzle load (and by anything that replaces the board), so a
// song fetch that resolves after the visitor has moved on is dropped.
let loadSeq = 0;

function beginLoad(): () => boolean {
  const seq = ++loadSeq;
  return () => seq === loadSeq;
}

/** Fetch the song behind a pool line. Null if it can't be loaded or no longer has the line. */
async function fetchLine(pc: PoolCandidate): Promise<LyricCandidate | null> {
  const song = await loadSongById(pc.song.id);
  if (!song) return null;
  const line = resolvePoolLine(song, pc);
  return line ? { ...line, song } : null;
}

function showLoadFailed(): void {
  loadSeq++;
  const container = document.getElementById('slots')!;
  container.innerHTML = '<div class="text-center" style="padding:2em;opacity:0.6">'
    + "Couldn't load this line. Check your connection and try again.</div>";
  document.getElementById('bubudle-lyric')!.textContent = '';
  document.getElementById('bubudle-lyric-jp')!.textContent = '';
  document.getElementById('bubudle-check-bottom')!.style.display = 'none';
  document.getElementById('bubudle-next-bottom')!.style.display = bubudleMode === 'daily' ? 'none' : '';
  resetHints();
}

function eligibleCandidates(): PoolCandidate[] {
  return filterEligible(candidates, {
    clipDiff: bubudleDiff,
    songDiff,
    subunitInclude,
    subunitExclude,
  });
}

// Infinite picks the following puzzle as soon as one renders and fetches its
// song, so Next doesn't wait on the network. Used only if it's still eligible
// and unplayed when Next comes; otherwise a fresh pick is drawn.
let upNext: PoolCandidate | null = null;

function drawFrom(pool: PoolCandidate[]): PoolCandidate {
  const available = pool.filter(c => !recentHistory.has(candidateKey(c)));
  const from = available.length > 0 ? available : pool;
  return from[Math.floor(Math.random() * from.length)];
}

function pickFromPool(pool: PoolCandidate[]): PoolCandidate {
  let pick = upNext && !recentHistory.has(candidateKey(upNext)) && pool.includes(upNext) ? upNext : null;
  upNext = null;
  if (!pick) {
    if (pool.every(c => recentHistory.has(candidateKey(c)))) recentHistory.clear();
    pick = drawFrom(pool);
  }
  recentHistory.add(candidateKey(pick));
  return pick;
}

function prefetchNext(pool: PoolCandidate[]): void {
  upNext = drawFrom(pool);
  void loadSongById(upNext.song.id);
}

function updatePoolCount(): void {
  const el = document.getElementById('bubudle-pool-count');
  if (el) el.textContent = `${eligibleCandidates().length}`;
}

function showEmptyPool(): void {
  loadSeq++;
  const container = document.getElementById('slots')!;
  container.innerHTML = '<div class="text-center" style="padding:2em;opacity:0.6">No lyrics available for this group yet</div>';
  document.getElementById('bubudle-lyric')!.textContent = '';
  document.getElementById('bubudle-lyric-jp')!.textContent = '';
  resetHints();
}

function pickRandom(initial = false, tryRestore = false): void {
  const pool = eligibleCandidates();
  updatePoolCount();
  if (pool.length === 0) { showEmptyPool(); return; }

  let restoredAnswered = false;
  let chosen: PoolCandidate;
  if (initial || tryRestore) {
    const restored = restoreCurrent();
    if (restored) { chosen = restored.candidate; restoredAnswered = restored.answered; }
    else { chosen = pickFromPool(pool); }
  } else {
    chosen = pickFromPool(pool);
  }
  void showPick(chosen, restoredAnswered, initial);
  if (bubudleMode === 'infinite') prefetchNext(pool);
}

async function showPick(pick: PoolCandidate, answered: boolean, initial: boolean): Promise<void> {
  const live = beginLoad();
  const c = await fetchLine(pick);
  if (!live()) return;
  if (!c) { showLoadFailed(); return; }
  saveCurrent(c, answered);
  renderCandidate(c, answered, initial);
}

function renderCandidate(c: LyricCandidate, answered: boolean, initial = false): void {
  // In any all-groups scope, the picked song determines the displayed group.
  if (isAllScope()) {
    const displayGroup = (c.song.menu ?? c.song.group) as GroupName;
    if (displayGroup !== bubudleGroup) {
      bubudleGroup = displayGroup;
      applyGroupClass(bubudleGroup);
      rebuildSingerPicker();
    }
  }

  current = c;
  checked = false;
  wrongCount = 0;
  previousGuesses = [];
  dailyResultCorrect = null;
  updateShareButton();
  clipRange = calcClipRange(c.range);
  updateLyricMarker();

  // Load audio first — loadSong sets state.group/singers from the song config,
  // so we override those after with values derived from the actual lyrics.
  player.setPreload('metadata');
  loadSong(c.song);

  songSingers = c.allSingers;
  const baseIds = Object.keys(MEMBER_MAPPING[bubudleGroup]).map(Number).sort((a, b) => a - b);
  const extras = c.allSingers.filter(s => !baseIds.includes(s));
  setActivePool([...baseIds, ...extras]);
  state.group = c.song.group;
  state.editMode = false;
  state.lyrics = [];

  const diff = c.diff;
  const mapping: MappingEntry = { range: c.range, ans: c.ans, diff, id: 0 };
  currentSlot = {
    id: 0, mapping, range: c.range, ans: c.ans, diff,
    active: false, revealed: false, choices: [], state: SlotState.Idle, element: null,
  };
  state.slots = [currentSlot];
  state.mapping = [mapping];

  const container = document.getElementById('slots')!;
  container.innerHTML = '';
  const el = createBubudleSlot(currentSlot, state.singers);
  currentSlot.element = el;
  container.appendChild(el);

  document.getElementById('bubudle-lyric')!.textContent = c.lyric;
  const jpEl = document.getElementById('bubudle-lyric-jp')!;
  if (c.lyricJp) { jpEl.textContent = c.lyricJp; jpEl.style.display = ''; }
  else { jpEl.textContent = ''; jpEl.style.display = 'none'; }

  resetHints();

  // Auto-narrow only in infinite (daily locks filters to 'all', so this would never trigger anyway)
  if (!answered && bubudleMode === 'infinite' && (bubudleDiff === 'normal' || songDiff === '1')) {
    if (songSingers.length < getActivePool().length) {
      setActivePool(songSingers);
      narrowToSingers(currentSlot, songSingers);
      revealHint('bubudle-hint-narrow', 'Singers', 'Narrowed to subunit');
    } else {
      const incorrect = getActivePool().filter(s => !c.ans.includes(s));
      const shuffled = incorrect.sort(() => Math.random() - 0.5);
      const toRemove = shuffled.slice(0, Math.min(2, shuffled.length));
      disableMembers(currentSlot, toRemove);
      revealHint('bubudle-hint-narrow', 'Singers', `Removed ${toRemove.length} wrong`);
    }
  }

  const diffBadge = document.getElementById('bubudle-diff')!;
  const diffLabels = ['', 'Normal', 'Hard', 'Insane'];
  const diffClasses = ['', 'diff-normal', 'diff-hard', 'diff-insane'];
  diffBadge.textContent = `Diff: ${diffLabels[diff] || diff}`;
  diffBadge.className = 'bubudle-diff ' + (diffClasses[diff] || '');

  const clipBadge = document.getElementById('bubudle-clip-diff')!;
  const clipLabels: Record<BubudleDifficulty, string> = { all: 'All', normal: 'Normal', hard: 'Hard', insane: 'Insane' };
  const clipClasses: Record<BubudleDifficulty, string> = { all: 'diff-all', normal: 'diff-normal', hard: 'diff-hard', insane: 'diff-insane' };
  clipBadge.textContent = `Clip: ${clipLabels[bubudleDiff]}`;
  clipBadge.className = 'bubudle-diff ' + clipClasses[bubudleDiff];

  switchTheme(null);
  document.getElementById('song-title')!.textContent = 'Bubudle';

  const nextDisplay = bubudleMode === 'daily' ? 'none' : '';
  const skipDisplay = bubudleMode === 'daily' ? 'none' : '';
  if (answered) {
    checked = true;
    revealSongName(c.song);
    switchTheme(c.song.id);
    toggleReveal(currentSlot!, true);
    document.getElementById('bubudle-check-bottom')!.style.display = 'none';
    document.getElementById('bubudle-skip-bottom')!.style.display = 'none';
    document.getElementById('bubudle-next-bottom')!.style.display = nextDisplay;
  } else {
    document.getElementById('bubudle-check-bottom')!.style.display = '';
    document.getElementById('bubudle-skip-bottom')!.style.display = skipDisplay;
    document.getElementById('bubudle-next-bottom')!.style.display = 'none';
  }

  if (!initial) playClip(true);
}

// ─── Daily mode ──────────────────────────────────────────────────

function readModeFromUrlOrStorage(): BubudleMode {
  const param = new URLSearchParams(location.search).get('mode');
  if (param === 'daily' || param === 'infinite') return param;
  const stored = getStorage('bubudle-mode');
  return stored === 'daily' ? 'daily' : 'infinite';
}

function updateUrlMode(mode: BubudleMode): void {
  const url = new URL(location.href);
  if (mode === 'daily') url.searchParams.set('mode', 'daily');
  else {
    url.searchParams.delete('mode');
    url.searchParams.delete('daily');
    url.searchParams.delete('date');
  }
  history.replaceState(null, '', url.toString());
}

// Keep ?daily=<scope> and ?date=<day> in sync with what's on screen, so the URL
// in the address bar is always a shareable link to the daily being shown.
function updateUrlScope(): void {
  const url = new URL(location.href);
  if (bubudleMode === 'daily') {
    url.searchParams.set('daily', dailyScope.kind === 'group' ? dailyScope.group : 'all');
    if (isArchive()) url.searchParams.set('date', dailyDate);
    else url.searchParams.delete('date');
  } else {
    url.searchParams.delete('daily');
    url.searchParams.delete('date');
  }
  history.replaceState(null, '', url.toString());
}

function applyModeUI(): void {
  document.querySelectorAll<HTMLElement>('.bubudle-mode-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === bubudleMode);
  });

  const isDaily = bubudleMode === 'daily';
  const allActive = isAllScope();
  const setDisplay = (id: string, hide: boolean) => {
    const el = document.getElementById(id);
    if (el) el.style.display = hide ? 'none' : '';
  };
  setDisplay('bubudle-difficulty', isDaily);
  setDisplay('bubudle-song-difficulty', isDaily);
  // Subunit filter is irrelevant in any all-groups scope (and in daily where filters are locked).
  setDisplay('bubudle-subunit-filter', isDaily || allActive);
  setDisplay('bubudle-all-group-li', false);   // All button always visible
  setDisplay('bubudle-daily-banner', !isDaily);
  setDisplay('bubudle-skip-bottom', isDaily);
  setDisplay('bubudle-bad-timestamp', isDaily);
  setDisplay('bubudle-flag-diff', isDaily);
  setDisplay('bubudle-flag-singer', isDaily);

  document.getElementById('bubudle-all-group-button')?.classList.toggle('active', allActive);

  // Pool counter row (parent of #bubudle-pool-count) is its own toggle div — hide it in daily.
  const poolBtn = document.getElementById('bubudle-pool-count');
  const poolWrap = poolBtn?.closest('.bubudle-difficulty-toggle') as HTMLElement | null;
  if (poolWrap) poolWrap.style.display = isDaily ? 'none' : '';

  if (!isDaily && countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function switchMode(mode: BubudleMode): void {
  if (mode === bubudleMode) return;
  if (bubudleMode === 'infinite' && !infiniteAll) lastInfiniteGroup = bubudleGroup;
  bubudleMode = mode;
  setStorage('bubudle-mode', mode);
  updateUrlMode(mode);
  applyModeUI();
  if (mode === 'daily') {
    if (dailyScope.kind === 'group') dailyScope = { kind: 'group', group: bubudleGroup };
    saveDailyScope();
    pinDailyDate(currentDateEst());   // re-entering Daily always lands on today
    void loadDailyWithManifest();
  } else {
    // Restore infinite filters from storage (they were locked during daily)
    const savedDiff = parseBubudleDiff(getStorage('bubudle-diff'));
    if (savedDiff) bubudleDiff = savedDiff;
    const savedSdiff = parseSongDiff(getStorage('bubudle-sdiff'));
    if (savedSdiff) songDiff = savedSdiff;
    syncDifficultyButtons();

    if (infiniteAll) {
      buildCandidatePoolAll(poolSongs);
    } else {
      bubudleGroup = lastInfiniteGroup;
      applyGroupClass(bubudleGroup);
      loadSubunitFilter();
      buildCandidatePool(poolSongs);
      rebuildSubunitFilter();
    }
    rebuildSingerPicker();
    recentHistory.clear();
    pickRandom(false, !infiniteAll);
  }
}

function syncDifficultyButtons(): void {
  document.querySelectorAll<HTMLElement>('.bubudle-diff-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.bdiff === bubudleDiff)
  );
  document.querySelectorAll<HTMLElement>('.bubudle-sdiff-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.sdiff === songDiff)
  );
}

async function loadDailyForScope(): Promise<void> {
  // Lock filters
  bubudleDiff = 'all';
  songDiff = 'all';
  subunitInclude = [];
  subunitExclude = [];
  recentHistory.clear();

  if (dailyScope.kind === 'group') {
    bubudleGroup = dailyScope.group;
    applyGroupClass(bubudleGroup);
    rebuildSingerPicker();
    buildCandidatePool(poolSongs);
  } else {
    buildCandidatePoolAll(poolSongs);
  }
  saveDailyScope();
  updateUrlScope();

  dailyUnavailable = false;

  const pool = eligibleCandidates();
  if (pool.length === 0) {
    showEmptyPool();
    updateDailyBanner();
    startCountdown();
    return;
  }

  const pick = pickDailyLine(pool, candidateKey, dailyScope, dailyDate, isArchive());
  if (!pick) {
    showArchiveUnavailable();
    updateDailyBanner();
    startCountdown();
    return;
  }

  const live = beginLoad();
  const candidate = await fetchLine(pick);
  if (!live()) return;
  if (!candidate) {
    showLoadFailed();
    updateDailyBanner();
    startCountdown();
    return;
  }

  const stored = loadDailyResult(dailyScope, dailyDate);
  renderCandidate(candidate, !!stored, true);

  if (stored) {
    previousGuesses = stored.guesses.slice();
    wrongCount = stored.wrongCount;
    renderGuesses();
    dailyResultCorrect = stored.correct;
    updateShareButton();
  }

  updateDailyBanner();
  startCountdown();
}

// Rather than silently serving a different line than the day actually had.
function showArchiveUnavailable(): void {
  loadSeq++;
  dailyUnavailable = true;
  const container = document.getElementById('slots')!;
  container.innerHTML = '<div class="text-center" style="padding:2em;opacity:0.6">'
    + "This day's line isn't in the song library any more.<br>Step to another day with the arrows above.</div>";
  document.getElementById('bubudle-lyric')!.textContent = '';
  document.getElementById('bubudle-lyric-jp')!.textContent = '';
  // Nothing to answer — renderCandidate puts these back on a playable day.
  document.getElementById('bubudle-check-bottom')!.style.display = 'none';
  document.getElementById('bubudle-next-bottom')!.style.display = 'none';
  resetHints();
}

// The day being shown now lives in the stepper next to the label, so the label
// itself is just the scope ("Love Live daily", "Aqours daily").
function dailyLabelFor(scope: DailyScope): string {
  return `${shareLabelFor(scope)} daily`;
}

function updateDailyBanner(): void {
  const labelEl = document.getElementById('bubudle-daily-label');
  if (labelEl) labelEl.textContent = dailyLabelFor(dailyScope);

  const archive = isArchive();
  const today = currentDateEst();

  const dateEl = document.getElementById('bubudle-daily-date');
  if (dateEl) {
    dateEl.textContent = archive ? formatDailyDate(dailyDate) : 'Today';
    dateEl.classList.toggle('bubudle-daily-date-gone', dailyUnavailable);
  }

  const prev = document.getElementById('bubudle-daily-prev') as HTMLButtonElement | null;
  if (prev) prev.disabled = dailyDate <= ARCHIVE_START;
  const next = document.getElementById('bubudle-daily-next') as HTMLButtonElement | null;
  if (next) next.disabled = dailyDate >= today;

  // Countdown only means something on today's daily; "back to today" only in the archive.
  const countdown = document.getElementById('bubudle-daily-countdown-wrap');
  if (countdown) countdown.style.display = archive ? 'none' : '';
  const back = document.getElementById('bubudle-daily-today');
  if (back) back.style.display = archive ? '' : 'none';
}

/** Step the archive by whole days, clamped to [ARCHIVE_START, today]. */
function stepDailyDate(days: number): void {
  const today = currentDateEst();
  let target = shiftDate(dailyDate, days);
  if (target > today) target = today;
  if (target < ARCHIVE_START) target = ARCHIVE_START;
  if (target === dailyDate) return;
  pinDailyDate(target);
  void loadDailyWithManifest();
}

// The manifest is only needed once you leave today, so it's fetched here rather
// than on page load. Resolved before rendering so the archive never flashes a
// live-computed line and then replaces it.
async function loadDailyWithManifest(): Promise<void> {
  await loadDailyManifest();
  await loadDailyForScope();
}

function goToTodaysDaily(): void {
  if (!isArchive()) return;
  pinDailyDate(currentDateEst());
  void loadDailyWithManifest();
}

function shareLabelFor(scope: DailyScope): string {
  if (scope.kind === 'group') return getGroup(scope.group)?.name ?? scope.group;
  return scope.mode === 'kpop' ? 'K-pop' : 'Love Live';
}

function shareUrlFor(scope: DailyScope): string {
  const base = `${location.host}${location.pathname}`;
  const params = new URLSearchParams();
  if (scope.kind === 'group') params.set('daily', scope.group);
  if (isArchive()) params.set('date', dailyDate);
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

// Archive plays are read-only for stats: the streak means "kept up with the
// daily", which replaying an old one doesn't demonstrate.
function recordStreak(next: number): void {
  if (isArchive()) return;
  streak = next;
  setStorage('bubudle-streak', String(streak));
  updateStreak();
}

function updateShareButton(): void {
  const btn = document.getElementById('bubudle-share');
  if (!btn) return;
  const show = bubudleMode === 'daily' && checked && dailyResultCorrect !== null;
  btn.style.display = show ? '' : 'none';
}

function shareDailyResult(target?: HTMLElement): void {
  if (!current || dailyResultCorrect === null) return;
  const text = buildShareText({
    label: shareLabelFor(dailyScope),
    date: dailyDate,
    guesses: previousGuesses.map(parseGuessKey),
    ans: current.ans,
    songSingers,
    correct: dailyResultCorrect,
    // An archive solve doesn't move the streak, so don't advertise one.
    streak: isArchive() ? undefined : streak,
    url: shareUrlFor(dailyScope),
  });
  const btn = target ?? document.getElementById('bubudle-share');
  const flash = () => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(flash).catch(() => fallbackCopy(text, flash));
  } else {
    fallbackCopy(text, flash);
  }
}

function fallbackCopy(text: string, done: () => void): void {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } finally { ta.remove(); }
}

function startCountdown(): void {
  if (countdownTimer !== null) clearInterval(countdownTimer);
  const tick = () => {
    const ms = msUntilNextEstMidnight();
    const el = document.getElementById('bubudle-daily-countdown');
    if (el) el.textContent = formatHms(ms);
    // Roll into the new day — but never yank someone off a daily they pinned.
    if (ms <= 0 && bubudleMode === 'daily' && !archivePinned) {
      dailyDate = currentDateEst();
      void loadDailyWithManifest();
    }
  };
  tick();
  countdownTimer = window.setInterval(tick, 1000);
}

function persistDailyResult(correct: boolean): void {
  if (bubudleMode !== 'daily' || !current) return;
  saveDailyResult(dailyScope, dailyDate, {
    guesses: previousGuesses.slice(),
    correct,
    songId: current.song.id,
    range: current.range,
    wrongCount,
    ...(isArchive() ? { archive: true } : {}),
  });
}

function showDailyStats(): void {
  const stored = loadDailyResult(dailyScope, dailyDate);
  const outcome = stored ? (stored.correct ? stored.guesses.length : 'X') : null;
  openStatsModal({
    title: `${shareLabelFor(dailyScope)} daily`,
    stats: computeDailyStats(loadScopeResults(dailyScope), currentDateEst()),
    outcome,
    showCountdown: !isArchive(),
    // Share needs the live board (answer + song singers), so only offer it
    // while the finished daily is the one on screen.
    onShare: stored && checked && dailyResultCorrect !== null ? (btn) => shareDailyResult(btn) : undefined,
    onPractice: () => switchMode('infinite'),
  });
}

// A beat after the reveal, so the answer and song name land before the dialog.
function showDailyStatsSoon(): void {
  const date = dailyDate;
  const key = scopeKey(dailyScope);
  setTimeout(() => {
    if (bubudleMode === 'daily' && dailyDate === date && scopeKey(dailyScope) === key) showDailyStats();
  }, 1400);
}

function playClip(forcePlay = false): void {
  if (!current) return;

  if (!forcePlay && player.isPlaying()) {
    player.pause();
    player.release();
    const playBtn = document.querySelector<HTMLElement>('.jp-play');
    const pauseBtn = document.querySelector<HTMLElement>('.jp-pause');
    if (playBtn) playBtn.style.display = 'inline-block';
    if (pauseBtn) pauseBtn.style.display = 'none';
    return;
  }

  clipEnd = clipRange[1] + 0.5;
  player.play(clipRange[0]);

  const playBtn = document.querySelector<HTMLElement>('.jp-play');
  const pauseBtn = document.querySelector<HTMLElement>('.jp-pause');
  if (playBtn) playBtn.style.display = 'none';
  if (pauseBtn) pauseBtn.style.display = 'inline-block';
}

function checkAnswer(): void {
  if (!current || !currentSlot || checked) return;
  if (currentSlot.choices.length === 0) return;

  const guessKey = [...currentSlot.choices].sort((a, b) => a - b).join(',');
  if (previousGuesses.includes(guessKey)) return;
  previousGuesses.push(guessKey);
  renderGuesses();

  checkSlot(currentSlot);

  const correct = currentSlot.state === SlotState.Correct;
  if (correct) {
    checked = true;
    recordStreak(streak + 1);

    revealSongName(current.song);
    switchTheme(current.song.id);
    saveCurrent(current, true);
    persistDailyResult(true);
    dailyResultCorrect = true;
    updateShareButton();
    if (bubudleMode === 'daily') showDailyStatsSoon();

    document.getElementById('bubudle-check-bottom')!.style.display = 'none';
    document.getElementById('bubudle-skip-bottom')!.style.display = 'none';
    document.getElementById('bubudle-next-bottom')!.style.display = bubudleMode === 'daily' ? 'none' : '';
    if (!player.isPlaying()) playClip(true);
    return;
  }

  // Wrong answer — apply progressive hints
  wrongCount++;

  if (wrongCount === 1) {
    // Hint 1: extend clip range by 1s each side
    clipRange[0] = Math.max(0, clipRange[0] - 1);
    clipRange[1] = clipRange[1] + 1;
    updateLyricMarker();
    revealHint('bubudle-hint-clip', 'Clip', '+1s each side');
    resetSlotForRetry(currentSlot);
  } else if (wrongCount === 2) {
    // Hint 2: narrow down to the song's actual singers (subgroup), then label
    if (songSingers.length < getActivePool().length) {
      setActivePool(songSingers);
      narrowToSingers(currentSlot, songSingers);
    }

    const ans = current.ans;
    const count = ans.length;
    const sorted = [...ans].sort((a, b) => a - b);
    const key = sorted.join(',');

    const SUBUNITS: Record<string, string> = HINT_SUBUNITS[bubudleGroup] ?? {};
    const YEARS: string[] = HINT_YEARS[bubudleGroup] ?? [];

    let narrowLabel = String(count);
    if (SUBUNITS[key]) narrowLabel += ' (Subunit)';
    else if (YEARS.includes(key)) narrowLabel += ' (Year)';

    revealHint('bubudle-hint-narrow', 'Singers', narrowLabel);
    resetSlotForRetry(currentSlot);
  } else if (wrongCount === 3) {
    // Hint 3: reveal song name
    revealHint('bubudle-hint-song', 'Song', current.song.name);
    switchTheme(current.song.id);
    // Also reveal theme if available
    if (current.song.theme) {
      revealHint('bubudle-hint-theme', 'Theme', current.song.theme);
    }
    resetSlotForRetry(currentSlot);
  } else {
    // 4th wrong: give up, reveal answer
    checked = true;
    recordStreak(0);
    // Drop the wrong guess so it isn't persisted back to the song as a
    // filled-in selection — only correct answers write to song progress.
    currentSlot.choices = [];
    toggleReveal(currentSlot, true);

    revealSongName(current.song);
    saveCurrent(current, true);
    persistDailyResult(false);
    dailyResultCorrect = false;
    updateShareButton();
    if (bubudleMode === 'daily') showDailyStatsSoon();

    document.getElementById('bubudle-check-bottom')!.style.display = 'none';
    document.getElementById('bubudle-skip-bottom')!.style.display = 'none';
    document.getElementById('bubudle-next-bottom')!.style.display = bubudleMode === 'daily' ? 'none' : '';
  }

  if (!player.isPlaying()) playClip(true);
}

function skipAnswer(): void {
  if (bubudleMode === 'daily') return;
  if (!current || !currentSlot || checked) return;

  checked = true;
  recordStreak(0);
  // Skipped — don't persist a partial guess back to the song.
  currentSlot.choices = [];
  toggleReveal(currentSlot, true);

  revealSongName(current.song);
  switchTheme(current.song.id);
  saveCurrent(current, true);

  document.getElementById('bubudle-check-bottom')!.style.display = 'none';
  document.getElementById('bubudle-skip-bottom')!.style.display = 'none';
  document.getElementById('bubudle-next-bottom')!.style.display = '';

  if (!player.isPlaying()) playClip(true);
}

function resetSlotForRetry(slot: Slot): void {
  if (!slot.element) return;
  slot.element.classList.remove('slot-wrong', 'slot-correct');
  slot.state = SlotState.Idle;
  slot.choices = [];
  slot.element.querySelectorAll<HTMLElement>('button.active').forEach((btn) => {
    btn.classList.remove('active');
    btn.style.removeProperty('--member-accent');
    btn.style.removeProperty('--member-accent-border');
  });
}

function narrowToSingers(slot: Slot, singers: number[]): void {
  if (!slot.element) return;
  slot.element.querySelectorAll<HTMLElement>('.slot-body button[data-value]').forEach((btn) => {
    const members = btn.dataset.value!.split(',').map(Number);
    const outside = members.some((m) => !singers.includes(m));
    if (outside && !btn.classList.contains('disabled')) {
      disableButton(btn);
    }
  });
}

function disableMembers(slot: Slot, members: number[]): void {
  if (!slot.element) return;
  slot.element.querySelectorAll<HTMLElement>('.slot-body button[data-value]').forEach((btn) => {
    const btnMembers = btn.dataset.value!.split(',').map(Number);
    if (btnMembers.length === 1 && members.includes(btnMembers[0]) && !btn.classList.contains('disabled')) {
      disableButton(btn);
    }
  });
}

function disableButton(btn: HTMLElement): void {
  btn.classList.add('disabled');
  btn.classList.remove('active');
  btn.style.removeProperty('--member-accent');
  btn.style.removeProperty('--member-accent-border');
  const clone = btn.cloneNode(true) as HTMLElement;
  btn.replaceWith(clone);
}

function candidateLine(c: LyricCandidate): Record<string, unknown> {
  const line: Record<string, unknown> = { lyric: c.lyric, ans: c.ans, range: c.range };
  if (c.lyricJp) line.lyric_jp = c.lyricJp;
  if (c.diff > 1) line.diff = c.diff;
  return line;
}

function reportBadTimestamp(): void {
  if (!current) return;
  const line = candidateLine(current);
  appendToLog('BAD TS', `${current.song.id} | ${JSON.stringify(line)}`, {
    song: current.song.name,
    songId: current.song.id,
    line,
  }, current.song.name);
  pickRandom();
}

function flagDifficulty(shouldBe: number): void {
  if (!current) return;
  const updated = candidateLine(current);
  if (shouldBe > 1) updated.diff = shouldBe; else delete updated.diff;
  appendToLog('FLAG DIFF', `${current.song.id} | ${JSON.stringify(updated)}`, {
    song: current.song.name,
    songId: current.song.id,
    currentDiff: current.diff,
    shouldBe,
    updatedLine: updated,
  }, current.song.name);
  document.getElementById('bubudle-diff-options')!.style.display = 'none';
  pickRandom();
}

function flagSinger(): void {
  if (!current) return;
  const picked = Array.from(document.querySelectorAll<HTMLElement>('.bubudle-singer-pick.active'))
    .map((btn) => parseInt(btn.dataset.singer!, 10))
    .sort((a, b) => a - b);
  if (picked.length === 0) return;

  const updated = candidateLine(current);
  updated.ans = picked;
  appendToLog('FLAG SINGER', `${current.song.id} | ${JSON.stringify(updated)}`, {
    song: current.song.name,
    songId: current.song.id,
    currentAns: current.ans,
    shouldBe: picked,
    updatedLine: updated,
  }, current.song.name);

  // Reset singer picks
  document.querySelectorAll<HTMLElement>('.bubudle-singer-pick.active').forEach((b) => b.classList.remove('active'));
  document.getElementById('bubudle-singer-options')!.style.display = 'none';
  pickRandom();
}

function flagSingerUnknown(): void {
  if (!current) return;
  const line = candidateLine(current);
  appendToLog('FLAG SINGER', `${current.song.id} | IDK | ${JSON.stringify(line)}`, {
    song: current.song.name,
    songId: current.song.id,
    currentAns: current.ans,
    shouldBe: 'unknown',
    line,
  }, current.song.name);
  document.querySelectorAll<HTMLElement>('.bubudle-singer-pick.active').forEach((b) => b.classList.remove('active'));
  document.getElementById('bubudle-singer-options')!.style.display = 'none';
  pickRandom();
}

function revealSongName(song: Song): void {
  const el = document.getElementById('bubudle-hint-song')!;
  el.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'hint-label';
  label.textContent = 'Song:';
  const value = document.createElement('span');
  value.className = 'hint-value';
  const a = document.createElement('a');
  a.href = `play.html#${song.id}`;
  a.dataset.songName = song.name;
  if (song.name_jp) a.dataset.songNameJp = song.name_jp;
  a.textContent = getSongTitle(song);
  value.appendChild(a);
  el.appendChild(label);
  el.appendChild(value);
  el.classList.add('revealed');

  if (song.theme) {
    revealHint('bubudle-hint-theme', 'Theme', song.theme);
  }
}

function revealHint(id: string, label: string, value: string): void {
  const el = document.getElementById(id)!;
  el.innerHTML = `<span class="hint-label">${label}:</span> <span class="hint-value">${value}</span>`;
  el.classList.add('revealed');
}

function resetHints(): void {
  for (const id of ['bubudle-hint-clip', 'bubudle-hint-song', 'bubudle-hint-narrow', 'bubudle-hint-theme']) {
    const el = document.getElementById(id);
    if (el) {
      el.innerHTML = '';
      el.classList.remove('revealed');
    }
  }
  const guessEl = document.getElementById('bubudle-guesses');
  if (guessEl) guessEl.innerHTML = '';
}

function renderGuesses(): void {
  const el = document.getElementById('bubudle-guesses');
  if (!el || !current || previousGuesses.length === 0) return;
  const group = current.song.group;
  const names = MEMBER_MAPPING[group] || {};
  el.innerHTML = '<span class="hint-label">Guessed:</span>' +
    previousGuesses.map((g) => {
      const members = parseGuessKey(g);
      const marks = classifyGuess(members, current!.ans, songSingers);
      const chips = members.map((m, i) =>
        `<span class="bubudle-guess-chip guess-${marks[i]}">${names[m] || m}</span>`).join('');
      return `<div class="bubudle-guess">${chips}</div>`;
    }).join('');
}

function initBubudleDifficulty(): void {
  const saved = parseBubudleDiff(getStorage('bubudle-diff'));
  if (saved) bubudleDiff = saved;

  // Sync button state
  document.querySelectorAll<HTMLElement>('.bubudle-diff-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.bdiff === bubudleDiff);
    btn.addEventListener('click', () => {
      bubudleDiff = parseBubudleDiff(btn.dataset.bdiff) ?? bubudleDiff;
      setStorage('bubudle-diff', bubudleDiff);
      recentHistory.clear();
      document.querySelectorAll<HTMLElement>('.bubudle-diff-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.bdiff === bubudleDiff)
      );
      // Restore saved quiz for this level, or pick a new one
      pickRandom(false, true);
    });
  });

  // Hover tooltip on (?)
  const helpEl = document.getElementById('bubudle-diff-help');
  if (helpEl) {
    let tip: HTMLElement | null = null;
    helpEl.addEventListener('mouseenter', () => {
      tip = document.createElement('div');
      tip.className = 'slot-tooltip';
      tip.innerHTML = '<b>All</b> — any clip length<br><b>Normal</b> — longer lyrics (>2s)<br><b>Hard</b> — short lyrics (≤2s)<br><b>Insane</b> — very short lyrics (≤1s)';
      document.body.appendChild(tip);
      const rect = helpEl.getBoundingClientRect();
      tip.style.top = `${rect.bottom + window.scrollY + 4}px`;
      tip.style.left = `${rect.left + window.scrollX + rect.width / 2 - tip.offsetWidth / 2}px`;
    });
    helpEl.addEventListener('mouseleave', () => {
      tip?.remove();
      tip = null;
    });
  }
}

function initSongDifficulty(): void {
  const saved = parseSongDiff(getStorage('bubudle-sdiff'));
  if (saved) songDiff = saved;

  document.querySelectorAll<HTMLElement>('.bubudle-sdiff-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.sdiff === songDiff);
    btn.addEventListener('click', () => {
      songDiff = parseSongDiff(btn.dataset.sdiff) ?? songDiff;
      setStorage('bubudle-sdiff', songDiff);
      recentHistory.clear();
      document.querySelectorAll<HTMLElement>('.bubudle-sdiff-btn').forEach((b) =>
        b.classList.toggle('active', b.dataset.sdiff === songDiff)
      );
      pickRandom(false, true);
    });
  });

  const helpEl = document.getElementById('bubudle-sdiff-help');
  if (helpEl) {
    let tip: HTMLElement | null = null;
    helpEl.addEventListener('mouseenter', () => {
      tip = document.createElement('div');
      tip.className = 'slot-tooltip';
      tip.innerHTML = '<b>All</b> — any difficulty<br><b>Normal</b> — easy lines<br><b>Hard</b> — tricky lines<br><b>Insane</b> — hardest lines';
      document.body.appendChild(tip);
      const rect = helpEl.getBoundingClientRect();
      tip.style.top = `${rect.bottom + window.scrollY + 4}px`;
      tip.style.left = `${rect.left + window.scrollX + rect.width / 2 - tip.offsetWidth / 2}px`;
    });
    helpEl.addEventListener('mouseleave', () => {
      tip?.remove();
      tip = null;
    });
  }

  initSongDifficultyPoolHelp();
}

function initProgressToggle(): void {
  state.recordProgress = getStorage('bubudle-count-progress') !== 'off';

  document.querySelectorAll<HTMLElement>('.bubudle-progress-btn').forEach((btn) => {
    const on = btn.dataset.progress === 'on';
    btn.classList.toggle('active', on === state.recordProgress);
    btn.addEventListener('click', () => {
      state.recordProgress = on;
      setStorage('bubudle-count-progress', on ? 'on' : 'off');
      document.querySelectorAll<HTMLElement>('.bubudle-progress-btn').forEach((b) =>
        b.classList.toggle('active', (b.dataset.progress === 'on') === state.recordProgress)
      );
    });
  });

  const helpEl = document.getElementById('bubudle-progress-help');
  if (helpEl) {
    let tip: HTMLElement | null = null;
    helpEl.addEventListener('mouseenter', () => {
      tip = document.createElement('div');
      tip.className = 'slot-tooltip';
      tip.innerHTML = '<b>On</b> — bubudle answers count toward your Mastery stats and saved progress<br><b>Off</b> — play without affecting your stats';
      document.body.appendChild(tip);
      const rect = helpEl.getBoundingClientRect();
      tip.style.top = `${rect.bottom + window.scrollY + 4}px`;
      tip.style.left = `${rect.left + window.scrollX + rect.width / 2 - tip.offsetWidth / 2}px`;
    });
    helpEl.addEventListener('mouseleave', () => {
      tip?.remove();
      tip = null;
    });
  }
}

function initSongDifficultyPoolHelp(): void {
  const poolHelpEl = document.getElementById('bubudle-pool-help');
  if (poolHelpEl) {
    let tip: HTMLElement | null = null;
    poolHelpEl.addEventListener('mouseenter', () => {
      tip = document.createElement('div');
      tip.className = 'slot-tooltip';
      tip.textContent = 'Number of lyrics matching your current clip and difficulty settings';
      document.body.appendChild(tip);
      const rect = poolHelpEl.getBoundingClientRect();
      tip.style.top = `${rect.bottom + window.scrollY + 4}px`;
      tip.style.left = `${rect.left + window.scrollX + rect.width / 2 - tip.offsetWidth / 2}px`;
    });
    poolHelpEl.addEventListener('mouseleave', () => {
      tip?.remove();
      tip = null;
    });
  }
}

function calcClipRange(range: [number, number]): [number, number] {
  const start = Math.max(0, range[0] - 0.5);
  const end = range[1] + 1;
  return [start, end];
}

function updateLyricMarker(): void {
  const marker = document.getElementById('bubudle-lyric-marker');
  if (!marker || !current) return;
  const clipDur = clipRange[1] - clipRange[0];
  if (clipDur <= 0) return;
  const lyricStart = current.range[0] - clipRange[0];
  const lyricEnd = current.range[1] - clipRange[0];
  const leftPct = Math.max(0, (lyricStart / clipDur) * 100);
  const widthPct = Math.min(100 - leftPct, ((lyricEnd - lyricStart) / clipDur) * 100);
  marker.style.left = `${leftPct}%`;
  marker.style.width = `${widthPct}%`;
}

// This counter is consecutive solves across Infinite and Daily, not the
// day-by-day streak the stats dialog shows, so the label has to say which.
function updateStreak(): void {
  const el = document.getElementById('bubudle-streak')!;
  if (streak > 0) {
    el.textContent = `Solves in a row: ${streak}`;
    el.title = 'Consecutive correct answers across Daily and Infinite. Your daily streak is in Stats.';
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

let seekDragging = false;

function initSeekSlider(): void {
  const slider = document.getElementById('bubudle-seek-slider') as HTMLInputElement | null;
  if (!slider) return;
  slider.addEventListener('mousedown', () => { seekDragging = true; });
  slider.addEventListener('touchstart', () => { seekDragging = true; });
  slider.addEventListener('change', () => {
    seekDragging = false;
    const clipDur = clipRange[1] - clipRange[0];
    if (clipDur > 0) {
      const t = clipRange[0] + (parseInt(slider.value, 10) / 1000) * clipDur;
      player.play(t);
      clipEnd = clipRange[1] + 0.5;
    }
  });
}

function updateSeekSlider(currentTime: number): void {
  if (seekDragging) return;
  const slider = document.getElementById('bubudle-seek-slider') as HTMLInputElement | null;
  const timeEl = document.getElementById('bubudle-time');
  const clipDur = clipRange[1] - clipRange[0];
  const relative = Math.max(0, Math.min(currentTime - clipRange[0], clipDur));
  if (slider && clipDur > 0) {
    slider.value = String(Math.round((relative / clipDur) * 1000));
  }
  if (timeEl) {
    const mins = Math.floor(relative / 60);
    const secs = Math.floor(relative % 60);
    timeEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}

function initVolume(): void {
  const savedVol = getStorage('volume');
  if (savedVol) player.setVolume(parseFloat(savedVol));

  const slider = document.getElementById('bubudle-volume-slider') as HTMLInputElement | null;
  if (slider) {
    slider.value = String(Math.round(player.getVolume() * 100));
    slider.addEventListener('input', () => {
      const vol = parseInt(slider.value, 10) / 100;
      player.setVolume(vol);
      setStorage('volume', String(vol));
    });
  }
}
