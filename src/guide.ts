import { loadIndex } from './config';
import { buildMenu } from './ui-menu';
import { initThemeToggle } from './ui-about';
import { getGroup } from './groups';
import { MenuSong, GroupName, GroupMember } from './types';

// ─── Content shape (songs/voice-guide.anime.json) ───────────────────
interface SignatureSong { songId: string; t?: string; label: string }
interface GuideNote { songId: string; t?: string; text: string }
interface MemberGuide {
  thesis: string;
  tells: string[];
  confusable?: string[];
  signatureSongs: SignatureSong[];
  notes?: GuideNote[];
}
type GuideData = Record<string, Record<string, MemberGuide>>;

// Groups covered by the dossiers, in display order.
const GUIDE_GROUPS: GroupName[] = ['muse', 'aqours'];
const IMAGE_BASE = 'css/images/members/';
// Voice-actor photos come in mixed formats; portraits/symbols/signatures are webp.
const VA_EXTS = ['jpeg', 'jpg', 'webp', 'png'];

async function loadGuide(): Promise<GuideData> {
  const base = (import.meta.env.VITE_CONTENT_BASE || import.meta.env.BASE_URL) as string;
  const mode = import.meta.env.VITE_APP_MODE === 'kpop' ? 'kpop' : 'anime';
  const resp = await fetch(`${base}songs/voice-guide.${mode}.json`);
  if (!resp.ok) throw new Error(`voice-guide.${mode}.json missing (${resp.status})`);
  return resp.json() as Promise<GuideData>;
}

export async function initGuidePage(): Promise<void> {
  const [songs, guide] = await Promise.all([loadIndex(), loadGuide()]);
  buildMenu(songs);
  initThemeToggle();

  const root = document.getElementById('guide-root');
  if (!root) return;
  const songById = new Map(songs.map(s => [s.id, s]));

  for (const slug of GUIDE_GROUPS) {
    const group = getGroup(slug);
    const members = guide[slug];
    if (!group || !members) continue;

    const section = el('section', 'guide-group');
    const title = el('h2', 'guide-group-title', group.name);
    section.appendChild(title);

    const grid = el('div', 'guide-grid');
    for (const m of group.members) {
      const data = members[String(m.id)];
      if (!data) continue;
      grid.appendChild(renderCard(slug, m, data, songById));
    }
    section.appendChild(grid);
    root.appendChild(section);
  }

  root.removeAttribute('aria-busy');
}

function renderCard(
  slug: GroupName,
  member: GroupMember,
  data: MemberGuide,
  songById: Map<string, MenuSong>,
): HTMLElement {
  const card = el('article', 'guide-card');
  card.style.setProperty('--member-color', member.color);

  // ── Header: portrait + symbol badge, name, signature, VA, thesis ──
  const head = el('header', 'guide-card-head');

  const figure = el('div', 'guide-figure');
  figure.appendChild(makeImg([`${IMAGE_BASE}${slug}/${member.id}.webp`], 'guide-portrait', member.name));
  const symbol = makeImg([`${IMAGE_BASE}${slug}/${member.id}-symbol.webp`], 'guide-symbol', '');
  figure.appendChild(symbol);
  head.appendChild(figure);

  const idBlock = el('div', 'guide-id');
  const name = el('h3', 'guide-name');
  name.append(document.createTextNode(member.name));
  if (member.nameNative) name.appendChild(el('span', 'guide-name-native', member.nameNative));
  idBlock.appendChild(name);

  const sig = makeImg([`${IMAGE_BASE}${slug}/${member.id}-signature.webp`], 'guide-signature', `${member.name} signature`);
  idBlock.appendChild(sig);

  idBlock.appendChild(el('p', 'guide-thesis', data.thesis));
  head.appendChild(idBlock);

  // Voice-actor photo (real-life seiyuu) — graceful if missing.
  const va = makeImg(VA_EXTS.map(ext => `${IMAGE_BASE}${slug}/${member.id}-va.${ext}`), 'guide-va', 'Voice actor');
  va.title = 'Voice actor (seiyuu)';
  head.appendChild(va);

  card.appendChild(head);

  // ── Ear tells ──
  card.appendChild(bulletBlock('Ear tells', data.tells));

  // ── Watch out (confusable voices) ──
  if (data.confusable?.length) {
    card.appendChild(bulletBlock('Don’t confuse', data.confusable, 'guide-confusable'));
  }

  // ── Hear it: signature-song chips deep-linking into the player ──
  if (data.signatureSongs.length) {
    const block = el('div', 'guide-block guide-hearit');
    block.appendChild(el('h4', 'guide-block-title', 'Hear it'));
    const chips = el('div', 'guide-chips');
    for (const s of data.signatureSongs) {
      chips.appendChild(songChip(s, songById));
    }
    block.appendChild(chips);
    card.appendChild(block);
  }

  // ── More moments (deeper per-song notes) ──
  if (data.notes?.length) {
    const details = el('details', 'guide-more') as HTMLDetailsElement;
    const summary = el('summary', 'guide-more-summary', 'More moments');
    details.appendChild(summary);
    const list = el('ul', 'guide-notes');
    for (const n of data.notes) {
      const li = el('li', 'guide-note');
      const song = songById.get(n.songId);
      const link = songLink(n.songId, n.t, song);
      li.appendChild(link);
      li.append(document.createTextNode(' — ' + n.text));
      list.appendChild(li);
    }
    details.appendChild(list);
    card.appendChild(details);
  }

  return card;
}

