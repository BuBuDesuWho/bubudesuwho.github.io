import {
  Song, Slot, SlotBase, SlotState, LyricToken, GameState, MappingEntry,
  MEMBER_COLORS, MEMBER_COLORS_OFFICIAL, MEMBER_MAPPING,
} from './types';
import { arrayEqual } from './utils';
import { mapToLabel } from './labels';
import {
  getStorage, saveHistory, loadChoicesForSong, saveChoicesForSong,
} from './storage';
import * as player from './player';

const AUTOSAVE_INTERVAL = 2000;

function getGroupColors(group: string): Record<number, string> {
  const useOfficial = document.documentElement.classList.contains('palette-official');
  if (useOfficial && MEMBER_COLORS_OFFICIAL[group]) {
    return MEMBER_COLORS_OFFICIAL[group];
  }
  return MEMBER_COLORS[group] ?? {};
}

/** Recompute inline colors on active slot buttons and revealed subgroup lyrics. */
export function refreshPaletteColors(): void {
  const groupColors = getGroupColors(state.group);

  document.querySelectorAll<HTMLElement>('.slot-body button[data-value].active').forEach((btn) => {
    const btnMembers = btn.dataset.value!.split(',').map(Number);
    const colors = btnMembers.map((m) => groupColors[m]).filter(Boolean);
    if (!colors.length) return;
    btn.style.setProperty('--member-accent', colors.length === 1
      ? colors[0]
      : `linear-gradient(135deg, ${colors.join(', ')})`);
    btn.style.setProperty('--member-accent-border', colors[0] ?? '');
  });

  for (const lyric of state.lyrics) {
    if (!lyric.element || !lyric.element.classList.contains('lyric-gradient')) continue;
    // In JP multi-part mode, the visible gradient reflects the currently-active sub-part, not part 0.
    let ans = lyric.mapping?.ans;
    if (state.jpLyrics && lyric.jpParts && lyric.activeJpPartId != null) {
      const active = lyric.jpParts.find((p) => p.id === lyric.activeJpPartId);
      if (active?.ans) ans = active.ans;
    }
    if (!ans || ans.length < 2) continue;
    const colors = ans.map((a) => groupColors[a]).filter(Boolean);
    if (colors.length < 2) continue;
    lyric.element.style.setProperty('--gradient', `linear-gradient(90deg, ${colors.join(', ')})`);
    lyric.element.style.setProperty('--glow1', colors[0]);
    lyric.element.style.setProperty('--glow2', colors[Math.floor(colors.length / 2)]);
    lyric.element.style.setProperty('--glow3', colors[colors.length - 1]);
  }
}

// ─── State ──────────────────────────────────────────────────────────
export const state: GameState = {
  group: 'aqours',
  song: null,
  mapping: [],
  singers: [],
  slots: [],
  lyrics: [],
  reverseMap: {},
  diff: 1,
  autoscroll: true,
  themed: true,
  lyricsMode: 0,
  calls: false,
  callSFX: false,
  globalReveal: false,
  loaded: null,
  assObjectURL: '',
  lastProgressUpdate: null,
  lastThemeUpdate: null,
  scrollSlotLock: null,
  scrollLyricLock: null,
  sortMode: 'index',
  groupBySubunit: false,
  editMode: false,
  jpLyrics: false,
  callSFXch: 0,
  controls: { lastSlotScroll: 0, lastLyricScroll: 0 },
};

let autosaveTimer: ReturnType<typeof setInterval> | null = null;

// ─── Initialization ─────────────────────────────────────────────────
export function initGameState(): void {
  loadPlaySettings();
  autosaveTimer = setInterval(storeChoices, AUTOSAVE_INTERVAL);
}

export function destroyGameState(): void {
  if (autosaveTimer) clearInterval(autosaveTimer);
}

