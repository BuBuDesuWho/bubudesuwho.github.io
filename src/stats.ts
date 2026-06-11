import { loadIndex } from './config';
import { buildMenu } from './ui-menu';
import { initThemeToggle } from './ui-about';
import { loadHistory, HistRecord, saveMasteryCache, exportProfileDoc, importProfileDoc } from './storage';
import { getGroup } from './groups';
import { getGroupColor } from './labels';
import { MenuSong, GroupName } from './types';
import { getFavorite, setFavorite, clearFavorite } from './favorite';
import { resetBuddy } from './buddy';

// Catalog-wide stats baked at deploy time by scripts/build-index.js.
//   byMember: per-(group, member) slot-ans appearances → Total Mastery dials.
//   slotCountByGroup: per-group slot count over non-hidden songs → ribbon
//     "Lines completed". Per-group (not a scalar) so future per-group views
//     can use it; the ribbon just sums it.
type CatalogByMember = Record<GroupName, Record<string, number>>;
type CatalogSlotsByGroup = Partial<Record<GroupName, number>>;
interface CatalogTotals { slotCountByGroup: CatalogSlotsByGroup; byMember: CatalogByMember }
async function loadCatalogTotals(): Promise<CatalogTotals> {
  const base = (import.meta.env.VITE_CONTENT_BASE || import.meta.env.BASE_URL) as string;
  const mode = import.meta.env.VITE_APP_MODE === 'kpop' ? 'kpop' : 'anime';
  const empty: CatalogTotals = { slotCountByGroup: {}, byMember: {} };
  try {
    const resp = await fetch(`${base}songs/totals.${mode}.json`);
    if (!resp.ok) return empty;
    const json = await resp.json() as CatalogTotals;
    return { slotCountByGroup: json.slotCountByGroup ?? {}, byMember: json.byMember ?? {} };
  } catch { return empty; }
}

const MEMBER_DIAL_MIN_TOTAL = 3;
const UNTRIED_SAMPLE = 6;
const PORTRAIT_BASE = 'css/images/members/';
// WUG is an easter-egg group with sparse coverage — excluded from catalog-
// wide totals (Total Mastery dials and the ribbon's "Lines completed") so it
// neither pads the dial strip with low-data members nor inflates the ribbon
// denominator with lines most users will never reach.
const TOTALS_EXCLUDED_GROUPS = new Set<string>(['wug']);

interface MemberStat {
  group: GroupName;
  groupName: string;
  id: number;
  name: string;
  color: string;
  correctAttempted: number; // numerator: lines you attempted AND got right
  attempted: number;        // denominator for Member Mastery (skips un-attempted lines)
  totalLines: number;       // denominator for Total Mastery (every line they sang)
}

interface PlayAggregate {
  entry: HistRecord;
  song?: MenuSong;
  group?: GroupName;
  // Slots actually filled in (chosen.length > 0)
  attempted: number;
  // Of those, how many matched ans exactly
  correctAttempted: number;
  // Total slots in the song (filled or empty)
  totalSlots: number;
  // True only when every slot in the song was correct — partial-but-right
  // does NOT earn a star, since the user could still have lines left.
  allCorrect: boolean;
}

export async function initStatsPage(): Promise<void> {
  const [songs, catalogTotals] = await Promise.all([loadIndex(), loadCatalogTotals()]);
  buildMenu(songs);
  initThemeToggle();

  const hist = loadHistory();
  const songsByName = new Map(songs.map(s => [s.name, s]));
  const plays = hist.map(buildPlay(songsByName));

  wireProfileIO();

  if (plays.length === 0) {
    renderEmpty(songs);
    return;
  }

  document.getElementById('stats-empty')?.classList.add('hidden');
  document.getElementById('stats-body')?.classList.remove('hidden');

  renderRibbon(plays, catalogTotals);
  renderMastery(plays, catalogTotals);
  renderSetlist(plays);
  renderUntried(songs, plays);
  wireResetBuddy();
}

