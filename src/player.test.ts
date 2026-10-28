import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for Howler's Howl: records what the player does with each track.
class FakeHowl {
  static made: FakeHowl[] = [];
  opts: { src: string[]; preload: boolean | 'metadata' };
  status: 'unloaded' | 'loading' | 'loaded' = 'loading';
  handlers = new Map<string, (() => void)[]>();
  vol = 0;
  seekedTo: number | null = null;
  node = {
    currentTime: 0,
    listeners: new Map<string, () => void>(),
    addEventListener(ev: string, fn: () => void) { this.listeners.set(ev, fn); },
  };
  _sounds = [{ _node: this.node }];

  constructor(opts: FakeHowl['opts']) {
    this.opts = opts;
    FakeHowl.made.push(this);
  }
  get ogg() { return this.opts.src[0]; }
  on(ev: string, fn: () => void) { this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); return this; }
  once(ev: string, fn: () => void) { return this.on(ev, fn); }
  emit(ev: string) { for (const fn of this.handlers.get(ev) ?? []) fn(); }
  state() { return this.status; }
  unload() { this.status = 'unloaded'; }
  volume(v: number) { this.vol = v; }
  rate() {}
  seek(t?: number) { if (t !== undefined) this.seekedTo = t; return this.seekedTo ?? 0; }
  play() { this.emit('play'); }
  playing() { return false; }
  pause() {}
}

vi.mock('howler', () => ({ Howl: FakeHowl }));

const player = await import('./player');

const target = (name: string, at = 60) => ({ ogg: `${name}.ogg`, m4a: `${name}.m4a`, at });
const live = () => FakeHowl.made.filter((h) => h.status !== 'unloaded');

beforeEach(() => {
  vi.useFakeTimers();
  FakeHowl.made = [];
});

afterEach(() => {
  player.destroyPlayer();
  vi.useRealTimers();
});

describe('prepare', () => {
  it('warms up to the limit, metadata only, and seeks each to its clip once metadata is in', () => {
    player.prepare(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => target(n, 42)));
    expect(FakeHowl.made.map((h) => h.ogg)).toEqual(['a.ogg', 'b.ogg', 'c.ogg', 'd.ogg', 'e.ogg']);
    expect(FakeHowl.made.every((h) => h.opts.preload === 'metadata')).toBe(true);
    const a = FakeHowl.made[0];
    expect(a.node.currentTime).toBe(0);
    a.node.listeners.get('loadedmetadata')!();
    expect(a.node.currentTime).toBe(42);
  });

  it('seeks again after the element is reloaded, but not once it is the current track', () => {
    player.prepare([target('a', 42)]);
    const a = FakeHowl.made[0];
    const reloaded = () => { a.node.currentTime = 0; a.node.listeners.get('loadedmetadata')!(); };
    reloaded(); // Howler's unlock reloads every element on the first tap
    expect(a.node.currentTime).toBe(42);
    player.loadSong('a.ogg', 'a.m4a');
    reloaded();
    expect(a.node.currentTime).toBe(0);
  });

  it('keeps tracks still wanted, drops the rest, and skips duplicates', () => {
    player.prepare([target('a'), target('b'), target('a')]);
    expect(FakeHowl.made).toHaveLength(2);
    player.prepare([target('b'), target('c')]);
    expect(live().map((h) => h.ogg)).toEqual(['b.ogg', 'c.ogg']);
    expect(FakeHowl.made).toHaveLength(3); // b was kept, not rebuilt
  });

  it('drops a track that fails to load', () => {
    player.prepare([target('a')]);
    FakeHowl.made[0].emit('loaderror');
    expect(live()).toHaveLength(0);
    player.loadSong('a.ogg', 'a.m4a');
    expect(FakeHowl.made).toHaveLength(2); // a fresh track, not the failed one
  });
});

describe('loadSong with prepared tracks', () => {
  it('takes over a prepared track instead of loading it again', () => {
    player.prepare([target('a'), target('b')]);
    player.setVolume(0.7);
    player.loadSong('a.ogg', 'a.m4a');
    expect(FakeHowl.made).toHaveLength(2);
    expect(FakeHowl.made[0].vol).toBe(0.7);
    expect(FakeHowl.made[0].handlers.has('end')).toBe(true); // wired as the current track
  });

  it('holds new preparation until the current track has had the network', () => {
    player.loadSong('cur.ogg', 'cur.m4a');
    player.prepare([target('a')]);
    expect(FakeHowl.made.map((h) => h.ogg)).toEqual(['cur.ogg']);
    player.play(10);
    expect(FakeHowl.made.map((h) => h.ogg)).toEqual(['cur.ogg', 'a.ogg']);
  });

  it('stops waiting after a while even if the current track never plays', () => {
    player.loadSong('cur.ogg', 'cur.m4a');
    player.prepare([target('a')]);
    vi.advanceTimersByTime(2500);
    expect(FakeHowl.made.map((h) => h.ogg)).toEqual(['cur.ogg', 'a.ogg']);
  });

  it('never prepares the track that is already playing', () => {
    player.loadSong('cur.ogg', 'cur.m4a');
    vi.advanceTimersByTime(2500);
    player.prepare([target('cur'), target('a')]);
    expect(FakeHowl.made.map((h) => h.ogg)).toEqual(['cur.ogg', 'a.ogg']);
  });
});
