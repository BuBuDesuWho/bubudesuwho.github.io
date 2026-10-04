/// <reference types="node" />
// Song-data integrity checker. Shared by src/song-data.test.ts (vitest) and
// scripts/validate-songs.ts (CLI) so the two never drift on what "valid" means.
//
// Reads songs/ straight off disk (not through config.ts's fetch-based loader,
// which needs a browser/Vite runtime) but runs every raw config through the
// app's own `preprocessSong` so a config that breaks real loading fails here
// too.

import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { preprocessSong } from './config';
import type { Group, LineEntry, MappingEntry, SongConfig } from './types';

const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
export const SONGS_ROOT = join(SRC_DIR, '..', 'songs');

// Non-song JSON that lives at the top of songs/ (catalog indexes, totals, the
// daily-repeat manifest) — never a per-song config.
const TOP_LEVEL_SKIP = new Set([
  'daily-manifest.json',
  'groups.anime.json',
  'groups.kpop.json',
  'index.anime.json',
  'index.kpop.json',
  'totals.anime.json',
  'totals.kpop.json',
  'voice-guide.anime.json',
]);

// Directories under songs/ that aren't a registered group's song folder.
const DIR_SKIP = new Set(['legacy', 'legacy-reformat']);

export interface SongFile {
  group: string;
  file: string; // basename, e.g. "after-the-rain.json"
  path: string; // absolute path
}

/** Every group slug registered for either app mode (mirrors groups.ts's registry sources). */
export function registeredGroupSlugs(): string[] {
  const slugs = new Set<string>();
  for (const mode of ['anime', 'kpop'] as const) {
    const { groups } = JSON.parse(
      readFileSync(join(SONGS_ROOT, `groups.${mode}.json`), 'utf8'),
    ) as { groups: string[] };
    for (const g of groups) slugs.add(g);
  }
  return Array.from(slugs);
}

export function loadGroupJson(slug: string): Group {
  return JSON.parse(readFileSync(join(SONGS_ROOT, slug, 'group.json'), 'utf8')) as Group;
}

/** Every real song config under songs/<group>/*.json, skipping group.json and legacy dirs.
 *  Sorted (groups, then files within each) so "which file is the duplicate" in
 *  the duplicate-id check is deterministic regardless of filesystem readdir order. */
export function discoverSongFiles(): SongFile[] {
  const out: SongFile[] = [];
  for (const group of registeredGroupSlugs().sort()) {
    if (DIR_SKIP.has(group)) continue;
    const dir = join(SONGS_ROOT, group);
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.json')) continue;
      if (file === 'group.json') continue;
      if (TOP_LEVEL_SKIP.has(file)) continue;
      out.push({ group, file, path: join(dir, file) });
    }
  }
  return out;
}

export type ViolationRule =
  | 'parse-error'
  | 'preprocess-throws'
  | 'missing-field'
  | 'id-mismatch'
  | 'duplicate-id'
  | 'unknown-ans-member'
  | 'unknown-group'
  | 'bad-range'
  | 'zero-length-range'
  | 'overlapping-lines';

export interface Violation {
  group: string;
  file: string;
  songId: string | null;
  rule: ViolationRule;
  detail: string;
}

const REQUIRED_FIELDS: (keyof SongConfig)[] = ['name', 'id', 'group', 'ogg'];

export function collectRanges(cfg: SongConfig): { range: unknown; ans: unknown; where: string }[] {
  const out: { range: unknown; ans: unknown; where: string }[] = [];
  const pushMapping = (m: MappingEntry, where: string) => out.push({ range: m.range, ans: m.ans, where });

  for (const m of cfg.mapping ?? []) pushMapping(m, 'mapping');
  for (const c of cfg.calls ?? []) pushMapping(c, 'calls');

  const visitLine = (line: LineEntry, idx: number) => {
    if (typeof line === 'string') return;
    if (line.parts && line.parts.length > 0) {
      line.parts.forEach((p, pi) => out.push({ range: p.range, ans: p.ans, where: `lines[${idx}].parts[${pi}]` }));
    } else {
      out.push({ range: line.range, ans: line.ans, where: `lines[${idx}]` });
    }
  };
  (cfg.lines ?? []).forEach(visitLine);

  return out;
}

// Same overlap rule as scripts/audit_config.py: a line may start up to 1 s before
// the previous line ends (staggered phrasing), background "(...)" lines with no
// singers are skipped, and a "" separator resets the comparison.
const OVERLAP_TOLERANCE_S = 1;

