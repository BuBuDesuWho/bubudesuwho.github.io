import { loadIndex, loadChangelog } from './config';
import { buildMenu } from './ui-menu';
import { prefs } from './prefs';
import { getGroupColor } from './labels';
import { escapeRegExp } from './utils';

// Theme toggle is shared with the play page, but lives here so non-play entries
// (About / Changelog / Stats) can statically import it without dragging the
// player/howler chain into their bundle.
export function initThemeToggle(): void {
  if (prefs.theme.get() === 'dark') {
    document.documentElement.classList.add('dark-mode');
  }
  updateThemeToggleLabel();
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark-mode');
    prefs.theme.set(isDark ? 'dark' : 'light');
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