function wireProfileIO(): void {
  const exportBtn = document.getElementById('stats-export') as HTMLButtonElement | null;
  const importBtn = document.getElementById('stats-import') as HTMLButtonElement | null;
  const fileInput = document.getElementById('stats-import-file') as HTMLInputElement | null;
  if (!exportBtn || !importBtn || !fileInput) return;

  exportBtn.addEventListener('click', () => {
    const mode = import.meta.env.VITE_APP_MODE === 'kpop' ? 'kpop' : 'anime';
    const doc = exportProfileDoc(mode);
    if (doc.keyCount === 0) {
      alert('Nothing to export yet — play a song or change a setting first.');
      return;
    }
    const blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = doc.exportedAt.slice(0, 10);
    a.download = `bubudesuwho-${mode}-profile-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  importBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const doc = JSON.parse(text);
      const result = importProfileDoc(doc);

      const parts: string[] = [];
      if (result.histAdded > 0) parts.push(`${result.histAdded} new plays`);
      if (result.prefsReplaced > 0) parts.push(`${result.prefsReplaced} setting${result.prefsReplaced === 1 ? '' : 's'}`);
      const histTail = result.histSkipped > 0 ? ` (${result.histSkipped} duplicate plays skipped)` : '';

      if (parts.length === 0) {
        alert(`No changes — profile already matches what's on this device.${histTail}`);
        return;
      }
      const summary = `Imported ${parts.join(' + ')}${histTail}. Reload to apply?`;
      if (confirm(summary)) location.reload();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error.';
      alert(`Import failed: ${reason}`);
    } finally {
      fileInput.value = '';
    }
  });
}

function wireResetBuddy(): void {
  const row = document.getElementById('reset-buddy-row');
  const btn = document.getElementById('reset-buddy');
  if (!row || !btn) return;
  if (!getFavorite()) return;  // nothing to reset until they pick a buddy
  row.classList.remove('hidden');
  btn.addEventListener('click', () => resetBuddy());
}

// ─── Aggregation ────────────────────────────────────────────────────

// Some groups extend an existing roster (aqours-miku adds Miku to Aqours;
// saint-aqours-snow adds Saint Snow's two members to Aqours). Members shared
// between an extension and its base ARE the same person — collapse them under
// the base group so Member Mastery shows one Riko, not three.
const PARENT_GROUP: Record<GroupName, GroupName> = {
  'aqours-miku': 'aqours',
  'saint-aqours-snow': 'aqours',
};

function canonicalMember(group: GroupName, id: number): { group: GroupName; id: number } {
  const parent = PARENT_GROUP[group];
  if (!parent) return { group, id };
  const p = getGroup(parent);
  if (p && p.members.some(m => m.id === id)) {
    return canonicalMember(parent, id);
  }
  return { group, id };
}

function buildPlay(songsByName: Map<string, MenuSong>) {
  return (entry: HistRecord): PlayAggregate => {
    const song = songsByName.get(entry.songName);
    let correctAttempted = 0;
    let attempted = 0;
    const totalSlots = entry.slots.length;
    for (const [chosen, ans] of entry.slots) {
      if (chosen.length === 0) continue;
      attempted++;
      if (chosen.length === ans.length && chosen.every((v, j) => v === ans[j])) correctAttempted++;
    }
    return {
      entry,
      song,
      group: song?.group,
      attempted,
      correctAttempted,
      totalSlots,
      // Star only when every slot in the song was correct — partial-but-right
      // doesn't earn it, since unanswered lines are still "not done."
      allCorrect: totalSlots > 0 && correctAttempted === totalSlots,
    };
  };
}

