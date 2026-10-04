import { MenuSong, GroupName, SortMode } from './types';
import { state, getSongTitle } from './game-state';
import { getAllGroups, getGroup, hasGroup, menuSectionLabel, menuSectionRank } from './groups';
import { setStorage, getStorage, hasLocalStorage, loadHistory } from './storage';
import {
  rankSongs, buildProgress, songStatus, matchesFilter, recentSongIds, pickRandom, hasAnyPick,
  type MenuFilter, type SearchFields, type SongProgress, type SongStatus,
} from './menu-discovery';
import '../css/menu-discovery.css';

// Menu-wide state. buildMenu runs once per page, so these are filled there
// and read by every render.
let allSongs: MenuSong[] = [];
let progress = new Map<string, SongProgress>();
let startedIds = new Set<string>();
let favorites = new Set<string>();
let menuFilter: MenuFilter = 'all';
let kbIndex = -1;
const fieldCache = new Map<string, SearchFields>();

const SEARCH_LIMIT = 80;
const FAV_KEY = 'fav-songs';
const FILTER_KEY = 'menu-filter';
const FILTERS: { value: MenuFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unplayed', label: 'Unplayed' },
  { value: 'progress', label: 'In progress' },
  { value: 'mastered', label: 'Mastered' },
  { value: 'favorites', label: '★' },
];
const EMPTY_FILTER_TEXT: Record<MenuFilter, string> = {
  all: '',
  unplayed: 'You have played every song here. Nice!',
  progress: 'Nothing in progress for this group.',
  mastered: 'No perfect runs yet. Get every line right to master a song.',
  favorites: 'Tap the star next to a song to favorite it.',
};

function statusOf(id: string): SongStatus {
  return songStatus(progress.get(id), startedIds.has(id));
}

function loadDiscoveryState(songs: MenuSong[]): void {
  allSongs = songs;
  try {
    progress = buildProgress(loadHistory(), songs);
  } catch {
    // A corrupt hist blob shouldn't take the whole menu down with it.
    progress = new Map();
  }
  // Mid-song picks live under "<songId>-selections"; any non-empty one means
  // the player has started that song even if they never finished a run.
  startedIds = new Set();
  if (hasLocalStorage()) {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.endsWith('-selections')) continue;
      if (hasAnyPick(localStorage.getItem(key))) startedIds.add(key.slice(0, -'-selections'.length));
    }
  }
  try {
    const raw = JSON.parse(getStorage(FAV_KEY) ?? '[]');
    favorites = new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []);
  } catch {
    favorites = new Set();
  }
  const savedFilter = getStorage(FILTER_KEY) as MenuFilter | null;
  if (savedFilter && FILTERS.some((f) => f.value === savedFilter)) menuFilter = savedFilter;
}

function saveFavorites(): void {
  setStorage(FAV_KEY, JSON.stringify([...favorites]));
}

/**
 * Build-mode visibility filter. The registry only holds groups from the
 * current mode's groups.json (e.g. kpop mode registers just Seventeen,
 * not the Love-Live groups). Any `.group-button` whose slug isn't in the
 * registry belongs to the other mode and should be hidden.
 */
function groupVisibleInMode(slug: string): boolean {
  return hasGroup(slug);
}

export function attachInstantTip(el: HTMLElement, text: string): void {
  let tip: HTMLElement | null = null;
  el.addEventListener('mouseenter', () => {
    tip = document.createElement('div');
    tip.className = 'slot-tooltip';
    tip.textContent = text;
    document.body.appendChild(tip);
    const rect = el.getBoundingClientRect();
    tip.style.top = `${rect.bottom + window.scrollY + 4}px`;
    tip.style.left = `${rect.left + window.scrollX + rect.width / 2 - tip.offsetWidth / 2}px`;
  });
  el.addEventListener('mouseleave', () => {
    tip?.remove();
    tip = null;
  });
}

