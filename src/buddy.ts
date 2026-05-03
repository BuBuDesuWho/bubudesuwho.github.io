import { getFavorite } from './favorite';
import { getStorage, setStorage } from './storage';

// Floating "buddy" portrait of the user's favorited member. Mounts on every
// page (called from main.ts). Currently only Aqours has portraits available
// (from schoolido.lu transparent cards) — other groups are no-ops until we
// have art for them.

const BUDDY_BASE = 'css/images/buddies/';
const SUPPORTED_GROUPS = new Set(['aqours']);
// Aqours uses ids 1–9 with normal/idolized art on disk.
const AQOURS_IDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);

// Idolization (the second card art) unlocks at this much total mastery.
const IDOLIZE_THRESHOLD_PCT = 20;

const NAME_KEY: Record<string, Record<number, string>> = {
  aqours: {
    1: 'Chika', 2: 'You', 3: 'Riko', 4: 'Hanamaru', 5: 'Ruby',
    6: 'Yoshiko', 7: 'Dia', 8: 'Kanan', 9: 'Mari',
  },
};

// Per-session dismiss — persists across page nav within a tab via
// sessionStorage, but clears on a fresh visit so the buddy returns.
const DISMISS_KEY = 'buddy-dismissed';
function isDismissed(): boolean {
  try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
}
function setDismissed(): void {
  try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* private mode */ }
}

// "Idolized?" preference is sticky across visits — the user picks a side and
// stays there until they tap to flip again.
const SIDE_KEY = 'buddy-idolized';
function loadIdolized(): boolean {
  return getStorage(SIDE_KEY) === '1';
}
function saveIdolized(v: boolean): void {
  setStorage(SIDE_KEY, v ? '1' : '0');
}

const SIZE_KEY = 'buddy-size';
type BuddySize = 'small' | 'medium' | 'large' | 'xl';
const SIZE_ORDER: BuddySize[] = ['small', 'medium', 'large', 'xl'];
function loadSize(): BuddySize {
  const v = getStorage(SIZE_KEY) as BuddySize | null;
  return v && SIZE_ORDER.includes(v) ? v : 'medium';
}
function saveSize(s: BuddySize): void { setStorage(SIZE_KEY, s); }
function nextSize(s: BuddySize): BuddySize {
  return SIZE_ORDER[(SIZE_ORDER.indexOf(s) + 1) % SIZE_ORDER.length];
}
function sizeLetter(s: BuddySize): string {
  return s === 'small' ? 'S' : s === 'medium' ? 'M' : s === 'large' ? 'L' : 'XL';
}

const ANIM_KEY = 'buddy-anim';
function animOn(): boolean {
  // default ON; explicitly stored '0' turns it off
  return getStorage(ANIM_KEY) !== '0';
}
function saveAnim(on: boolean): void { setStorage(ANIM_KEY, on ? '1' : '0'); }

// Manual-position state — set when the user long-presses + drags the buddy
// to a custom spot. Sticky across pages/reloads so the placement persists.
//
// Stored as { right, bottom } from the viewport edges so the bottom-right
// corner is the anchor — size changes grow the wrap toward the top-left,
// keeping the control buttons (positioned right:0/26/52/78, bottom:8px)
// visually pinned in place across S/M/L/XL.
//
// Position is bucketed by viewport width so phone / narrow-window / wide
// each remember their own placement. Buckets mirror the CSS breakpoints:
// narrow ≤ 600 < medium ≤ 1199 < wide.
const POS_KEY = 'buddy-pos';
const HOLD_MS = 250;        // long-press threshold to enter drag mode
const MOVE_CANCEL_PX = 8;   // movement before threshold cancels the hold
type BuddyPos = { right: number; bottom: number };
type Bucket = 'narrow' | 'medium' | 'wide';
type PosMap = Partial<Record<Bucket, BuddyPos>>;
function bucket(): Bucket {
  const w = window.innerWidth;
  if (w <= 600) return 'narrow';
  if (w <= 1199) return 'medium';
  return 'wide';
}
function loadPosMap(): PosMap {
  const raw = getStorage(POS_KEY);
  if (!raw) return {};
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      const out: PosMap = {};
      for (const k of ['narrow', 'medium', 'wide'] as const) {
        const v = p[k];
        if (v && typeof v.right === 'number' && typeof v.bottom === 'number') out[k] = v;
      }
      return out;
    }
  } catch { /* corrupt */ }
  return {};
}
function loadPos(): BuddyPos | null {
  return loadPosMap()[bucket()] ?? null;
}
function savePos(p: BuddyPos): void {
  const map = loadPosMap();
  map[bucket()] = p;
  setStorage(POS_KEY, JSON.stringify(map));
}
function clampPos(p: BuddyPos, w: number, h: number): BuddyPos {
  return {
    right:  Math.max(0, Math.min(p.right,  window.innerWidth - w)),
    bottom: Math.max(0, Math.min(p.bottom, window.innerHeight - h)),
  };
}

