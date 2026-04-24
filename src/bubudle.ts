import { Song, Slot, SlotState, LineObject, MappingEntry, GroupName, MEMBER_MAPPING } from './types';
import { loadConfig } from './config';
import { state, initGameState, loadSong, checkSlot, toggleChoice, toggleReveal } from './game';
import { initThemeToggle, switchTheme, buildSlotSkeleton } from './ui';
import { buildMenu, toggleMenu } from './ui-menu';
import * as player from './player';
import { getStorage, setStorage } from './storage';
import {
  MEMBER_NICKNAMES,
  SHORTCUT_GROUPS,
  MEMBER_COLUMNS,
  HINT_SUBUNITS,
  HINT_YEARS,
} from './bubudle-config';
import { appendToLog, renderLog, hasLogEntries } from './bubudle-log';

interface LyricCandidate {
  lyric: string;
  lyricJp?: string;
  ans: number[];
  range: [number, number];
  song: Song;
  diff: number;
  sourceLine: LineObject;
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

  const baseIdSet = new Set(Object.keys(MEMBER_MAPPING[bubudleGroup]).map(Number));
  const extraMembers = singers.filter(s => !baseIdSet.has(s));
  const memberMapping = MEMBER_MAPPING[state.group] ?? MEMBER_MAPPING[bubudleGroup];

  const predefined = MEMBER_COLUMNS[bubudleGroup];
  const cols: number[][] = predefined
    ? predefined.map(col => col.filter(id => singers.includes(id)))
    : (() => {
        const base = singers.filter(s => baseIdSet.has(s));
        const n = Math.ceil(base.length / 3);
        return [base.slice(0, n), base.slice(n, n * 2), base.slice(n * 2)];
      })();

  // Applicable shortcuts — only include if all members present in singer set
  const hasExtras = extraMembers.length > 0;
  const shortcuts = (SHORTCUT_GROUPS[bubudleGroup] ?? []).filter(g =>
    g.members.every(m => singerSet.has(m)) && (!g.extraOnly || hasExtras));
  const shortcutsLeft = shortcuts.filter(g => g.subunit);
  const shortcutsRight = shortcuts.filter(g => !g.subunit);

  // If there are extra members but no subunit shortcuts, put extras in the left shortcut col
  // and year/group shortcuts in the right
  const hasSubunits = shortcutsLeft.length > 0;

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
  const memberCols = cols.map(ids => {
    const buttons = ids.map(id => {
      const name = memberMapping[id] ?? `#${id}`;
      const nick = (MEMBER_NICKNAMES[bubudleGroup] ?? {})[id];
      const label = nick ? `${name} (${nick})` : name;
      return makeBtn(String(id), label);
    });
    return buttons;
  });

  // Extra member buttons
  const extraBtns = extraMembers.map(id => {
    const name = memberMapping[id] ?? `#${id}`;
    const nick = (MEMBER_NICKNAMES[bubudleGroup] ?? {})[id];
    const label = nick ? `${name} (${nick})` : name;
    return makeBtn(String(id), label);
  });

  // Shortcut buttons
  const leftShortcutBtns = (hasSubunits ? shortcutsLeft : shortcuts.filter(g => g.members.some(m => m > 9)))
    .map(g => makeBtn(g.members.join(','), g.label));
  const rightShortcutBtns = (hasSubunits ? shortcutsRight : shortcuts.filter(g => g.members.every(m => m <= 9)))
    .map(g => makeBtn(g.members.join(','), g.label));

  // Add extra member buttons to whichever shortcut column has room
  if (extraBtns.length > 0) {
    if (!hasSubunits) {
      leftShortcutBtns.unshift(...extraBtns);
    } else {
      leftShortcutBtns.push(...extraBtns);
    }
  }

