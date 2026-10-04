// "Who's singing" rhythm mode: a full-screen overlay on the play page. The
// game rules live in whosings.ts; this file owns the DOM, the clock, input,
// and the frame loop, and hands drawing to whosings-render.ts.
import type { Song } from './types';
import * as player from './player';
import { memberName } from './groups';
import { getGroupColors, getDiffLabel, getSongTitle } from './game';
import { toTimeStr } from './utils';
import { saveWhosingsRun, loadWhosingsResults, isBetterWhosingsRun, type WhosingsRun } from './storage';
import {
  buildLines, revealLines, revealHolds, activeLineAt, laneForKey, GuessSession, lowestDiff, rankFor,
  countdownStep, COUNTDOWN_MS, accuracyPct,
  type WsLine, type RevealHold, type Rank,
} from './whosings';
import {
  STAGE_W, STAGE_H, CUE_LEAD, arcLayout, drawSeats, drawCue, drawPicks, drawLyric,
  type Seat,
} from './whosings-render';
import { StageFx, RANK_COLOR } from './whosings-fx';
import { RevealNotes } from './whosings-notes';
import { trapTab } from './focus-trap';
import {
  loadSettings, saveSettings, clampOffset, SPEEDS, SPEED_SECONDS, OFFSET_STEP, OFFSET_LIMIT,
  type NoteSpeed,
} from './whosings-settings';
import './whosings.css';

type Mode = 'start' | 'guess' | 'reveal' | 'results';

const PORTRAIT_BASE = import.meta.env.BASE_URL + 'css/images/members/';
/** Room kept under the stage for the scrub bar. */
const BAR_SPACE = 44;
/** Width the stage is fitted by: the widest arc and its names, not the full
 *  stage, so a portrait phone doesn't shrink the faces for empty margins.
 *  Beams and sparkles just run past the edges. */
const FIT_W = 1000;
/** Re-read the player when the interpolated clock drifts further than this. */
const DRIFT = 0.15;
/** A line start only lights the stage if we saw it happen, not if a seek landed past it. */
const PULSE_WINDOW = 0.3;
/** Menus and the pause screen only have the slow ambient drift left to show,
 *  so it's drawn at about 20 fps instead of every frame: wait this long, then
 *  take the next animation frame. */
const AMBIENT_WAIT_MS = 34;

const SPEED_LABEL: Record<NoteSpeed, string> = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };

let closeCurrent: (() => void) | null = null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

// webp first, png for groups that only have those (same order as stats.ts)
function loadPortrait(seat: Seat, group: string, onLoad: () => void): void {
  const exts = ['webp', 'png'];
  let i = 0;
  const tryNext = () => {
    if (i >= exts.length) return;
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth) {
        seat.img = img;
        onLoad();
      } else { i++; tryNext(); }
    };
    img.onerror = () => { i++; tryNext(); };
    img.src = `${PORTRAIT_BASE}${group}/${seat.id}.${exts[i]}`;
  };
  tryNext();
}

function songLevels(song: Song): number[] {
  return [...new Set(song.slotsBase.map((b) => b.mapping.diff ?? 1))].sort((a, b) => a - b);
}

