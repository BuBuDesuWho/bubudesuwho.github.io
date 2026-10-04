import { Group, Subunit } from './types';

const registry = new Map<string, Group>();

export function registerGroup(g: Group): void {
  registry.set(g.slug, g);
}

export function getGroup(slug: string): Group | undefined {
  return registry.get(slug);
}

export function getAllGroups(): Group[] {
  return Array.from(registry.values());
}

export function hasGroup(slug: string): boolean {
  return registry.has(slug);
}

export function clearGroups(): void {
  registry.clear();
}

/** Display name for a group slug; falls back to the slug if unregistered. */
export function groupLabel(slug: string): string {
  return registry.get(slug)?.name ?? slug;
}

export function parentGroupOf(slug: string): string | undefined {
  return registry.get(slug)?.parent;
}

export function isExcludedFrom(slug: string | undefined, feature: 'stats' | 'bubudle'): boolean {
  return !!slug && !!registry.get(slug)?.excludeFrom?.includes(feature);
}

/** Header text for a menu section. An empty key is the group's own bucket. */
export function menuSectionLabel(slug: string, sectionId: string): string {
  if (!sectionId) return groupLabel(slug);
  return registry.get(slug)?.menuSections?.find(s => s.id === sectionId)?.label ?? sectionId;
}

/** Sort rank for a menu section: group bucket first, declared sections in
 *  order, anything unknown last. */
export function menuSectionRank(slug: string, sectionId: string): number {
  if (!sectionId) return 0;
  const i = registry.get(slug)?.menuSections?.findIndex(s => s.id === sectionId) ?? -1;
  return i < 0 ? 99 : i + 1;
}

export function subunitFilterAliases(slug: string): string[] {
  return registry.get(slug)?.subunitFilterAliases ?? [];
}

/** IDs of members in a group, sorted ascending. */
export function memberIdsOf(slug: string): number[] {
  const g = registry.get(slug);
  if (!g) return [];
  return g.members.map(m => m.id).sort((a, b) => a - b);
}

/** Lookup a single member's display name. Falls back to supplementaryMembers
 *  (per-group guest artists) so lines crediting a featured singer can still
 *  render a labelled slot. */
export function memberName(slug: string, id: number): string | undefined {
  const g = registry.get(slug);
  if (!g) return undefined;
  return (
    g.members.find(m => m.id === id)?.name
    ?? g.supplementaryMembers?.find(m => m.id === id)?.name
  );
}

/** Resolve an `ans` array to a label: exact subunit match → subunit name; full group → group name. */
export function labelForAns(slug: string, ans: number[]): string | null {
  const g = registry.get(slug);
  if (!g) return null;
  if (ans.length === g.members.length && ans.every(a => g.members.some(m => m.id === a))) {
    return g.name;
  }
  const sorted = [...ans].sort((a, b) => a - b);
  for (const sub of g.subunits ?? []) {
    const subSorted = [...sub.memberIds].sort((a, b) => a - b);
    if (arraysEqual(sorted, subSorted)) return sub.name;
  }
  return null;
}

/** Subunits that are fully contained in a given ans set (for shortcut/present-only filtering). */
export function subunitsPresentIn(slug: string, present: Set<number>): Subunit[] {
  const g = registry.get(slug);
  if (!g?.subunits) return [];
  return g.subunits.filter(s => s.memberIds.every(m => present.has(m)));
}

function arraysEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Back-compat Proxies ─────────────────────────────────────────
// These mimic the old Record<GroupName, Record<number, string>> constants so
// pre-refactor call sites keep working. Each read re-queries the registry.

function makeGroupMap<V>(valueOfMember: (m: Group['members'][number]) => V): Record<string, Record<number, V>> {
  const makeInner = (g: Group): Record<number, V> => {
    // Lookup-by-id includes supplementaryMembers so featured-artist slots can
    // resolve a name/color. Iteration (ownKeys) returns only the main roster
    // so "all members" views don't surface guests.
    const findMember = (id: number) =>
      g.members.find(mm => mm.id === id)
      ?? g.supplementaryMembers?.find(mm => mm.id === id);
    return new Proxy({} as Record<number, V>, {
      get(_, prop) {
        const id = typeof prop === 'string' ? Number(prop) : (prop as unknown as number);
        if (Number.isNaN(id)) return undefined;
        const m = findMember(id);
        return m ? valueOfMember(m) : undefined;
      },
      ownKeys() {
        return g.members.map(m => String(m.id));
      },
      getOwnPropertyDescriptor() {
        return { enumerable: true, configurable: true };
      },
      has(_, prop) {
        const id = typeof prop === 'string' ? Number(prop) : (prop as unknown as number);
        return !Number.isNaN(id) && findMember(id) !== undefined;
      },
    });
  };
  return new Proxy({} as Record<string, Record<number, V>>, {
    get(_, slug: string) {
      const g = registry.get(slug);
      return g ? makeInner(g) : undefined;
    },
    ownKeys() {
      return Array.from(registry.keys());
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
    has(_, slug) {
      return typeof slug === 'string' && registry.has(slug);
    },
  });
}

export const MEMBER_MAPPING: Record<string, Record<number, string>> = makeGroupMap(m => m.name);
export const MEMBER_COLORS: Record<string, Record<number, string>> = makeGroupMap(m => m.color);
export const MEMBER_COLORS_OFFICIAL: Record<string, Record<number, string>> = makeGroupMap(m => m.colorOfficial ?? m.color);