function aggregateMembers(plays: PlayAggregate[], catalogTotals: CatalogTotals): MemberStat[] {
  const stats = new Map<string, MemberStat>();

  // Numerator + Member-Mastery denominator: drawn from play history.
  // `correctAttempted` is deduped per (songId, slotIdx) so replaying the same
  // song doesn't double-count a member's correct line — Total Mastery is a
  // coverage metric, not an attempt-count. `attempted` is left non-deduped
  // because it's only feeding the cached buddy idolization gate, which
  // doesn't care about replays.
  const correctSlotKeys = new Map<string, Set<string>>();
  for (const p of plays) {
    if (!p.group) continue;
    if (!getGroup(p.group)) continue;
    const songId = p.song?.id;
    p.entry.slots.forEach(([chosen, ans], slotIdx) => {
      const attempted = chosen.length > 0;
      const chosenSet = new Set(chosen);
      for (const id of ans) {
        const canon = canonicalMember(p.group!, id);
        const canonGroup = getGroup(canon.group);
        if (!canonGroup) continue;
        const key = `${canon.group}:${canon.id}`;
        let s = stats.get(key);
        if (!s) {
          const m = canonGroup.members.find(mm => mm.id === canon.id)
                 ?? canonGroup.supplementaryMembers?.find(mm => mm.id === canon.id);
          if (!m) continue;
          s = { group: canon.group, groupName: canonGroup.name, id: canon.id, name: m.name, color: m.color, correctAttempted: 0, attempted: 0, totalLines: 0 };
          stats.set(key, s);
        }
        if (attempted) {
          s.attempted += 1;
          // chosen ids are in the song's group id-space; canonicalization
          // preserves the id where applicable, so direct membership still works.
          if (chosenSet.has(id) && songId) {
            let bag = correctSlotKeys.get(key);
            if (!bag) { bag = new Set(); correctSlotKeys.set(key, bag); }
            bag.add(`${songId}:${slotIdx}`);
          }
        }
      }
    });
  }
  for (const [key, bag] of correctSlotKeys) {
    const s = stats.get(key);
    if (s) s.correctAttempted = bag.size;
  }

  // Total-Mastery denominator: catalog-wide slot count, canonicalized so
  // extension groups (aqours-miku, saint-aqours-snow) fold into the parent's
  // member entry. Members the user has never tried (no history) still get
  // populated here so Total Mastery can show full-roster coverage gates.
  for (const [groupSlug, members] of Object.entries(catalogTotals.byMember)) {
    if (TOTALS_EXCLUDED_GROUPS.has(groupSlug)) continue;
    const group = getGroup(groupSlug);
    if (!group) continue;
    for (const [idStr, count] of Object.entries(members)) {
      const id = Number(idStr);
      if (!Number.isFinite(id)) continue;
      const canon = canonicalMember(groupSlug, id);
      const canonGroup = getGroup(canon.group);
      if (!canonGroup) continue;
      const m = canonGroup.members.find(mm => mm.id === canon.id)
             ?? canonGroup.supplementaryMembers?.find(mm => mm.id === canon.id);
      if (!m) continue;
      const key = `${canon.group}:${canon.id}`;
      let s = stats.get(key);
      if (!s) {
        s = { group: canon.group, groupName: canonGroup.name, id: canon.id, name: m.name, color: m.color, correctAttempted: 0, attempted: 0, totalLines: 0 };
        stats.set(key, s);
      }
      s.totalLines += count;
    }
  }

  // Snapshot's pre-wipe `correct` is a raw incident count (replays included)
  // with no per-slot keys, so we can't dedupe it after the fact. Cap the
  // combined numerator at the catalog denominator so Total Mastery stays
  // bounded at 100%.
  for (const s of stats.values()) {
    if (s.totalLines > 0 && s.correctAttempted > s.totalLines) {
      s.correctAttempted = s.totalLines;
    }
  }

  return Array.from(stats.values());
}

type MasteryMode = 'attempted' | 'total';

function sortedForMode(stats: MemberStat[], mode: MasteryMode): MemberStat[] {
  return stats
    .filter(s => denomFor(s, mode) >= MEMBER_DIAL_MIN_TOTAL)
    .sort((a, b) => {
      const aPct = a.correctAttempted / Math.max(1, denomFor(a, mode));
      const bPct = b.correctAttempted / Math.max(1, denomFor(b, mode));
      if (aPct !== bPct) return bPct - aPct;       // best-first
      return denomFor(b, mode) - denomFor(a, mode); // tiebreak: more data first
    });
}

function denomFor(s: MemberStat, mode: MasteryMode): number {
  return mode === 'attempted' ? s.attempted : s.totalLines;
}