export function buildMenu(songs: MenuSong[]): void {
  loadDiscoveryState(songs);
  const savedGroup = getStorage('group') as GroupName | null;
  if (savedGroup) state.group = savedGroup;

  // If the current state.group (from default or localStorage) belongs to the
  // other mode, snap to the first registered group so the menu renders.
  if (!hasGroup(state.group)) {
    const first = getAllGroups()[0];
    if (first) state.group = first.slug;
  }

  const savedSort = getStorage('sort') as SortMode | null;
  if (savedSort && ['index', 'date', 'alpha'].includes(savedSort)) state.sortMode = savedSort;
  // migrate legacy 'group' sort mode (was a sort+grouping combo)
  if ((getStorage('sort') as string) === 'group') {
    state.sortMode = 'date';
    state.groupBy = IS_KPOP ? { subunit: false, album: true } : { subunit: true, album: false };
  }
  // migrate legacy `groupBySubunit` boolean → groupBy flags. The legacy
  // flag meant "the natural grouping for this mode" — subunit on anime,
  // album on kpop.
  const legacyGroup = getStorage('groupBySubunit');
  if (legacyGroup === 'true') {
    state.groupBy = IS_KPOP ? { subunit: false, album: true } : { subunit: true, album: false };
  } else if (legacyGroup === 'false') {
    state.groupBy = { subunit: false, album: false };
  }
  // Newer storage: comma-separated flag list ('', 'subunit', 'album',
  // 'subunit,album'). Parse permissively.
  const savedGroupBy = getStorage('groupBy');
  if (savedGroupBy != null) {
    const flags = savedGroupBy.split(',').map((s) => s.trim());
    state.groupBy = {
      subunit: flags.includes('subunit'),
      album: flags.includes('album'),
    };
  }

  buildDiscoveryPanel();
  switchGroup(state.group);
  updateSortButton();
  updateGroupToggle();

  toggleMenu(window.innerWidth >= 1200);

  document.getElementById('menu-button')?.addEventListener('click', () => toggleMenu());
  setupMobileMenuButton();
  setupMobileCheckButton();

  document.querySelectorAll<HTMLElement>('.group-button').forEach((btn) => {
    const slug = btn.dataset.value as GroupName | undefined;
    if (slug && !groupVisibleInMode(slug)) {
      btn.style.display = 'none';
    }
    btn.addEventListener('click', () => {
      switchGroup(slug as GroupName);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.sort as SortMode;
      state.sortMode = mode === state.sortMode ? 'index' : mode;
      setStorage('sort', state.sortMode);
      updateSortButton();
      switchGroup(state.group);
    });
  });

  // Both toggles flip their flag independently — when both are on, songs
  // bucket by subunit first then album. (Subunit hidden for kpop.)
  const persistGroupBy = () => {
    const flags: string[] = [];
    if (state.groupBy.subunit) flags.push('subunit');
    if (state.groupBy.album) flags.push('album');
    setStorage('groupBy', flags.join(','));
  };
  document.getElementById('group-toggle')?.addEventListener('click', () => {
    state.groupBy.subunit = !state.groupBy.subunit;
    persistGroupBy();
    updateGroupToggle();
    switchGroup(state.group);
  });
  document.getElementById('album-toggle')?.addEventListener('click', () => {
    state.groupBy.album = !state.groupBy.album;
    persistGroupBy();
    updateGroupToggle();
    switchGroup(state.group);
  });

  setupSearch();
}

function setupSearch(): void {
  const input = document.getElementById('menu-search') as HTMLInputElement | null;
  if (!input) return;
  input.placeholder = 'Search songs  ( / )';
  input.setAttribute('aria-label', 'Search songs');
  input.addEventListener('input', () => renderList());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      moveKb(kbIndex + (e.key === 'ArrowDown' ? 1 : -1));
      e.preventDefault();
    } else if (e.key === 'Enter') {
      const links = visibleSongLinks();
      const target = links[kbIndex] ?? links[0];
      if (target) {
        e.preventDefault();
        openSong(target.dataset.songId!);
      }
    } else if (e.key === 'Escape') {
      // Clear first, then let go of focus so play.html's shortcuts work again.
      if (input.value) {
        input.value = '';
        renderList();
      } else {
        input.blur();
      }
      e.preventDefault();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    toggleMenu(true);
    input.focus();
    input.select();
  });
}

