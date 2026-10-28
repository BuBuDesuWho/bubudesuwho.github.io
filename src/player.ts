import { Howl } from 'howler';

export interface PlayerCallbacks {
  onTick: (currentTime: number, duration: number, didSeek: boolean) => void;
  /** Playback reached the end of the track on its own (not stop/pause). */
  onEnd?: () => void;
}

let howl: Howl | null = null;
let animFrameId: number | null = null;
let callbacks: PlayerCallbacks | null = null;
let _volume = 0.3;
let _rate = 1;
let _seekPending = false;

const callSFXPool: HTMLAudioElement[] = [];
let callSFXChannel = 0;

export function initPlayer(cbs: PlayerCallbacks): void {
  callbacks = cbs;
  // preload call SFX
  for (let i = 0; i < 3; i++) {
    const sfx = new Audio(import.meta.env.BASE_URL + 'sound/call.wav');
    sfx.load();
    callSFXPool.push(sfx);
  }
  startAnimLoop();
}

// Deep-link seek (?t=) requested before any user gesture. Browser autoplay
// policy blocks the initial play() and Howler's html5 backend loses a seek
// applied while paused/unloaded — so we hold the target and re-apply it every
// time playback actually starts until it sticks.
let _pendingSeek: number | null = null;

// Backup source (GitHub-direct) to retry from if the primary (Cloudflare worker)
// fails to load. Tried at most once per song so a genuine 404 can't loop.
let _fallback: { ogg: string; m4a: string } | null = null;
let _triedFallback = false;

// Bubudle only ever plays a few seconds of each track, so it asks for
// metadata-only preload instead of buffering the whole file up front.
let _preload: boolean | 'metadata' = true;

export function setPreload(preload: boolean | 'metadata'): void {
  _preload = preload;
}

function newHowl(ogg: string, m4a: string, preload: boolean | 'metadata'): Howl {
  return new Howl({
    src: [ogg, m4a],
    format: ['ogg', 'm4a'],
    html5: true,
    preload,
    volume: _volume,
    rate: _rate,
  });
}

function makeHowl(ogg: string, m4a: string): Howl {
  return adopt(newHowl(ogg, m4a, _preload));
}

/** Make `h` the current track: the end, deferred-seek and fallback handlers. */
function adopt(h: Howl): Howl {
  h.on('end', () => callbacks?.onEnd?.());
  h.on('play', () => {
    if (_pendingSeek === null) return;
    _seekPending = true;
    howl!.seek(_pendingSeek);
    _pendingSeek = null;
  });
  h.on('loaderror', () => {
    if (_triedFallback || !_fallback) return;
    _triedFallback = true;
    const fb = _fallback;
    const wasPlaying = h.playing();
    const pos = (h.seek() as number) || 0;
    h.unload();
    howl = makeHowl(fb.ogg, fb.m4a);
    if (pos > 0) _pendingSeek = pos;
    if (wasPlaying) howl.play();
  });
  return h;
}

export function loadSong(ogg: string, m4a: string, fallback?: { ogg: string; m4a: string }): void {
  if (howl) {
    howl.unload();
  }
  _seekPending = true;
  _pendingSeek = null;
  _fallback = fallback ?? null;
  _triedFallback = false;
  const ready = prepared.get(ogg);
  prepared.delete(ogg);
  if (ready && ready.state() !== 'unloaded') {
    ready.volume(_volume);
    ready.rate(_rate);
    howl = adopt(ready);
  } else {
    howl = makeHowl(ogg, m4a);
  }
  currentOgg = ogg;
  settleLater();
}

// ─── Prepared tracks ─────────────────────────────────────────────
// Bubudle warms the clips you're likely to open next (Infinite's next puzzle,
// the neighbouring dailies) so they start without a network wait. Each is a
// paused, metadata-only element already seeked to its clip, which makes the
// browser fetch just the bytes around it; loadSong() takes it over as is.

export interface PrepareTarget {
  ogg: string;
  m4a: string;
  /** Where playback will start, in seconds. */
  at: number;
}

/** Browsers cap live media elements (Howler pools 10); this plus the current track stays under that. */
export const PREPARE_LIMIT = 5;
const SETTLE_MS = 2500;

const prepared = new Map<string, Howl>();
let currentOgg: string | null = null;
// The current track gets the network first: preparing waits until it has
// started playing, finished loading, or had SETTLE_MS to itself.
let settled = true;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let wanted: PrepareTarget[] = [];

function settleLater(): void {
  if (howl?.state() === 'loaded') { settled = false; settle(); return; }
  settled = false;
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, SETTLE_MS);
  howl?.once('play', settle);
  howl?.once('load', settle);
}