function aggregateCompletion(plays: PlayAggregate[], catalogTotals: CatalogTotals): number {
  // Ribbon "Lines completed" — coverage across the whole catalog.
  // Numerator: distinct (songId, slotIdx) pairs you got correct in any play
  // (replays don't help; hidden songs excluded so we stay bounded ≤ 100%).
  // Denominator: catalog slotCount baked at build time over non-hidden songs.
  const correctSlots = new Set<string>();
  for (const p of plays) {
    if (!p.song || p.song.hidden) continue;
    if (p.song.group && TOTALS_EXCLUDED_GROUPS.has(p.song.group)) continue;
    const songId = p.song.id;
    p.entry.slots.forEach(([chosen, ans], slotIdx) => {
      if (chosen.length === 0) return;
      if (chosen.length !== ans.length) return;
      for (let j = 0; j < chosen.length; j++) if (chosen[j] !== ans[j]) return;
      correctSlots.add(`${songId}:${slotIdx}`);
    });
  }
  let total = 0;
  for (const [g, n] of Object.entries(catalogTotals.slotCountByGroup)) {
    if (TOTALS_EXCLUDED_GROUPS.has(g)) continue;
    total += n ?? 0;
  }
  if (total === 0) return 0;
  return Math.min(100, Math.round((correctSlots.size / total) * 100));
}

// ─── Rendering ──────────────────────────────────────────────────────

function renderRibbon(plays: PlayAggregate[], catalogTotals: CatalogTotals): void {
  const playsCell = document.getElementById('stat-plays');
  const accCell = document.getElementById('stat-accuracy');
  if (playsCell) playsCell.textContent = plays.length >= 10000 ? '10k+' : String(plays.length);
  if (accCell) accCell.textContent = `${aggregateCompletion(plays, catalogTotals)}%`;
}

function renderMastery(plays: PlayAggregate[], catalogTotals: CatalogTotals): void {
  const all = aggregateMembers(plays, catalogTotals);
  // Snapshot for the buddy on other pages — gates idolization at 20%.
  saveMasteryCache(all.map(s => ({
    group: s.group, id: s.id,
    correct: s.correctAttempted, attempted: s.attempted, totalLines: s.totalLines,
  })));
  renderMasteryInto('total-mastery', 'total-mastery-section', sortedForMode(all, 'total'), 'total');
}

function renderMasteryInto(containerId: string, sectionId: string, stats: MemberStat[], mode: MasteryMode): void {
  const container = document.getElementById(containerId);
  const section = document.getElementById(sectionId);
  if (!container || !section) return;
  if (stats.length === 0) {
    section.classList.add('hidden');
    return;
  }
  for (const s of stats) {
    container.appendChild(buildDial(s, mode));
  }
}

function buildDial(s: MemberStat, mode: MasteryMode): HTMLElement {
  const denom = denomFor(s, mode);
  const num = s.correctAttempted;
  // Clamp: catalog drift (slots removed since a play) or snapshot-seeded
  // attempted with no matching catalog entry can push num past denom.
  const pct = Math.min(100, Math.round((num / denom) * 100));
  const tile = document.createElement('div');
  tile.className = 'member-dial';
  tile.style.setProperty('--c', s.color);
  tile.dataset.group = s.group;
  tile.dataset.id = String(s.id);
  const fav = getFavorite();
  if (fav && fav.group === s.group && fav.id === s.id) tile.classList.add('is-favorite');
  tile.setAttribute('aria-label', `${s.name} (${s.groupName}) — ${pct}% (${num} of ${denom})`);
  tile.title = `${s.name} · ${s.groupName}\n${pct}% · ${num}/${denom}`;

  // Heart button only on the Total Mastery strip, and only once the user has
  // reached ≥10% total mastery for that member. Below the gate, the dial is
  // shown but un-favoritable.
  const FAV_THRESHOLD_PCT = 10;
  if (mode === 'total' && pct >= FAV_THRESHOLD_PCT) {
    const favBtn = document.createElement('button');
    favBtn.type = 'button';
    favBtn.className = 'member-fav';
    favBtn.setAttribute('aria-label', `Set ${s.name} as favorite`);
    favBtn.setAttribute('aria-pressed', tile.classList.contains('is-favorite') ? 'true' : 'false');
    favBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.5-9.1C1 8.4 3.4 5 6.8 5c2 0 3.5 1.1 5.2 3 1.7-1.9 3.2-3 5.2-3 3.4 0 5.8 3.4 4.3 6.9C19.5 16.4 12 21 12 21z"/></svg>';
    favBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      toggleFavorite(s.group, s.id);
    });
    tile.appendChild(favBtn);
  }

  // SVG arc — full circle track + filled arc starting at 12 o'clock.
  const r = 46;
  const circ = 2 * Math.PI * r;
  const fillLen = (pct / 100) * circ;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'member-arc');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('class', 'arc-track');
  track.setAttribute('cx', '50'); track.setAttribute('cy', '50'); track.setAttribute('r', String(r));
  const fill = document.createElementNS(svgNS, 'circle');
  fill.setAttribute('class', 'arc-fill');
  fill.setAttribute('cx', '50'); fill.setAttribute('cy', '50'); fill.setAttribute('r', String(r));
  fill.setAttribute('stroke-dasharray', `${fillLen} ${circ - fillLen}`);
  svg.append(track, fill);

  const portrait = document.createElement('div');
  portrait.className = 'member-portrait';
  const initial = document.createElement('span');
  initial.className = 'member-initial';
  initial.textContent = s.name.charAt(0);
  portrait.appendChild(initial);
  // Try to load a portrait image; if missing, the initial fallback stays.
  // Note: in Vite dev the SPA fallback returns index.html (200 OK) for missing
  // assets, so onerror never fires — naturalWidth stays 0 and we detect that
  // in onload. Remote hosts (GH Pages / Vercel) return real 404s → onerror.
  loadPortrait(portrait, s.group, s.id);

  const name = document.createElement('div');
  name.className = 'member-name';
  name.textContent = s.name;

  const pctEl = document.createElement('div');
  pctEl.className = 'member-pct';
  pctEl.textContent = `${pct}%`;

  tile.append(svg, portrait, name, pctEl);
  return tile;
}