  // Build layout: col1 | shortcutsLeft | col2 | shortcutsRight | col3
  // Using same Bootstrap grid as the templates
  row.appendChild(makeCol('col-xs-4 col-sm-offset-1 col-sm-2 btn-group-vertical', memberCols[0]));
  if (leftShortcutBtns.length > 0) {
    row.appendChild(makeCol('hidden-xs col-sm-push-4 col-sm-2 btn-group-vertical', leftShortcutBtns));
  }
  row.appendChild(makeCol('col-xs-4 col-sm-pull-2 col-sm-2 btn-group-vertical', memberCols[1]));
  if (rightShortcutBtns.length > 0) {
    row.appendChild(makeCol('hidden-xs col-sm-push-2 col-sm-2 btn-group-vertical', rightShortcutBtns));
  }
  row.appendChild(makeCol('col-xs-4 col-sm-pull-4 col-sm-2 btn-group-vertical', memberCols[2]));

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
let candidates: LyricCandidate[] = [];
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

type BubudleDifficulty = 'all' | 'normal' | 'hard' | 'insane';
let bubudleDiff: BubudleDifficulty = 'normal';

// Lyric range duration thresholds per difficulty (seconds)
// All: any length, Normal: clips > 2s, Hard: clips <= 2s, Insane: clips <= 1s
const RANGE_CAPS: Record<BubudleDifficulty, number> = {
  all: Infinity,
  normal: 2,
  hard: 2,
  insane: 1,
};

type SongDifficulty = 'all' | '1' | '2' | '3';
let songDiff: SongDifficulty = 'all';

let subunitInclude: string[] = [];
let subunitExclude: string[] = [];

export async function initBubudlePage(): Promise<void> {
  player.initPlayer({
    onTick(currentTime, _duration, _didSeek) {
      if (clipEnd !== null && currentTime >= clipEnd) {
        clipEnd = null;
        player.pause();
      }
      updateSeekSlider(currentTime);
    },
  });

  initGameState();
  initBubudleDifficulty();
  initSongDifficulty();
  loadSubunitFilter();
  const songs = await loadConfig();
  if (songs.length === 0) return;

  // Build sidebar menu (links go to play.html#song)
  buildMenu(songs);
  bubudleGroup = state.group;
  applyGroupClass(bubudleGroup);
  toggleMenu(window.innerWidth >= 1200);
  initThemeToggle();
  initVolume();
  initSeekSlider();

  buildCandidatePool(songs);
  rebuildSingerPicker();
  rebuildSubunitFilter();

  // Switch bubudle group when sidebar group button is clicked
  document.querySelectorAll<HTMLElement>('.group-button').forEach((btn) => {
    btn.addEventListener('click', () => {
      bubudleGroup = btn.dataset.value as GroupName;
      applyGroupClass(bubudleGroup);
      loadSubunitFilter();
      buildCandidatePool(songs);
      rebuildSingerPicker();
      rebuildSubunitFilter();
      recentHistory.clear();
      pickRandom(false, true);
    });
  });

  streak = parseInt(getStorage('bubudle-streak') ?? '0', 10) || 0;
  updateStreak();

  // Bind controls
  document.getElementById('bubudle-check-bottom')!.addEventListener('click', checkAnswer);
  document.getElementById('bubudle-skip-bottom')!.addEventListener('click', skipAnswer);
  document.getElementById('bubudle-next-bottom')!.addEventListener('click', () => pickRandom());
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
      else pickRandom();
    } else if (e.key === 'c') {
      if (!checked) checkAnswer();
      else pickRandom();
    } else if (e.key === ' ') {
      e.preventDefault();
      playClip();
    }
  });

  pickRandom(true);

  if (hasLogEntries()) renderLog();
}

function applyGroupClass(group: GroupName): void {
  const html = document.documentElement;
  html.classList.remove('group-muse', 'group-aqours', 'group-wug', 'group-nijigasaki');
  html.classList.add(`group-${group}`);
}

