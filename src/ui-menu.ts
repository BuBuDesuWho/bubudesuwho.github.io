import { Song, GroupName, SortMode } from './types';
import { escapeRegExp } from './utils';
import { state } from './game';
import { getSongs } from './config';
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

export function buildMenu(songs: Song[]): void {
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
  // migrate legacy 'group' sort mode
  if ((getStorage('sort') as string) === 'group') {
    state.sortMode = 'date';
    state.groupBySubunit = true;
  }
  const savedGroupBy = getStorage('groupBySubunit');
  if (savedGroupBy != null) state.groupBySubunit = savedGroupBy === 'true';

  switchGroup(state.group, songs);
  updateSortButton();
  updateGroupToggle();

  toggleMenu(window.innerWidth >= 1200);

  document.getElementById('menu-button')?.addEventListener('click', () => toggleMenu());

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

  document.getElementById('group-toggle')?.addEventListener('click', () => {
    state.groupBySubunit = !state.groupBySubunit;
    setStorage('groupBySubunit', String(state.groupBySubunit));
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
  document.getElementById('group-toggle')?.classList.toggle('active', state.groupBySubunit);
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

function sortSongs(filtered: Song[]): Song[] {
  const sorted = filtered.slice();

  if (state.sortMode === 'index' && !state.groupBySubunit) return sorted;

  const byDate = (a: Song, b: Song) =>
    (a.released ?? '9999').localeCompare(b.released ?? '9999') || a.name.localeCompare(b.name);
  const byAlpha = (a: Song, b: Song) => a.name.localeCompare(b.name);
  const base = state.sortMode === 'alpha' ? byAlpha : state.sortMode === 'date' ? byDate : () => 0;

  if (state.groupBySubunit) {
    sorted.sort((a, b) => {
      const ga = SUBUNIT_ORDER[a.subunit ?? ''] ?? 99;
      const gb = SUBUNIT_ORDER[b.subunit ?? ''] ?? 99;
      return ga - gb || base(a, b);
    });
  } else {
    sorted.sort(base);
  }
  return sorted;
}

function switchGroup(group: GroupName, songs: Song[]): void {
  state.group = group;
  setStorage('group', group);

  document.querySelectorAll<HTMLElement>('.group-button').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === group);
  });

  const htmlEl = document.documentElement;
  htmlEl.classList.remove('group-muse', 'group-aqours', 'group-wug', 'group-nijigasaki');
  htmlEl.classList.add(`group-${group}`);
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.classList.remove('group-muse', 'group-aqours', 'group-wug', 'group-nijigasaki');
    sidebar.classList.add(`group-${group}`);
  }

  document.querySelectorAll('.select-option, .sort-section-header').forEach((el) => el.remove());
  const nav = document.querySelector('.sidebar-nav');
  if (!nav) return;

  const filtered: Song[] = [];
  for (const song of songs) {
    if (song.hidden) continue;
    if (song.menu != null ? song.menu !== group : song.group !== group) continue;
    filtered.push(song);
  }

  const sorted = sortSongs(filtered);
  let lastSection = '';

  for (const song of sorted) {
    if (state.groupBySubunit) {
      const section = song.subunit ?? '';
      if (section !== lastSection) {
        const header = document.createElement('li');
        header.className = 'sort-section-header';
        header.textContent = subunitLabel(group, section);
        nav.appendChild(header);
        lastSection = section;
      }
    }

    const i = songs.indexOf(song);
    const li = document.createElement('li');
    li.className = 'select-option';

    const a = document.createElement('a');
    a.id = `select${i}`;
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
    nameSpan.appendChild(document.createTextNode(song.name));
    a.appendChild(nameSpan);

    const attrsSpan = document.createElement('span');
    attrsSpan.className = 'song-attrs';
    if (song.lyrics && (Array.isArray(song.lyrics) ? song.lyrics.length > 0 : song.lyrics.length > 0)) {
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
  const songs = getSongs();
  const idx = songs.findIndex((s) => s.id === id);
  if (idx >= 0) {
    const el = document.getElementById(`select${idx}`);
    el?.classList.add('active');
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
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