function lineSpan(line: Exclude<LineEntry, string>): [number, number] | null {
  const first = line.parts?.length ? line.parts[0].range : line.range;
  const last = line.parts?.length ? line.parts[line.parts.length - 1].range : line.range;
  if (!Array.isArray(first) || !Array.isArray(last)) return null;
  return [first[0], last[1]];
}

function findLineOverlaps(cfg: SongConfig): string[] {
  const out: string[] = [];
  let prevEnd: number | null = null;
  (cfg.lines ?? []).forEach((line, i) => {
    if (typeof line === 'string') {
      prevEnd = null;
      return;
    }
    const span = lineSpan(line);
    if (!span || typeof span[0] !== 'number' || typeof span[1] !== 'number') return;
    const isBackground = !line.parts?.length && (line.lyric ?? '').startsWith('(')
      && Array.isArray(line.ans) && line.ans.length === 0;
    if (isBackground) return;
    if (prevEnd !== null && span[0] < prevEnd - OVERLAP_TOLERANCE_S) {
      out.push(`lines[${i}]: start ${span[0]} < previous end ${prevEnd}`);
    }
    prevEnd = span[1];
  });
  return out;
}

/** Member ids valid for `ans` values in this group: main roster + supplementary
 *  guests (memberName/MEMBER_MAPPING resolve both), plus the `0` = "all singers"
 *  sentinel that preprocessSong expands. */
function validAnsIds(group: Group): Set<number> {
  const ids = new Set<number>([0]);
  for (const m of group.members) ids.add(m.id);
  for (const m of group.supplementaryMembers ?? []) ids.add(m.id);
  return ids;
}

/** Validates one song. `roster` is the Group matching `cfg.group` (the field
 *  that actually drives runtime lookups via groups.ts) — NOT necessarily the
 *  group whose folder the file lives in; a handful of collab songs are filed
 *  under one group's directory but declare a different `group` field (e.g.
 *  songs/aqours/after-the-rain.json declares group: "saint-aqours-snow"). */
export function validateSong(cfg: SongConfig, roster: Group | undefined, sf: SongFile): Violation[] {
  const violations: Violation[] = [];
  const push = (rule: ViolationRule, detail: string) =>
    violations.push({ group: sf.group, file: sf.file, songId: cfg.id ?? null, rule, detail });

  for (const field of REQUIRED_FIELDS) {
    if (cfg[field] == null || cfg[field] === '') push('missing-field', `missing "${field}"`);
  }

  const expectedId = basename(sf.file, '.json');
  if (cfg.id && cfg.id !== expectedId) {
    push('id-mismatch', `id "${cfg.id}" does not match filename "${sf.file}"`);
  }

  if (!roster) {
    push('unknown-group', `cfg.group "${cfg.group}" is not a registered group; cannot check ans ids`);
    return violations;
  }
  const validIds = validAnsIds(roster);
  for (const { range, ans, where } of collectRanges(cfg)) {
    if (!Array.isArray(range) || range.length !== 2
      || typeof range[0] !== 'number' || typeof range[1] !== 'number'
      || range[0] < 0 || range[1] < 0 || range[0] > range[1]) {
      push('bad-range', `${where}: range ${JSON.stringify(range)} is not a valid [start,end]`);
    } else if (range[0] === range[1]) {
      push('zero-length-range', `${where}: zero-length range ${JSON.stringify(range)}`);
    }
    if (Array.isArray(ans)) {
      for (const a of ans as unknown[]) {
        if (typeof a === 'number' && !validIds.has(a)) {
          push('unknown-ans-member', `${where}: ans member id ${a} not in ${cfg.group}'s roster`);
        }
      }
    }
  }

  for (const detail of findLineOverlaps(cfg)) push('overlapping-lines', detail);

  try {
    preprocessSong(structuredClone(cfg));
  } catch (e) {
    push('preprocess-throws', e instanceof Error ? e.message : String(e));
  }

  return violations;
}

