import { describe, expect, it } from 'vitest';
import { revealClasses, applyClasses, type RevealContext } from './reveal';
import type { MappingEntry } from './types';

/** Minimal element stand-in — records the class/style/title writes that
 *  applyClasses makes, so the DOM adapter can be tested without a real DOM
 *  (the project has no jsdom). Supports exactly the surface applyClasses uses. */
function fakeEl(initialClasses: string[] = []) {
  const classes = new Set<string>(initialClasses);
  const styles: Record<string, string> = {};
  let title: string | undefined;
  const el = {
    classList: {
      add: (...c: string[]) => c.forEach((x) => classes.add(x)),
      remove: (...c: string[]) => c.forEach((x) => classes.delete(x)),
      contains: (c: string) => classes.has(c),
      [Symbol.iterator]: () => classes[Symbol.iterator](),
    },
    style: {
      setProperty: (k: string, v: string) => { styles[k] = v; },
      removeProperty: (k: string) => { delete styles[k]; },
    },
    set title(v: string) { title = v; },
    get title() { return title ?? ''; },
    removeAttribute: () => { title = undefined; },
  };
  return { el: el as unknown as HTMLElement, classes, styles, titleOf: () => title };
}

function mapping(ans: number[] | undefined, id = 0): MappingEntry {
  return { range: [0, 1], ans, id };
}

function ctx(overrides: Partial<RevealContext> = {}): RevealContext {
  return {
    songRoster: [1, 2, 3, 4],
    activePool: [1, 2, 3, 4],
    slotRevealed: false,
    colors: { 1: '#e4002b', 2: '#00a0e9', 3: '#a5d4ad', 4: '#f6ad3c' },
    title: 'Label',
    ...overrides,
  };
}

describe('revealClasses', () => {
  it('is hidden when the mapping has no answer', () => {
    expect(revealClasses(mapping(undefined), ctx())).toEqual({ kind: 'hidden' });
  });

  it('is hidden when the line is not revealed', () => {
    // single guessable singer, slot not answered, ans !== active pool
    expect(revealClasses(mapping([1]), ctx({ slotRevealed: false }))).toEqual({ kind: 'hidden' });
  });

  it('reveals a solo line with its member colour once the slot is answered', () => {
    expect(revealClasses(mapping([2]), ctx({ slotRevealed: true }))).toEqual({
      kind: 'solo', member: 2, color: '#00a0e9', title: 'Label',
    });
  });

  it('reveals a solo line with no colour when the palette lacks the member', () => {
    expect(revealClasses(mapping([9]), ctx({ slotRevealed: true }))).toEqual({
      kind: 'solo', member: 9, color: undefined, title: 'Label',
    });
  });

  it('auto-reveals an all-members line without needing the slot answered', () => {
    // ans equals the full song roster → revealed even though slotRevealed is false
    expect(revealClasses(mapping([1, 2, 3, 4]), ctx({ slotRevealed: false }))).toEqual({
      kind: 'all', title: 'Label',
    });
  });

  it('reveals a subgroup line as a gradient of its members’ colours', () => {
    expect(revealClasses(mapping([1, 2]), ctx({ slotRevealed: true }))).toEqual({
      kind: 'subgroup', colors: ['#e4002b', '#00a0e9'], title: 'Label',
    });
  });

  it('drops uncoloured members from the subgroup gradient', () => {
    // member 9 has no palette colour → filtered out, leaving a single colour
    expect(revealClasses(mapping([1, 9]), ctx({ slotRevealed: true }))).toEqual({
      kind: 'subgroup', colors: ['#e4002b'], title: 'Label',
    });
  });

  // The reason song roster and active pool are distinct (see CONTEXT.md): in
  // Bubudle the active pool is a curated set narrower than the song roster, and
  // a line reveals when its answer matches that pool — not the roster.
  it('reveals a line whose answer equals the active pool, even if the slot is unanswered', () => {
    const bubudle = ctx({
      songRoster: [1, 2, 3, 4],
      activePool: [1, 2],          // curated pool, narrower than the roster
      slotRevealed: false,
    });
    // ans === active pool but !== roster → subgroup, revealed
    expect(revealClasses(mapping([1, 2]), bubudle)).toEqual({
      kind: 'subgroup', colors: ['#e4002b', '#00a0e9'], title: 'Label',
    });
  });

  it('keeps a line hidden when its answer matches neither the pool nor the slot', () => {
    const bubudle = ctx({ songRoster: [1, 2, 3, 4], activePool: [1, 2], slotRevealed: false });
    expect(revealClasses(mapping([3, 4]), bubudle)).toEqual({ kind: 'hidden' });
  });
});