function toggleFavorite(group: GroupName, id: number): void {
  const current = getFavorite();
  const isCurrent = !!current && current.group === group && current.id === id;
  if (isCurrent) clearFavorite();
  else setFavorite(group, id);
  // Re-sync every dial across both strips so only the active favorite is lit.
  const dials = document.querySelectorAll<HTMLElement>('.member-dial');
  dials.forEach(d => {
    const g = d.dataset.group;
    const i = Number(d.dataset.id);
    const active = !isCurrent && g === group && i === id;
    d.classList.toggle('is-favorite', active);
    const btn = d.querySelector<HTMLButtonElement>('.member-fav');
    if (btn) btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}

function loadPortrait(parent: HTMLElement, group: GroupName, id: number): void {
  const exts = ['webp', 'png'];
  let i = 0;
  const tryNext = () => {
    if (i >= exts.length) return; // give up; the initial fallback remains
    const probe = new Image();
    probe.onload = () => {
      if (probe.naturalWidth === 0) { i++; tryNext(); return; }
      const live = document.createElement('img');
      live.alt = '';
      live.loading = 'lazy';
      live.src = probe.src;
      parent.appendChild(live);
    };
    probe.onerror = () => { i++; tryNext(); };
    probe.src = `${PORTRAIT_BASE}${group}/${id}.${exts[i]}`;
  };
  tryNext();
}

function renderSetlist(plays: PlayAggregate[]): void {
  const list = document.getElementById('setlist');
  const filterRow = document.getElementById('setlist-filters');
  if (!list || !filterRow) return;

  // Filter chips — built only from groups actually present in history.
  const groupsPresent: { slug: GroupName; name: string }[] = [];
  const seen = new Set<GroupName>();
  for (const p of plays) {
    if (!p.group || seen.has(p.group)) continue;
    seen.add(p.group);
    const g = getGroup(p.group);
    if (g) groupsPresent.push({ slug: p.group, name: g.name });
  }

  if (groupsPresent.length > 1) {
    filterRow.appendChild(buildChip('all', 'All', null, true));
    for (const g of groupsPresent) {
      filterRow.appendChild(buildChip(g.slug, g.name, getGroupColor(g.slug), false));
    }
    filterRow.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button.chip');
      if (!btn) return;
      filterRow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const sel = btn.dataset.group ?? 'all';
      for (const row of list.querySelectorAll<HTMLElement>('.setlist-row')) {
        row.classList.toggle('filtered-out', sel !== 'all' && row.dataset.group !== sel);
      }
    });
  } else {
    filterRow.classList.add('hidden');
  }

  // Rows — one per song, most recent attempt wins. Walk newest→oldest and
  // skip any song already rendered.
  const seenSongs = new Set<string>();
  for (let i = plays.length - 1; i >= 0; i--) {
    const p = plays[i];
    const key = p.song?.id ?? p.entry.songName;
    if (seenSongs.has(key)) continue;
    seenSongs.add(key);
    list.appendChild(buildSetlistRow(p));
  }
}

