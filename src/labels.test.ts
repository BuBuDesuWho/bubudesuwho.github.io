import { describe, expect, it, beforeEach } from 'vitest';
import { registerGroup, clearGroups } from './groups';
import { mapToLabel, getGroupColor, getNumSingersInGroup } from './labels';
import type { Group } from './types';

const AQOURS: Group = {
  slug: 'aqours',
  name: 'Aqours',
  members: [
    { id: 1, name: 'Chika', color: '#F0A20B' },
    { id: 2, name: 'You', color: '#49B9F9' },
    { id: 3, name: 'Riko', color: '#E9A9E8' },
  ],
  subunits: [
    { name: 'CYaRon', memberIds: [1, 2] },
  ],
  colorClass: 'aqours-blue',
};

describe('labels', () => {
  beforeEach(() => {
    clearGroups();
    registerGroup(AQOURS);
  });

  it('mapToLabel prefers a subunit/full-group label over a member list', () => {
    expect(mapToLabel('aqours', [1, 2])).toBe('CYaRon');
    expect(mapToLabel('aqours', [1, 2, 3])).toBe('Aqours');
  });

  it('mapToLabel falls back to a joined member name list', () => {
    expect(mapToLabel('aqours', [1, 3])).toBe('Chika, Riko');
  });

  it('mapToLabel falls back to the raw id for an unknown member', () => {
    expect(mapToLabel('aqours', [1, 404])).toBe('Chika, 404');
  });

  it('getGroupColor returns the registered colorClass, null when unregistered', () => {
    expect(getGroupColor('aqours')).toBe('aqours-blue');
    expect(getGroupColor('nope')).toBeNull();
  });

  it('getNumSingersInGroup counts the main roster, 0 when unregistered', () => {
    expect(getNumSingersInGroup('aqours')).toBe(3);
    expect(getNumSingersInGroup('nope')).toBe(0);
  });
});
