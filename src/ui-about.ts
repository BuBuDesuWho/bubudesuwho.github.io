import { loadIndex, loadChangelog } from './config';
import { buildMenu } from './ui-menu';
import { getStorage, setStorage, loadHistory } from './storage';
import { getGroupColor } from './labels';
import { escapeRegExp } from './utils';

// Theme toggle is shared with the play page, but lives here so non-play entries
// (About / Changelog / Stats) can statically import it without dragging the
// player/howler chain into their bundle.
export function initThemeToggle(): void {
  const savedTheme = getStorage('theme');
  if (savedTheme === 'dark') {
    document.documentElement.classList.add('dark-mode');
  }
  updateThemeToggleLabel();
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark-mode');
    setStorage('theme', isDark ? 'dark' : 'light');
    updateThemeToggleLabel();
  });
}

function updateThemeToggleLabel(): void {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const isDark = document.documentElement.classList.contains('dark-mode');
  btn.textContent = isDark ? '☀' : '🌙';
  btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
}

// Vercel deploy rewrites the sister-site hostname so cross-mode links point
// at the Vercel host instead of GH Pages. GitHub *repo* URLs (github.com/.../
// *.github.io) are left alone — those resolve via the github.com domain.
function rewriteSisterSiteLinks(): void {
  if (!location.hostname.endsWith('.vercel.app')) return;
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const url = new URL(a.href, location.href);
    if (url.hostname === 'bubudesuwho.github.io') {
      url.hostname = 'bubudesuwho.vercel.app';
      a.href = url.toString();
    } else if (url.hostname === 'whoranghae.github.io') {
      url.hostname = 'whoranghae.vercel.app';
      a.href = url.toString();
    }
  }
}

export async function initAboutPage(): Promise<void> {
  const songs = await loadIndex();
  buildMenu(songs);
  initThemeToggle();
  rewriteSisterSiteLinks();
}

export async function initChangelogPage(): Promise<void> {
  const songs = await loadIndex();
  buildMenu(songs);
  initThemeToggle();

  const data = await loadChangelog();
  const container = document.getElementById('changelog');
  if (!container) return;

  if (location.hostname.endsWith('.vercel.app')) {
    for (const entry of data) {
      entry.change = entry.change
        .replace(/bubudesuwho\.github\.io/g, 'bubudesuwho.vercel.app')
        .replace(/whoranghae\.github\.io/g, 'whoranghae.vercel.app');
    }
  }

  for (const song of songs) {
    const repl = `<a href="#${song.id}" class="change-song-name ${getGroupColor(song.group) ?? ''}">${song.name}</a>`;
    for (const entry of data) {
      entry.change = entry.change.replace(new RegExp(escapeRegExp(song.name), 'g'), repl);
    }
  }

  for (const entry of data) {
    const li = document.createElement('li');
    li.className = 'change-entry';
    li.innerHTML = `<span class="change-date">${entry.date}</span>: <span class="change-content">${entry.change}</span>`;
    container.appendChild(li);
  }
}

export async function initStatsPage(): Promise<void> {
  const songs = await loadIndex();
  buildMenu(songs);
  initThemeToggle();

  const container = document.getElementById('stats-history');
  if (!container) return;

  const hist = loadHistory();
  const nameToSong = new Map(songs.map((s) => [s.name, s]));

  for (let i = hist.length - 1; i >= 0; i--) {
    const entry = hist[i];
    const song = nameToSong.get(entry.songName);

    const li = document.createElement('li');
    li.className = 'history-entry';

    const dateSpan = document.createElement('span');
    dateSpan.className = 'history-date';
    dateSpan.textContent = entry.date;

    const nameA = document.createElement('a');
    nameA.className = 'history-song-name';
    nameA.textContent = entry.songName;
    if (song) {
      nameA.href = `play.html#${song.id}`;
      const color = getGroupColor(song.group);
      if (color) nameA.classList.add(color);
    }

    let correct = 0;
    for (const [choices, ans] of entry.slots) {
      if (choices.length === ans.length && choices.every((v, j) => v === ans[j])) correct++;
    }
    const resultSpan = document.createElement('span');
    resultSpan.className = 'history-result';
    resultSpan.textContent = `(${correct}/${entry.slots.length})`;
    if (correct === entry.slots.length) resultSpan.classList.add('all-correct');

    li.append(dateSpan, ': ', nameA, ' ', resultSpan);
    container.appendChild(li);
  }
}