// ─── Song Loading ───────────────────────────────────────────────────
export function loadSong(song: Song): void {
  if (state.song) storeChoices();

  _monotonicTime = -1;
  state.loaded = new Date();
  state.song = song;
  state.group = song.group;
  state.mapping = song.mapping ?? [];
  state.singers = song.singers;
  state.assObjectURL = '';
  state.slots = makeSlotsFromBase(song.slotsBase);
  state.lyrics = makeLyricsFromBase(song.lyricsBase);
  state.reverseMap = makeReverseMapping(state.slots, state.lyrics);

  // default to lowest available diff
  for (let i = 1; i <= 3; i++) {
    if (getNumSlotsDiff(i) > 0) {
      state.diff = i;
      break;
    }
  }

  // load saved diff, clamped to valid range for this song
  const savedDiff = getStorage('diff');
  if (savedDiff) state.diff = Math.min(parseInt(savedDiff, 10), getMaxDiff());

  // load audio — VITE_SOUND_BASE overrides for external hosting (e.g. GitHub Releases).
  // iOS Safari rejects the GH Releases Content-Type/Disposition, so route iOS through
  // VITE_IOS_AUDIO_BASE (a Cloudflare Worker that rewrites the headers) when present.
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
  const iosBase = import.meta.env.VITE_IOS_AUDIO_BASE;
  const soundBase = isIOS && iosBase ? iosBase : import.meta.env.VITE_SOUND_BASE;
  const base = import.meta.env.BASE_URL;
  const resolveAudio = (path: string) =>
    soundBase ? soundBase + path.replace(/^sound\/(?:kpop\/)?/, '') : base + path;
  // iOS Safari can't decode Opus-in-Ogg — pass the .m4a sibling so Howler
  // falls through to AAC when Ogg isn't playable.
  const m4aPath = song.ogg.replace(/\.ogg$/, '.m4a');
  player.loadSong(resolveAudio(song.ogg), resolveAudio(m4aPath));
}

export function makeSlotsFromBase(bases: SlotBase[]): Slot[] {
  return bases.map((base) => ({
    id: base.id,
    mapping: base.mapping,
    range: base.mapping.range,
    ans: base.mapping.ans ?? [],
    diff: base.mapping.diff ?? 1,
    active: false,
    revealed: false,
    choices: [],
    state: SlotState.Idle,
    element: null,
  }));
}

function makeLyricsFromBase(bases: LyricToken[]): LyricToken[] {
  return bases.map((base) => ({
    ...base,
    active: base.mapping ? false : undefined,
    element: undefined,
  }));
}

export function makeReverseMapping(
  slots: Slot[],
  lyrics: LyricToken[],
): Record<number, { slot?: Slot; lyric?: LyricToken }> {
  const map: Record<number, { slot?: Slot; lyric?: LyricToken }> = {};
  const ensure = (id: number) => { if (!map[id]) map[id] = {}; };

  for (const slot of slots) {
    const m = slot.mapping;
    if ('members' in m && m.members) {
      for (const memberId of m.members) {
        ensure(memberId);
        map[memberId].slot = slot;
      }
    } else {
      ensure(m.id);
      map[m.id].slot = slot;
    }
  }

  for (const lyric of lyrics) {
    if (lyric.mapping) {
      ensure(lyric.mapping.id);
      map[lyric.mapping.id].lyric = lyric;
    }
  }

  return map;
}

// ─── Tick (called every animation frame) ────────────────────────────
// Strictly monotonic time: never allow backward jumps unless a genuine
// user-initiated seek is signalled via `didSeek`. This prevents HTML5
// audio's occasional currentTime=0 glitches from briefly deactivating
// all slots (the root cause of the slot-flash bug).
let _monotonicTime = -1;

export function tick(rawTime: number, didSeek = false): void {
  // Guard against NaN/non-finite values from Howler
  if (!isFinite(rawTime) || rawTime < 0) return;

  if (didSeek) {
    // Genuine seek — accept the new position unconditionally
    _monotonicTime = rawTime;
  } else if (_monotonicTime >= 0 && rawTime < _monotonicTime) {
    // Backward jump without seek — Howler jitter or audio glitch, clamp
    rawTime = _monotonicTime;
  } else {
    _monotonicTime = rawTime;
  }

  highlightSlots(rawTime);
  highlightLyrics(rawTime);
}

function highlightSlots(time: number): void {
  // Batch: collect all changes first, then apply together in one pass
  // to avoid intermediate repaints where old slot is deactivated before new one activates.
  const toActivate: Slot[] = [];
  const toDeactivate: Slot[] = [];
  for (const slot of state.slots) {
    const active = slot.range[0] <= time && time < slot.range[1];
    if (active && !slot.active) toActivate.push(slot);
    else if (!active && slot.active) toDeactivate.push(slot);
  }
  // Activate first, then deactivate — new slot lights up before old one fades
  for (const slot of toActivate) activateSlot(slot);
  for (const slot of toDeactivate) deactivateSlot(slot);
}