function visibleSongLinks(): HTMLAnchorElement[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>('.sidebar-nav .select-option > a'));
}

function moveKb(next: number): void {
  const links = visibleSongLinks();
  links.forEach((a) => a.classList.remove('kb-focus'));
  if (links.length === 0) {
    kbIndex = -1;
    return;
  }
  kbIndex = Math.max(0, Math.min(links.length - 1, next));
  const el = links[kbIndex];
  el.classList.add('kb-focus');
  el.scrollIntoView({ block: 'nearest' });
}

function openSong(id: string): void {
  location.href = `play.html#${id}`;
}

/** Filter chips, random picks and the "continue" strip. Lives in the
 *  partial's #menu-discovery slot; pages without it just skip this. */
function buildDiscoveryPanel(): void {
  const host = document.getElementById('menu-discovery');
  if (!host || host.dataset.built) return;
  host.dataset.built = '1';

  const chips = document.createElement('div');
  chips.className = 'menu-filter-chips';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Filter songs');
  for (const f of FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-chip';
    b.dataset.filter = f.value;
    if (f.value === 'favorites') b.title = 'Favorites';
    b.innerHTML = `<span class="menu-chip-label"></span><span class="menu-chip-count"></span>`;
    b.querySelector('.menu-chip-label')!.textContent = f.label;
    b.addEventListener('click', () => {
      menuFilter = f.value === menuFilter ? 'all' : f.value;
      setStorage(FILTER_KEY, menuFilter);
      renderList();
    });
    chips.appendChild(b);
  }
  host.appendChild(chips);

  const actions = document.createElement('div');
  actions.className = 'menu-random';
  const mkRandom = (label: string, title: string, pool: () => MenuSong[]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'menu-random-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => {
      const pick = pickRandom(pool());
      if (pick) openSong(pick.id);
      else b.classList.add('menu-random-empty');
    });
    actions.appendChild(b);
  };
  mkRandom('Random', 'Play a random song from this group', () => groupSongs(state.group).filter(passesFilter));
  mkRandom('Random unplayed', 'Play a song from this group you have not tried yet',
    () => groupSongs(state.group).filter((s) => statusOf(s.id) === 'unplayed'));
  host.appendChild(actions);

  const recent = recentSongIds(safeHistory(), allSongs, 3)
    .map((id) => allSongs.find((s) => s.id === id))
    .filter((s): s is MenuSong => !!s && !s.hidden && hasGroup(s.menu ?? s.group));
  if (recent.length > 0) {
    const strip = document.createElement('div');
    strip.className = 'menu-recent';
    const label = document.createElement('span');
    label.className = 'menu-recent-label';
    label.textContent = 'Continue';
    strip.appendChild(label);
    for (const s of recent) {
      const a = document.createElement('a');
      a.className = 'menu-recent-item';
      a.href = `play.html#${s.id}`;
      a.dataset.recentId = s.id;
      a.textContent = getSongTitle(s);
      const best = progress.get(s.id)?.best;
      a.title = best != null ? `${s.name} (best ${best}%)` : s.name;
      strip.appendChild(a);
    }
    host.appendChild(strip);
  }
}

function safeHistory() {
  try {
    return loadHistory();
  } catch {
    return [];
  }
}

/** Chip counts reflect the active group so the numbers match what a click
 *  will show. */
function updateCounts(): void {
  const songs = groupSongs(state.group);
  const counts: Record<MenuFilter, number> = { all: songs.length, unplayed: 0, progress: 0, mastered: 0, favorites: 0 };
  for (const s of songs) {
    counts[statusOf(s.id)]++;
    if (favorites.has(s.id)) counts.favorites++;
  }
  document.querySelectorAll<HTMLButtonElement>('.menu-chip').forEach((b) => {
    const f = b.dataset.filter as MenuFilter;
    b.classList.toggle('active', f === menuFilter);
    b.setAttribute('aria-pressed', String(f === menuFilter));
    const c = b.querySelector('.menu-chip-count');
    if (c) c.textContent = String(counts[f]);
  });
}

