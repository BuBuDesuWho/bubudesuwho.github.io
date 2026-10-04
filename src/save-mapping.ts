import { LineEntry } from './types';

// The contract between edit mode (client) and the dev server's
// /api/save-mapping endpoint (saveMappingPlugin in vite.config.ts). Pure, no
// node or DOM imports, so both sides and the tests can share it.

/** A mapping-only song's entry as written to disk. */
export interface MappingRecord {
  ans?: number[];
  range: [number, number];
  diff?: number;
}

/** What edit mode exports. `format` mirrors the song file: a song with `lines`
 *  is saved as `lines`, a legacy mapping-only song as `mapping`. */
export type EditedConfig =
  | { format: 'lines'; lines: LineEntry[] }
  | { format: 'mapping'; mapping: MappingRecord[] };

export type SaveMappingRequest = EditedConfig & { songId: string; group: string };

export interface SongIndexEntry {
  id: string;
  group: string;
  file: string;
}

export type SaveResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Index `file` paths are relative to songs/. Accept only plain relative
 *  segments so a bad index entry can never point the writer outside songs/. */
export function isSafeSongFile(file: string): boolean {
  if (!file.endsWith('.json')) return false;
  return file.split('/').every((seg) => SAFE_SEGMENT.test(seg) && seg !== '..');
}

/** Find the song's file (relative to songs/) in the merged song indexes. Ids
 *  are not unique across groups (e.g. `run` is both Stray Kids and BTS), so
 *  match on id + group. */
export function resolveSongFile(
  index: SongIndexEntry[],
  songId: string,
  group: string,
): SaveResult<string> {
  const matches = index.filter((e) => e.id === songId && e.group === group);
  if (matches.length === 0) {
    return { ok: false, status: 404, error: `Song "${songId}" (group "${group}") not found in songs/index.*.json` };
  }
  if (matches.length > 1) {
    return { ok: false, status: 409, error: `Song "${songId}" (group "${group}") is listed ${matches.length} times in songs/index.*.json` };
  }
  const { file } = matches[0];
  if (!isSafeSongFile(file)) {
    return { ok: false, status: 400, error: `Refusing to write "${file}": not a plain path under songs/` };
  }
  return { ok: true, value: file };
}

/** Merge an edit into the song config read from disk. Refuses an edit whose
 *  format doesn't match the file, since a `mapping` written next to `lines`
 *  is overwritten on load (and `lines` without lyrics renders as {undefined}). */
export function applyEditedConfig(
  cfg: Record<string, unknown>,
  req: SaveMappingRequest,
): SaveResult<Record<string, unknown>> {
  if (cfg.id !== req.songId || cfg.group !== req.group) {
    return { ok: false, status: 409, error: `File holds "${String(cfg.id)}" (group "${String(cfg.group)}"), expected "${req.songId}" (group "${req.group}")` };
  }
  const fileFormat = Array.isArray(cfg.lines) ? 'lines' : 'mapping';
  if (req.format !== fileFormat) {
    return { ok: false, status: 409, error: `Edit is "${req.format}" format but the file uses "${fileFormat}"` };
  }
  if (req.format === 'lines') {
    if (!Array.isArray(req.lines)) return { ok: false, status: 400, error: 'Missing lines array' };
    return { ok: true, value: { ...cfg, lines: req.lines } };
  }
  if (!Array.isArray(req.mapping)) return { ok: false, status: 400, error: 'Missing mapping array' };
  const mapping = req.mapping.slice().sort((a, b) => a.range[0] - b.range[0]);
  return { ok: true, value: { ...cfg, mapping } };
}

/** Number of timed entries in an edit, for the "Saved (N entries)" toast. */
export function countEntries(edit: EditedConfig): number {
  if (edit.format === 'mapping') return edit.mapping.length;
  return edit.lines.reduce((n, l) => {
    if (typeof l === 'string') return n;
    return n + (l.parts && l.parts.length > 0 ? l.parts.length : 1);
  }, 0);
}
