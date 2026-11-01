import './bubudle-faces.css';

// Bubudle's answer buttons as face tiles: portrait in a ring of the member's
// colour, name, VA nickname. Only the button's contents change; game.ts still
// drives the same <button data-value> through its active/disabled/revealed
// classes, so the guessing logic doesn't know the tiles exist.

export interface FaceInfo {
  name: string;
  color?: string;
  /** Portrait URLs to try in order; a coloured initial if none load. */
  urls: string[];
}

/** Folders to look for a member's portrait in, most specific first, no repeats.
 *  A collab group (Saint Aqours Snow) keeps only its own members' portraits and
 *  borrows the rest from its parent group's folder. */
export function portraitFolders(group: string, parent: string | undefined, fallback: string): string[] {
  return [...new Set([group, parent, fallback].filter((g): g is string => !!g))];
}

export function portraitUrls(base: string, folders: string[], id: number): string[] {
  return folders.map((f) => `${base}css/images/members/${f}/${id}.webp`);
}

function initial(name: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'bf-initial';
  el.textContent = name.slice(0, 1);
  return el;
}

function face(info: FaceInfo, cls: string): HTMLElement {
  const ring = document.createElement('span');
  ring.className = cls;
  if (info.color) ring.style.setProperty('--mc', info.color);
  if (info.urls.length === 0) {
    ring.appendChild(initial(info.name));
    return ring;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  let i = 0;
  img.onerror = () => {
    i += 1;
    if (i < info.urls.length) img.src = info.urls[i];
    else img.replaceWith(initial(info.name));
  };
  img.src = info.urls[0];
  ring.appendChild(img);
  return ring;
}

export function decorateMemberButton(btn: HTMLButtonElement, info: FaceInfo, nick?: string): void {
  btn.classList.add('bf-tile');
  btn.textContent = '';
  btn.appendChild(face(info, 'bf-face'));
  const text = document.createElement('span');
  text.className = 'bf-text';
  const name = document.createElement('span');
  name.className = 'bf-name';
  name.textContent = info.name;
  text.appendChild(name);
  if (nick) {
    const n = document.createElement('span');
    n.className = 'bf-nick';
    n.textContent = nick;
    text.appendChild(n);
  }
  btn.appendChild(text);
  btn.title = nick ? `${info.name} (${nick})` : info.name;
}

export function decorateShortcutButton(btn: HTMLButtonElement, label: string, faces: FaceInfo[]): void {
  btn.classList.add('bf-tile', 'bf-shortcut');
  btn.textContent = '';
  const stack = document.createElement('span');
  stack.className = 'bf-stack';
  // A whole-group shortcut (e.g. "Aqours" next to guests) would be nine faces;
  // three say "a group" just as well.
  for (const f of faces.slice(0, 3)) stack.appendChild(face(f, 'bf-mini'));
  btn.appendChild(stack);
  const name = document.createElement('span');
  name.className = 'bf-name';
  name.textContent = label;
  btn.appendChild(name);
}
