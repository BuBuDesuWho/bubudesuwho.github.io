import { Slot, SlotState, MappingEntry, LinePart } from './types';
import { arrayEqual, toTimeStr } from './utils';
import { state, makeSlotsFromBase, makeReverseMapping } from './game';

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
  state.reverseMap = makeReverseMapping(state.slots, state.lyrics);
}

export function setSlotStart(slot: Slot, time: number): void {
  const rounded = Math.round(time * 100) / 100;
  slot.range[0] = rounded;
}

export function setSlotEnd(slot: Slot, time: number): void {
  const rounded = Math.round(time * 100) / 100;
  slot.range[1] = rounded;
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
  state.mapping.splice(mapIdx + 1, 0, newEntry);
  state.mapping.forEach((m, i) => { m.id = i; });

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
  const slotIdx = state.slots.indexOf(slot);
  state.slots.splice(slotIdx + 1, 0, newSlot);
  state.slots.forEach((s, i) => { s.id = i; });
  state.reverseMap = makeReverseMapping(state.slots, state.lyrics);

  return newEntry;
}

export function deleteSlot(slot: Slot): void {
  const mapIdx = state.mapping.indexOf(slot.mapping);
  if (mapIdx !== -1) state.mapping.splice(mapIdx, 1);
  state.mapping.forEach((m, i) => { m.id = i; });

  const slotIdx = state.slots.indexOf(slot);
  if (slotIdx !== -1) state.slots.splice(slotIdx, 1);
  state.slots.forEach((s, i) => { s.id = i; });
  state.reverseMap = makeReverseMapping(state.slots, state.lyrics);
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

export function exportEditedConfig(): (object | string)[] {
  if (!state.song) return [];

  // If the song uses the lines format, reconstruct it by merging updated mapping back in
  if (state.song.lines) {
    let mappingIdx = 0;
    return state.song.lines.map((l) => {
      if (typeof l === 'string') return l;

      if (l.parts && l.parts.length > 0) {
        // Consume one mapping entry per part, reconstruct parts array — preserve
        // any non-edited sibling fields on each part (e.g. lyric_hangul on kpop).
        const updatedParts: LinePart[] = l.parts.map((part) => {
          const updated = state.mapping[mappingIdx++];
          if (!updated) return part;
          const { lyric: _lyric, range: _range, ans: _ans, ...partExtras } = part as LinePart & Record<string, unknown>;
          const updatedAns = updated.ans ?? [];
          const ans = arrayEqual(updatedAns, state.song!.singers) ? [] : updatedAns;
          return { lyric: updated.lyric ?? part.lyric, range: [updated.range[0], updated.range[1]], ans, ...partExtras } as LinePart;
        });
        const { parts: _parts, diff: _diff, ...lineExtras } = l as typeof l & Record<string, unknown>;
        return {
          ...lineExtras,
          parts: updatedParts,
          ...(l.diff && l.diff > 1 ? { diff: l.diff } : {}),
        };
      }

      const updated = state.mapping[mappingIdx++];
      if (!updated) return l;

      // Collapse all-singers back to [] — the preprocessor expands it at load time.
      const updatedAns = updated.ans ?? [];
      const ans = arrayEqual(updatedAns, state.song!.singers) ? [] : updatedAns;

      // Preserve sibling fields like lyric_hangul, lyric_translation, lyric_jp.
      const { lyric: _lyric, range: _range, ans: _ans, diff: _diff, ...extras } = l as typeof l & Record<string, unknown>;
      return {
        lyric: updated.lyric ?? l.lyric,
        range: [updated.range[0], updated.range[1]],
        ans,
        ...extras,
        ...(updated.diff && updated.diff > 1 ? { diff: updated.diff } : {}),
      };
    });
  }

  // Legacy mapping-only format
  return state.mapping.map((m) => ({
    range: [m.range[0], m.range[1]],
    ans: m.ans ?? [],
    ...(m.diff && m.diff > 1 ? { diff: m.diff } : {}),
  }));
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