function buildChip(slug: string, label: string, color: string | null, active: boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  if (color) b.classList.add(color);
  if (active) b.classList.add('active');
  b.dataset.group = slug;
  b.textContent = label;
  return b;
}

function buildSetlistRow(p: PlayAggregate): HTMLElement {
  const li = document.createElement('li');
  li.className = 'setlist-row';
  if (p.group) li.dataset.group = p.group;
  const groupColor = p.group ? getGroupColor(p.group) : null;

  const date = document.createElement('span');
  date.className = 'setlist-date';
  date.textContent = p.entry.date;

  const songEl = document.createElement(p.song ? 'a' : 'span');
  songEl.className = 'setlist-song';
  songEl.textContent = p.entry.songName;
  if (p.song) {
    (songEl as HTMLAnchorElement).href = `play.html#${p.song.id}`;
    if (groupColor) songEl.classList.add(groupColor);
  }

  const meter = buildDotMeter(p.correctAttempted, p.totalSlots);

  const score = document.createElement('span');
  score.className = 'setlist-score';
  score.textContent = `${p.correctAttempted}/${p.totalSlots}`;
  if (p.allCorrect) score.classList.add('all-correct');

  li.append(date, songEl);
  if (p.group) {
    const tag = document.createElement('span');
    tag.className = 'setlist-tag';
    if (groupColor) tag.classList.add(groupColor);
    tag.textContent = getGroup(p.group)?.name ?? '';
    li.appendChild(tag);
  }
  if (p.allCorrect) {
    const star = document.createElement('span');
    star.className = 'setlist-star';
    star.textContent = '★';
    star.setAttribute('aria-label', 'all correct');
    score.appendChild(star);
  }
  li.append(meter, score);
  return li;
}

function buildDotMeter(correct: number, total: number): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'setlist-meter';
  wrap.setAttribute('aria-hidden', 'true');
  const MAX_DOTS = 8;
  if (total === 0) return wrap;
  if (total <= MAX_DOTS) {
    for (let i = 0; i < total; i++) {
      const d = document.createElement('span');
      d.className = 'dot' + (i < correct ? ' filled' : '');
      wrap.appendChild(d);
    }
  } else {
    // Compress to MAX_DOTS proportionally — preserves the visual "almost full" cue
    // without making 24-slot songs blow out the row.
    const filled = Math.round((correct / total) * MAX_DOTS);
    for (let i = 0; i < MAX_DOTS; i++) {
      const d = document.createElement('span');
      d.className = 'dot' + (i < filled ? ' filled' : '');
      wrap.appendChild(d);
    }
  }
  return wrap;
}

function renderUntried(songs: MenuSong[], plays: PlayAggregate[]): void {
  const list = document.getElementById('untried-list');
  const section = document.getElementById('untried-section');
  if (!list || !section) return;

  const triedIds = new Set<string>();
  for (const p of plays) if (p.song) triedIds.add(p.song.id);
  const candidates = songs.filter(s => !s.hidden && !triedIds.has(s.id));
  if (candidates.length === 0) {
    section.classList.add('hidden');
    return;
  }
  // Reservoir-style random pick (Fisher–Yates partial shuffle).
  const picked: MenuSong[] = [];
  const pool = candidates.slice();
  const n = Math.min(UNTRIED_SAMPLE, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    picked.push(pool[i]);
  }
  for (const s of picked) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'untried-song';
    const color = getGroupColor(s.group);
    if (color) a.classList.add(color);
    a.href = `play.html#${s.id}`;
    a.textContent = s.name;
    li.appendChild(a);
    list.appendChild(li);
  }
}

function renderEmpty(songs: MenuSong[]): void {
  document.getElementById('stats-empty')?.classList.remove('hidden');
  document.getElementById('stats-body')?.classList.add('hidden');
  const link = document.getElementById('stats-empty-link') as HTMLAnchorElement | null;
  if (!link) return;
  const visible = songs.filter(s => !s.hidden);
  if (visible.length === 0) return;
  const pick = visible[Math.floor(Math.random() * visible.length)];
  link.href = `play.html#${pick.id}`;
}