function updateSortButton(): void {
  document.querySelectorAll<HTMLButtonElement>('.sort-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.sort === state.sortMode);
  });
}

function updateGroupToggle(): void {
  document.getElementById('group-toggle')?.classList.toggle('active', state.groupBy.subunit);
  document.getElementById('album-toggle')?.classList.toggle('active', state.groupBy.album);
  // KPop has no subunit data — hide that button entirely.
  const subunitBtn = document.getElementById('group-toggle');
  if (subunitBtn && IS_KPOP) subunitBtn.style.display = 'none';
}

function subunitLabel(group: GroupName, subunit: string): string {
  return menuSectionLabel(group, subunit);
}

const IS_KPOP = import.meta.env.VITE_APP_MODE === 'kpop';

/** Section key is "subunitalbum" so the renderer can decide whether
 *  to print one combined header or fall back to a single-axis label.
 *  Empty fields stay empty so unmapped songs collapse into one bucket. */
function sectionKey(song: MenuSong): string {
  const sub = state.groupBy.subunit ? (song.subunit ?? '') : '';
  const alb = state.groupBy.album ? (song.album ?? '') : '';
  return sub + '' + alb;
}

function sectionLabel(group: GroupName, key: string): string {
  const [sub, alb] = key.split('');
  const subLabel = state.groupBy.subunit ? subunitLabel(group, sub) : '';
  const albLabel = state.groupBy.album ? (alb || '(No album)') : '';
  if (state.groupBy.subunit && state.groupBy.album) return `${subLabel} · ${albLabel}`;
  return state.groupBy.album ? albLabel : subLabel;
}

function sortSongs(filtered: MenuSong[]): MenuSong[] {
  const sorted = filtered.slice();
  const grpOn = state.groupBy.subunit || state.groupBy.album;

  if (state.sortMode === 'index' && !grpOn) return sorted;

  const byDate = (a: MenuSong, b: MenuSong) =>
    (a.released ?? '9999').localeCompare(b.released ?? '9999') || a.name.localeCompare(b.name);
  const byAlpha = (a: MenuSong, b: MenuSong) => a.name.localeCompare(b.name);
  // Within an album, prefer track-position order when both songs carry it
  // (keeps eg "TOKIMEKI Runners album" tracks in disc order).
  const byTrack = (a: MenuSong, b: MenuSong) => {
    const ta = a.trackPosition;
    const tb = b.trackPosition;
    if (ta != null && tb != null) return ta - tb;
    return byDate(a, b);
  };
  const base = state.sortMode === 'alpha' ? byAlpha : state.sortMode === 'date' ? byDate : () => 0;

  if (!grpOn) {
    sorted.sort(base);
    return sorted;
  }

  // Album → earliest release date in that album, used as the chronological
  // ordering key when album grouping is active.
  const albumDate = new Map<string, string>();
  if (state.groupBy.album) {
    for (const s of filtered) {
      const k = s.album ?? '';
      const d = s.released ?? '9999';
      const prev = albumDate.get(k);
      if (prev == null || d.localeCompare(prev) < 0) albumDate.set(k, d);
    }
  }

  sorted.sort((a, b) => {
    if (state.groupBy.subunit) {
      const ga = menuSectionRank(a.menu ?? a.group, a.subunit ?? '');
      const gb = menuSectionRank(b.menu ?? b.group, b.subunit ?? '');
      if (ga !== gb) return ga - gb;
    }
    if (state.groupBy.album) {
      const ka = a.album ?? '';
      const kb = b.album ?? '';
      const da = albumDate.get(ka) ?? '9999';
      const db = albumDate.get(kb) ?? '9999';
      const cmp = da.localeCompare(db) || ka.localeCompare(kb);
      if (cmp !== 0) return cmp;
      // Within an album, default sort uses track position when available.
      if (state.sortMode === 'index') return byTrack(a, b);
    }
    return base(a, b);
  });
  return sorted;
}

