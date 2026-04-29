import { GroupName, MEMBER_MAPPING, MEMBER_COLORS } from './types';
import { initThemeToggle } from './ui';
import { toggleMenu, setupMobileMenuButton } from './ui-menu';
import { ensureGroups } from './config';
import { MEMBER_COLUMNS, SHORTCUT_GROUPS, ShortcutGroup } from './bubudle-config';
import EXAMPLE_LYRICS_V3 from './submission-example.json';

const EXAMPLE_SONG_NAME = 'WONDERFUL STORIES';

interface LyricsV3Entry {
  lyric: string;
  ans: number[];
}
interface LyricsV3 {
  group: GroupName;
  lines: (LyricsV3Entry | string)[];
}

function entriesFromLyricsV3(doc: LyricsV3): Entry[] {
  const out: Entry[] = [];
  for (const line of doc.lines) {
    if (typeof line === 'string') {
      out.push({ kind: 'separator' });
    } else {
      out.push({ kind: 'lyric', text: line.lyric, ans: [...line.ans] });
    }
  }
  return out;
}

type Entry =
  | { kind: 'lyric'; text: string; ans: number[] }
  | { kind: 'separator' };

interface SubmissionState {
  group: GroupName;
  songName: string;
  entries: Entry[];
}

const state: SubmissionState = {
  group: 'aqours',
  songName: '',
  entries: [],
};

const GROUP_LABELS: Record<GroupName, string> = {
  muse: "μ's",
  aqours: 'Aqours',
  'saint-aqours-snow': 'Saint Aqours Snow',
  'aqours-miku': 'Aqours × Miku',
  wug: 'Wake Up, Girls!',
  nijigasaki: 'Nijigasaki',
};

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

function filenameFor(name: string): string {
  return `lyrics-u-${slugify(name)}.json`;
}

function memberIdsFor(group: GroupName): number[] {
  return Object.keys(MEMBER_MAPPING[group]).map(Number).sort((a, b) => a - b);
}

/**
 * Resolve column layout for the group: use MEMBER_COLUMNS if defined,
 * then append any remaining members (e.g. Sarah/Leah for saint-aqours-snow)
 * as an extras column. Falls back to a single column if no template exists.
 */
function columnsFor(group: GroupName): number[][] {
  const all = memberIdsFor(group);
  const preset = MEMBER_COLUMNS[group];
  if (!preset) {
    // Fallback: split evenly into up to 3 columns
    const cols: number[][] = [[], [], []];
    all.forEach((id, i) => cols[i % 3].push(id));
    return cols.filter(c => c.length > 0);
  }
  const seen = new Set(preset.flat());
  const extras = all.filter(id => !seen.has(id));
  return extras.length > 0 ? [...preset, extras] : preset;
}

function shortcutsFor(group: GroupName): ShortcutGroup[] {
  const base = SHORTCUT_GROUPS[group] ?? [];
  const all = new Set(memberIdsFor(group));
  return base.filter(s =>
    !s.extraOnly && s.members.every(m => all.has(m))
  );
}

function parseRomajiText(text: string): Entry[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: Entry[] = [];
  let lastWasSep = true; // suppress leading blanks
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      if (!lastWasSep) {
        out.push({ kind: 'separator' });
        lastWasSep = true;
      }
    } else {
      out.push({ kind: 'lyric', text: trimmed, ans: [] });
      lastWasSep = false;
    }
  }
  // drop trailing separator
  while (out.length && out[out.length - 1].kind === 'separator') {
    out.pop();
  }
  return out;
}

function buildOutput(): { group: GroupName; lines: (object | string)[] } {
  const lines = state.entries.map(e => {
    if (e.kind === 'separator') return '';
    const ans = [...e.ans].sort((a, b) => a - b);
    return { lyric: e.text, ans };
  });
  return { group: state.group, lines };
}