function highlightLyrics(time: number): void {
  let playSFX = false;
  for (const lyric of state.lyrics) {
    if (!lyric.element || !lyric.mapping) continue;
    const range = (state.jpLyrics && lyric.rangeJp) ? lyric.rangeJp : lyric.mapping.range;
    const active = range[0] <= time && time < range[1];

    if (active && !lyric.active) {
      lyric.element.classList.add('lyric-active');
      lyric.active = true;

      if (state.autoscroll) {
        if (lyric.src !== 'calls' || (state.lyricsMode === 2 && state.calls)) {
          scrollLyric(lyric);
        }
      }

      if (lyric.src === 'calls' && state.calls && state.callSFX && state.lyricsMode === 2) {
        playSFX = true;
      }

      if (lyric.mapping.kdur != null) {
        lyric.element.classList.add('karaoke');
        lyric.element.style.transition =
          `text-shadow ${lyric.mapping.kdur / 150}s, color ${lyric.mapping.kdur / 100}s`;
      }
    } else if (!active && lyric.active) {
      lyric.element.classList.remove('lyric-active');
      lyric.active = false;
      if (lyric.mapping.kdur != null) {
        lyric.element.style.transition = '';
      }
    }

    // JP multi-part: recolor the visible first-part element as each sub-part plays.
    if (state.jpLyrics && lyric.jpParts && lyric.element) {
      const sub = lyric.jpParts.find((p) => p.range[0] <= time && time < p.range[1])
        ?? lyric.jpParts[0];
      if (sub.id !== lyric.activeJpPartId) {
        lyric.activeJpPartId = sub.id;
        applyRevealClasses(lyric.element, sub);
      }
    }
  }

  if (playSFX) player.playCallSFX();
}

function activateSlot(slot: Slot): void {
  slot.element?.classList.add('slot-active');
  slot.active = true;
  if (state.autoscroll && slot.diff <= state.diff) scrollSlot(slot);
}

function deactivateSlot(slot: Slot): void {
  slot.element?.classList.remove('slot-active');
  slot.active = false;
}

// ─── Scrolling ──────────────────────────────────────────────────────
function scrollSlot(slot: Slot): void {
  if (!slot.element) return;
  const now = performance.now();
  if (state.scrollSlotLock != null && state.scrollSlotLock > now) return;
  if (Date.now() - state.controls.lastSlotScroll <= 1000) return;

  const container = document.getElementById('slots-container');
  if (!container) return;

  const dur = 1000 * Math.min(1, slot.range[1] - slot.range[0]);
  const slotsEl = document.getElementById('slots');
  if (!slotsEl) return;

  const slotPos = slot.element.offsetTop - slotsEl.offsetTop;
  const scrollTop = container.scrollTop;
  const scrollBottom = scrollTop + 0.7 * container.clientHeight;

  if (slotPos < scrollTop) {
    container.scrollTo({ top: slotPos, behavior: 'smooth' });
  } else if (slotPos > scrollBottom) {
    container.scrollTo({
      top: slotPos - (scrollBottom - scrollTop) / 1.4,
      behavior: 'smooth',
    });
  }

  state.scrollSlotLock = now + dur;
}

function scrollLyric(lyric: LyricToken): void {
  if (!lyric.element || !lyric.mapping) return;
  const now = performance.now();
  if (state.scrollLyricLock != null && state.scrollLyricLock > now) return;
  if (Date.now() - state.controls.lastLyricScroll <= 1000) return;

  const container = document.getElementById('lyrics-container');
  if (!container) return;

  const dur = 1000 * Math.min(1, lyric.mapping.range[1] - lyric.mapping.range[0]);
  const lyricsEl = document.getElementById('lyrics');
  if (!lyricsEl) return;

  const lyricPos = lyric.element.offsetTop - lyricsEl.offsetTop;
  const scrollTop = container.scrollTop;
  const scrollBottom = scrollTop + 0.6 * container.clientHeight;

  if (lyricPos < scrollTop) {
    container.scrollTo({ top: lyricPos, behavior: 'smooth' });
  } else if (lyricPos > scrollBottom) {
    container.scrollTo({
      top: lyricPos - (scrollBottom - scrollTop) / 1.2,
      behavior: 'smooth',
    });
  }

  state.scrollLyricLock = now + dur;
}