// Total Mastery for a member, from the cache stats.ts writes during render.
// Falls back to 0 if the user hasn't visited the stats page this session.
function totalMasteryPct(group: string, id: number): number {
  const raw = getStorage('mastery-cache');
  if (!raw) return 0;
  try {
    const arr = JSON.parse(raw) as { group: string; id: number; correct: number; totalLines: number }[];
    const m = arr.find(x => x.group === group && x.id === id);
    if (!m || m.totalLines < 1) return 0;
    return Math.round((m.correct / m.totalLines) * 100);
  } catch { return 0; }
}

export function initBuddy(): void {
  const fav = getFavorite();
  if (!fav) return;
  if (!SUPPORTED_GROUPS.has(fav.group)) return;
  if (fav.group === 'aqours' && !AQOURS_IDS.has(fav.id)) return;
  if (isDismissed()) return;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => mount(fav.group, fav.id));
  } else {
    mount(fav.group, fav.id);
  }
}

function mount(group: string, id: number): void {
  if (document.getElementById('buddy')) return;
  const name = NAME_KEY[group]?.[id] ?? '';
  const masteryPct = totalMasteryPct(group, id);
  const canIdolize = masteryPct >= IDOLIZE_THRESHOLD_PCT;

  const wrap = document.createElement('div');
  wrap.id = 'buddy';
  wrap.className = `buddy size-${loadSize()}`;
  if (!animOn()) wrap.classList.add('anim-off');

  // Inner frame holds the image + carries the bob/flip animations so the
  // buttons (which live on the outer wrap) stay still.
  const frame = document.createElement('div');
  frame.className = 'buddy-frame';

  const img = document.createElement('img');
  img.className = 'buddy-img';
  img.alt = name ? `${name} buddy` : 'Buddy';
  img.draggable = false;

  // Idolization is gated — if locked, force non-idolized regardless of pref.
  let idolized = canIdolize && loadIdolized();
  const setSrc = () => {
    img.src = `${BUDDY_BASE}${group}/${id}-${idolized ? 'idolized' : 'normal'}.png`;
  };
  setSrc();

  // Idolization toggle — small "I" button, locked at < 20% total mastery.
  const idolBtn = document.createElement('button');
  idolBtn.type = 'button';
  idolBtn.className = 'buddy-idol-btn';
  idolBtn.textContent = 'I';
  const refreshIdolBtn = () => {
    if (!canIdolize) {
      idolBtn.classList.add('locked');
      idolBtn.classList.remove('on');
      idolBtn.disabled = true;
      idolBtn.setAttribute('aria-pressed', 'false');
      idolBtn.title = `Idolization unlocks at ${IDOLIZE_THRESHOLD_PCT}% total mastery (currently ${masteryPct}%)`;
      idolBtn.setAttribute('aria-label', 'Idolization locked');
      return;
    }
    idolBtn.classList.toggle('on', idolized);
    idolBtn.setAttribute('aria-pressed', idolized ? 'true' : 'false');
    idolBtn.title = idolized ? 'Idolized — tap to revert' : 'Tap to idolize';
    idolBtn.setAttribute('aria-label', idolized ? 'Revert to non-idolized' : 'Idolize');
  };
  refreshIdolBtn();
  idolBtn.addEventListener('click', () => {
    if (!canIdolize) return;
    // Card-flip: collapse the current image to a vertical line, swap src
    // mid-flight, expand back. Total ~320ms.
    frame.classList.add('flipping');
    setTimeout(() => {
      idolized = !idolized;
      saveIdolized(idolized);
      setSrc();
      refreshIdolBtn();
      frame.classList.remove('flipping');
    }, 160);
  });

  // Animation toggle (A) — currently controls the gentle bob.
  const animBtn = document.createElement('button');
  animBtn.type = 'button';
  animBtn.className = 'buddy-anim-btn';
  animBtn.textContent = 'A';
  const refreshAnimBtn = () => {
    const on = !wrap.classList.contains('anim-off');
    animBtn.classList.toggle('on', on);
    animBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    animBtn.title = on ? 'Animation on (tap to disable)' : 'Animation off (tap to enable)';
    animBtn.setAttribute('aria-label', on ? 'Disable buddy animation' : 'Enable buddy animation');
  };
  refreshAnimBtn();
  animBtn.addEventListener('click', () => {
    const nowOn = wrap.classList.toggle('anim-off');
    saveAnim(!nowOn);
    refreshAnimBtn();
  });

  // Size cycle button — S → M → L → XL → S.
  const sizeBtn = document.createElement('button');
  sizeBtn.type = 'button';
  sizeBtn.className = 'buddy-size-btn';
  sizeBtn.setAttribute('aria-label', 'Cycle buddy size');
  sizeBtn.textContent = sizeLetter(loadSize());
  sizeBtn.title = `Size: ${loadSize()} (tap to cycle)`;
  sizeBtn.addEventListener('click', () => {
    const cur = loadSize();
    const nxt = nextSize(cur);
    saveSize(nxt);
    SIZE_ORDER.forEach(s => wrap.classList.remove(`size-${s}`));
    wrap.classList.add(`size-${nxt}`);
    sizeBtn.textContent = sizeLetter(nxt);
    sizeBtn.title = `Size: ${nxt} (tap to cycle)`;
  });

  // Dismiss × — session-only; reappears on a fresh visit.
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'buddy-close';
  close.setAttribute('aria-label', 'Dismiss buddy');
  close.textContent = '×';
  close.addEventListener('click', () => {
    setDismissed();
    wrap.classList.add('leaving');
    setTimeout(() => wrap.remove(), 240);
  });

  // Long-press to drag. Distinct from a quick tap (which toggles controls):
  //   pointerdown → start hold timer → if held HOLD_MS without moving past
  //   MOVE_CANCEL_PX, enter drag mode and follow the pointer until release.
  // didDrag suppresses the trailing click so dragging doesn't also toggle
  // the controls overlay.
  let holdTimer: number | null = null;
  let dragging = false;
  let didDrag = false;
  let pStartX = 0, pStartY = 0;
  let origRight = 0, origBottom = 0;
  const applyPos = (p: BuddyPos) => {
    const w = wrap.offsetWidth || 168;
    const h = wrap.offsetHeight || 220;
    const c = clampPos(p, w, h);
    wrap.style.right = c.right + 'px';
    wrap.style.bottom = c.bottom + 'px';
    wrap.style.left = 'auto';
    wrap.style.top = 'auto';
  };
  const cancelHold = () => {
    if (holdTimer != null) { clearTimeout(holdTimer); holdTimer = null; }
  };
  img.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    pStartX = e.clientX;
    pStartY = e.clientY;
    const rect = wrap.getBoundingClientRect();
    origRight  = window.innerWidth  - (rect.left + rect.width);
    origBottom = window.innerHeight - (rect.top  + rect.height);
    didDrag = false;
    cancelHold();
    holdTimer = window.setTimeout(() => {
      dragging = true;
      try { img.setPointerCapture(e.pointerId); } catch { /* may already be released */ }
      wrap.classList.add('dragging');
    }, HOLD_MS);
  });
  img.addEventListener('pointermove', (e) => {
    if (!dragging) {
      if (holdTimer != null) {
        const dx = Math.abs(e.clientX - pStartX);
        const dy = Math.abs(e.clientY - pStartY);
        if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) cancelHold();
      }
      return;
    }
    e.preventDefault();
    didDrag = true;
    // Pointer moved (dx, dy) → bottom-right anchor moves the opposite way.
    applyPos({
      right:  origRight  - (e.clientX - pStartX),
      bottom: origBottom - (e.clientY - pStartY),
    });
  });
  const endDrag = (e: PointerEvent) => {
    cancelHold();
    if (!dragging) return;
    if (img.hasPointerCapture(e.pointerId)) img.releasePointerCapture(e.pointerId);
    wrap.classList.remove('dragging');
    if (didDrag) {
      const rect = wrap.getBoundingClientRect();
      savePos({
        right:  window.innerWidth  - (rect.left + rect.width),
        bottom: window.innerHeight - (rect.top  + rect.height),
      });
    }
    dragging = false;
  };
  img.addEventListener('pointerup', endDrag);
  img.addEventListener('pointercancel', endDrag);

  // Touch devices have no hover, so tap the portrait to reveal/hide the
  // control buttons. Tap anywhere else dismisses them.
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    if (didDrag) { didDrag = false; return; }
    wrap.classList.toggle('controls-on');
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target as Node)) wrap.classList.remove('controls-on');
  });

  frame.appendChild(img);
  wrap.append(frame, idolBtn, animBtn, sizeBtn, close);
  document.body.appendChild(wrap);

  // Restore a previously-dragged position, clamped to the current viewport
  // so a phone-rotated or resized window can't strand the buddy off-screen.
  // Crossing a bucket boundary on resize re-reads from the new bucket — if
  // nothing's saved there, clear inline styles so the CSS default applies.
  const clearInline = () => {
    wrap.style.right = '';
    wrap.style.bottom = '';
    wrap.style.left = '';
    wrap.style.top = '';
  };
  const restoreForBucket = () => {
    const cur = loadPos();
    if (cur) applyPos(cur);
    else clearInline();
  };
  const initial = loadPos();
  if (initial) requestAnimationFrame(() => applyPos(initial));
  let lastBucket: Bucket = bucket();
  window.addEventListener('resize', () => {
    const b = bucket();
    if (b !== lastBucket) {
      lastBucket = b;
      restoreForBucket();
    } else {
      const cur = loadPos();
      if (cur) applyPos(cur);  // re-clamp same-bucket position to new viewport
    }
  });
}
