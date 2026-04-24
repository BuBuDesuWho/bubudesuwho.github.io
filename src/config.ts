import {
  SongConfig, Song, MappingEntry, SlotBase, SlotDetail, LyricToken, Group,
} from './types';
import { arrayEqual } from './utils';
import { registerGroup } from './groups';

let songs: Song[] = [];

async function loadGroups(base: string, mode: 'anime' | 'kpop'): Promise<void> {
  const resp = await fetch(base + `songs/groups.${mode}.json?t=` + Date.now());
  if (!resp.ok) {
    console.warn(`songs/groups.${mode}.json missing (${resp.status}); registry will be empty`);
    return;
  }
  const { groups: slugs } = await resp.json() as { groups: string[] };
  await Promise.all(slugs.map(async (slug) => {
    const gr = await fetch(base + 'songs/' + slug + '/group.json?t=' + Date.now());
    if (!gr.ok) {
      console.warn(`songs/${slug}/group.json missing (${gr.status})`);
      return;
    }
    const g = await gr.json() as Group;
    registerGroup(g);
  }));
}

export async function loadConfig(): Promise<Song[]> {
  const base = import.meta.env.BASE_URL;
  const raw: SongConfig[] = [];

  const mode = import.meta.env.VITE_APP_MODE === 'kpop' ? 'kpop' : 'anime';
  await loadGroups(base, mode);

  const indexResp = await fetch(base + `songs/index.${mode}.json?t=` + Date.now());
  const indexEntries: (string | { file: string; cover?: string })[] = await indexResp.json();
  const results = await Promise.allSettled(
    indexEntries.map(async (entry) => {
      const file = typeof entry === 'string' ? entry : entry.file;
      const cover = typeof entry === 'object' ? entry.cover : undefined;
      const r = await fetch(base + 'songs/' + file + '?t=' + Date.now());
      if (!r.ok) throw new Error(`${r.status} ${file}`);
      const cfg = await r.json() as SongConfig;
      if (cover && !cfg.cover) cfg.cover = cover;
      return cfg;
    }),
  );
  for (const result of results) {
    if (result.status === 'fulfilled') raw.push(result.value);
    else console.warn('Failed to load song:', result.reason);
  }

  // Deduplicate by id — preserves songs/index.json order
  const seen = new Map<string, SongConfig>();
  for (const cfg of raw) {
    if (cfg.id) seen.set(cfg.id, cfg);
  }

  songs = Array.from(seen.values()).map(preprocessSong);
  return songs;
}

export function getSongs(): Song[] {
  return songs;
}

interface NormalizedJp {
  jpTexts: (string | undefined)[];
  jpRanges: ([number, number] | undefined)[];
  jpParts: (MappingEntry[] | undefined)[];
}

function normalizeLines(cfg: SongConfig): NormalizedJp | undefined {
  if (!cfg.lines) { console.log(`[legacy] ${cfg.id}`); return undefined; }
  const mappingEntries: MappingEntry[] = [];
  const lyricParts: string[] = [];
  const jpTexts: (string | undefined)[] = [];
  const jpRanges: ([number, number] | undefined)[] = [];
  const jpParts: (MappingEntry[] | undefined)[] = [];

  for (const line of cfg.lines) {
    if (typeof line === 'string') {
      lyricParts.push(line);
    } else if (line.parts && line.parts.length > 0) {
      // Native text: accept either lyric_jp or lyric_hangul; the loader is
      // agnostic to script (group.json's nativeScript drives UI labels).
      const nativeText = line.lyric_jp ?? line.lyric_hangul;
      // When native text is present and spans multiple parts, the first part owns
      // the visible glow for the full span (subsequent parts render as display:none).
      const spansAll = nativeText != null && line.parts.length > 1
        ? [line.parts[0].range[0], line.parts[line.parts.length - 1].range[1]] as [number, number]
        : undefined;
      const partMappings: MappingEntry[] = [];
      for (let pi = 0; pi < line.parts.length; pi++) {
        const part = line.parts[pi];
        const { lyric: _l, ...m } = part;
        const entry = m as MappingEntry;
        mappingEntries.push(entry);
        partMappings.push(entry);
        // First part gets the full native text; subsequent parts get empty string (hidden in native mode)
        jpTexts.push(pi === 0 ? nativeText : (nativeText != null ? '' : undefined));
        jpRanges.push(pi === 0 ? spansAll : undefined);
        jpParts.push(undefined);
      }
      // Attach sibling mappings to the first part (only when native text spans >1 part,
      // since that's the only scenario where the native element stays visible across sub-parts).
      if (spansAll) {
        jpParts[jpParts.length - line.parts.length] = partMappings;
      }
      // Emit all parts on one display line — space-separated so the full
      // lyric appears as a single line rather than one line per part.
      lyricParts.push(line.parts.map(p => '{' + p.lyric + '}').join(' '));
    } else {
      const { lyric: _l, tail: _t, parts: _p, lyric_jp: _jp, lyric_hangul: _hg, lyric_translation: _tr, ...m } = line;
      mappingEntries.push(m as MappingEntry);
      lyricParts.push('{' + line.lyric + '}');
      jpTexts.push(line.lyric_jp ?? line.lyric_hangul);
      jpRanges.push(undefined);
      jpParts.push(undefined);
    }
  }

  cfg.mapping = mappingEntries;
  cfg.lyrics = lyricParts.join('\n');
  return { jpTexts, jpRanges, jpParts };
}