function switchGroup(group: GroupName): void {
  state.group = group;
  setStorage('group', group);

  document.querySelectorAll<HTMLElement>('.group-button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === group);
  });

  const htmlEl = document.documentElement;
  const stripGroupClasses = (el: Element) => {
    const stale = Array.from(el.classList).filter((c) => c.startsWith('group-'));
    el.classList.remove(...stale);
  };
  stripGroupClasses(htmlEl);
  htmlEl.classList.add(`group-${group}`);
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    stripGroupClasses(sidebar);
    sidebar.classList.add(`group-${group}`);
  }

  renderList();
}

/** Songs belonging to the active group, before status filtering. */
function groupSongs(group: GroupName): MenuSong[] {
  const out: MenuSong[] = [];
  for (const song of allSongs) {
    if (song.hidden) continue;
    if (song.menu != null ? song.menu !== group : song.group !== group) continue;
    out.push(song);
  }
  return out;
}

function passesFilter(song: MenuSong): boolean {
  return matchesFilter(menuFilter, statusOf(song.id), favorites.has(song.id));
}

/** Single render path for the song list: ranked cross-group results while
 *  a query is typed, the grouped/sorted list otherwise. */
function renderList(): void {
  document.querySelectorAll('.select-option, .sort-section-header, .menu-empty').forEach((el) => el.remove());
  const nav = document.querySelector('.sidebar-nav');
  if (!nav) return;
  kbIndex = -1;

  const searchInput = document.getElementById('menu-search') as HTMLInputElement | null;
  const query = searchInput?.value.trim() ?? '';
  const group = state.group;

  if (query) {
    // Search spans every group in this build so a title from another group
    // is one keystroke away; the active group gets a nudge to rank first.
    const pool = allSongs.filter((s) => !s.hidden && hasGroup(s.menu ?? s.group) && passesFilter(s));
    const ranked = rankSongs(pool, query, (s) => ((s.menu ?? s.group) === group ? 15 : 0), fieldCache);
    for (const { song } of ranked.slice(0, SEARCH_LIMIT)) {
      nav.appendChild(makeSongItem(song, (song.menu ?? song.group) !== group));
    }
    if (ranked.length === 0) appendEmpty(nav, 'No songs match that search.');
    else moveKb(0);
    updateCounts();
    return;
  }

  const sorted = sortSongs(groupSongs(group).filter(passesFilter));
  let lastSection: string | null = null;
  const grpOn = state.groupBy.subunit || state.groupBy.album;
  for (const song of sorted) {
    if (grpOn) {
      const section = sectionKey(song);
      if (section !== lastSection) {
        const header = document.createElement('li');
        header.className = 'sort-section-header';
        header.textContent = sectionLabel(group, section);
        nav.appendChild(header);
        lastSection = section;
      }
    }
    nav.appendChild(makeSongItem(song, false));
  }
  if (sorted.length === 0 && menuFilter !== 'all') appendEmpty(nav, EMPTY_FILTER_TEXT[menuFilter]);
  updateCounts();
}

function appendEmpty(nav: Element, text: string): void {
  const li = document.createElement('li');
  li.className = 'menu-empty';
  li.textContent = text;
  nav.appendChild(li);
}

