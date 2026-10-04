import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerGroup, getGroup, getAllGroups, hasGroup, clearGroups,
  memberIdsOf, memberName, labelForAns, subunitsPresentIn,
  MEMBER_MAPPING, MEMBER_COLORS,
  groupLabel, parentGroupOf, isExcludedFrom, menuSectionLabel, menuSectionRank, subunitFilterAliases,
} from './groups';
import type { Group } from './types';

const AQOURS: Group = {
  slug: 'aqours',
  name: 'Aqours',
  members: [
    { id: 1, name: 'Chika', color: '#F0A20B' },
    { id: 2, name: 'You', color: '#49B9F9' },
    { id: 3, name: 'Riko', color: '#E9A9E8' },
  ],
  supplementaryMembers: [
    { id: 99, name: 'Guest', color: '#000000' },
  ],
  subunits: [
    { name: 'CYaRon', memberIds: [1, 2] },
  ],
  colorClass: 'aqours-blue',
};

describe('groups registry', () => {
  beforeEach(() => { clearGroups(); });

  it('registers and retrieves a group by slug', () => {
    registerGroup(AQOURS);
    expect(getGroup('aqours')).toBe(AQOURS);
    expect(hasGroup('aqours')).toBe(true);
    expect(hasGroup('nope')).toBe(false);
  });

  it('getAllGroups reflects every registered group', () => {
    registerGroup(AQOURS);
    registerGroup({ ...AQOURS, slug: 'muse', name: "μ's" });
    expect(getAllGroups().map((g) => g.slug).sort()).toEqual(['aqours', 'muse']);
  });

  it('clearGroups empties the registry', () => {
    registerGroup(AQOURS);
    clearGroups();
    expect(getAllGroups()).toEqual([]);
    expect(hasGroup('aqours')).toBe(false);
  });

  it('memberIdsOf returns ids sorted ascending, empty for unknown group', () => {
    registerGroup(AQOURS);
    expect(memberIdsOf('aqours')).toEqual([1, 2, 3]);
    expect(memberIdsOf('nope')).toEqual([]);
  });

  it('memberName resolves main roster and falls back to supplementaryMembers', () => {
    registerGroup(AQOURS);
    expect(memberName('aqours', 1)).toBe('Chika');
    expect(memberName('aqours', 99)).toBe('Guest');
    expect(memberName('aqours', 404)).toBeUndefined();
    expect(memberName('nope', 1)).toBeUndefined();
  });

  it('labelForAns returns the group name for the full roster', () => {
    registerGroup(AQOURS);
    expect(labelForAns('aqours', [1, 2, 3])).toBe('Aqours');
    expect(labelForAns('aqours', [3, 1, 2])).toBe('Aqours'); // order-insensitive
  });

  it('labelForAns returns a subunit name for an exact subunit match', () => {
    registerGroup(AQOURS);
    expect(labelForAns('aqours', [2, 1])).toBe('CYaRon');
  });

  it('labelForAns returns null when ans matches neither the group nor a subunit', () => {
    registerGroup(AQOURS);
    expect(labelForAns('aqours', [1])).toBeNull();
    expect(labelForAns('nope', [1])).toBeNull();
  });

  it('subunitsPresentIn returns only subunits fully contained in the given set', () => {
    registerGroup(AQOURS);
    expect(subunitsPresentIn('aqours', new Set([1, 2, 3]))).toHaveLength(1);
    expect(subunitsPresentIn('aqours', new Set([1]))).toHaveLength(0);
    expect(subunitsPresentIn('nope', new Set([1, 2]))).toEqual([]);
  });

  it('MEMBER_MAPPING proxy resolves by id and lists only the main roster', () => {
    registerGroup(AQOURS);
    expect(MEMBER_MAPPING.aqours[1]).toBe('Chika');
    expect(MEMBER_MAPPING.aqours[99]).toBe('Guest'); // lookup includes guests
    expect(Object.keys(MEMBER_MAPPING.aqours)).toEqual(['1', '2', '3']); // iteration excludes guests
    expect(MEMBER_COLORS.aqours[2]).toBe('#49B9F9');
  });

  it('MEMBER_MAPPING proxy returns undefined for an unregistered group', () => {
    expect(MEMBER_MAPPING.nope).toBeUndefined();
  });

  describe('declarative group metadata', () => {
    const META: Group = {
      ...AQOURS,
      parent: 'base',
      excludeFrom: ['stats'],
      subunitFilterAliases: ['10,11'],
      menuSections: [{ id: 'cyaron', label: 'CYaRon!' }, { id: 'azalea', label: 'AZALEA' }],
    };

    it('groupLabel uses the group name, falling back to the slug', () => {
      registerGroup(META);
      expect(groupLabel('aqours')).toBe('Aqours');
      expect(groupLabel('unregistered')).toBe('unregistered');
    });

    it('parentGroupOf and subunitFilterAliases read the declared fields', () => {
      registerGroup(META);
      expect(parentGroupOf('aqours')).toBe('base');
      expect(parentGroupOf('nope')).toBeUndefined();
      expect(subunitFilterAliases('aqours')).toEqual(['10,11']);
      expect(subunitFilterAliases('nope')).toEqual([]);
    });

    it('isExcludedFrom is per feature and false for unknown or missing groups', () => {
      registerGroup(META);
      expect(isExcludedFrom('aqours', 'stats')).toBe(true);
      expect(isExcludedFrom('aqours', 'bubudle')).toBe(false);
      expect(isExcludedFrom('nope', 'stats')).toBe(false);
      expect(isExcludedFrom(undefined, 'stats')).toBe(false);
    });

    it('menu sections label and rank by declared order, group bucket first', () => {
      registerGroup(META);
      expect(menuSectionLabel('aqours', '')).toBe('Aqours');
      expect(menuSectionLabel('aqours', 'azalea')).toBe('AZALEA');
      expect(menuSectionLabel('aqours', 'mystery')).toBe('mystery');
      expect(menuSectionRank('aqours', '')).toBe(0);
      expect(menuSectionRank('aqours', 'cyaron')).toBe(1);
      expect(menuSectionRank('aqours', 'azalea')).toBe(2);
      expect(menuSectionRank('aqours', 'mystery')).toBe(99);
    });
  });
});