// ─── Game Actions ───────────────────────────────────────────────────
export function checkSlot(slot: Slot): void {
  if (!slot.element) return;

  if (slot.choices.length === 0) {
    slot.element.classList.remove('slot-correct', 'slot-wrong');
    slot.state = SlotState.Idle;
  } else if (arrayEqual(slot.choices, slot.ans)) {
    slot.element.classList.add('slot-correct');
    slot.element.classList.remove('slot-wrong');
    slot.state = SlotState.Correct;
  } else {
    slot.element.classList.add('slot-wrong');
    slot.element.classList.remove('slot-correct');
    slot.state = SlotState.Wrong;
  }

  revealLyrics();
  updateMeter();
  saveHist();
}

export function checkChoices(): void {
  if (!state.slots.some((s) => s.choices.length > 0)) {
    resetChoices();
    return;
  }

  for (const slot of state.slots) {
    if (slot.diff > state.diff) continue;
    if (!slot.element) continue;

    if (slot.choices.length === 0) {
      slot.element.classList.remove('slot-correct', 'slot-wrong');
      slot.state = SlotState.Idle;
    } else if (arrayEqual(slot.choices, slot.ans)) {
      slot.element.classList.add('slot-correct');
      slot.element.classList.remove('slot-wrong');
      slot.state = SlotState.Correct;
    } else {
      slot.element.classList.add('slot-wrong');
      slot.element.classList.remove('slot-correct');
      slot.state = SlotState.Wrong;
    }
  }

  revealLyrics();
  updateMeter();
  saveHist();
}

export function resetChoices(): void {
  for (const slot of state.slots) {
    slot.element?.classList.remove('slot-wrong', 'slot-correct', 'slot-active');
    slot.active = false;
    slot.revealed = false;
    slot.choices = [];
    slot.state = SlotState.Idle;
    // clear button active states
    slot.element?.querySelectorAll('button.active').forEach((btn) =>
      btn.classList.remove('active'),
    );
  }
  revealLyrics();
  updateMeter();
  storeChoices();
}

export function toggleChoice(button: HTMLElement, slot: Slot): void {
  const memberIds = Object.keys(MEMBER_MAPPING[state.group]).map(Number).sort((a, b) => a - b);
  const active: Record<number, boolean> = {};
  for (const id of memberIds) active[id] = false;
  for (const c of slot.choices) active[c] = true;

  // Collect disabled member IDs so we never activate them
  const slotEl = slot.element!;
  const disabledMembers = new Set<number>();
  slotEl.querySelectorAll<HTMLElement>('.slot-body button.disabled[data-value]').forEach((btn) => {
    const ids = btn.dataset.value!.split(',').map(Number);
    if (ids.length === 1) disabledMembers.add(ids[0]);
  });

  const members = button.dataset.value!.split(',').map(Number);
  const isActive = !button.classList.contains('active');
  for (const m of members) {
    if (!disabledMembers.has(m)) active[m] = isActive;
  }

  // sync all buttons in this slot
  const groupColors = getGroupColors(state.group);
  slotEl.querySelectorAll<HTMLElement>('.slot-body button[data-value]').forEach((btn) => {
    if (btn.classList.contains('disabled')) return;
    const btnMembers = btn.dataset.value!.split(',').map(Number);
    const allActive = btnMembers.every((m) => active[m]);
    btn.classList.toggle('active', allActive);
    if (allActive) {
      const colors = btnMembers.map((m) => groupColors[m]).filter(Boolean);
      btn.style.setProperty('--member-accent', colors.length === 1
        ? colors[0]
        : `linear-gradient(135deg, ${colors.join(', ')})`);
      btn.style.setProperty('--member-accent-border', colors[0] ?? '');
    } else {
      btn.style.removeProperty('--member-accent');
      btn.style.removeProperty('--member-accent-border');
    }
  });

  slot.choices = [];
  for (const id of memberIds) {
    if (active[id]) slot.choices.push(id);
  }
}

