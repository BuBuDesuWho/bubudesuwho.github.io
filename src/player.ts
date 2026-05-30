import { Howl } from 'howler';

export interface PlayerCallbacks {
  onTick: (currentTime: number, duration: number, didSeek: boolean) => void;
}

let howl: Howl | null = null;
let animFrameId: number | null = null;
let callbacks: PlayerCallbacks | null = null;
let _volume = 0.3;
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

export function loadSong(ogg: string, m4a: string): void {
  if (howl) {
    howl.unload();
  }
  _seekPending = true;
  _pendingSeek = null;
  howl = new Howl({
    src: [ogg, m4a],
    format: ['ogg', 'm4a'],
    html5: true,
    volume: _volume,
  });
  howl.on('play', () => {
    if (_pendingSeek === null) return;
    _seekPending = true;
    howl!.seek(_pendingSeek);
    _pendingSeek = null;
  });
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
}
