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

// Sources of the current track, kept so release() can drop the audio element
// and the next play() rebuild it.
let _src: { ogg: string; m4a: string } | null = null;

function makeHowl(ogg: string, m4a: string): Howl {
  _src = { ogg, m4a };
  const h = new Howl({
    src: [ogg, m4a],
    format: ['ogg', 'm4a'],
    html5: true,
    preload: _preload,
    volume: _volume,
    rate: _rate,
  });
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
  howl = makeHowl(ogg, m4a);
}

/** Unload the audio element so the browser stops buffering the rest of the
 *  track (Bubudle plays a few seconds, then idles on a paused element that keeps
 *  downloading). The next play() reloads it from the same source. */
export function release(): void {
  if (!howl) return;
  howl.unload();
  howl = null;
}

export function play(seekTo?: number): void {
  if (!howl && _src) howl = makeHowl(_src.ogg, _src.m4a);
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
  _src = null;
}