function preprocessSong(cfg: SongConfig): Song {
  const normalized = normalizeLines(cfg);

  // assign IDs to mappings
  (cfg.mapping ?? []).forEach((m, idx) => {
    m.id = idx;
    if (m.diff == null) m.diff = 1;
    if (m.ans != null && (m.ans.length === 0 || m.ans.indexOf(0) !== -1)) {
      m.ans = findSingers(cfg.mapping ?? []).slice();
    }
  });

  const mapping = cfg.mapping ?? [];
  const singers = cfg.singers ?? findSingers(mapping);
  const calls = cfg.calls ?? [];
  const slotsBase = preprocessSlots(mapping, cfg.slots, singers);
  const lyricsBase = preprocessLyrics(
    cfg.name,
    { mapping, calls },
    cfg.lyrics,
    normalized?.jpTexts,
    normalized?.jpRanges,
    normalized?.jpParts,
  );

  return {
    ...cfg,
    singers,
    calls,
    slotsBase,
    lyricsBase,
  };
}

function findSingers(mapping: MappingEntry[]): number[] {
  const seen = new Set<number>();
  for (const m of mapping) {
    if (m.ans) {
      for (const s of m.ans) {
        if (s > 0) seen.add(s);
      }
    }
  }
  return Array.from(seen).sort((a, b) => a - b);
}

function preprocessSlots(
  mapping: MappingEntry[],
  slotDetails: SlotDetail[] | undefined,
  singers: number[],
): SlotBase[] {
  // filter out "all singers" entries — nothing to guess
  const quizEntries = mapping
    .filter((m) => m.ans != null)
    .filter((m) => !arrayEqual(m.ans!, singers));

  // auto-group consecutive entries with the same ans
  // Only group if they are originally adjacent (consecutive IDs) — prevents merging
  // across all-singer separator lines that were filtered out above.
  let idCounter = mapping.length;
  const slots: SlotBase[] = [];
  let i = 0;
  while (i < quizEntries.length) {
    let j = i + 1;
    while (
      j < quizEntries.length &&
      arrayEqual(quizEntries[j].ans!, quizEntries[i].ans!) &&
      quizEntries[j].id === quizEntries[j - 1].id + 1
    ) {
      j++;
    }
    if (j - i > 1) {
      // grouped
      const group = {
        members: quizEntries.slice(i, j).map((m) => m.id),
        id: idCounter++,
        ans: quizEntries[i].ans,
        diff: quizEntries[i].diff,
        range: [
          quizEntries[i].range[0],
          quizEntries[j - 1].range[1],
        ] as [number, number],
      };
      slots.push({ id: 0, mapping: group as SlotBase['mapping'] });
    } else {
      slots.push({ id: 0, mapping: quizEntries[i] });
    }
    i = j;
  }

  // apply ignore directives if present
  let result = slots;
  if (slotDetails) {
    for (const detail of slotDetails) {
      if (detail.command === 'ignore' && detail.slots) {
        result = result.filter((s) => !detail.slots!.includes(s.mapping.id));
      }
    }
  }

  result.forEach((s, idx) => { s.id = idx; });
  return result;
}