/** `onClose` lets the play page resync its own controls after we pause the song. */
export function openWhosings(song: Song, diff: number, onClose?: () => void): void {
  closeCurrent?.();

  const levels = songLevels(song);
  let chosenDiff = levels.includes(diff) ? diff : lowestDiff(song);

  const colors = getGroupColors(song.group);
  // The play page's practice speed would slow the song under a 1x judging
  // clock; run at full speed and hand the practice rate back on close.
  const practiceRate = player.getRate();
  player.setRate(1);
  const layout = arcLayout(song.singers.length);
  const seats: Seat[] = [...song.singers].sort((a, b) => a - b).map((id, i) => ({
    id,
    name: memberName(song.group, id) ?? String(id),
    color: colors[id] ?? '#ccc',
    img: null,
    ...layout.points[i],
  }));
  // the stage may be idle by the time a face arrives
  seats.forEach((s) => loadPortrait(s, song.group, () => wake()));
  const seatById = new Map(seats.map((s) => [s.id, s]));
  const holds: RevealHold[] = revealHolds(song);
  const allLines: WsLine[] = revealLines(song);

  // ─── DOM ──────────────────────────────────────────────────────────
  const root = el('div', 'whosings');
  const bg = el('div', 'whosings-bg');
  const cover = document.getElementById('song-cover')?.getAttribute('src');
  if (cover) bg.style.backgroundImage = `url("${cover}")`;
  const canvas = el('canvas', 'whosings-canvas');
  const ctx = canvas.getContext('2d')!;

  const hud = el('div', 'whosings-hud');
  const title = el('div', 'whosings-title', getSongTitle(song));
  const tallyEl = el('div', 'whosings-tally');
  const pauseBtn = el('button', 'whosings-close whosings-pause');
  pauseBtn.type = 'button';
  pauseBtn.title = 'Pause (Esc or P)';
  pauseBtn.setAttribute('aria-label', 'Pause');
  const closeBtn = el('button', 'whosings-close', '✕');
  closeBtn.type = 'button';
  closeBtn.title = 'Close';
  closeBtn.setAttribute('aria-label', 'Close');
  hud.append(title, tallyEl, pauseBtn, closeBtn);
  const countdownEl = el('div', 'whosings-countdown');
  countdownEl.setAttribute('aria-live', 'assertive');

  const panel = el('div', 'whosings-panel');

  const bar = el('div', 'whosings-bar');
  const track = el('div', 'whosings-track');
  // The fill is a full-width strip slid in from the left inside a rounded clip,
  // so the frame loop moves it with a transform instead of a layout per frame.
  const fillClip = el('div', '');
  fillClip.style.cssText = 'position:absolute;inset:0;border-radius:3px;overflow:hidden';
  const fill = el('div', 'whosings-fill');
  fill.style.cssText = 'width:100%;transform:translateX(-100%);will-change:transform';
  const timeEl = el('span', 'whosings-time');
  fillClip.append(fill);
  track.append(fillClip);
  bar.append(track, timeEl);

  root.append(bg, canvas, hud, panel, countdownEl, bar);
  document.body.append(root);

  // ─── State ────────────────────────────────────────────────────────
  let mode: Mode = 'start';
  let session: GuessSession | null = null;
  let saved = false;
  let wasPlaying = false;
  let lastPlayingT = 0;
  let dragging = false;
  /** The pending animation frame, or 0 while the loop is idle. */
  let raf = 0;
  /** The timer that brings the loop back for the next ambient frame. */
  let ambientTimer = 0;
  let closed = false;
  let lastStarted = -1;
  let settings = loadSettings();
  /** Paused mid-run: the stage stays frozen behind the pause menu. */
  let paused = false;
  /** performance.now() when the resume countdown ends, or 0 when none is running. */
  let countdownEnd = 0;
  /** Where focus was before the pause menu took it, handed back on the way out. */
  let pauseReturn: HTMLElement | null = null;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fx = new StageFx(() => reducedMotion.matches);
  let frameNow = 0;
  const seatScale = (id: number) => fx.seatScale(id, frameNow);
  const notes = new RevealNotes(holds, seatById, layout.radius, fx, () => reducedMotion.matches);
  notes.travel = SPEED_SECONDS[settings.speed];

  // Howler's html5 clock only ticks a few times a second; interpolate between
  // reads so the arc and notes move smoothly.
  let clockT = 0;
  let clockAt = 0;
  function resync(): number {
    clockT = player.getCurrentTime();
    clockAt = performance.now();
    return clockT;
  }
  function now(): number {
    if (!player.isPlaying()) return resync();
    const est = clockT + (performance.now() - clockAt) / 1000;
    return Math.abs(est - player.getCurrentTime()) > DRIFT ? resync() : est;
  }
  /** The song clock as the player hears it: the calibration offset pushes the
   *  stage (and judging) later when the sound arrives late. */
  function gameNow(): number {
    return now() - settings.offsetMs / 1000;
  }

  function setMode(next: Mode): void {
    mode = next;
    root.dataset.mode = next;
    wake();
    setPaused(false);
    leavePauseMenu();
    panel.replaceChildren();
    if (next === 'start') buildStart();
  }

  function setPaused(on: boolean): void {
    paused = on;
    wake();
    countdownEnd = 0;
    countdownEl.textContent = '';
    if (on) root.dataset.paused = '';
    else delete root.dataset.paused;
  }

  function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
    const b = el('button', `whosings-btn ${cls}`, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function buildStart(): void {
    if (levels.length > 1) {
      const picker = el('div', 'whosings-diffs');
      for (const d of levels) {
        const b = button(getDiffLabel(d), 'whosings-diff', () => {
          chosenDiff = d;
          picker.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        });
        b.classList.toggle('active', d === chosenDiff);
        picker.append(b);
      }
      panel.append(picker);
    }
    panel.append(
      button('Start', 'whosings-go', () => begin('guess')),
      button('Auto play (reveal)', 'whosings-auto', () => begin('reveal')),
      buildSettings(),
    );
  }

  function buildSettings(): HTMLElement {
    const box = el('details', 'whosings-settings');
    box.append(el('summary', '', 'Settings'));

    const speedRow = el('div', 'whosings-setting');
    speedRow.append(el('span', 'whosings-setting-label', 'Note speed'));
    const speeds = el('div', 'whosings-diffs');
    for (const sp of SPEEDS) {
      const b = button(SPEED_LABEL[sp], 'whosings-diff', () => {
        settings = { ...settings, speed: sp };
        saveSettings(settings);
        notes.travel = SPEED_SECONDS[sp];
        speeds.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      });
      b.classList.toggle('active', sp === settings.speed);
      speeds.append(b);
    }
    speedRow.append(speeds);

    const offRow = el('div', 'whosings-setting');
    offRow.append(el('span', 'whosings-setting-label', 'Audio offset'));
    const offCtl = el('div', 'whosings-offset');
    const value = el('output', 'whosings-offset-val');
    const show = () => {
      const ms = settings.offsetMs;
      value.textContent = ms === 0 ? '0 ms' : `${ms > 0 ? '+' : ''}${ms} ms`;
    };
    const nudge = (d: number) => {
      settings = { ...settings, offsetMs: clampOffset(d === 0 ? 0 : settings.offsetMs + d) };
      saveSettings(settings);
      show();
    };
    const minus = button('−', 'whosings-step', () => nudge(-OFFSET_STEP));
    minus.setAttribute('aria-label', 'Offset earlier');
    const plus = button('+', 'whosings-step', () => nudge(OFFSET_STEP));
    plus.setAttribute('aria-label', 'Offset later');
    offCtl.append(minus, value, plus, button('Reset', 'whosings-step whosings-reset', () => nudge(0)));
    show();
    offRow.append(offCtl);
    offRow.append(el('span', 'whosings-hint',
      `If the cues feel early (common with Bluetooth), raise it. Up to ${OFFSET_LIMIT} ms either way.`));

    const keys = el('div', 'whosings-hint',
      'Keys: A S D F G/Space H J K L ; pick members left to right. Esc or P pauses.');
    box.append(speedRow, offRow, keys);
    return box;
  }

  function begin(next: 'guess' | 'reveal'): void {
    session = next === 'guess' ? new GuessSession(buildLines(song, chosenDiff)) : null;
    saved = false;
    wasPlaying = false;
    lastPlayingT = 0;
    lastStarted = -1;
    fx.reset();
    notes.reset(0);
    tallyEl.textContent = '';
    tallyStale = true;
    setMode(next);
    // this click is the gesture that lets the browser start audio
    player.play(0);
    resync();
  }

  function running(): boolean {
    return mode === 'guess' || mode === 'reveal';
  }

  function pause(): void {
    if (!running() || (paused && !countdownEnd)) return;
    player.pause();
    resync();
    setPaused(true);
    const active = document.activeElement;
    if (!panel.contains(active) && active instanceof HTMLElement && active !== document.body) pauseReturn = active;
    const heading = el('div', 'whosings-score', 'Paused');
    heading.id = 'whosings-paused-title';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', heading.id);
    panel.replaceChildren(
      heading,
      button('Resume', 'whosings-go', resume),
      button('Restart', 'whosings-auto', () => begin(mode === 'reveal' ? 'reveal' : 'guess')),
      button('Quit to menu', 'whosings-auto', () => { player.pause(0); setMode('start'); }),
    );
    panel.querySelector<HTMLButtonElement>('button')?.focus();
  }

  // A short count-in so the player's fingers are back on the keys before the music is.
  function resume(): void {
    if (!paused || countdownEnd) return;
    leavePauseMenu();
    panel.replaceChildren();
    countdownEnd = performance.now() + COUNTDOWN_MS;
    wake();
  }

  function leavePauseMenu(): void {
    panel.removeAttribute('role');
    panel.removeAttribute('aria-modal');
    panel.removeAttribute('aria-labelledby');
    if (panel.contains(document.activeElement)) pauseReturn?.focus();
    pauseReturn = null;
  }

  function tickCountdown(ts: number): void {
    if (!countdownEnd) return;
    const step = countdownStep(countdownEnd - ts);
    if (step === null) {
      setPaused(false);
      player.play();
      resync();
      return;
    }
    const label = String(step);
    if (countdownEl.textContent !== label) {
      countdownEl.textContent = label;
      // restart the pop animation for each number
      countdownEl.classList.remove('tick');
      void countdownEl.offsetWidth;
      countdownEl.classList.add('tick');
    }
  }

  function finish(dur: number): void {
    if (mode === 'reveal') {
      setMode('start');
      return;
    }
    if (!session || saved) return;
    saved = true;
    session.update(dur);
    const { right, guessed, total } = session.tally();
    const { score, maxCombo } = session.runStats();
    const rank = rankFor(score, session.maxScore());
    const fullCombo = session.fullCombo();
    const run: WhosingsRun = {
      correct: right, attempted: guessed, total, partial: session.seeked, diff: chosenDiff,
      date: new Date().toISOString(), score, maxCombo,
    };
    const prevBest = loadWhosingsResults()[song.id]?.best;
    const newBest = total > 0 && !!prevBest && isBetterWhosingsRun(run, prevBest);
    // a run that skipped every line says nothing, and would bump the real last run
    if (total > 0) saveWhosingsRun(song.id, run);
    setMode('results');
    if (fullCombo) {
      fx.celebrate(performance.now());
      panel.append(el('div', 'whosings-fc', 'FULL COMBO'));
    }
    if (rank) panel.append(rankStamp(rank));
    if (newBest) panel.append(el('div', 'whosings-newbest', 'New best!'));
    panel.append(
      el('div', 'whosings-score', `Who's singing: ${right} of ${total} lines`),
      el('div', 'whosings-sub',
        `${guessed} guessed` + (guessed ? `, ${accuracyPct(right, guessed)}% right` : '') +
        (session.seeked ? ' (partial run)' : '')),
      el('div', 'whosings-sub',
        `Score ${score.toLocaleString()}` + (rank ? ` (${rank} rank)` : '') + `, max combo ${maxCombo}`),
    );
    if (prevBest && !newBest) panel.append(el('div', 'whosings-sub whosings-best', bestLine(prevBest)));
    panel.append(memberTable());
    const again = button('Retry', 'whosings-go', () => begin('guess'));
    again.title = 'Retry (R)';
    panel.append(
      again,
      button('Change difficulty', 'whosings-auto', () => setMode('start')),
      button('Close', 'whosings-auto', close),
    );
    again.focus();
  }

  function bestLine(best: WhosingsRun): string {
    return `Best: ${best.correct} of ${best.total} (${getDiffLabel(best.diff)})` +
      (best.score !== undefined ? `, score ${best.score.toLocaleString()}` : '');
  }

  /** Who you spotted and who you mixed up: the part of a run worth practising. */
  function memberTable(): HTMLElement {
    const box = el('div', 'whosings-members');
    if (!session) return box;
    const stats = session.memberStats(seats.map((s) => s.id)).filter((m) => m.lines > 0 || m.wrongPicks > 0);
    if (!stats.length) return box;
    box.append(el('div', 'whosings-members-head', 'By member'));
    for (const st of stats) {
      const seat = seatById.get(st.member);
      const row = el('div', 'whosings-member');
      row.style.setProperty('--c', seat?.color ?? '#ccc');
      const pct = accuracyPct(st.caught, st.lines);
      const meter = el('div', 'whosings-meter');
      const fillEl = el('div', 'whosings-meter-fill');
      fillEl.style.width = `${pct}%`;
      meter.append(fillEl);
      const detail = st.lines ? `${st.caught}/${st.lines}` : '0/0';
      const extra = st.wrongPicks ? `, ${st.wrongPicks} mixed up` : '';
      row.title = `${seat?.name ?? st.member}: spotted in ${st.caught} of ${st.lines} lines${extra}`;
      row.append(el('span', 'whosings-member-name', seat?.name ?? String(st.member)), meter,
        el('span', 'whosings-member-num', detail + extra));
      box.append(row);
    }
    return box;
  }

  function rankStamp(rank: Rank): HTMLElement {
    const stamp = el('div', 'whosings-rank', rank);
    stamp.style.color = RANK_COLOR[rank];
    return stamp;
  }

  // ─── Seeking ──────────────────────────────────────────────────────
  function barTime(ev: PointerEvent): number {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * player.getDuration();
  }
  let barFrac = NaN;
  let barSecond = NaN;
  let barDur = NaN;
  function showBar(t: number): void {
    const dur = player.getDuration();
    const frac = dur ? Math.min(1, Math.max(0, t / dur)) : 0;
    if (frac !== barFrac) {
      barFrac = frac;
      fill.style.transform = `translateX(${(frac - 1) * 100}%)`;
    }
    // whole seconds on screen: rebuild the label only when one ticks over
    const second = Math.floor(t);
    if (second !== barSecond || dur !== barDur) {
      barSecond = second;
      barDur = dur;
      timeEl.textContent = `${toTimeStr(t)} / ${toTimeStr(dur)}`;
    }
  }
  function seekTo(target: number): void {
    const dur = player.getDuration();
    if (!dur) return;
    target = Math.max(0, Math.min(target, dur - 0.5));
    if (player.isPlaying() && !paused) player.play(target);
    else player.pause(target);
    // the session and notes run on the calibrated clock, like the frame loop
    const gameTarget = target - settings.offsetMs / 1000;
    session?.seek(gameTarget);
    fx.reset(session?.runStats().score ?? 0);
    notes.reset(gameTarget);
    lastStarted = -1;
    lastPlayingT = target;
    tallyStale = true;
    resync();
    wake();
  }
  track.addEventListener('pointerdown', (ev) => {
    dragging = true;
    track.setPointerCapture(ev.pointerId);
    showBar(barTime(ev));
  });
  track.addEventListener('pointermove', (ev) => {
    if (dragging) showBar(barTime(ev));
  });
  track.addEventListener('pointerup', (ev) => {
    if (!dragging) return;
    dragging = false;
    seekTo(barTime(ev));
  });
  track.addEventListener('pointercancel', () => { dragging = false; });

  // ─── Stage geometry ───────────────────────────────────────────────
  let scale = 1;
  let offX = 0;
  let offY = 0;
  let dpr = 1;
  /** Set by a resize; the first frame always measures. */
  let sizeStale = true;
  function fit(): void {
    sizeStale = false;
    const w = root.clientWidth;
    const h = root.clientHeight;
    dpr = window.devicePixelRatio || 1;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const avail = Math.max(1, h - BAR_SPACE);
    scale = Math.min(w / FIT_W, avail / STAGE_H);
    offX = (w - STAGE_W * scale) / 2;
    offY = (avail - STAGE_H * scale) / 2;
  }

  function press(member: number): void {
    if (mode !== 'guess' || !session || paused) return;
    session.toggle(member, gameNow());
    const seat = seatById.get(member);
    if (seat) fx.tap(seat, performance.now());
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const r = canvas.getBoundingClientRect();
    const x = (ev.clientX - r.left - offX) / scale;
    const y = (ev.clientY - r.top - offY) / scale;
    const hit = seats.find((s) => Math.hypot(x - s.x, y - s.y) < layout.radius * 1.15);
    if (hit) press(hit.id);
  });

  // Capture phase on window so the play page's own shortcuts never see these.
  function onKey(ev: KeyboardEvent): void {
    ev.stopPropagation();
    const k = ev.key.toLowerCase();
    if (ev.key === 'Escape' || (k === 'p' && !ev.ctrlKey && !ev.metaKey)) {
      ev.preventDefault();
      if (running() && (!paused || countdownEnd)) pause();
      else if (running() && paused) resume();
      else if (ev.key === 'Escape') close();
      return;
    }
    // The pause menu is a small modal: keep Tab inside it, and let Enter or
    // Space press the focused button instead of hitting a lane.
    if (paused && !countdownEnd) {
      if (ev.key === 'Tab') trapTab(ev, panel);
      if (panel.contains(ev.target as Node)) return;
    }
    if (ev.key === ' ') ev.preventDefault();
    if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (mode === 'results' && k === 'r') {
      begin('guess');
      return;
    }
    const lane = laneForKey(ev.key, seats.length);
    if (lane !== null) press(seats[lane].id);
  }
  window.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', close);
  pauseBtn.addEventListener('click', () => (paused && !countdownEnd ? resume() : pause()));
  // switching tabs or apps mid-song shouldn't cost you a run
  function onHide(): void {
    if (document.hidden) pause();
  }
  document.addEventListener('visibilitychange', onHide);
  // an idle stage still has to follow the window, the motion setting and late web fonts
  function onResize(): void {
    sizeStale = true;
    wake();
  }
  window.addEventListener('resize', onResize);
  reducedMotion.addEventListener('change', wake);
  document.fonts?.addEventListener('loadingdone', wake);

  // ─── Frame loop ───────────────────────────────────────────────────
  // The loop runs at full rate while the song or a stage effect is moving,
  // drops to ambient frames on menus, and stops when a redraw would change
  // nothing. Anything that changes what the stage shows calls wake().
  function wake(): void {
    if (closed || raf) return;
    clearTimeout(ambientTimer);
    ambientTimer = 0;
    raf = requestAnimationFrame(frame);
  }

  // reused every frame so a long song doesn't feed the garbage collector
  const held = new Set<number>();
  const pickedSeats: Seat[] = [];
  let tallyStale = true;

  function frame(ts: number): void {
    // requested up front so a throw mid-draw doesn't kill the loop
    raf = requestAnimationFrame(frame);
    frameNow = ts;
    if (sizeStale) fit();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offX, dpr * offY);

    tickCountdown(ts);
    const rawT = now();
    const t = rawT - settings.offsetMs / 1000;
    const playing = player.isPlaying() && !paused;
    const dur = player.getDuration();
    const live = running();
    if (live && !dragging) showBar(rawT);

    // guess mode shows the asked lines; reveal shows every line, full-cast included
    const lines = session && mode === 'guess' ? session.lines : allLines;
    if (live) {
      let started = -1;
      for (let i = 0; i < lines.length && lines[i].start <= t; i++) started = i;
      if (started !== lastStarted) {
        if (playing && started >= 0 && t - lines[started].start < PULSE_WINDOW) fx.pulse(ts);
        lastStarted = started;
      }
    }
    fx.tick(ts);
    fx.drawBack(ctx, ts);

    held.clear();
    if (mode === 'reveal') {
      for (const h of holds) if (h.start <= t && t < h.end) held.add(h.member);
      if (playing) notes.update(t, ts);
      notes.drawBack(ctx, t, ts);
    }
    if (mode === 'guess' && session) {
      // only while audio runs: a deferred seek can leave a stale time until playback starts
      if (playing) {
        const judged = session.update(t);
        if (judged.length) tallyStale = true;
        // several at once only after a stall; the latest is the one worth showing
        const i = judged.length ? judged[judged.length - 1] : -1;
        const res = i >= 0 ? session.result(i) : null;
        if (res === 'right') {
          const picked = session.guessOf(i);
          pickedSeats.length = 0;
          for (const s of seats) if (picked.has(s.id)) pickedSeats.push(s);
          fx.judge('right', pickedSeats, ts);
        } else if (res === 'wrong') {
          fx.judge('wrong', [], ts);
        }
      }
      const lead = SPEED_SECONDS[settings.speed] * CUE_LEAD;
      for (const l of session.lines) {
        if (l.end <= t) continue;
        if (l.start - lead > t) break;
        drawCue(ctx, t, l, lead);
      }
    }
    // it runs along the cue arc, which only guess mode draws
    if (mode === 'guess') fx.drawShimmer(ctx, ts);
    fx.drawBreath(ctx, seats, layout.radius, ts);
    drawSeats(ctx, seats, layout.radius, held, seatScale);
    if (mode === 'reveal') notes.drawFront(ctx, t, ts, seatScale);
    if (mode === 'guess' && session) {
      drawPicks(ctx, seats, layout.radius, session.picksAt(t), seatScale);
      if (tallyStale) {
        tallyStale = false;
        const { right, guessed } = session.tally();
        tallyEl.textContent = `${right} / ${guessed} right`;
      }
    }
    fx.drawFront(ctx, seats, layout.radius, ts);
    if (live) {
      const i = activeLineAt(lines, t);
      if (i >= 0 && lines[i].lyric) drawLyric(ctx, lines[i].lyric);
    }
    if (mode === 'guess' && session) {
      const { score, combo } = session.runStats();
      fx.drawJudgement(ctx, combo, ts);
      fx.drawGauge(ctx, score, session.maxScore(), ts);
    }

    if (live && dur > 0 && !paused) {
      if (playing) {
        wasPlaying = true;
        lastPlayingT = rawT;
      }
      // html5 audio may report 0 once it has ended, so also catch "stopped near the end"
      const ended = (playing && rawT >= dur - 0.2) || (!playing && wasPlaying && lastPlayingT >= dur - 1);
      if (ended) finish(dur);
    }

    // finish() above may have changed the mode, so read the state fresh
    if ((running() && !paused) || countdownEnd) return;
    const activity = fx.activity(ts);
    if (activity === 'busy') return;
    cancelAnimationFrame(raf);
    raf = 0;
    if (activity === 'ambient') ambientTimer = window.setTimeout(wake, AMBIENT_WAIT_MS);
  }

  function close(): void {
    closed = true;
    cancelAnimationFrame(raf);
    clearTimeout(ambientTimer);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('resize', onResize);
    reducedMotion.removeEventListener('change', wake);
    document.fonts?.removeEventListener('loadingdone', wake);
    player.pause();
    player.setRate(practiceRate);
    root.remove();
    closeCurrent = null;
    onClose?.();
  }
  closeCurrent = close;

  player.pause();
  setMode('start');
}
