import { Song, Slot, LyricToken, GroupName } from './types';
import { toTimeStr, escapeRegExp, parseURLParams } from './utils';
import { getGroupColor } from './labels';
import { getGroup } from './groups';
import {
  state, toggleChoice, toggleReveal, toggleDiff, toggleAutoscroll,
  toggleThemed, cycleLyricsMode, setLyricsMode, toggleCalls, toggleCallSFX,
  toggleJpLyrics, hasJpLyrics,
  toggleGlobalReveal, checkChoices, checkSlot, resetChoices, loadSong,
  restoreChoices, getDiffLabel, getNumSlotsDiff,
  tick, initGameState, updateMeter, refreshPaletteColors, revealLyrics,
} from './game';
import {
  setEditMode, setSlotSingers, setSlotDiff, setSlotLyric,
  insertMappingAfter, deleteSlot, exportEditedConfig, makeASSObjectURL,
} from './game-edit';
import { loadConfig, loadChangelog } from './config';
import * as player from './player';
import { setStorage, getStorage, loadHistory } from './storage';
import { buildMenu, highlightSongInMenu, attachInstantTip } from './ui-menu';
import { initKofi } from './kofi';

let preMuteVolume: number | null = null;

// ─── Page: Play ─────────────────────────────────────────────────────
export async function initPlayPage(): Promise<void> {
  player.initPlayer({
    onTick(currentTime, duration, didSeek) {
      tick(currentTime, didSeek);
      updateProgressDisplay(currentTime, duration);
    },
  });

  initGameState();
  const songs = await loadConfig();
  if (songs.length === 0) return;

  buildMenu(songs);
  bindPlayControls();
  bindKeyboard();
  bindEditToggle();

  // sync volume bar with saved volume setting
  updateVolumeDisplay(player.getVolume());

  // load song from hash or default
  const hashParts = location.hash.slice(1).split('?');
  const songId = hashParts[0];
  const song = songs.find((s) => s.id === songId) ?? songs[0];
  selectSong(song);

  // parse URL params (?t=, ?lyrics=, ?edit=)
  const queryStr = hashParts[1] || location.search.substring(1);
  if (queryStr) {
    const params = parseURLParams(queryStr);
    if (params.lyrics) {
      setLyricsMode(2);
      applyLyricsMode(2);
      setStorage('lyrics', '2');
    }
    if (params.t) {
      const seekTo = parseTimeParam(params.t);
      if (seekTo > 0) player.play(seekTo);
    }
    if (params.edit === '1') {
      activateEditMode();
    }
  }

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1).split('?')[0];
    const s = songs.find((x) => x.id === id);
    if (s) selectSong(s);
  });

  window.addEventListener('resize', resizeGameArea);

  initThemeToggle();
  initPaletteToggle();
  initKofi();
}

export function initPaletteToggle(): void {
  const savedPalette = getStorage('palette');
  if (savedPalette === 'official') {
    document.documentElement.classList.add('palette-official');
  }
  updatePaletteToggleLabel();
  document.getElementById('palette-toggle')?.addEventListener('click', () => {
    const isOfficial = document.documentElement.classList.toggle('palette-official');
    setStorage('palette', isOfficial ? 'official' : 'default');
    updatePaletteToggleLabel();
    refreshPaletteColors();
  });
}

function updatePaletteToggleLabel(): void {
  const btn = document.getElementById('palette-toggle');
  if (!btn) return;
  const isOfficial = document.documentElement.classList.contains('palette-official');
  btn.title = isOfficial ? 'Switch to default color palette' : 'Switch to official color palette';
  btn.classList.toggle('active', isOfficial);
}

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