export function toggleReveal(slot: Slot, val?: boolean): void {
  slot.revealed = val ?? !slot.revealed;
  if (!slot.element) return;

  const revealBtn = slot.element.querySelector<HTMLElement>('.reveal-button');
  const revealOffBtn = slot.element.querySelector<HTMLElement>('.reveal-off-button');

  if (slot.revealed) {
    revealBtn?.style.setProperty('display', 'none');
    revealOffBtn?.style.setProperty('display', '');
    const ans = slot.ans.map(String);
    slot.element.querySelectorAll<HTMLElement>('.slot-body button').forEach((btn) => {
      const members = btn.dataset.value!.split(',');
      if (members.every((m) => ans.includes(m))) {
        btn.classList.add('revealed');
      }
    });
  } else {
    revealBtn?.style.setProperty('display', '');
    revealOffBtn?.style.setProperty('display', 'none');
    slot.element.querySelectorAll('.revealed').forEach((btn) =>
      btn.classList.remove('revealed'),
    );
  }
  revealLyrics();
}

export function toggleGlobalReveal(val?: boolean): void {
  state.globalReveal = val ?? !state.globalReveal;
  for (const slot of state.slots) toggleReveal(slot, state.globalReveal);
}

// ─── Difficulty ─────────────────────────────────────────────────────
export function toggleDiff(val?: number): void {
  if (val != null) {
    state.diff = val;
  } else {
    const maxDiff = getMaxDiff();
    if (state.diff === maxDiff) {
      for (let i = 1; i <= 3; i++) {
        if (getNumSlotsDiff(i) > 0) { state.diff = i; break; }
      }
    } else {
      state.diff++;
      while (state.diff <= maxDiff && getNumSlotsDiff(state.diff) === getNumSlotsDiff(state.diff - 1)) {
        state.diff++;
      }
      if (state.diff > maxDiff) state.diff = maxDiff;
    }
  }

  // Animate only the slots that are changing state, like jQuery did:
  //   data('diff') == state.diff  → slideDown (newly revealed)
  //   data('diff') > state.diff   → slideUp (newly hidden)
  // Already-visible and already-hidden slots are left alone.

  // Phase 1: batch all DOM reads
  const toShow: { el: HTMLElement; targetH: number }[] = [];
  const toHide: { el: HTMLElement; currentH: number }[] = [];

  for (const slot of state.slots) {
    const el = slot.element;
    if (!el) continue;
    const isHidden = el.style.display === 'none' || el.dataset.slidingUp === '1';
    const shouldShow = slot.diff <= state.diff;

    if (shouldShow && isHidden) {
      // Briefly un-hide to measure natural height
      el.style.display = '';
      el.style.height = 'auto';
      toShow.push({ el, targetH: el.offsetHeight });
    } else if (!shouldShow && !isHidden) {
      toHide.push({ el, currentH: el.offsetHeight });
    }
  }

  // Phase 2: start all animations (no more reads after this)
  for (const { el, targetH } of toShow) {
    slideDown(el, targetH, 500);
  }
  for (const { el, currentH } of toHide) {
    slideUp(el, currentH, 500);
  }

  updateMeter();
}

export function getNumSlotsDiff(diff: number): number {
  return state.slots.filter((s) => s.diff <= diff).length;
}

function getMaxDiff(): number {
  let max = 1;
  for (const m of state.mapping) max = Math.max(max, m.diff ?? 1);
  return max;
}

export function getDiffLabel(): string {
  if (state.diff === 1) return 'Normal';
  if (state.diff === 2) return 'Hard';
  return 'Insane';
}

// ─── Settings Toggles ───────────────────────────────────────────────
export function toggleAutoscroll(val?: boolean): void {
  state.autoscroll = val ?? !state.autoscroll;
  if (state.autoscroll) {
    // Clear scroll locks so the jump happens immediately
    state.scrollSlotLock = null;
    state.scrollLyricLock = null;
    state.controls.lastSlotScroll = 0;
    state.controls.lastLyricScroll = 0;
    const activeSlot = state.slots.find((s) => s.active && s.diff <= state.diff);
    if (activeSlot) scrollSlot(activeSlot);
    const activeLyric = state.lyrics.find((l) => l.active && l.element);
    if (activeLyric) scrollLyric(activeLyric);
  }
}

export function toggleThemed(val?: boolean): void {
  state.themed = val ?? !state.themed;
}