// Known-bad configs that predate a rule: tracked, not fixed here (songs/ is
// curated by hand). src/song-data.test.ts pins the counts; the gate treats a
// match as a warning instead of a failure.
// Keyed by `${group}/${file}:${rule}`. A count guards against the allowlist
// silently absorbing new violations on an already-listed file.
//
// The first 14 entries (id-mismatch/duplicate-id) are the same shape: an orphaned "-v2"/"-bck"
// backup copy that duplicates a shipped song's `id`. None of these files are
// referenced by songs/index.anime.json, so nothing actually loads them at
// runtime — see docs/trackers/song-data-audit-2026-09-27.md.
export const KNOWN_VIOLATIONS: Record<string, number> = {
  'muse/bokuhika-v2.json:id-mismatch': 1,
  'muse/bokuhika.json:duplicate-id': 1,
  'muse/borarara-v2.json:id-mismatch': 1,
  'muse/borarara.json:duplicate-id': 1,
  'muse/cp-v2.json:id-mismatch': 1,
  'muse/cp.json:duplicate-id': 1,
  'muse/mogyu-v2.json:id-mismatch': 1,
  'muse/mogyu.json:duplicate-id': 1,
  'muse/rabumaji-v2.json:id-mismatch': 1,
  'muse/rabumaji.json:duplicate-id': 1,
  'muse/ssh-v2.json:id-mismatch': 1,
  'muse/ssh.json:duplicate-id': 1,
  'nijigasaki/monster-girls-bck.json:id-mismatch': 1,
  'nijigasaki/monster-girls.json:duplicate-id': 1,
  // Structural rules added with the song gate (npm run gate). Songs that predate
  // them are listed so they stay visible; new songs must pass. overlapping-lines
  // mirrors audit_config.py (start > 1s before the previous end), so most of these
  // are real staggered-phrasing timing, not broken data.
  'aqours/deep-blue.json:overlapping-lines': 1,
  'aqours/fantastic-departure.json:overlapping-lines': 1,
  'aqours/hajimari-road.json:overlapping-lines': 1,
  'aqours/innocent-bird-v2.json:overlapping-lines': 1,
  'aqours/my-list-to-you-v2.json:overlapping-lines': 1,
  'aqours/namida-ga-yuki-ni-naru-mae-ni.json:overlapping-lines': 1,
  'aqours/namida-times.json:zero-length-range': 5,
  'aqours/not-alone-not-hitori.json:overlapping-lines': 1,
  'aqours/phantom-rocket-adventure.json:overlapping-lines': 1,
  'aqours/silent-pain.json:overlapping-lines': 1,
  'aqours/tokimeki-bunruigaku-v2.json:overlapping-lines': 1,
  'aqours/wonderful-stories-v2.json:overlapping-lines': 1,
  'bts/am-i-wrong.json:overlapping-lines': 1,
  'bts/dionysus.json:overlapping-lines': 1,
  'bts/dynamite.json:overlapping-lines': 2,
  'bts/intro-persona.json:overlapping-lines': 2,
  'bts/intro-serendipity.json:overlapping-lines': 1,
  'bts/jump.json:overlapping-lines': 1,
  'bts/lie.json:overlapping-lines': 1,
  'bts/on-jp.json:overlapping-lines': 1,
  'bts/satoori-rap.json:overlapping-lines': 1,
  'bts/the-rise-of-bangtan.json:overlapping-lines': 1,
  'muse/dreamin-go-go.json:overlapping-lines': 2,
  'muse/kira-kira-sensation.json:overlapping-lines': 1,
  'muse/mi-wa-sic-no-mi.json:overlapping-lines': 2,
  'muse/private-wars.json:overlapping-lines': 1,
  'muse/shocking-party.json:overlapping-lines': 2,
  'muse/super-lovesuper-live.json:overlapping-lines': 2,
  'nijigasaki/eternal-light.json:overlapping-lines': 1,
  'nijigasaki/fashionista.json:overlapping-lines': 3,
  'nijigasaki/folklore-kanki-no-uta.json:overlapping-lines': 1,
  'nijigasaki/hurray-hurray.json:overlapping-lines': 1,
  'nijigasaki/make-up-session-abc.json:overlapping-lines': 1,
  'nijigasaki/ryouran-victory-road.json:overlapping-lines': 1,
  'nijigasaki/twinkle-town.json:overlapping-lines': 1,
  'seventeen/chuck.json:overlapping-lines': 1,
  'seventeen/if-i.json:overlapping-lines': 1,
  'seventeen/lean-on-me.json:overlapping-lines': 1,
  'seventeen/omg.json:overlapping-lines': 1,
  'seventeen/snap-shoot.json:overlapping-lines': 1,
  'seventeen/space.json:overlapping-lines': 3,
  'seventeen/spell.json:overlapping-lines': 2,
  'seventeen/still-lonely.json:overlapping-lines': 1,
  'seventeen/super.json:overlapping-lines': 6,
  'stray-kids/0325.json:overlapping-lines': 5,
  'stray-kids/ceremony.json:overlapping-lines': 1,
  'stray-kids/domino.json:overlapping-lines': 2,
  'stray-kids/haven.json:overlapping-lines': 1,
  'stray-kids/maze-of-memories.json:overlapping-lines': 1,
  'stray-kids/mixtape-time-out.json:overlapping-lines': 1,
  'stray-kids/piece-of-a-puzzle.json:overlapping-lines': 1,
  'stray-kids/ta.json:overlapping-lines': 2,
  'twice/bdz.json:overlapping-lines': 1,
  'twice/bloom.json:overlapping-lines': 2,
  'twice/ffw.json:overlapping-lines': 3,
  'twice/heart-shaker.json:overlapping-lines': 2,
  'twice/hi-hello.json:overlapping-lines': 1,
  'twice/hold-me-tight.json:overlapping-lines': 1,
  'twice/i-got-you.json:overlapping-lines': 3,
  'twice/kiss-my-troubles-away.json:overlapping-lines': 5,
  'twice/mars.json:overlapping-lines': 2,
  'twice/me-you.json:overlapping-lines': 2,
  'twice/ooh-ahh.json:overlapping-lines': 1,
  'twice/options.json:overlapping-lines': 1,
  'twice/ponytail.json:overlapping-lines': 1,
  'twice/queen-of-hearts.json:overlapping-lines': 3,
  'twice/seesaw.json:overlapping-lines': 1,
  'twice/strawberry.json:overlapping-lines': 1,
  'twice/stuck-in-my-head.json:overlapping-lines': 1,
  'twice/talk-that-talk.json:overlapping-lines': 1,
  'twice/trouble.json:overlapping-lines': 1,
  'twice/truth.json:overlapping-lines': 6,
  'twice/tt.json:overlapping-lines': 5,
  'twice/when-we-were-kids.json:overlapping-lines': 2,
  'twice/young-wild.json:overlapping-lines': 1,
};