function selectSong(song: Song): void {
  loadSong(song);

  // reset progress bar, time display, and play/pause button for the new song
  const bar = document.getElementById('progress-bar');
  if (bar) bar.style.width = '0%';
  const timeEl = document.querySelector('.jp-current-time');
  if (timeEl) timeEl.textContent = '0:00';
  const playBtn = document.querySelector<HTMLElement>('.jp-play');
  const pauseBtn = document.querySelector<HTMLElement>('.jp-pause');
  if (playBtn) playBtn.style.display = '';
  if (pauseBtn) pauseBtn.style.display = 'none';

  const brand = import.meta.env.VITE_APP_MODE === 'kpop' ? 'Whoranghae' : 'BubuDesuWho';
  document.title = `${brand} - ${song.name}`;
  const titleEl = document.getElementById('song-title');
  if (titleEl) {
    titleEl.textContent = song.name;
    if (song.note === 'unsynced') {
      const badge = document.createElement('span');
      badge.className = 'unsynced-badge';
      badge.textContent = '≈ timing approx';
      attachInstantTip(badge, 'Lyric timing was derived from speech recognition — positions may drift');
      titleEl.appendChild(badge);
    }
  }

  const coverEl = document.getElementById('song-cover') as HTMLImageElement | null;
  if (coverEl) {
    if (song.cover) {
      const coverBase = import.meta.env.VITE_COVER_BASE;
      coverEl.src = coverBase
        ? coverBase + song.cover.replace(/^css\/images\/covers\/(?:kpop\/)?/, '')
        : import.meta.env.BASE_URL + song.cover;
      coverEl.style.display = '';
    } else {
      coverEl.src = '';
      coverEl.style.display = 'none';
    }
  }

  // Easter egg: show WUG button for WUG songs
  const wugBtn = document.getElementById('wug-group-button');
  if (wugBtn) wugBtn.style.display = song.group === 'wug' ? 'inline-block' : 'none';

  // generate slots and lyrics
  generateSlots(state.slots, song.group);
  generateLyrics(state.lyrics);
  revealLyrics();

  // lyrics button visibility
  const lyricsBtn = document.getElementById('lyrics-button');
  if (lyricsBtn) lyricsBtn.style.display = state.lyrics.length > 0 ? '' : 'none';

  // calls buttons
  const callsBtn = document.getElementById('lyrics-enable-calls');
  const sfxBtn = document.getElementById('lyrics-enable-calls-sfx');
  if (callsBtn) callsBtn.style.display = song.calls.length > 0 ? '' : 'none';
  if (sfxBtn) sfxBtn.style.display = song.calls.length > 0 ? '' : 'none';

  // Native-lyrics toggle — show only if song has native-script data.
  // Label/title come from the current song's group.nativeScript so the same
  // button serves Japanese (JP) and Korean (한).
  const jpBtn = document.getElementById('lyrics-jp-toggle');
  if (jpBtn) {
    jpBtn.style.display = hasJpLyrics() ? '' : 'none';
    jpBtn.classList.toggle('active', state.jpLyrics);
    const ns = getGroup(song.group)?.nativeScript;
    if (ns === 'ko') {
      jpBtn.textContent = '한';
      jpBtn.title = 'Hangul lyrics';
    } else {
      jpBtn.textContent = 'JP';
      jpBtn.title = 'Japanese lyrics';
    }
  }
  if (state.jpLyrics && hasJpLyrics()) toggleJpLyrics(true);

  // diff button
  updateDiffButton();

  // restore saved choices
  restoreChoices();

  // highlight in menu
  highlightSongInMenu(song.id);

  // apply theme
  if (state.themed) {
    switchTheme(song.id);
  } else {
    switchTheme(null);
  }

  // apply global reveal
  if (state.globalReveal) toggleGlobalReveal(true);

  // update meter display (0 / N)
  updateMeter();

  // apply lyrics mode — visually force off if song has no lyrics, but keep preference
  applyLyricsMode(state.lyrics.length === 0 ? 0 : state.lyricsMode);

  resizeGameArea();
}

function generateSlots(slots: Slot[], group: GroupName): void {
  const container = document.getElementById('slots');
  if (!container) return;
  container.innerHTML = '';

  for (const slot of slots) {
    const el = createSlotElement(slot, group);
    slot.element = el;
    if (slot.diff > state.diff) el.style.display = 'none';
    container.appendChild(el);
  }
}

/**
 * Fallback slot skeleton builder for groups without an HTML <template>.
 * Iterates members + subunits from the registry. Used for newly-added groups
 * (e.g. K-pop) that don't ship hand-authored Bootstrap markup.
 */
export function buildSlotSkeleton(group: GroupName): HTMLElement {
  const g = getGroup(group);

  const row = document.createElement('div');
  row.className = 'row slot';

  const header = document.createElement('div');
  header.className = 'col-xs-12 col-md-2 slot-header';
  const headerIcons: [string, string?][] = [
    ['label label-default timerange'],
    ['jump-button glyphicon glyphicon-play'],
    ['check-slot-button glyphicon glyphicon-ok', 'Check this line'],
    ['reveal-button glyphicon glyphicon-search'],
    ['reveal-off-button glyphicon glyphicon-search'],
    ['show-lyrics glyphicon glyphicon-question-sign'],
  ];
  for (const [cls, title] of headerIcons) {
    const el = document.createElement('span');
    el.className = cls;
    el.setAttribute('aria-hidden', 'true');
    if (title) el.title = title;
    header.appendChild(el);
  }
  row.appendChild(header);

  const body = document.createElement('div');
  body.className = 'col-xs-12 col-md-10 slot-body';
  const bodyRow = document.createElement('div');
  bodyRow.className = 'row';
  body.appendChild(bodyRow);

  const members = document.createElement('div');
  members.className = 'col-xs-12 slot-members';
  for (const m of g?.members ?? []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary choice';
    btn.dataset.value = String(m.id);
    btn.textContent = m.name;
    members.appendChild(btn);
  }
  bodyRow.appendChild(members);

  if (g?.subunits?.length) {
    const subs = document.createElement('div');
    subs.className = 'col-xs-12 slot-subunits';
    for (const sub of g.subunits) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-primary';
      btn.dataset.value = [...sub.memberIds].sort((a, b) => a - b).join(',');
      btn.textContent = sub.name;
      subs.appendChild(btn);
    }
    bodyRow.appendChild(subs);
  }

  row.appendChild(body);
  return row;
}

