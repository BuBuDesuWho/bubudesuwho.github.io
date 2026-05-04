import { MenuSong, GroupName, SortMode } from './types';
import { escapeRegExp } from './utils';
import { state, getSongTitle } from './game-state';
import { getAllGroups, hasGroup } from './groups';
import { setStorage, getStorage } from './storage';

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

  switchGroup(state.group, songs);
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
      switchGroup(slug as GroupName, songs);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.sort-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.sort as SortMode;
      state.sortMode = mode === state.sortMode ? 'index' : mode;
      setStorage('sort', state.sortMode);
      updateSortButton();
      switchGroup(state.group, songs);
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
    switchGroup(state.group, songs);
  });
  document.getElementById('album-toggle')?.addEventListener('click', () => {
    state.groupBy.album = !state.groupBy.album;
    persistGroupBy();
    updateGroupToggle();
    switchGroup(state.group, songs);
  });

  document.getElementById('menu-search')?.addEventListener('keyup', (e) => {
    const query = (e.target as HTMLInputElement).value;
    searchMenu(query);
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

const SUBUNIT_ORDER: Record<string, number> = {
  '': 0, 'cyaron': 1, 'azalea': 2, 'guilty-kiss': 3,
  'diverdiva': 1, 'a-zu-na': 2, 'qu4rtz': 3, 'r3birth': 4,
  '1st-years': 5, '2nd-years': 6, '3rd-years': 7,
  'saint-aqours-snow': 8, 'aqours-miku': 9,
};
const SUBUNIT_LABELS: Record<string, string> = {
  'cyaron': 'CYaRon!', 'azalea': 'AZALEA', 'guilty-kiss': 'Guilty Kiss',
  'diverdiva': 'DiverDiva', 'a-zu-na': 'A·ZU·NA', 'qu4rtz': 'QU4RTZ', 'r3birth': 'R3BIRTH',
  '1st-years': '1st Years', '2nd-years': '2nd Years', '3rd-years': '3rd Years',
  'saint-aqours-snow': 'Saint Aqours Snow', 'aqours-miku': 'Aqours & Miku',
};
const MAIN_GROUP_LABELS: Record<string, string> = {
  muse: "μ's", aqours: 'Aqours', nijigasaki: 'Nijigasaki', wug: 'Wake Up, Girls!',
};
function subunitLabel(group: GroupName, subunit: string): string {
  if (!subunit) return MAIN_GROUP_LABELS[group] ?? group;
  return SUBUNIT_LABELS[subunit] ?? subunit;
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
      const ga = SUBUNIT_ORDER[a.subunit ?? ''] ?? 99;
      const gb = SUBUNIT_ORDER[b.subunit ?? ''] ?? 99;
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

function switchGroup(group: GroupName, songs: MenuSong[]): void {
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

  document.querySelectorAll('.select-option, .sort-section-header').forEach((el) => el.remove());
  const nav = document.querySelector('.sidebar-nav');
  if (!nav) return;

  const filtered: MenuSong[] = [];
  for (const song of songs) {
    if (song.hidden) continue;
    if (song.menu != null ? song.menu !== group : song.group !== group) continue;
    filtered.push(song);
  }

  const sorted = sortSongs(filtered);
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

    const li = document.createElement('li');
    li.className = 'select-option';

    const a = document.createElement('a');
    a.dataset.songId = song.id;
    a.href = `play.html#${song.id}`;

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
    nav.appendChild(li);
  }

  const searchInput = document.getElementById('menu-search') as HTMLInputElement | null;
  if (searchInput) searchMenu(searchInput.value);
}

function searchMenu(query: string): void {
  const regex = new RegExp(escapeRegExp(query), 'i');
  document.querySelectorAll<HTMLElement>('.select-option').forEach((el) => {
    el.style.display = regex.test(el.textContent ?? '') ? '' : 'none';
  });
  document.querySelectorAll<HTMLElement>('.sort-section-header').forEach((hdr) => {
    let hasVisible = false;
    let el = hdr.nextElementSibling as HTMLElement | null;
    while (el && !el.classList.contains('sort-section-header')) {
      if (el.classList.contains('select-option') && el.style.display !== 'none') hasVisible = true;
      el = el.nextElementSibling as HTMLElement | null;
    }
    hdr.style.display = hasVisible ? '' : 'none';
  });
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