function makeSongItem(song: MenuSong, showGroup: boolean): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'select-option';

  const a = document.createElement('a');
  a.dataset.songId = song.id;
  a.href = `play.html#${song.id}`;
  // Re-renders (search, filters) rebuild the list, so carry the playing
  // song's highlight over instead of relying on highlightSongInMenu.
  if (state.song?.id === song.id) a.classList.add('active');

  const status = statusOf(song.id);
  const pip = document.createElement('span');
  pip.className = `song-progress song-progress-${status}`;
  const prog = progress.get(song.id);
  pip.title = status === 'unplayed'
    ? 'Not played yet'
    : prog
      ? `Best ${prog.best}% over ${prog.plays} play${prog.plays === 1 ? '' : 's'}${prog.mastered ? ', mastered' : ''}`
      : 'Started, not finished';
  if (prog && !prog.mastered) pip.style.setProperty('--pct', String(prog.best));
  a.appendChild(pip);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'song-name';
  if (song.note === 'unsynced') {
    const mark = document.createElement('span');
    mark.className = 'unsynced-mark';
    mark.textContent = '≈';
    attachInstantTip(mark, 'Lyric timing approximate');
    nameSpan.appendChild(mark);
  }
  // Wrap the name in a text span carrying both name + name_jp so the
  // global JP toggle can swap them without rebuilding the menu.
  const nameText = document.createElement('span');
  nameText.className = 'song-name-text';
  nameText.dataset.songName = song.name;
  if (song.name_jp) nameText.dataset.songNameJp = song.name_jp;
  nameText.textContent = getSongTitle(song);
  nameSpan.appendChild(nameText);
  if (showGroup) {
    const badge = document.createElement('span');
    badge.className = 'song-group-badge';
    badge.textContent = getGroup(song.menu ?? song.group)?.name ?? song.group;
    nameSpan.appendChild(badge);
  }
  a.appendChild(nameSpan);

  const attrsSpan = document.createElement('span');
  attrsSpan.className = 'song-attrs';
  if (song.hasLyrics) {
    const icon = document.createElement('span');
    icon.className = 'glyphicon glyphicon-align-right';
    attrsSpan.appendChild(icon);
  }
  a.appendChild(attrsSpan);
  li.appendChild(a);

  // The star sits outside the link so toggling it never starts the song.
  const star = document.createElement('button');
  star.type = 'button';
  star.className = 'song-fav';
  const setStar = () => {
    const on = favorites.has(song.id);
    star.classList.toggle('on', on);
    star.textContent = on ? '★' : '☆';
    star.setAttribute('aria-label', on ? 'Remove from favorites' : 'Add to favorites');
    star.setAttribute('aria-pressed', String(on));
  };
  setStar();
  star.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (favorites.has(song.id)) favorites.delete(song.id);
    else favorites.add(song.id);
    saveFavorites();
    setStar();
    updateCounts();
    if (menuFilter === 'favorites') renderList();
  });
  li.appendChild(star);
  return li;
}

export function highlightSongInMenu(id: string): void {
  document.querySelectorAll('.sidebar-nav a').forEach((a) => a.classList.remove('active'));
  const el = document.querySelector<HTMLElement>(`.sidebar-nav a[data-song-id="${CSS.escape(id)}"]`);
  el?.classList.add('active');
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

export function setupMobileMenuButton(): void {
  if (document.getElementById('menu-button-bottom')) return;
  const btn = document.createElement('button');
  btn.id = 'menu-button-bottom';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Toggle menu');
  btn.innerHTML = '<span class="glyphicon glyphicon-menu-hamburger" aria-hidden="true"></span>';
  btn.addEventListener('click', () => toggleMenu());
  document.body.appendChild(btn);
}

export function setupMobileCheckButton(): void {
  if (document.getElementById('check-button-bottom')) return;
  const checkBtn = document.getElementById('check');
  if (!checkBtn) return;
  const btn = document.createElement('button');
  btn.id = 'check-button-bottom';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Check');
  btn.innerHTML = '<span class="glyphicon glyphicon-ok" aria-hidden="true"></span>';
  btn.addEventListener('click', () => checkBtn.click());
  document.body.appendChild(btn);
}

export function toggleMenu(show?: boolean): void {
  const main = document.querySelector<HTMLElement>('.main');
  const menuBtn = document.getElementById('menu-button');
  const sidebar = document.getElementById('sidebar');
  if (!main || !menuBtn || !sidebar) return;

  const isOpen = main.classList.contains('with-menu');
  const shouldOpen = show ?? !isOpen;

  main.classList.toggle('with-menu', shouldOpen);
  menuBtn.classList.toggle('with-menu', shouldOpen);
  sidebar.classList.toggle('sidebar-collapsed', !shouldOpen);
}