export function createSlotElement(slot: Slot, group: GroupName): HTMLElement {
  // Prefer the hand-authored HTML <template> (richer Bootstrap grid, seiyuu
  // names, mobile shortcut rows). Fall back to registry-driven skeleton for
  // groups without a template (e.g. newly added K-pop groups).
  const template = document.getElementById(`${group}-slot-template`) as HTMLTemplateElement | null;
  const clone = template
    ? template.content.firstElementChild!.cloneNode(true) as HTMLElement
    : buildSlotSkeleton(group);

  clone.id = `slot${slot.id}`;
  clone.dataset.diff = String(slot.diff);

  if (group === 'nijigasaki' && !state.singers.includes(13)) {
    clone.querySelector('.nijigasaki-yu-row')?.remove();
  }

  // time range
  const timeRange = clone.querySelector('.timerange')!;
  if (state.editMode) {
    (timeRange as HTMLElement).style.display = 'none';

    const inputs: HTMLInputElement[] = [0, 1].map((i) => {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'edit-time-input';
      inp.value = String(slot.range[i]);
      inp.step = '0.01';
      inp.min = '0';
      inp.addEventListener('change', () => {
        const v = parseFloat(inp.value);
        if (!isNaN(v)) slot.range[i as 0 | 1] = Math.round(v * 100) / 100;
      });
      return inp;
    });

    const snapBtns: HTMLButtonElement[] = [0, 1].map((i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn btn-xs ${i === 0 ? 'btn-info' : 'btn-warning'} edit-snap`;
      btn.textContent = '⏱';
      btn.title = `Snap ${i === 0 ? 'start' : 'end'} to current playback time`;
      btn.addEventListener('click', () => {
        slot.range[i as 0 | 1] = Math.round(player.getCurrentTime() * 100) / 100;
        inputs[i].value = String(slot.range[i as 0 | 1]);
      });
      return btn;
    });

    // Full-width top bar: timing on left, lyric input stretching right
    const editBar = document.createElement('div');
    editBar.className = 'col-xs-12 edit-top-bar';

    const timingWrap = document.createElement('div');
    timingWrap.className = 'edit-timing';
    for (let i = 0; i < 2; i++) {
      const row = document.createElement('div');
      row.className = 'edit-timing-row';
      const label = Object.assign(document.createElement('span'), { className: 'edit-time-label', textContent: i === 0 ? 'S:' : 'E:' });
      row.append(label, inputs[i], snapBtns[i]);
      timingWrap.appendChild(row);
    }

    const currentLyric = state.lyrics
      .filter((l) => l.mapping && l.src === 'mapping' && state.reverseMap[l.mapping.id]?.slot === slot)
      .map((l) => l.text ?? '')
      .join(' ');
    const lyricInput = document.createElement('input');
    lyricInput.type = 'text';
    lyricInput.className = 'edit-lyric-input';
    lyricInput.placeholder = '(no lyric)';
    lyricInput.value = slot.mapping.lyric ?? currentLyric;
    lyricInput.addEventListener('input', () => setSlotLyric(slot, lyricInput.value));

    editBar.append(timingWrap, lyricInput);
    clone.prepend(editBar);
  } else {
    timeRange.textContent = `${toTimeStr(slot.range[0], 1, 0.7)} - ${toTimeStr(slot.range[1], 1, 0.7)}`;
  }

  // jump button
  clone.querySelector('.jump-button')!.addEventListener('click', () => {
    player.play(slot.range[0]);
    const playBtn = document.querySelector<HTMLElement>('.jp-play');
    const pauseBtn = document.querySelector<HTMLElement>('.jp-pause');
    if (playBtn) playBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'inline-block';
  });

  // show-lyrics tooltip (?) — gather lyrics for this slot
  const showLyrics = clone.querySelector<HTMLElement>('.show-lyrics');
  if (showLyrics) {
    const slotLyrics = state.lyrics.filter(
      (l) => l.mapping && l.src === 'mapping' && state.reverseMap[l.mapping.id]?.slot === slot,
    );
    if (slotLyrics.length > 0) {
      const lines = slotLyrics.map((l) => l.text ?? '');
      showLyrics.dataset.tooltip = lines.join(' / ');

      // Instant tooltip on hover using a positioned div
      let tip: HTMLElement | null = null;
      showLyrics.addEventListener('mouseenter', () => {
        tip = document.createElement('div');
        tip.className = 'slot-tooltip';
        tip.innerHTML = lines.join(' /<br>');
        document.body.appendChild(tip);
        const rect = showLyrics.getBoundingClientRect();
        tip.style.top = `${rect.bottom + window.scrollY + 4}px`;
        tip.style.left = `${rect.left + window.scrollX + rect.width / 2 - tip.offsetWidth / 2}px`;
      });
      showLyrics.addEventListener('mouseleave', () => {
        tip?.remove();
        tip = null;
      });
    } else {
      showLyrics.style.display = 'none';
    }
  }

  // edit mode buttons
  if (state.editMode) {
    const editControls = document.createElement('span');
    editControls.className = 'edit-controls';

    const insertBtn = document.createElement('button');
    insertBtn.className = 'btn btn-xs btn-success edit-insert';
    insertBtn.textContent = 'Insert ▼';
    insertBtn.title = 'Insert new slot below';
    insertBtn.addEventListener('click', () => {
      insertMappingAfter(slot);
      if (state.song) {
        generateSlots(state.slots, state.song.group);
        restoreChoices();
      }
    });

    const singersBtn = document.createElement('button');
    singersBtn.className = 'btn btn-xs btn-default edit-set-singers';
    singersBtn.textContent = 'Set Singers';
    singersBtn.title = 'Set selected members as the answer for this slot';
    singersBtn.addEventListener('click', () => {
      if (slot.choices.length === 0) return;
      setSlotSingers(slot, slot.choices);
      singersBtn.textContent = '✓ Set';
      singersBtn.classList.remove('btn-default');
      singersBtn.classList.add('btn-primary');
      setTimeout(() => {
        singersBtn.textContent = 'Set Singers';
        singersBtn.classList.remove('btn-primary');
        singersBtn.classList.add('btn-default');
      }, 1000);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-xs btn-danger edit-delete';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Delete this slot';
    deleteBtn.addEventListener('click', () => {
      deleteSlot(slot);
      if (state.song) generateSlots(state.slots, state.song.group);
    });

    editControls.appendChild(insertBtn);
    editControls.appendChild(singersBtn);
    editControls.appendChild(deleteBtn);
    clone.querySelector('.slot-header')!.appendChild(editControls);

    // difficulty buttons in slot-body
    const diffCol = document.createElement('div');
    diffCol.className = 'col-xs-4 col-sm-1 btn-group-vertical edit-diff-col';
    const diffOpts: [string, string][] = [['Normal', 'btn-success'], ['Hard', 'btn-warning'], ['Insane', 'btn-danger']];
    for (let d = 1; d <= 3; d++) {
      const [label, colorClass] = diffOpts[d - 1];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${colorClass} edit-diff-btn`;
      btn.dataset.diff = String(d);
      btn.textContent = label;
      if (d === slot.diff) btn.classList.add('active');
      btn.addEventListener('click', () => {
        setSlotDiff(slot, d);
        diffCol.querySelectorAll('.edit-diff-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
      diffCol.appendChild(btn);
    }
    clone.querySelector('.slot-body .row')!.prepend(diffCol);
  }

  // check-slot button
  clone.querySelector('.check-slot-button')!.addEventListener('click', () => checkSlot(slot));

  // reveal buttons
  clone.querySelector('.reveal-button')!.addEventListener('click', () => toggleReveal(slot, true));
  const revealOffBtn = clone.querySelector<HTMLElement>('.reveal-off-button')!;
  revealOffBtn.style.display = 'none';
  revealOffBtn.addEventListener('click', () => toggleReveal(slot, false));

  // buttons — disable solo buttons for missing singers; filter multi-member
  // (year/subunit) buttons to only present members.
  clone.querySelectorAll<HTMLElement>('.slot-body button[data-value]').forEach((btn) => {
    const members = btn.dataset.value!.split(',').map(Number);
    const present = members.filter((m) => state.singers.includes(m));
    if (present.length === 0) {
      btn.classList.add('disabled');
    } else if (members.length === 1) {
      btn.addEventListener('click', () => toggleChoice(btn, slot));
    } else {
      btn.dataset.value = present.join(',');
      btn.addEventListener('click', () => toggleChoice(btn, slot));
    }
    btn.addEventListener('mouseup', () => btn.blur());
  });

  return clone;
}

function generateLyrics(lyrics: LyricToken[]): void {
  const leftCol = document.getElementById('lyrics-left');
  const rightCol = document.getElementById('lyrics-right');
  if (!leftCol || !rightCol) return;
  leftCol.innerHTML = '';
  rightCol.innerHTML = '';

  let currentCol = leftCol;

  for (const lyric of lyrics) {
    if (lyric.type === 'text') {
      if (lyric.src === 'calls' && lyric.text !== ' ') {
        const span = document.createElement('span');
        span.className = 'call';
        span.textContent = lyric.text ?? '';
        if (lyric.push) span.style.marginLeft = lyric.push;
        currentCol.appendChild(span);
      } else {
        currentCol.appendChild(document.createTextNode(lyric.text ?? ''));
      }
    } else if (lyric.type === 'newline') {
      const br = document.createElement('br');
      if (lyric.src === 'calls') br.className = 'call';
      currentCol.appendChild(br);
    } else if (lyric.type === 'next-col') {
      currentCol = rightCol;
    } else if (lyric.type === 'lyric') {
      const el = document.createElement('div');
      el.className = 'lyric';
      el.id = `lyric${lyric.id}`;
      el.textContent = lyric.text ?? '';
      el.classList.add(`group-${state.group}`);

      if (lyric.src === 'calls') {
        el.classList.add('call');
        el.title = 'call';
      }
      if (lyric.together) el.classList.add('together');
      if (lyric.push) el.style.marginLeft = lyric.push;

      el.addEventListener('click', () => {
        if (lyric.mapping) {
          player.play(lyric.mapping.range[0]);
          const playBtn = document.querySelector<HTMLElement>('.jp-play');
          const pauseBtn = document.querySelector<HTMLElement>('.jp-pause');
          if (playBtn) playBtn.style.display = 'none';
          if (pauseBtn) pauseBtn.style.display = 'inline-block';

          const entry = state.reverseMap[lyric.mapping.id];
          const slotEl = entry?.slot?.element;
          const slotsContainer = document.getElementById('slots-container');
          const slotsEl = document.getElementById('slots');
          if (slotEl && slotsContainer && slotsEl) {
            const slotTop = slotEl.offsetTop - slotsEl.offsetTop;
            const target = slotTop - (slotsContainer.clientHeight - slotEl.offsetHeight) / 2;
            slotsContainer.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
          }
        }
      });

      lyric.element = el;
      currentCol.appendChild(el);
    }
  }
}

// ─── Control Bindings ───────────────────────────────────────────────
function bindPlayControls(): void {
  document.getElementById('check')?.addEventListener('click', checkChoices);
  document.getElementById('reset')?.addEventListener('click', resetChoices);

  document.getElementById('autoscroll')?.addEventListener('click', () => {
    toggleAutoscroll();
    document.getElementById('autoscroll')?.classList.toggle('active', state.autoscroll);
    setStorage('autoscroll', String(state.autoscroll));
  });

  document.getElementById('themed')?.addEventListener('click', () => {
    toggleThemed();
    document.getElementById('themed')?.classList.toggle('active', state.themed);
    setStorage('themed', String(state.themed));
    if (state.themed && state.song) switchTheme(state.song.id);
    else switchTheme(null);
  });

  // Reveal button — inline popover confirmation (matches original bootstrap-confirmation)
  const revealBtn = document.getElementById('global-reveal');
  const revealOffBtn = document.getElementById('global-reveal-off');
  if (revealBtn && revealOffBtn) {
    revealOffBtn.style.display = 'none';

    revealBtn.addEventListener('click', () => {
      // Toggle popover off if already open
      const existing = document.getElementById('reveal-popover');
      if (existing) {
        existing.remove();
        return;
      }

      const pop = document.createElement('div');
      pop.id = 'reveal-popover';
      pop.style.cssText = 'position:absolute;z-index:1060;background:#fff;border:1px solid #ccc;border-radius:6px;padding:0;box-shadow:0 5px 10px rgba(0,0,0,.2);min-width:160px;';
      pop.innerHTML =
        '<div style="padding:8px 14px;font-size:14px;font-weight:bold;background:#f7f7f7;border-bottom:1px solid #ebebeb;border-radius:5px 5px 0 0;text-align:center">Reveal all singers?</div>' +
        '<div style="padding:9px 14px;text-align:center">' +
        '<button class="btn btn-xs btn-warning" id="reveal-yes">&#10003; Yes</button> ' +
        '<button class="btn btn-xs btn-default" id="reveal-no">&#10005; No</button>' +
        '</div>';

      // Insert after the button
      revealBtn.insertAdjacentElement('afterend', pop);

      // Position below the button
      const popRect = pop.getBoundingClientRect();
      pop.style.top = `${revealBtn.offsetTop + revealBtn.offsetHeight + 4}px`;
      pop.style.left = `${revealBtn.offsetLeft + revealBtn.offsetWidth / 2 - popRect.width / 2}px`;

      document.getElementById('reveal-yes')!.addEventListener('click', () => {
        pop.remove();
        toggleGlobalReveal(true);
        revealBtn.style.display = 'none';
        revealOffBtn.style.display = '';
      });
      document.getElementById('reveal-no')!.addEventListener('click', () => {
        pop.remove();
      });
    });

    revealOffBtn.addEventListener('click', () => {
      toggleGlobalReveal(false);
      revealBtn.style.display = '';
      revealOffBtn.style.display = 'none';
    });
  }

  document.getElementById('diff')?.addEventListener('click', () => {
    toggleDiff();
    updateDiffButton();
    setStorage('diff', String(state.diff));
  });

  document.getElementById('lyrics-button')?.addEventListener('click', () => {
    const mode = cycleLyricsMode();
    applyLyricsMode(mode);
    setStorage('lyrics', String(mode));
  });

  document.getElementById('lyrics-dl-ass')?.addEventListener('click', (e) => {
    const a = e.currentTarget as HTMLAnchorElement;
    if (!state.assObjectURL) state.assObjectURL = makeASSObjectURL();
    a.href = state.assObjectURL;
    if (state.song) {
      a.download = state.song.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.ass';
    }
  });

  document.getElementById('lyrics-enable-calls')?.addEventListener('click', () => {
    toggleCalls();
    document.getElementById('lyrics-enable-calls')?.classList.toggle('active', state.calls);
    setStorage('calls', String(state.calls));
    applyCallMode();
  });

  document.getElementById('lyrics-enable-calls-sfx')?.addEventListener('click', () => {
    toggleCallSFX();
    document.getElementById('lyrics-enable-calls-sfx')?.classList.toggle('active', state.callSFX);
    setStorage('callSFX', String(state.callSFX));
  });

  document.getElementById('lyrics-jp-toggle')?.addEventListener('click', () => {
    toggleJpLyrics();
    document.getElementById('lyrics-jp-toggle')?.classList.toggle('active', state.jpLyrics);
    setStorage('jpLyrics', String(state.jpLyrics));
  });

  // player controls — play/pause toggle
  // CSS hides .jp-pause by default, so we must use inline 'inline-block' to show
  const playBtn = document.querySelector<HTMLElement>('.jp-play');
  const pauseBtn = document.querySelector<HTMLElement>('.jp-pause');
  playBtn?.addEventListener('click', () => {
    player.play();
    playBtn.style.display = 'none';
    pauseBtn!.style.display = 'inline-block';
  });
  pauseBtn?.addEventListener('click', () => {
    player.pause();
    pauseBtn.style.display = 'none';
    playBtn!.style.display = 'inline-block';
  });
  document.querySelector('.jp-stop')?.addEventListener('click', () => {
    player.stop();
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (playBtn) playBtn.style.display = 'inline-block';
  });

  // progress slider — click to seek
  const progressSlider = document.getElementById('progress-slider');
  const seekTooltip = document.getElementById('seek-tooltip');
  progressSlider?.addEventListener('click', (e) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const target = pct * player.getDuration();
    if (player.isPlaying()) player.play(target);
    else {
      player.pause(target);
      updateProgressDisplay(target, player.getDuration());
    }
  });
  progressSlider?.addEventListener('mousemove', (e) => {
    if (!seekTooltip) return;
    const rect = progressSlider.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const target = pct * player.getDuration();
    if (!isFinite(target)) { seekTooltip.style.display = 'none'; return; }
    seekTooltip.textContent = toTimeStr(target);
    seekTooltip.style.left = `${pct * 100}%`;
    seekTooltip.style.display = '';
  });
  progressSlider?.addEventListener('mouseleave', () => {
    if (seekTooltip) seekTooltip.style.display = 'none';
  });

  // volume slider — click to set
  document.getElementById('volume-slider')?.addEventListener('click', (e) => {
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const vol = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    preMuteVolume = null;
    player.setVolume(vol);
    setStorage('volume', String(vol));
    updateVolumeDisplay(vol);
  });

  // mute button — toggle mute/unmute
  document.querySelector('.jp-mute')?.addEventListener('click', () => {
    if (preMuteVolume !== null) {
      player.setVolume(preMuteVolume);
      setStorage('volume', String(preMuteVolume));
      updateVolumeDisplay(preMuteVolume);
      preMuteVolume = null;
    } else {
      preMuteVolume = player.getVolume();
      player.setVolume(0);
      setStorage('volume', '0');
      updateVolumeDisplay(0);
    }
  });


  // scroll detection for grace period
  document.getElementById('slots-container')?.addEventListener('scroll', () => {
    state.controls.lastSlotScroll = Date.now();
  });
  document.getElementById('lyrics-container')?.addEventListener('scroll', () => {
    state.controls.lastLyricScroll = Date.now();
  });
}

function bindKeyboard(): void {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

    if (e.key === 'a' && e.ctrlKey) {
      toggleGlobalReveal();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (e.code === 'Space') {
      if (player.isPlaying()) player.pause();
      else player.play();
      syncPlayPauseButtons();
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      const t = Math.max(0, player.getCurrentTime() - 2);
      if (player.isPlaying()) player.play(t);
      else player.pause(t);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      const t = Math.min(player.getDuration(), player.getCurrentTime() + 2);
      if (player.isPlaying()) player.play(t);
      else player.pause(t);
      e.preventDefault();
    } else if (e.key === 'c') {
      checkChoices();
      e.preventDefault();
    }
  });
}

function syncPlayPauseButtons(): void {
  const playBtn = document.querySelector<HTMLElement>('.jp-play');
  const pauseBtn = document.querySelector<HTMLElement>('.jp-pause');
  if (!playBtn || !pauseBtn) return;
  if (player.isPlaying()) {
    playBtn.style.display = 'none';
    pauseBtn.style.display = 'inline-block';
  } else {
    playBtn.style.display = 'inline-block';
    pauseBtn.style.display = 'none';
  }
}

// ─── UI Updates ─────────────────────────────────────────────────────
function updateDiffButton(): void {
  const btn = document.getElementById('diff');
  if (!btn) return;
  btn.textContent = getDiffLabel();
  btn.classList.remove('btn-warning', 'btn-danger');
  if (state.diff === 2) btn.classList.add('btn-warning');
  else if (state.diff >= 3) btn.classList.add('btn-danger');

  // disable if only one diff level
  const total = state.slots.length;
  const atDiff = getNumSlotsDiff(state.diff) - getNumSlotsDiff(state.diff - 1);
  if (total === atDiff) {
    btn.classList.add('disabled');
  } else {
    btn.classList.remove('disabled');
  }
}

function updateProgressDisplay(currentTime: number, duration: number): void {
  const timeEl = document.querySelector('.jp-current-time');
  if (timeEl) timeEl.textContent = toTimeStr(currentTime);

  // update progress bar
  const bar = document.getElementById('progress-bar');
  if (bar && duration > 0) {
    bar.style.width = `${(currentTime / duration) * 100}%`;
  }
}

function updateVolumeDisplay(vol: number): void {
  const bar = document.getElementById('volume-bar');
  if (bar) bar.style.width = `${vol * 100}%`;
  const icon = document.querySelector('.jp-mute .glyphicon');
  if (icon) {
    icon.classList.toggle('glyphicon-volume-down', vol > 0);
    icon.classList.toggle('glyphicon-volume-off', vol === 0);
  }
}

function applyLyricsMode(mode: number): void {
  const slotsContainer = document.getElementById('slots-container');
  const lyricsContainer = document.getElementById('lyrics-container');
  const lyricsBtn = document.getElementById('lyrics-button');
  const gameSettings = document.getElementById('game-settings');
  const lyricsMenu = document.getElementById('lyrics-menu');
  const checkBtn = document.getElementById('check');
  const resetBtn = document.getElementById('reset');

  if (!slotsContainer || !lyricsContainer) return;

  slotsContainer.classList.remove('with-lyrics', 'with-full-lyrics');
  lyricsContainer.classList.remove('full');
  lyricsBtn?.classList.remove('active');
  document.body.classList.remove('lyrics-side-open');

  if (mode === 0) {
    if (gameSettings) gameSettings.style.display = '';
    if (lyricsMenu) lyricsMenu.style.display = 'none';
    if (checkBtn) checkBtn.style.display = '';
    if (resetBtn) resetBtn.style.display = '';
    applyCallMode(false);
  } else if (mode === 1) {
    slotsContainer.classList.add('with-lyrics');
    lyricsBtn?.classList.add('active');
    document.body.classList.add('lyrics-side-open');
    if (gameSettings) gameSettings.style.display = '';
    if (lyricsMenu) lyricsMenu.style.display = 'none';
    if (checkBtn) checkBtn.style.display = '';
    if (resetBtn) resetBtn.style.display = '';
    applyCallMode(false);
  } else if (mode === 2) {
    slotsContainer.classList.add('with-full-lyrics');
    lyricsContainer.classList.add('full');
    lyricsBtn?.classList.add('active');
    if (gameSettings) gameSettings.style.display = 'none';
    if (lyricsMenu) lyricsMenu.style.display = '';
    if (checkBtn) checkBtn.style.display = 'none';
    if (resetBtn) resetBtn.style.display = 'none';
    if (state.calls) applyCallMode(true);
  }
}

function applyCallMode(enable?: boolean): void {
  const lyricsEl = document.getElementById('lyrics');
  if (!lyricsEl) return;
  const val = enable ?? (state.calls && state.lyricsMode === 2);
  lyricsEl.classList.toggle('call-mode', val);
}

export function switchTheme(theme: string | null): void {
  const themeRegex = /\btheme-\S+/g;
  const selectors = [
    '.navbar', '.main', '#song-title', '.slot', '.meter',
    '#menu-button', '#check', '#lyrics-container', '.lyric',
    '#slots', '#lyrics', '#player-bar',
  ];
  for (const sel of selectors) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      // remove all existing theme classes
      const toRemove = el.className.match(themeRegex);
      if (toRemove) toRemove.forEach((cls) => el.classList.remove(cls));
      // add new theme class
      if (theme != null) el.classList.add(`theme-${theme}`);
    });
  }

  // Propagate theme class to <html> so CSS custom properties cascade page-wide
  const htmlEl = document.documentElement;
  (htmlEl.className.match(themeRegex) ?? []).forEach(c => htmlEl.classList.remove(c));
  if (theme != null) htmlEl.classList.add(`theme-${theme}`);

  // --play-btn-bg is defined on #player-bar.theme-*, but #kofi-button lives
  // up in the header. Mirror the resolved value onto <html> so any element
  // can read it via var(--play-btn-bg).
  const bar = document.getElementById('player-bar');
  const barBg = bar ? getComputedStyle(bar).getPropertyValue('--play-btn-bg').trim() : '';
  if (barBg) htmlEl.style.setProperty('--play-btn-bg', barBg);
  else htmlEl.style.removeProperty('--play-btn-bg');

  // wrap each word in song title with <span class="word"> for per-word theming
  const titleEl = document.getElementById('song-title');
  if (titleEl) {
    const badge = titleEl.querySelector('.unsynced-badge');
    const text = (badge ? (titleEl.firstChild?.textContent ?? '') : (titleEl.textContent ?? ''));
    titleEl.innerHTML = text.replace(/(\S+)/g, '<span class="word">$1</span>');
    if (badge) titleEl.appendChild(badge);
  }
}