function download() {
  if (state.entries.length === 0) return;
  const payload = buildOutput();
  const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFor(state.songName);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function populateGroupSelect(select: HTMLSelectElement) {
  select.innerHTML = '';
  for (const g of Object.keys(MEMBER_MAPPING) as GroupName[]) {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = GROUP_LABELS[g] ?? g;
    if (g === state.group) opt.selected = true;
    select.appendChild(opt);
  }
}

function onGroupChange(newGroup: GroupName) {
  const lyricEntries = state.entries.filter(e => e.kind === 'lyric') as Extract<Entry, { kind: 'lyric' }>[];
  const hasAssignments = lyricEntries.some(e => e.ans.length > 0);
  if (hasAssignments && newGroup !== state.group) {
    const ok = confirm(
      `Changing group from ${GROUP_LABELS[state.group]} to ${GROUP_LABELS[newGroup]}. ` +
      `Singer IDs that don't exist in the new group will be dropped. Continue?`
    );
    if (!ok) return false;
    const validIds = new Set(memberIdsFor(newGroup));
    for (const e of lyricEntries) {
      e.ans = e.ans.filter(id => validIds.has(id));
    }
  }
  state.group = newGroup;
  return true;
}

function styleMemberChip(btn: HTMLButtonElement, id: number, selected: boolean) {
  const colors = MEMBER_COLORS[state.group] ?? {};
  const color = colors[id] ?? '#888';
  if (selected) {
    btn.classList.add('selected');
    btn.style.backgroundColor = color;
    btn.style.borderColor = color;
    btn.style.color = '#fff';
  } else {
    btn.classList.remove('selected');
    btn.style.backgroundColor = '';
    btn.style.borderColor = color;
    btn.style.color = color;
  }
}

function renderChipStrip(strip: HTMLElement, entryIndex: number) {
  strip.innerHTML = '';
  const entry = state.entries[entryIndex];
  if (!entry || entry.kind !== 'lyric') return;

  const mapping = MEMBER_MAPPING[state.group];
  const assigned = new Set(entry.ans);

  // Member columns (solo picks)
  const memberGrid = document.createElement('div');
  memberGrid.className = 'submission-member-grid';
  const columns = columnsFor(state.group);
  for (const col of columns) {
    const colEl = document.createElement('div');
    colEl.className = 'submission-member-col';
    for (const id of col) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'submission-chip submission-chip-member';
      chip.dataset.memberId = String(id);
      chip.textContent = mapping[id];
      styleMemberChip(chip, id, assigned.has(id));
      chip.addEventListener('click', () => {
        if (assigned.has(id)) {
          entry.ans = entry.ans.filter(a => a !== id);
        } else {
          entry.ans = [...entry.ans, id].sort((a, b) => a - b);
        }
        renderChipStrip(strip, entryIndex);
      });
      colEl.appendChild(chip);
    }
    memberGrid.appendChild(colEl);
  }
  strip.appendChild(memberGrid);

  // Shortcut columns: subunits first, years second
  const shortcuts = shortcutsFor(state.group);
  if (shortcuts.length > 0) {
    const subunits = shortcuts.filter(s => s.subunit);
    const years = shortcuts.filter(s => !s.subunit);
    const shortcutGrid = document.createElement('div');
    shortcutGrid.className = 'submission-shortcut-grid';
    for (const group of [subunits, years]) {
      if (group.length === 0) continue;
      const colEl = document.createElement('div');
      colEl.className = 'submission-shortcut-col';
      for (const s of group) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'submission-chip submission-chip-shortcut';
        btn.textContent = s.label;
        const current = new Set(entry.ans);
        const allOn = s.members.every(m => current.has(m));
        if (allOn) btn.classList.add('selected');
        btn.addEventListener('click', () => {
          // Additive toggle: if every shortcut member is already selected, drop
          // just those members; otherwise add them on top of existing picks.
          const sel = new Set(entry.ans);
          const everyOn = s.members.every(m => sel.has(m));
          if (everyOn) {
            for (const m of s.members) sel.delete(m);
          } else {
            for (const m of s.members) sel.add(m);
          }
          entry.ans = [...sel].sort((a, b) => a - b);
          renderChipStrip(strip, entryIndex);
        });
        colEl.appendChild(btn);
      }
      shortcutGrid.appendChild(colEl);
    }
    strip.appendChild(shortcutGrid);
  }
}

