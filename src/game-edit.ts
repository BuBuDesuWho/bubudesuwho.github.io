import { Slot, SlotState, MappingEntry, LineEntry, LineObject, LinePart } from './types';
import { EditedConfig } from './save-mapping';
import { arrayEqual, toTimeStr } from './utils';
import { state, makeSlotsFromBase } from './game';
import { withInsertedAfter, withRemovedAt } from './mapping-edit';

export function setEditMode(val: boolean): void {
  state.editMode = val;
  if (!state.song) return;
  if (val) {
    // rebuild slots: one per mapping entry, no grouping, no filtering
    state.slots = state.mapping.map((m, i) => ({
      id: i,
      mapping: m,
      range: m.range,
      ans: m.ans ?? [],
      diff: m.diff ?? 1,
      active: false,
      revealed: false,
      choices: [],
      state: SlotState.Idle,
      element: null,
    }));
  } else {
    // restore grouped play-mode slots
    state.slots = makeSlotsFromBase(state.song.slotsBase);
  }
}

export function insertMappingAfter(slot: Slot): MappingEntry {
  const afterEnd = slot.range[1];
  const newEntry: MappingEntry = {
    range: [afterEnd, afterEnd + 2],
    ans: [],
    diff: 1,
    id: 0,
  };
  const mapIdx = state.mapping.indexOf(slot.mapping);
  state.mapping = withInsertedAfter(state.mapping, mapIdx, newEntry);

  const newSlot: Slot = {
    id: 0,
    mapping: newEntry,
    range: newEntry.range,
    ans: [],
    diff: 1,
    active: false,
    revealed: false,
    choices: [],
    state: SlotState.Idle,
    element: null,
  };
  // Reassign (not in-place splice) so the slot graph picks up the new list.
  const slotIdx = state.slots.indexOf(slot);
  const slots = state.slots.slice();
  slots.splice(slotIdx + 1, 0, newSlot);
  slots.forEach((s, i) => { s.id = i; });
  state.slots = slots;

  return newEntry;
}

export function deleteSlot(slot: Slot): void {
  const mapIdx = state.mapping.indexOf(slot.mapping);
  state.mapping = withRemovedAt(state.mapping, mapIdx);

  // Reassign (not in-place splice) so the slot graph picks up the new list.
  const slotIdx = state.slots.indexOf(slot);
  const slots = state.slots.slice();
  if (slotIdx !== -1) slots.splice(slotIdx, 1);
  slots.forEach((s, i) => { s.id = i; });
  state.slots = slots;
}

export function setSlotSingers(slot: Slot, singers: number[]): void {
  const sorted = singers.slice().sort((a, b) => a - b);
  slot.ans = sorted;
  slot.mapping.ans = sorted;
}

export function setSlotDiff(slot: Slot, diff: number): void {
  slot.diff = diff;
  slot.mapping.diff = diff;
}

export function setSlotLyric(slot: Slot, text: string): void {
  slot.mapping.lyric = text;
}

type LineOrigin = { line: number; part?: number };

/** Which original line (and part) each loaded mapping entry came from.
 *  normalizeLines emits one entry per part, or one per plain line, in order,
 *  so walking the original lines alongside `song.mapping` recovers it. Keyed by
 *  object identity: insert/delete build a new `state.mapping` but keep the
 *  surviving entry objects, and `song.mapping` keeps the load-time order. */
function lineOrigins(lines: LineEntry[], loaded: MappingEntry[]): Map<MappingEntry, LineOrigin> {
  const origins = new Map<MappingEntry, LineOrigin>();
  let k = 0;
  lines.forEach((l, line) => {
    if (typeof l === 'string') return;
    if (l.parts && l.parts.length > 0) l.parts.forEach((_, part) => origins.set(loaded[k++], { line, part }));
    else origins.set(loaded[k++], { line });
  });
  return origins;
}

/** A raw `ans` as preprocessSong leaves it: `[]`/`[0]` expand to the roster,
 *  anything else is sorted and de-duplicated. */
function ansAsLoaded(raw: number[], singers: number[]): number[] {
  if (raw.length === 0 || raw.includes(0)) return singers;
  return Array.from(new Set(raw)).sort((a, b) => a - b);
}

/** `ans` as it should be written. Missing stays missing (a plain, unquizzed
 *  line), and so does an inserted entry nobody set singers on, rather than
 *  turning into an all-members `[]`. An unchanged answer is written back as
 *  the file had it (explicit roster lists stay explicit); a changed one that
 *  is the full roster collapses to `[]`, which the preprocessor expands. */
function exportAns(ans: number[] | undefined, original: number[] | undefined, singers: number[]): number[] | undefined {
  if (ans && original && arrayEqual(ans, ansAsLoaded(original, singers))) return original;
  if (!ans || ans.length === 0) return undefined;
  return arrayEqual(ans, singers) ? [] : ans;
}

