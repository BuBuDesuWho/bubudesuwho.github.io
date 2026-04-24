import { GroupName } from './types';
import {
  getGroup, labelForAns, memberName,
} from './groups';

export function mapToLabel(group: GroupName, ans: number[]): string {
  const subunitOrFull = labelForAns(group, ans);
  if (subunitOrFull) return subunitOrFull;
  return ans
    .map(a => memberName(group, a) ?? String(a))
    .join(', ');
}

export function getGroupColor(group: GroupName): string | null {
  return getGroup(group)?.colorClass ?? null;
}

export function getNumSingersInGroup(group: GroupName): number {
  return getGroup(group)?.members.length ?? 0;
}