function renderEntries() {
  const container = document.getElementById('submission-entries')!;
  container.innerHTML = '';

  if (state.entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'submission-empty';
    empty.innerHTML = 'No lines yet — import a romaji file or click <em>Add line</em>.';
    container.appendChild(empty);
    updateDownloadEnabled();
    return;
  }

  const lyricTpl = document.getElementById('submission-lyric-template') as HTMLTemplateElement;
  const sepTpl = document.getElementById('submission-separator-template') as HTMLTemplateElement;

  state.entries.forEach((entry, i) => {
    if (entry.kind === 'lyric') {
      const node = lyricTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
      const input = node.querySelector('.submission-entry-text') as HTMLInputElement;
      input.value = entry.text;
      input.addEventListener('input', () => {
        entry.text = input.value;
      });

      const strip = node.querySelector('.submission-chip-strip') as HTMLElement;
      renderChipStrip(strip, i);

      node.querySelector('.submission-split')!.addEventListener('click', () => {
        const caret = input.selectionStart ?? input.value.length;
        const before = input.value.slice(0, caret).trim();
        const after = input.value.slice(caret).trim();
        if (!before || !after) {
          alert('Place the cursor in the middle of the line to split it.');
          return;
        }
        const inheritedAns = [...entry.ans];
        state.entries.splice(i, 1,
          { kind: 'lyric', text: before, ans: inheritedAns },
          { kind: 'lyric', text: after, ans: [...inheritedAns] }
        );
        renderEntries();
      });

      node.querySelector('.submission-merge')!.addEventListener('click', () => {
        if (i === 0) {
          alert('No previous line to merge with.');
          return;
        }
        const prev = state.entries[i - 1];
        if (prev.kind !== 'lyric') {
          alert('Previous entry is a separator — cannot merge across a section break.');
          return;
        }
        const mergedAns = Array.from(new Set([...prev.ans, ...entry.ans])).sort((a, b) => a - b);
        state.entries.splice(i - 1, 2, {
          kind: 'lyric',
          text: `${prev.text} ${entry.text}`.replace(/\s+/g, ' ').trim(),
          ans: mergedAns,
        });
        renderEntries();
      });

      node.querySelector('.submission-insert-line')!.addEventListener('click', () => {
        state.entries.splice(i + 1, 0, { kind: 'lyric', text: '', ans: [] });
        renderEntries();
      });

      node.querySelector('.submission-insert-sep')!.addEventListener('click', () => {
        state.entries.splice(i + 1, 0, { kind: 'separator' });
        renderEntries();
      });

      node.querySelector('.submission-delete')!.addEventListener('click', () => {
        state.entries.splice(i, 1);
        renderEntries();
      });

      container.appendChild(node);
    } else {
      const node = sepTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
      node.querySelector('.submission-delete')!.addEventListener('click', () => {
        state.entries.splice(i, 1);
        renderEntries();
      });
      container.appendChild(node);
    }
  });

  updateDownloadEnabled();
}

function updateDownloadEnabled() {
  const btn = document.getElementById('submission-download') as HTMLButtonElement;
  btn.disabled = state.entries.length === 0;
  const preview = document.getElementById('submission-filename-preview');
  if (preview) {
    preview.textContent = state.entries.length
      ? `Will download as: ${filenameFor(state.songName)}`
      : '';
  }
}

export async function initSubmissionPage() {
  initThemeToggle();

  toggleMenu(window.innerWidth >= 1200);
  document.getElementById('menu-button')?.addEventListener('click', () => toggleMenu());
  setupMobileMenuButton();

  await ensureGroups();

  const available = Object.keys(MEMBER_MAPPING) as GroupName[];
  if (!available.includes(state.group) && available.length > 0) {
    state.group = available[0];
  }

  const groupSelect = document.getElementById('submission-group') as HTMLSelectElement;
  populateGroupSelect(groupSelect);
  groupSelect.addEventListener('change', () => {
    const next = groupSelect.value as GroupName;
    if (!onGroupChange(next)) {
      groupSelect.value = state.group;
      return;
    }
    renderEntries();
  });

  const nameInput = document.getElementById('submission-song-name') as HTMLInputElement;
  nameInput.addEventListener('input', () => {
    state.songName = nameInput.value;
    updateDownloadEnabled();
  });

  const fileInput = document.getElementById('submission-file') as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseRomajiText(text);
    if (state.entries.length > 0) {
      const ok = confirm(`Replace the current ${state.entries.length} entries with ${parsed.length} imported entries?`);
      if (!ok) {
        fileInput.value = '';
        return;
      }
    }
    state.entries = parsed;
    if (!state.songName) {
      // Derive song name from filename (strip extension)
      state.songName = file.name.replace(/\.[^.]+$/, '');
      nameInput.value = state.songName;
    }
    renderEntries();
    fileInput.value = '';
  });

  document.getElementById('submission-add-line')!.addEventListener('click', () => {
    state.entries.push({ kind: 'lyric', text: '', ans: [] });
    renderEntries();
  });

  document.getElementById('submission-add-sep')!.addEventListener('click', () => {
    state.entries.push({ kind: 'separator' });
    renderEntries();
  });

  document.getElementById('submission-clear')!.addEventListener('click', () => {
    if (state.entries.length === 0) return;
    if (!confirm('Clear all entries?')) return;
    state.entries = [];
    renderEntries();
  });

  document.getElementById('submission-download')!.addEventListener('click', download);

  document.getElementById('submission-example')!.addEventListener('click', () => {
    if (state.entries.length > 0 && !confirm('Replace current entries with the example?')) return;
    const doc = EXAMPLE_LYRICS_V3 as LyricsV3;
    state.group = doc.group;
    state.songName = EXAMPLE_SONG_NAME;
    state.entries = entriesFromLyricsV3(doc);
    groupSelect.value = doc.group;
    nameInput.value = EXAMPLE_SONG_NAME;
    renderEntries();
  });

  renderEntries();
}