function settle(): void {
  if (settled) return;
  settled = true;
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  applyPrepared();
}

/**
 * Keep exactly these tracks warm, most wanted first; the first PREPARE_LIMIT
 * count. Tracks already warm are kept, ones no longer wanted are dropped.
 */
export function prepare(targets: PrepareTarget[]): void {
  const seen = new Set<string>();
  wanted = targets.filter((t) => !seen.has(t.ogg) && seen.add(t.ogg)).slice(0, PREPARE_LIMIT);
  if (settled) applyPrepared();
}

function applyPrepared(): void {
  const keep = new Set(wanted.map((t) => t.ogg).filter((o) => o !== currentOgg));
  for (const [ogg, h] of prepared) {
    if (!keep.has(ogg)) { h.unload(); prepared.delete(ogg); }
  }
  for (const t of wanted) {
    if (!keep.has(t.ogg) || prepared.has(t.ogg)) continue;
    prepared.set(t.ogg, warm(t));
  }
}

function warm(t: PrepareTarget): Howl {
  const h = newHowl(t.ogg, t.m4a, 'metadata');
  // Howler only applies a seek once the track can play through, which a
  // metadata-only element never reaches by itself; seeking the element as soon
  // as its metadata is in is what gets the clip's bytes fetched. Not once:
  // Howler's audio unlock on the first tap calls load() on every element,
  // which throws the seek away, so it's redone while the track is still waiting.
  const node = (h as unknown as { _sounds?: { _node?: HTMLMediaElement }[] })._sounds?.[0]?._node;
  if (node) {
    node.addEventListener('loadedmetadata', () => {
      if (prepared.get(t.ogg) === h) node.currentTime = t.at;
    });
  } else {
    h.seek(t.at);
  }
  h.once('loaderror', () => {
    if (prepared.get(t.ogg) === h) prepared.delete(t.ogg);
    h.unload();
  });
  return h;
}

export function play(seekTo?: number): void {
  if (!howl) return;
  if (seekTo !== undefined) {
    _seekPending = true;
    const wasPlaying = howl.playing();
    if (howl.state() === 'loaded') howl.seek(seekTo);
    if (wasPlaying) {
      // Already running — the seek sticks immediately, nothing to defer.
      _pendingSeek = null;
    } else {
      // Paused/unloaded: the seek may be lost (autoplay block, lazy html5
      // node), so re-apply it when playback actually starts.
      _pendingSeek = seekTo;
      howl.play();
    }
  } else if (!howl.playing()) {
    howl.play();
  }
}

export function pause(seekTo?: number): void {
  if (!howl) return;
  if (seekTo !== undefined) {
    _seekPending = true;
    // A fresh explicit seek supersedes any deferred deep-link target.
    _pendingSeek = null;
    howl.seek(seekTo);
  }
  howl.pause();
}

export function stop(): void {
  if (!howl) return;
  _seekPending = true;
  howl.stop();
}

export function isPlaying(): boolean {
  return howl?.playing() ?? false;
}

export function getCurrentTime(): number {
  if (!howl) return 0;
  const t = howl.seek();
  return typeof t === 'number' && isFinite(t) ? t : 0;
}

export function getDuration(): number {
  if (!howl) return 0;
  return howl.duration();
}

export function setVolume(vol: number): void {
  _volume = Math.max(0, Math.min(1, vol));
  if (howl) howl.volume(_volume);
}

export function getVolume(): number {
  return _volume;
}

/** Practice speed. Held here too so a song loaded later starts at the same
 *  rate; html5 audio keeps pitch while slowing down. */
export function setRate(rate: number): void {
  _rate = rate;
  if (howl) howl.rate(_rate);
}

export function getRate(): number {
  return _rate;
}

export function playCallSFX(): void {
  const sfx = callSFXPool[callSFXChannel];
  if (sfx) {
    sfx.currentTime = 0;
    sfx.play();
  }
  callSFXChannel = (callSFXChannel + 1) % callSFXPool.length;
}

function startAnimLoop(): void {
  function frame() {
    if (howl && howl.playing() && callbacks) {
      const time = getCurrentTime();
      const dur = getDuration();
      const didSeek = _seekPending;
      _seekPending = false;
      callbacks.onTick(time, dur, didSeek);
    }
    animFrameId = requestAnimationFrame(frame);
  }
  animFrameId = requestAnimationFrame(frame);
}

export function destroyPlayer(): void {
  if (animFrameId !== null) cancelAnimationFrame(animFrameId);
  if (howl) howl.unload();
  howl = null;
  currentOgg = null;
  for (const h of prepared.values()) h.unload();
  prepared.clear();
  wanted = [];
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = null;
  settled = true;
}