export function violationKey(v: Violation): string {
  return `${v.group}/${v.file}:${v.rule}`;
}

export interface ValidationResult {
  songCount: number;
  violations: Violation[];
}

export function validateAllSongs(): ValidationResult {
  const files = discoverSongFiles();
  const registered = new Set(registeredGroupSlugs());
  const groupJsonCache = new Map<string, Group>();
  const idsSeenPerGroup = new Map<string, Map<string, string>>(); // group -> id -> first file
  const violations: Violation[] = [];

  const rosterFor = (slug: string): Group | undefined => {
    if (!registered.has(slug)) return undefined;
    let g = groupJsonCache.get(slug);
    if (!g) {
      g = loadGroupJson(slug);
      groupJsonCache.set(slug, g);
    }
    return g;
  };

  for (const sf of files) {
    let cfg: SongConfig;
    try {
      cfg = JSON.parse(readFileSync(sf.path, 'utf8')) as SongConfig;
    } catch (e) {
      violations.push({
        group: sf.group, file: sf.file, songId: null, rule: 'parse-error',
        detail: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    // Roster for ans-id checks follows cfg.group (what the app actually
    // looks up at runtime), which can differ from the directory a collab
    // song happens to be filed under.
    const roster = rosterFor(cfg.group);
    violations.push(...validateSong(cfg, roster, sf));

    if (cfg.id) {
      const seen = idsSeenPerGroup.get(sf.group) ?? new Map<string, string>();
      idsSeenPerGroup.set(sf.group, seen);
      const first = seen.get(cfg.id);
      if (first && first !== sf.file) {
        violations.push({
          group: sf.group, file: sf.file, songId: cfg.id, rule: 'duplicate-id',
          detail: `id "${cfg.id}" already used by ${first}`,
        });
      } else if (!first) {
        seen.set(cfg.id, sf.file);
      }
    }
  }

  return { songCount: files.length, violations };
}

/** Formats a ValidationResult as a readable multi-line report (used by the CLI). */
export function formatReport(result: ValidationResult): string {
  const lines: string[] = [];
  lines.push(`Checked ${result.songCount} song configs.`);
  if (result.violations.length === 0) {
    lines.push('No violations found.');
    return lines.join('\n');
  }
  lines.push(`${result.violations.length} violation(s):`);
  const byRule = new Map<string, Violation[]>();
  for (const v of result.violations) {
    const arr = byRule.get(v.rule) ?? [];
    arr.push(v);
    byRule.set(v.rule, arr);
  }
  for (const [rule, vs] of byRule) {
    lines.push(`\n${rule} (${vs.length}):`);
    for (const v of vs) {
      lines.push(`  ${v.group}/${v.file}${v.songId ? ` (${v.songId})` : ''}: ${v.detail}`);
    }
  }
  return lines.join('\n');
}