function resizeGameArea(): void {
  const nav = document.querySelector('nav');
  if (!nav) return;
  const winH = window.innerHeight;
  const navH = nav.offsetHeight;
  const slotsContainer = document.getElementById('slots-container');
  const lyricsContainer = document.getElementById('lyrics-container');
  if (slotsContainer) slotsContainer.style.height = `${winH - navH}px`;
  if (lyricsContainer) lyricsContainer.style.height = `${winH - navH}px`;
}

/** Parse time param: "30" → 30, "1m30" → 90 */
function parseTimeParam(t: string): number {
  const mMatch = t.match(/^(\d+)m(\d*)$/);
  if (mMatch) {
    return parseInt(mMatch[1], 10) * 60 + (mMatch[2] ? parseInt(mMatch[2], 10) : 0);
  }
  const n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

// ─── Edit Mode ──────────────────────────────────────────────────────
function bindEditToggle(): void {
  document.getElementById('edit-toggle')?.addEventListener('click', () => {
    if (state.editMode) deactivateEditMode();
    else activateEditMode();
  });
}

function activateEditMode(): void {
  setEditMode(true);
  document.getElementById('edit-toggle')?.classList.add('active');
  document.body.classList.add('edit-mode');

  // add export button
  const miscControls = document.getElementById('misc-controls');
  if (miscControls && !document.getElementById('edit-export')) {
    const exportBtn = document.createElement('button');
    exportBtn.id = 'edit-export';
    exportBtn.type = 'button';
    exportBtn.className = 'btn btn-info';
    exportBtn.textContent = 'Save Mapping';
    exportBtn.addEventListener('click', () => {
      if (!state.song) return;
      const mapping = exportEditedConfig();
      exportBtn.disabled = true;
      exportBtn.textContent = 'Saving...';

      const resetBtn = (text: string, cls: string) => {
        exportBtn.textContent = text;
        exportBtn.className = `btn ${cls}`;
        setTimeout(() => {
          exportBtn.textContent = 'Save Mapping';
          exportBtn.className = 'btn btn-info';
          exportBtn.disabled = false;
        }, 2000);
      };

      const downloadFallback = () => {
        const json = JSON.stringify(mapping, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${state.song!.id}.json`;
        a.click();
        URL.revokeObjectURL(url);
        resetBtn('Downloaded!', 'btn-success');
      };

      fetch('/api/save-mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songId: state.song.id, lines: mapping }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) resetBtn(`Saved (${data.entries} entries)`, 'btn-success');
          else downloadFallback();
        })
        .catch(() => downloadFallback());
    });
    miscControls.appendChild(exportBtn);
  }

  // regenerate slots with edit buttons, pre-select correct answers
  if (state.song) {
    generateSlots(state.slots, state.song.group);
    for (const slot of state.slots) {
      if (!slot.element || slot.ans.length === 0) continue;
      for (const singer of slot.ans) {
        const btn = slot.element.querySelector<HTMLElement>(`[data-value="${singer}"]`);
        if (btn) toggleChoice(btn, slot);
      }
    }
  }
}

function deactivateEditMode(): void {
  setEditMode(false);
  document.getElementById('edit-toggle')?.classList.remove('active');
  document.body.classList.remove('edit-mode');
  document.getElementById('edit-export')?.remove();

  // regenerate slots without edit buttons
  if (state.song) {
    generateSlots(state.slots, state.song.group);
    restoreChoices();
  }
}

// ─── Page: About ────────────────────────────────────────────────────
export async function initAboutPage(): Promise<void> {
  const songs = await loadConfig();
  buildMenu(songs);
  initThemeToggle();
}

// ─── Page: Changelog ────────────────────────────────────────────────
export async function initChangelogPage(): Promise<void> {
  const songs = await loadConfig();
  buildMenu(songs);
  initThemeToggle();

  const data = await loadChangelog();
  const container = document.getElementById('changelog');
  if (!container) return;

  // link song names in changelog entries
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

// ─── Page: Stats ────────────────────────────────────────────────────
export async function initStatsPage(): Promise<void> {
  const songs = await loadConfig();
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