export function cycleLyricsMode(): number {
  state.lyricsMode = (state.lyricsMode + 1) % 3;
  if (state.lyricsMode === 1 && window.innerWidth <= 1000) {
    state.lyricsMode = 2;
  }
  return state.lyricsMode;
}

export function setLyricsMode(mode: number): void {
  state.lyricsMode = mode;
}

export function toggleCalls(val?: boolean): void {
  state.calls = val ?? !state.calls;
}

export function toggleCallSFX(val?: boolean): void {
  state.callSFX = val ?? !state.callSFX;
}

export function hasJpLyrics(): boolean {
  return state.lyrics.some((l) => l.textJp != null && l.textJp !== '');
}

export function toggleJpLyrics(val?: boolean): void {
  state.jpLyrics = val ?? !state.jpLyrics;
  for (const lyric of state.lyrics) {
    if (!lyric.element || lyric.type !== 'lyric') continue;
    if (state.jpLyrics && lyric.textJp != null) {
      if (lyric.textJp === '') {
        lyric.element.style.display = 'none';
      } else {
        lyric.element.textContent = lyric.textJp;
      }
    } else {
      lyric.element.textContent = lyric.text ?? '';
      lyric.element.style.display = '';
    }
    // Reset per-sub-part tracking; revealLyrics below re-applies correct classes.
    lyric.activeJpPartId = undefined;
  }
  revealLyrics();
}

// ─── Lyrics Reveal ──────────────────────────────────────────────────

/** Clear any reveal coloring (ansN / ans-all / solo / gradient) from a lyric element. */
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

/** Apply reveal coloring for the given mapping, or clear it if not yet revealed. */
function applyRevealClasses(element: HTMLElement, mapping: MappingEntry): void {
  clearRevealClasses(element);
  if (!mapping.ans) { element.removeAttribute('title'); return; }
  const ans = mapping.ans;

  const songSingers = state.song?.singers ?? [];
  const isSolo = ans.length === 1;
  const isAllMembers = ans.length > 1 && arrayEqual(songSingers, ans);
  const isSubGroup = ans.length > 1 && !isAllMembers;

  const slot = state.reverseMap[mapping.id]?.slot;
  const revealed =
    isAllMembers ||
    arrayEqual(state.singers, ans) ||
    (slot && (slot.revealed || slot.state === SlotState.Correct));

  if (!revealed) { element.removeAttribute('title'); return; }

  if (isSolo) {
    element.classList.add(...ans.map((a) => 'ans' + a));
    // Generic data-driven solo glow — used when no hardcoded .group-X.ansN rule
    // matches (e.g. SEVENTEEN). Existing hardcoded rules win on specificity.
    const soloColor = getGroupColors(state.group)[ans[0]];
    if (soloColor) {
      element.classList.add('lyric-solo');
      element.style.setProperty('--solo-color', soloColor);
    }
  } else if (isAllMembers) {
    element.classList.add('ans-all');
  } else if (isSubGroup) {
    const groupColors = getGroupColors(state.group);
    const colors = ans.map((a) => groupColors[a]).filter(Boolean);
    if (colors.length >= 2) {
      element.classList.add('lyric-gradient');
      element.style.setProperty('--gradient', `linear-gradient(90deg, ${colors.join(', ')})`);
      element.style.setProperty('--glow1', colors[0]);
      element.style.setProperty('--glow2', colors[Math.floor(colors.length / 2)]);
      element.style.setProperty('--glow3', colors[colors.length - 1]);
    }
  }
  element.title = mapToLabel(state.group, ans);
}

export function revealLyrics(): void {
  for (const lyric of state.lyrics) {
    if (!lyric.element || !lyric.mapping || !lyric.mapping.ans) continue;
    // In JP mode, multi-part lines are re-colored per sub-part by highlightLyrics,
    // so pick whichever sub-part is currently tracked to keep classes consistent.
    let mapping = lyric.mapping;
    if (state.jpLyrics && lyric.jpParts) {
      const active = lyric.jpParts.find((p) => p.id === lyric.activeJpPartId);
      if (active) mapping = active;
    }
    applyRevealClasses(lyric.element, mapping);
  }
}

// ─── Meter ──────────────────────────────────────────────────────────
export function updateMeter(): void {
  const meterEl = document.querySelector<HTMLElement>('.meter');
  if (!meterEl) return;
  const correct = getNumCorrectSlots();
  const total = getNumSlotsDiff(state.diff);
  meterEl.textContent = `${correct} / ${total}`;
  meterEl.classList.toggle('all-correct', correct === total);
}

