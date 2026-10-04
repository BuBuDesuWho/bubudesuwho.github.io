// Song-data integrity suite. Loads every real song config under songs/ (via
// song-validate.ts, shared with scripts/validate-songs.ts) and asserts the
// invariants the app relies on: parses + preprocesses cleanly, `ans` ids
// exist in the group's roster, ranges are sane, required fields are present,
// ids are unique and match their filename.
//
// songs/ is hand-curated (see CLAUDE.md — no editing song data from here).
// Known-bad configs that predate this suite are allowlisted below rather than
// fixed, so the suite catches NEW regressions without blocking on old data.
// See docs/trackers/song-data-audit-2026-09-27.md for the full violation list.

import { describe, expect, it } from 'vitest';
import { KNOWN_VIOLATIONS, validateAllSongs, violationKey, type Violation } from './song-validate';

// KNOWN_VIOLATIONS (song-validate.ts) is the allowlist the gate shares.

describe('song data integrity', () => {
  const result = validateAllSongs();

  it('finds a sane number of song configs', () => {
    // Sanity floor so a broken discoverSongFiles() (e.g. wrong path) fails
    // loudly instead of silently validating zero songs.
    expect(result.songCount).toBeGreaterThan(100);
  });

  it('has no unallowlisted violations', () => {
    const counts = new Map<string, number>();
    const unexpected: Violation[] = [];
    for (const v of result.violations) {
      const k = violationKey(v);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      if (!(k in KNOWN_VIOLATIONS)) unexpected.push(v);
    }

    if (unexpected.length > 0) {
      const detail = unexpected
        .slice(0, 20)
        .map((v) => `  ${violationKey(v)}: ${v.detail}`)
        .join('\n');
      expect.fail(
        `${unexpected.length} unallowlisted violation(s) (showing up to 20):\n${detail}`,
      );
    }

    for (const [k, expectedCount] of Object.entries(KNOWN_VIOLATIONS)) {
      expect(counts.get(k) ?? 0, `allowlisted violation "${k}" count changed`).toBe(expectedCount);
    }
  });
});
