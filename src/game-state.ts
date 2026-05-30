import { GameState } from './types';

// Pulled out of `game.ts` so non-play modules (e.g. `ui-menu.ts`) can read
// game state without dragging the player → howler chain into their bundle.
/** Pick the song title to display given the current JP-toggle state.
 *  Falls back to `name` when the song has no `name_jp` (e.g. K-pop, or a
 *  Liella song whose romaji and JP titles match). Lives here (not in
 *  game.ts) so non-play bundles like ui-menu.ts can call it without
 *  pulling howler/player into their tree. */
export function getSongTitle(song: { name: string; name_jp?: string }): string {
  if (state.jpLyrics && song.name_jp) return song.name_jp;
  return song.name;
}

export const state: GameState = {
  group: 'aqours',
  song: null,
  mapping: [],
  singers: [],
  slots: [],
  lyrics: [],
  reverseMap: {},
  diff: 1,
  autoscroll: true,
  themed: true,
  lyricsMode: 0,
  calls: false,
  callSFX: false,
  globalReveal: false,
  hints: false,
  inline: false,
  loaded: null,
  assObjectURL: '',
  lastProgressUpdate: null,
  lastThemeUpdate: null,
  scrollSlotLock: null,
  scrollLyricLock: null,
  sortMode: 'index',
  groupBySubunit: false,
  editMode: false,
  jpLyrics: false,
  callSFXch: 0,
  controls: { lastSlotScroll: 0, lastLyricScroll: 0 },
};
