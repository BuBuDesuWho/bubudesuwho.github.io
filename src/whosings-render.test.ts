import { describe, expect, it } from 'vitest';
import { arcLayout, CX, CY } from './whosings-render';

describe('arcLayout', () => {
  it('puts a single singer at the bottom of the arc', () => {
    const { points } = arcLayout(1);
    expect(points).toHaveLength(1);
    expect(points[0].x).toBeCloseTo(CX);
    expect(points[0].y).toBeCloseTo(CY + 400);
  });

  it('spaces faces 22.5° apart around the bottom, left to right and symmetric', () => {
    const { points } = arcLayout(5);
    const step = Math.PI / 8;
    expect(points[0]).toEqual({ x: expect.closeTo(CX + 400 * Math.cos(Math.PI / 2 + 2 * step)), y: expect.closeTo(CY + 400 * Math.sin(Math.PI / 2 + 2 * step)) });
    expect(points[2].y).toBeCloseTo(CY + 400);
    expect(points[0].y).toBeCloseTo(points[4].y);
    for (let i = 1; i < points.length; i++) expect(points[i].x).toBeGreaterThan(points[i - 1].x);
    expect(points[1].y).toBeCloseTo(points[3].y);
  });

  it('spans the full half-circle at nine, like SIF', () => {
    const { points } = arcLayout(9);
    expect(points[0]).toEqual({ x: expect.closeTo(CX - 400), y: expect.closeTo(CY) });
    expect(points[8]).toEqual({ x: expect.closeTo(CX + 400), y: expect.closeTo(CY) });
  });

  it('keeps SIF-sized buttons for nine and shrinks them so twelve never overlap', () => {
    expect(arcLayout(9).radius).toBe(64);
    const { points, radius } = arcLayout(12);
    expect(radius).toBeLessThan(64);
    for (let i = 1; i < points.length; i++) {
      const gap = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      expect(gap).toBeGreaterThan(2 * radius);
    }
  });
});
