export interface LinePart {
  lyric: string;
  range: [number, number];
  ans?: number[];
}

export interface LineObject {
  lyric?: string;               // required when no parts; omitted when parts is present
  lyric_jp?: string;            // Japanese lyrics (display-only)
  lyric_hangul?: string;        // Hangul lyrics (display-only)
  lyric_translation?: string;   // English translation (display-only)
  range?: [number, number];     // required when no parts; omitted when parts is present
  ans?: number[];
  parts?: LinePart[];
  diff?: number;
  tail?: string;
}

export type LineEntry = string | LineObject;

/** Raw song config as loaded from config.json */
export interface SongConfig {
  name: string;
  ogg: string;
  id: string;
  group: GroupName;
  mapping?: MappingEntry[];
  lyrics?: string | string[];
  lines?: LineEntry[];
  slots?: SlotDetail[];
  singers?: number[];
  calls?: MappingEntry[];
  theme?: string;
  hidden?: boolean;
  added?: string;
  released?: string;
  subunit?: string;
  menu?: GroupName;
  cover?: string;
  note?: 'unsynced';
}

export interface MappingEntry {
  range: [number, number];
  ans?: number[];
  diff?: number;
  kdur?: number;
  id: number; // assigned during preprocessing
  lyric?: string; // user-edited lyric text (edit mode only, not persisted in JSON)
}

export interface SlotDetail {
  command: 'group' | 'ignore';
  members?: number[];
  slots?: number[];
}

/**
 * A group's slug (e.g. "aqours", "seventeen"). Runtime-defined — groups are loaded
 * from songs/<slug>/group.json at startup. See groups.ts for the registry.
 */
export type GroupName = string;
export type SortMode = 'index' | 'date' | 'alpha';

export interface GroupMember {
  id: number;
  name: string;            // display name
  nameNative?: string;     // e.g. kanji / hangul
  color: string;           // primary palette hex
  colorOfficial?: string;  // optional secondary palette
}

export interface Subunit {
  /** Display name, e.g. "CYaRon!", "Hip-Hop Unit". */
  name: string;
  /** Optional slug used for grouping/sorting; derived from name if omitted. */
  slug?: string;
  /** Member IDs in this subunit. Order-insensitive for matching. */
  memberIds: number[];
}

export interface Group {
  slug: string;
  name: string;
  nameNative?: string;
  /** Script of the native-lyric lane: 'ja' (lyric_jp), 'ko' (lyric_hangul), or null. */
  nativeScript?: 'ja' | 'ko' | null;
  members: GroupMember[];
  subunits?: Subunit[];
  /** List of song JSON filenames to load (relative to songs/<slug>/). */
  songs?: string[];
  /** CSS text-color class for the group nav title (optional). */
  colorClass?: string;
}

/** Processed slot ready for gameplay */
export interface Slot {
  id: number;
  mapping: MappingEntry & { members?: number[] };
  range: [number, number];
  ans: number[];
  diff: number;
  active: boolean;
  revealed: boolean;
  choices: number[];
  state: SlotState;
  element: HTMLElement | null;
}

export enum SlotState {
  Idle = 0,
  Correct = 1,
  Wrong = 2,
}

/** Processed lyric token */
export interface LyricToken {
  id: number;
  type: 'text' | 'newline' | 'lyric' | 'next-col';
  text?: string;
  textJp?: string;
  /** When set, the effective highlight range in JP mode — spans all sibling parts. */
  rangeJp?: [number, number];
  /** Sibling part mappings (including self) for multi-part JP lines; present on first part only. */
  jpParts?: MappingEntry[];
  /** Last sub-part id the JP element was colored for (change-detection during playback). */
  activeJpPartId?: number;
  textHangul?: string;
  rangeHangul?: [number, number];
  hangulParts?: MappingEntry[];
  activeHangulPartId?: number;
  mapping?: MappingEntry;
  src?: 'mapping' | 'calls';
  push?: string;
  together?: boolean;
  active?: boolean;
  element?: HTMLElement;
}

/** Preprocessed song with derived game data */
export interface Song extends SongConfig {
  singers: number[];
  slotsBase: SlotBase[];
  lyricsBase: LyricToken[];
  calls: MappingEntry[];
}

export interface SlotBase {
  id: number;
  mapping: MappingEntry & { members?: number[] };
}

/** Global game state */
export interface GameState {
  group: GroupName;
  song: Song | null;
  mapping: MappingEntry[];
  singers: number[];
  slots: Slot[];
  lyrics: LyricToken[];
  reverseMap: Record<number, { slot?: Slot; lyric?: LyricToken }>;
  diff: number;
  autoscroll: boolean;
  themed: boolean;
  lyricsMode: number; // 0=off, 1=side, 2=full
  calls: boolean;
  callSFX: boolean;
  globalReveal: boolean;
  loaded: Date | null;
  assObjectURL: string;
  lastProgressUpdate: number | null;
  lastThemeUpdate: number | null;
  scrollSlotLock: number | null;
  scrollLyricLock: number | null;
  callSFXch: number;
  sortMode: SortMode;
  groupBySubunit: boolean;
  editMode: boolean;
  jpLyrics: boolean;
  controls: {
    lastSlotScroll: number;
    lastLyricScroll: number;
  };
}

export interface ChangelogEntry {
  date: string;
  change: string;
}

export interface HistoryEntry {
  date: string;
  songName: string;
  record: [number[], number[]][];
}

// Back-compat re-exports — prefer importing directly from './groups'.
export {
  MEMBER_MAPPING, MEMBER_COLORS, MEMBER_COLORS_OFFICIAL,
} from './groups';