function arrEq(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function buildCandidatePool(songs: Song[]): void {
  candidates = [];
  for (const song of songs) {
    if (!song.lines || song.hidden) continue;
    if ((song.menu ?? song.group) !== bubudleGroup) continue;

    const allSingers = new Set<number>();
    for (const line of song.lines) {
      if (typeof line === 'string') continue;
      const obj = line as LineObject;
      if (obj.parts) {
        for (const p of obj.parts) {
          if (p.ans) for (const a of p.ans) if (a > 0) allSingers.add(a);
        }
      } else if (obj.ans) {
        for (const a of obj.ans) if (a > 0) allSingers.add(a);
      }
    }
    const singerArr = Array.from(allSingers).sort((a, b) => a - b);

    for (const line of song.lines) {
      if (typeof line === 'string') continue;
      const obj = line as LineObject;
      const lineDiff = obj.diff ?? 1;

      if (obj.parts) {
        for (const part of obj.parts) {
          if (part.ans && part.ans.length > 0 && part.lyric.trim() && part.range) {
            const sorted = [...part.ans].filter(a => a > 0).sort((a, b) => a - b);
            if (sorted.length === 0) continue;
            if (arrEq(sorted, singerArr)) continue;
            candidates.push({ lyric: part.lyric, lyricJp: obj.lyric_jp, ans: sorted, range: part.range, song, diff: lineDiff, sourceLine: obj, allSingers: singerArr });
          }
        }
      } else if (obj.ans && obj.ans.length > 0 && obj.lyric?.trim() && obj.range) {
        const sorted = [...obj.ans].filter(a => a > 0).sort((a, b) => a - b);
        if (sorted.length === 0) continue;
        if (arrEq(sorted, singerArr)) continue;
        candidates.push({ lyric: obj.lyric, lyricJp: obj.lyric_jp, ans: sorted, range: obj.range, song, diff: lineDiff, sourceLine: obj, allSingers: singerArr });
      }
    }
  }
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

function restoreCurrent(): { candidate: LyricCandidate; answered: boolean } | null {
  const raw = getStorage(currentStorageKey());
  if (!raw) return null;
  try {
    const { songId, lyric, range, answered } = JSON.parse(raw);
    const candidate = candidates.find(c =>
      c.song.id === songId && c.lyric === lyric &&
      c.range[0] === range[0] && c.range[1] === range[1]
    );
    if (!candidate) return null;
    return { candidate, answered: !!answered };
  } catch { return null; }
}

function candidateKey(c: LyricCandidate): string {
  return `${c.song.id}|${c.range[0]}|${c.range[1]}`;
}

function eligibleCandidates(): LyricCandidate[] {
  const cap = RANGE_CAPS[bubudleDiff];
  const diffFilter = songDiff === 'all' ? 0 : parseInt(songDiff, 10);
  const includeSet = subunitInclude.length > 0 ? new Set(subunitInclude) : null;
  const excludeSet = subunitExclude.length > 0 ? new Set(subunitExclude) : null;
  return candidates.filter(c => {
    const dur = c.range[1] - c.range[0];
    const clipOk = bubudleDiff === 'all' ? true : bubudleDiff === 'normal' ? dur > cap : dur <= cap;
    if (!clipOk) return false;
    if (diffFilter !== 0 && c.diff !== diffFilter) return false;
    const key = c.allSingers.join(',');
    if (includeSet && !includeSet.has(key)) return false;
    if (excludeSet && excludeSet.has(key)) return false;
    return true;
  });
}

function pickFromPool(pool: LyricCandidate[]): LyricCandidate {
  let available = pool.filter(c => !recentHistory.has(candidateKey(c)));
  if (available.length === 0) {
    recentHistory.clear();
    available = pool;
  }
  const pick = available[Math.floor(Math.random() * available.length)];
  recentHistory.add(candidateKey(pick));
  return pick;
}

function updatePoolCount(): void {
  const el = document.getElementById('bubudle-pool-count');
  if (el) el.textContent = `${eligibleCandidates().length}`;
}

function pickRandom(initial = false, tryRestore = false): void {
  let restoredAnswered = false;
  const pool = eligibleCandidates();
  updatePoolCount();
  if (pool.length === 0) {
    const container = document.getElementById('slots')!;
    container.innerHTML = '<div class="text-center" style="padding:2em;opacity:0.6">No lyrics available for this group yet</div>';
    document.getElementById('bubudle-lyric')!.textContent = '';
    document.getElementById('bubudle-lyric-jp')!.textContent = '';
    resetHints();
    return;
  }
  if (initial || tryRestore) {
    const restored = restoreCurrent();
    if (restored) {
      current = restored.candidate;
      restoredAnswered = restored.answered;
    } else {
      current = pickFromPool(pool);
    }
  } else {
    current = pickFromPool(pool);
  }
  saveCurrent(current, restoredAnswered);
  checked = false;
  wrongCount = 0;
  previousGuesses = [];
  clipRange = calcClipRange(current.range);
  updateLyricMarker();

  // Load audio first — loadSong sets state.group/singers from the song config,
  // so we override those after with values derived from the actual lyrics.
  const song = current.song;
  loadSong(song);

  songSingers = current.allSingers;
  const baseIds = Object.keys(MEMBER_MAPPING[bubudleGroup]).map(Number).sort((a, b) => a - b);
  const extras = current.allSingers.filter(s => !baseIds.includes(s));
  state.singers = [...baseIds, ...extras];
  state.group = current.song.group;
  state.editMode = false;
  state.lyrics = [];
  state.reverseMap = {};

  // Create a fake mapping entry for this lyric line
  const diff = current.diff;
  const mapping: MappingEntry = {
    range: current.range,
    ans: current.ans,
    diff,
    id: 0,
  };

  currentSlot = {
    id: 0,
    mapping,
    range: current.range,
    ans: current.ans,
    diff,
    active: false,
    revealed: false,
    choices: [],
    state: SlotState.Idle,
    element: null,
  };

  state.slots = [currentSlot];
  state.mapping = [mapping];

  // Build slot dynamically based on actual singers
  const container = document.getElementById('slots')!;
  container.innerHTML = '';
  const el = createBubudleSlot(currentSlot, state.singers);
  currentSlot.element = el;
  container.appendChild(el);

  // Update lyric card
  document.getElementById('bubudle-lyric')!.textContent = current.lyric;
  const jpEl = document.getElementById('bubudle-lyric-jp')!;
  if (current.lyricJp) {
    jpEl.textContent = current.lyricJp;
    jpEl.style.display = '';
  } else {
    jpEl.textContent = '';
    jpEl.style.display = 'none';
  }

  // Reset all hint lines
  resetHints();

  // Auto-narrow singers when either difficulty is normal
  if (!restoredAnswered && (bubudleDiff === 'normal' || songDiff === '1')) {
    if (songSingers.length < state.singers.length) {
      state.singers = songSingers;
      narrowToSingers(currentSlot, songSingers);
      revealHint('bubudle-hint-narrow', 'Singers', 'Narrowed to subunit');
    } else {
      // Full group — remove 3 random incorrect members
      const incorrect = state.singers.filter(s => !current!.ans.includes(s));
      const shuffled = incorrect.sort(() => Math.random() - 0.5);
      const toRemove = shuffled.slice(0, Math.min(2, shuffled.length));
      disableMembers(currentSlot, toRemove);
      revealHint('bubudle-hint-narrow', 'Singers', `Removed ${toRemove.length} wrong`);
    }
  }

  // Update difficulty badges
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

  // Reset theme and title
  switchTheme(null);
  document.getElementById('song-title')!.textContent = 'Bubudle';

  if (restoredAnswered) {
    // Already answered — show resolved state
    checked = true;
    revealSongName(current.song);
    switchTheme(current.song.id);
    toggleReveal(currentSlot!, true);
    document.getElementById('bubudle-check-bottom')!.style.display = 'none';
    document.getElementById('bubudle-skip-bottom')!.style.display = 'none';
    document.getElementById('bubudle-next-bottom')!.style.display = '';
  } else {
    // Show check + skip, hide next
    document.getElementById('bubudle-check-bottom')!.style.display = '';
    document.getElementById('bubudle-skip-bottom')!.style.display = '';
    document.getElementById('bubudle-next-bottom')!.style.display = 'none';
  }

  if (!initial) playClip(true);
}

function playClip(forcePlay = false): void {
  if (!current) return;

  if (!forcePlay && player.isPlaying()) {
    player.pause();
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
    streak++;
    setStorage('bubudle-streak', String(streak));
    updateStreak();

    revealSongName(current.song);
    switchTheme(current.song.id);
    saveCurrent(current, true);

    document.getElementById('bubudle-check-bottom')!.style.display = 'none';
    document.getElementById('bubudle-skip-bottom')!.style.display = 'none';
    document.getElementById('bubudle-next-bottom')!.style.display = '';
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
    // Hint 2: reveal song name
    revealHint('bubudle-hint-song', 'Song', current.song.name);
    switchTheme(current.song.id);
    // Also reveal theme if available
    if (current.song.theme) {
      revealHint('bubudle-hint-theme', 'Theme', current.song.theme);
    }
    resetSlotForRetry(currentSlot);
  } else if (wrongCount === 3) {
    // Hint 3: narrow down to the song's actual singers (subgroup), then label
    if (songSingers.length < state.singers.length) {
      state.singers = songSingers;
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
  } else {
    // 4th wrong: give up, reveal answer
    checked = true;
    streak = 0;
    setStorage('bubudle-streak', String(streak));
    updateStreak();
    toggleReveal(currentSlot, true);

    revealSongName(current.song);
    saveCurrent(current, true);

    document.getElementById('bubudle-check-bottom')!.style.display = 'none';
    document.getElementById('bubudle-skip-bottom')!.style.display = 'none';
    document.getElementById('bubudle-next-bottom')!.style.display = '';
  }

  if (!player.isPlaying()) playClip(true);
}

function skipAnswer(): void {
  if (!current || !currentSlot || checked) return;

  checked = true;
  streak = 0;
  setStorage('bubudle-streak', String(streak));
  updateStreak();
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
  a.textContent = song.name;
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
    previousGuesses.map(g => {
      const label = g.split(',').map(n => names[parseInt(n, 10)] || n).join(', ');
      return `<div class="bubudle-guess">${label}</div>`;
    }).join('');
}

function initBubudleDifficulty(): void {
  const saved = getStorage('bubudle-diff') as BubudleDifficulty | null;
  if (saved && saved in RANGE_CAPS) bubudleDiff = saved;

  // Sync button state
  document.querySelectorAll<HTMLElement>('.bubudle-diff-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.bdiff === bubudleDiff);
    btn.addEventListener('click', () => {
      bubudleDiff = btn.dataset.bdiff as BubudleDifficulty;
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
  const saved = getStorage('bubudle-sdiff') as SongDifficulty | null;
  if (saved && ['all', '1', '2', '3'].includes(saved)) songDiff = saved;

  document.querySelectorAll<HTMLElement>('.bubudle-sdiff-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.sdiff === songDiff);
    btn.addEventListener('click', () => {
      songDiff = btn.dataset.sdiff as SongDifficulty;
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

function updateStreak(): void {
  const el = document.getElementById('bubudle-streak')!;
  if (streak > 0) {
    el.textContent = `Streak: ${streak}`;
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