describe('applyClasses (DOM adapter)', () => {
  it('hidden clears prior reveal classes and removes the title', () => {
    const f = fakeEl(['ans3', 'lyric-gradient', 'lyric-active']);
    applyClasses(f.el, { kind: 'hidden' });
    expect(f.classes.has('ans3')).toBe(false);
    expect(f.classes.has('lyric-gradient')).toBe(false);
    expect(f.classes.has('lyric-active')).toBe(true); // non-reveal classes untouched
    expect(f.titleOf()).toBeUndefined();
  });

  it('solo adds ansN + lyric-solo with the member colour and a title', () => {
    const f = fakeEl();
    applyClasses(f.el, { kind: 'solo', member: 2, color: '#00a0e9', title: 'You' });
    expect(f.classes.has('ans2')).toBe(true);
    expect(f.classes.has('lyric-solo')).toBe(true);
    expect(f.styles['--solo-color']).toBe('#00a0e9');
    expect(f.titleOf()).toBe('You');
  });

  it('solo without a colour adds only ansN and the title', () => {
    const f = fakeEl();
    applyClasses(f.el, { kind: 'solo', member: 9, color: undefined, title: 'Guest' });
    expect(f.classes.has('ans9')).toBe(true);
    expect(f.classes.has('lyric-solo')).toBe(false);
    expect(f.styles['--solo-color']).toBeUndefined();
    expect(f.titleOf()).toBe('Guest');
  });

  it('all adds ans-all and the title', () => {
    const f = fakeEl();
    applyClasses(f.el, { kind: 'all', title: 'Aqours' });
    expect(f.classes.has('ans-all')).toBe(true);
    expect(f.titleOf()).toBe('Aqours');
  });

  it('subgroup with >=2 colours sets the gradient + glow vars', () => {
    const f = fakeEl();
    applyClasses(f.el, { kind: 'subgroup', colors: ['#a', '#b', '#c'], title: 'Trio' });
    expect(f.classes.has('lyric-gradient')).toBe(true);
    expect(f.styles['--gradient']).toBe('linear-gradient(90deg, #a, #b, #c)');
    expect(f.styles['--glow1']).toBe('#a');
    expect(f.styles['--glow2']).toBe('#b'); // middle = floor(3/2) = index 1
    expect(f.styles['--glow3']).toBe('#c');
    expect(f.titleOf()).toBe('Trio');
  });

  it('subgroup with <2 colours sets the title but no gradient', () => {
    const f = fakeEl();
    applyClasses(f.el, { kind: 'subgroup', colors: ['#only'], title: 'Pair' });
    expect(f.classes.has('lyric-gradient')).toBe(false);
    expect(f.styles['--gradient']).toBeUndefined();
    expect(f.titleOf()).toBe('Pair'); // still revealed → title set
  });

  it('re-applying overwrites the previous reveal cleanly', () => {
    const f = fakeEl();
    applyClasses(f.el, { kind: 'subgroup', colors: ['#a', '#b'], title: 'First' });
    applyClasses(f.el, { kind: 'solo', member: 1, color: '#c', title: 'Second' });
    expect(f.classes.has('lyric-gradient')).toBe(false); // gradient cleared
    expect(f.styles['--gradient']).toBeUndefined();
    expect(f.classes.has('ans1')).toBe(true);
    expect(f.titleOf()).toBe('Second');
  });
});