function getNumCorrectSlots(): number {
  return state.slots.filter(
    (s) => s.diff <= state.diff && s.state === SlotState.Correct,
  ).length;
}

// ─── Persistence ────────────────────────────────────────────────────
function loadPlaySettings(): void {
  const vol = getStorage('volume');
  if (vol) player.setVolume(parseFloat(vol));

  const auto = getStorage('autoscroll');
  state.autoscroll = auto ? auto === 'true' : true;

  const themed = getStorage('themed');
  state.themed = themed ? themed === 'true' : true;

  const lyrics = getStorage('lyrics');
  state.lyricsMode = lyrics ? parseInt(lyrics, 10) : 0;

  const calls = getStorage('calls');
  state.calls = calls === 'true';

  const callSFX = getStorage('callSFX');
  state.callSFX = callSFX === 'true';

  const jpLyrics = getStorage('jpLyrics');
  state.jpLyrics = jpLyrics === 'true';
}

export function restoreChoices(): void {
  if (!state.song) return;
  const choices = loadChoicesForSong(state.song.id);
  if (Object.keys(choices).length === 0) return;

  for (const slot of state.slots) {
    const key = hashSlot(slot);
    const saved = choices[key];
    if (!saved || !slot.element) continue;

    for (const choice of saved) {
      if (!state.singers.includes(choice)) continue;
      const btn = slot.element.querySelector<HTMLElement>(
        `[data-value="${choice}"]`,
      );
      if (btn) toggleChoice(btn, slot);
    }
  }
}

function storeChoices(): void {
  if (!state.song || state.editMode) return;
  const mapped: Record<string, number[]> = {};
  for (const slot of state.slots) {
    mapped[hashSlot(slot)] = slot.choices;
  }
  saveChoicesForSong(state.song.id, mapped);
}

function hashSlot(slot: Slot): string {
  return `${slot.range[0]}/${slot.range[1]}`;
}

function saveHist(): void {
  if (!state.song) return;
  const record: [number[], number[]][] = [];
  for (const slot of state.slots) {
    if (slot.diff > state.diff) continue;
    record.push([slot.choices, slot.ans]);
  }
  saveHistory({
    date: new Date().toLocaleDateString(),
    songName: state.song.name,
    slots: record,
  });
}

// ─── Slide Animations (Web Animations API) ─────────────────────────
// Mimics jQuery 1.12's slideDown/slideUp: animates height, padding,
// and margin so the entire box model collapses/expands smoothly.

function slideDown(el: HTMLElement, targetH: number, duration: number): void {
  // Cancel any running slide animation on this element
  el.getAnimations().forEach((a) => a.cancel());

  const cs = getComputedStyle(el);
  const pt = cs.paddingTop;
  const pb = cs.paddingBottom;
  const mt = cs.marginTop;
  const mb = cs.marginBottom;

  // Clear measurement inline styles
  el.style.height = '';
  el.style.overflow = 'hidden';

  const anim = el.animate([
    { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 },
    { height: `${targetH}px`, paddingTop: pt, paddingBottom: pb, marginTop: mt, marginBottom: mb, opacity: 1 },
  ], { duration, easing: 'ease' });

  anim.onfinish = () => {
    el.style.overflow = '';
  };
}

function slideUp(el: HTMLElement, currentH: number, duration: number): void {
  el.getAnimations().forEach((a) => a.cancel());
  el.dataset.slidingUp = '1';

  const cs = getComputedStyle(el);
  const pt = cs.paddingTop;
  const pb = cs.paddingBottom;
  const mt = cs.marginTop;
  const mb = cs.marginBottom;

  el.style.overflow = 'hidden';
  const anim = el.animate([
    { height: `${currentH}px`, paddingTop: pt, paddingBottom: pb, marginTop: mt, marginBottom: mb, opacity: 1 },
    { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 },
  ], { duration, easing: 'ease' });

  anim.onfinish = () => {
    el.style.display = 'none';
    el.style.overflow = '';
    el.style.height = '';
    delete el.dataset.slidingUp;
  };

  anim.oncancel = () => {
    delete el.dataset.slidingUp;
  };
}

