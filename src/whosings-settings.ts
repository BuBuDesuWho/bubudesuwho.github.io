// Rhythm-mode settings: note speed and an audio/visual offset. Kept out of the
// profile backup on purpose: the offset calibrates this device's audio
// latency (Bluetooth headphones vs speakers), so it shouldn't follow you.
import { getStorage, setStorage } from './storage';

export type NoteSpeed = 'slow' | 'normal' | 'fast';

export interface WsSettings {
  speed: NoteSpeed;
  /** Positive when the sound reaches you late: everything on screen waits this long. */
  offsetMs: number;
}

/** Seconds a cue or note is on screen before its line lands. */
export const SPEED_SECONDS: Record<NoteSpeed, number> = { slow: 1.6, normal: 1, fast: 0.65 };
export const SPEEDS: readonly NoteSpeed[] = ['slow', 'normal', 'fast'];
export const OFFSET_LIMIT = 400;
export const OFFSET_STEP = 10;
export const DEFAULT_SETTINGS: Readonly<WsSettings> = { speed: 'normal', offsetMs: 0 };

const KEY = 'whosings-settings';

export function clampOffset(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  const snapped = Math.round(ms / OFFSET_STEP) * OFFSET_STEP;
  return Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, snapped));
}

/** Whatever's stored, coerced back into range; junk falls back to the defaults. */
export function parseSettings(raw: string | null): WsSettings {
  let obj: Partial<WsSettings> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') obj = parsed as Partial<WsSettings>;
  } catch { /* junk: defaults */ }
  const speed = SPEEDS.includes(obj.speed as NoteSpeed) ? (obj.speed as NoteSpeed) : DEFAULT_SETTINGS.speed;
  return { speed, offsetMs: clampOffset(Number(obj.offsetMs ?? 0)) };
}

export function loadSettings(): WsSettings {
  return parseSettings(getStorage(KEY));
}

export function saveSettings(s: WsSettings): void {
  setStorage(KEY, JSON.stringify({ speed: s.speed, offsetMs: clampOffset(s.offsetMs) }));
}
