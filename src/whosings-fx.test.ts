import { describe, expect, it } from 'vitest';
import { comboTier, StageFx } from './whosings-fx';
import type { Seat } from './whosings-render';

describe('comboTier', () => {
  it('steps up at 10, 25 and 50', () => {
    expect([0, 9, 10, 24, 25, 49, 50, 200].map(comboTier)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
});

const seat: Seat = { id: 1, name: 'You', color: '#f0a', img: null, x: 500, y: 500 };

// ticks the pool the way the frame loop does, so expired particles are cleared
function at(fx: StageFx, now: number) {
  fx.tick(now);
  return fx.activity(now);
}

describe('StageFx.activity', () => {
  it('keeps drifting ambience going, but rests once reduced motion stops it', () => {
    expect(at(new StageFx(() => false), 0)).toBe('ambient');
    expect(at(new StageFx(() => true), 0)).toBe('still');
  });

  it('stays busy until a tap ripple and its stars have played out', () => {
    const fx = new StageFx(() => true);
    fx.tap(seat, 1000);
    expect(at(fx, 1000)).toBe('busy');
    expect(at(fx, 1440)).toBe('busy');
    expect(at(fx, 1460)).toBe('still');
  });

  it('waits for the late second ripple and the slower stars when motion is on', () => {
    const fx = new StageFx(() => false);
    fx.tap(seat, 1000);
    // the face's bounce (280 ms) and first ripple (450 ms) are over by now
    expect(at(fx, 1500)).toBe('busy');
    // stars live up to 750 ms
    expect(at(fx, 1751)).toBe('ambient');
  });

  it('holds a judgement and its burst on screen, then lets go', () => {
    const fx = new StageFx(() => true);
    fx.judge('right', [seat], 0);
    expect(at(fx, 800)).toBe('busy');
    // reduced-motion burst stars live up to 950 ms
    expect(at(fx, 1000)).toBe('still');
  });

  it('counts a line pulse as moving only while the beam glow is visible', () => {
    const fx = new StageFx(() => false);
    fx.pulse(0);
    expect(at(fx, 2000)).toBe('busy');
    expect(at(fx, 2600)).toBe('ambient');
    const calm = new StageFx(() => true);
    calm.pulse(0);
    expect(at(calm, 10)).toBe('still');
  });

  it('is still once reset drops a seek-stale judgement burst and flash', () => {
    const fx = new StageFx(() => true);
    fx.judge('wrong', [], 0);
    fx.judge('right', [seat], 0);
    fx.reset();
    expect(at(fx, 10)).toBe('still');
  });
});