function preprocessLyrics(
  songName: string,
  mappings: { mapping: MappingEntry[]; calls: MappingEntry[] },
  lyricsDefinition: string | string[] | undefined,
  jpTexts?: (string | undefined)[],
  jpRanges?: ([number, number] | undefined)[],
  jpParts?: (MappingEntry[] | undefined)[],
): LyricToken[] {
  if (!lyricsDefinition) return [];

  const raw = Array.isArray(lyricsDefinition)
    ? lyricsDefinition.join('\n')
    : lyricsDefinition;

  // lex
  const tokenStrings = raw.match(/\n|\[|]|\{|}|[^[\]{}\n]+/g);
  if (!tokenStrings) return [];

  type TokenType = 'opening_brace' | 'closing_brace' | 'opening_bracket' | 'closing_bracket' | 'newline' | 'text';
  interface Token { type: TokenType; str?: string; }

  const toTokenObj = (str: string): Token => {
    if (str === '{') return { type: 'opening_brace' };
    if (str === '}') return { type: 'closing_brace' };
    if (str === '[') return { type: 'opening_bracket' };
    if (str === ']') return { type: 'closing_bracket' };
    if (str === '\n') return { type: 'newline' };
    return { type: 'text', str };
  };

  const tokens = tokenStrings.map(toTokenObj);
  const lyrics: LyricToken[] = [];
  let src: 'mapping' | 'calls' = 'mapping';
  let endcallBreak = false;
  let together = false;
  let push: string | undefined;

  const sources = Object.keys(mappings) as (keyof typeof mappings)[];
  const refs: Record<string, number> = {};
  for (const s of sources) refs[s] = 0;

  for (let i = 0; i < tokens.length;) {
    const t = tokens[i];
    if (t.type === 'text') {
      lyrics.push({ id: 0, type: 'text', text: t.str, src, push });
      push = undefined;
      i++;
    } else if (t.type === 'newline') {
      lyrics.push({ id: 0, type: 'newline', src: endcallBreak ? 'calls' : src });
      endcallBreak = false;
      i++;
    } else if (t.type === 'opening_bracket') {
      if (!(i + 2 < tokens.length && tokens[i + 1].type === 'text' && tokens[i + 2].type === 'closing_bracket')) {
        console.error(`Syntax error in lyrics for "${songName}": unclosed or empty bracket "[" at token ${i}. Next tokens: ${tokens.slice(i, i + 3).map(t => t.str ?? t.type).join(', ')}`);
        return [];
      }
      const func = tokens[i + 1].str!.split(',');
      if (func[0] === 'call') src = 'calls';
      else if (func[0] === 'end-call') { src = 'mapping'; endcallBreak = true; }
      else if (func[0] === 'next-col') lyrics.push({ id: 0, type: 'next-col' });
      else if (func[0] === 'push') push = func[1];
      else if (func[0] === 'together') together = true;
      i += 3;
    } else if (t.type === 'opening_brace') {
      // Consume everything up to the matching } as raw text, so lyric
      // strings containing literal [ or ] (e.g. "[A]qours days") don't
      // get mis-parsed as directive brackets.
      i++;
      let rawText = '';
      while (i < tokens.length && tokens[i].type !== 'closing_brace') {
        const tok = tokens[i];
        if (tok.type === 'text') rawText += tok.str;
        else if (tok.type === 'opening_bracket') rawText += '[';
        else if (tok.type === 'closing_bracket') rawText += ']';
        else { console.error(`Syntax error in lyrics for "${songName}": unexpected ${tok.type} inside braces at token ${i}. Only text, [, and ] are allowed inside {}`); return []; }
        i++;
      }
      if (i >= tokens.length) { console.error(`Syntax error in lyrics for "${songName}": unclosed {`); return []; }
      i++; // consume closing_brace

      const srcMapping = mappings[src];
      if (!srcMapping) {
        console.error(`Unknown lyrics src "${src}" in "${songName}"`);
        return [];
      }

      const text = rawText;

      if (refs[src] >= srcMapping.length) {
        console.warn(`Lyrics ref ${refs[src]} for src "${src}" exceeds mapping count`);
        break;
      }
      const jpIdx = refs[src];
      const matched = srcMapping[refs[src]];
      refs[src]++;

      const textJp = src === 'mapping' && jpTexts ? jpTexts[jpIdx] : undefined;
      const rangeJp = src === 'mapping' && jpRanges ? jpRanges[jpIdx] : undefined;
      const partsJp = src === 'mapping' && jpParts ? jpParts[jpIdx] : undefined;
      lyrics.push({
        id: 0,
        type: 'lyric',
        text,
        textJp,
        rangeJp,
        jpParts: partsJp,
        mapping: matched,
        src,
        push,
        together,
      });
      push = undefined;
      together = false;
    } else {
      console.error(`Syntax error in lyrics for "${songName}": unexpected token "${t.type}" at position ${i}. Expected text, newline, [, or {`);
      return [];
    }
  }

  lyrics.forEach((l, idx) => { l.id = idx; });
  return lyrics;
}

export async function loadChangelog(): Promise<{ date: string; change: string }[]> {
  const resp = await fetch(import.meta.env.BASE_URL + 'changelog.json');
  return resp.json();
}