/** `base` (an original line or part, or `{}` for an inserted entry) with the
 *  edited timing, answer, difficulty and lyric applied. Spreading `base` first
 *  keeps sibling fields (lyric_jp, lyric_hangul, kdur, tail...) and key order. */
function applyEntry<T extends LineObject | LinePart>(base: Partial<T>, m: MappingEntry, singers: number[]): T {
  const out: Record<string, unknown> = {
    ...base,
    lyric: m.lyric ?? base.lyric ?? '',
    range: [m.range[0], m.range[1]],
  };
  const ans = exportAns(m.ans, base.ans, singers);
  if (ans) out.ans = ans;
  else delete out.ans;
  if (m.diff && m.diff > 1) out.diff = m.diff;
  else delete out.diff;
  return out as T;
}

/** Rebuild `lines` from the edited mapping, walking it in order: string
 *  separators stay where they were, a line whose entries were all deleted is
 *  dropped, and an inserted entry becomes a new line right after the line it
 *  was inserted below (or a new part, if it sits between two parts of one line). */
function exportLines(lines: LineEntry[], loaded: MappingEntry[], mapping: MappingEntry[], singers: number[]): LineEntry[] {
  const origins = lineOrigins(lines, loaded);
  const out: LineEntry[] = [];
  let next = 0; // first original line not yet emitted or dropped
  const separatorsUpTo = (end: number) => {
    for (; next < end; next++) {
      const l = lines[next];
      if (typeof l === 'string') out.push(l);
    }
  };

  let i = 0;
  while (i < mapping.length) {
    const origin = origins.get(mapping[i]);
    if (!origin) {
      out.push(applyEntry<LineObject>({}, mapping[i], singers));
      i++;
      continue;
    }
    separatorsUpTo(origin.line);
    const line = lines[origin.line] as LineObject;

    // This line's surviving entries, plus anything inserted between them.
    let last = i;
    for (let j = i + 1; j < mapping.length; j++) {
      const o = origins.get(mapping[j]);
      if (!o) continue;
      if (o.line !== origin.line) break;
      last = j;
    }
    const run = mapping.slice(i, last + 1);

    if (line.parts && line.parts.length > 0) {
      const parts = run.map((m) => {
        const part = origins.get(m)?.part;
        return applyEntry<LinePart>(part != null ? line.parts![part] : {}, m, singers);
      });
      out.push({ ...line, parts });
    } else {
      out.push(applyEntry<LineObject>(line, run[0], singers));
    }
    next = origin.line + 1;
    i = last + 1;
  }
  separatorsUpTo(lines.length);
  return out;
}

export function exportEditedConfig(): EditedConfig | null {
  const song = state.song;
  if (!song) return null;

  if (song.lines) {
    return { format: 'lines', lines: exportLines(song.lines, song.mapping ?? [], state.mapping, song.singers) };
  }

  // Mapping-only (legacy) songs list answers explicitly, and preprocessSong
  // rewrote these entries in place, so there's no raw value to fall back on:
  // write answers as loaded, minus unset ones on inserted entries.
  return {
    format: 'mapping',
    mapping: state.mapping.map((m) => {
      const ans = m.ans && m.ans.length > 0 ? m.ans : undefined;
      return {
        ...(ans ? { ans } : {}),
        range: [m.range[0], m.range[1]],
        ...(m.diff && m.diff > 1 ? { diff: m.diff } : {}),
      };
    }),
  };
}

// ─── ASS Export ─────────────────────────────────────────────────────
export function makeASSObjectURL(): string {
  if (!state.song) return '';
  const lines = [
    '[Script Info]',
    '; Script generated by GanbaWhoby',
    'Title: ' + state.song.name,
    'ScriptType: v4.00+',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  let curLines: string[] = [];
  let curStart: number | null = null;
  let curEnd: number | null = null;

  for (const lyric of state.lyrics) {
    if (lyric.src !== 'mapping') continue;
    if (lyric.type === 'newline' && curLines.length > 0) {
      const start = toTimeStr(curStart!, 0.1);
      const end = toTimeStr(curEnd!, 0.1);
      lines.push(`Dialogue: 0,0:0${start}0,0:0${end}0,Default,,0,0,0,,${curLines.join('')}`);
      curLines = [];
      curStart = null;
      curEnd = null;
    }
    if (lyric.type === 'text' || lyric.type === 'lyric') {
      curLines.push(lyric.text ?? '');
    }
    if (lyric.mapping) {
      if (curStart === null) curStart = lyric.mapping.range[0];
      curEnd = Math.max(curEnd ?? 0, lyric.mapping.range[1]);
    }
  }

  if (curLines.length > 0 && curStart !== null && curEnd !== null) {
    const start = toTimeStr(curStart, 0.1);
    const end = toTimeStr(curEnd, 0.1);
    lines.push(`Dialogue: 0,0:0${start}0,0:0${end}0,Default,,0,0,0,,${curLines.join('')}`);
  }

  const blob = new Blob([lines.join('\n')], { type: 'application/octet-stream' });
  return URL.createObjectURL(blob);
}