// ─── Small builders ─────────────────────────────────────────────────

function bulletBlock(title: string, items: string[], extraClass = ''): HTMLElement {
  const block = el('div', `guide-block ${extraClass}`.trim());
  block.appendChild(el('h4', 'guide-block-title', title));
  const ul = el('ul', 'guide-bullets');
  for (const it of items) ul.appendChild(el('li', '', it));
  block.appendChild(ul);
  return block;
}

/** A pill linking to a signature moment: cover thumb + descriptive label. */
function songChip(s: SignatureSong, songById: Map<string, MenuSong>): HTMLElement {
  const song = songById.get(s.songId);
  const node = song
    ? (el('a', 'guide-chip') as HTMLAnchorElement)
    : el('span', 'guide-chip guide-chip-plain');
  if (song) {
    (node as HTMLAnchorElement).href = playHref(s.songId, s.t);
    if (song.cover) {
      const cover = makeImg([song.cover], 'guide-chip-cover', '');
      node.appendChild(cover);
    }
  }
  const body = el('span', 'guide-chip-body');
  body.appendChild(el('span', 'guide-chip-song', song ? song.name : s.songId));
  body.appendChild(el('span', 'guide-chip-label', s.label));
  node.appendChild(body);
  return node;
}

/** Inline link to a song (used in the notes list). Falls back to plain text. */
function songLink(songId: string, t: string | undefined, song?: MenuSong): HTMLElement {
  if (!song) return el('strong', 'guide-note-song', songId);
  const a = el('a', 'guide-note-song') as HTMLAnchorElement;
  a.href = playHref(songId, t);
  a.textContent = song.name;
  return a;
}

function playHref(songId: string, t?: string): string {
  return `play.html#${songId}${t ? `?t=${t}` : ''}`;
}

function el<T extends HTMLElement = HTMLElement>(tag: string, className = '', text = ''): T {
  const node = document.createElement(tag) as T;
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * Build an <img> that tries each candidate URL in order, hiding itself if all
 * fail. Mirrors the multi-extension probe in stats.ts so a missing asset never
 * leaves a broken-image icon.
 */
function makeImg(candidates: string[], className: string, alt: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = className;
  img.alt = alt;
  img.loading = 'lazy';
  let i = 0;
  const tryNext = () => {
    if (i >= candidates.length) { img.style.display = 'none'; return; }
    img.src = candidates[i++];
  };
  img.addEventListener('error', tryNext);
  tryNext();
  return img;
}
