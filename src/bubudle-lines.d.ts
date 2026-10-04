import type { GroupName, LineEntry, LineObject } from './types';

export interface SongLine {
  lyric: string;
  lyricJp?: string;
  ans: number[];
  range: [number, number];
  diff: number;
  sourceLine: LineObject;
}

export interface SongLines {
  singers: number[];
  lines: SongLine[];
}

/** One line in the pool file: [start, end] or [start, end, diff]. */
export type PoolLine = [number, number] | [number, number, number];

/** A song as the Bubudle pool file carries it. */
export interface PoolSong {
  id: string;
  group: GroupName;
  menu?: GroupName;
  singers: number[];
  lines: PoolLine[];
}

interface LinesSource {
  id: string;
  group: GroupName;
  menu?: GroupName;
  hidden?: boolean;
  lines?: LineEntry[];
}

export function songLines(song: LinesSource): SongLines | null;
export function poolSong(song: LinesSource): PoolSong | null;
