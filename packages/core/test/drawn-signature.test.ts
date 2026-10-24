import { describe, expect, it } from 'vitest';
import { MAX_ART_COMMANDS, MAX_STROKES, PAD_PEN_WIDTH, artPoints, isSignatureArt, strokesToArt, type Point } from '../src';

const line = (n: number, y = 50): Point[] => Array.from({ length: n }, (_, i) => ({ x: 20 + i * 5, y: y + (i % 2) * 3 }));

describe('strokesToArt', () => {
  it('has nothing to make from no strokes', () => {
    expect(strokesToArt([])).toBeUndefined();
    expect(strokesToArt([[]])).toBeUndefined();
  });

  it('makes valid stroke-mode artwork with a round pen of the pad width', () => {
    const art = strokesToArt([line(10)])!;
    expect(isSignatureArt(art)).toBe(true);
    expect(art.mode).toBe('stroke');
    expect(art.strokeWidth).toBe(PAD_PEN_WIDTH);
  });

  it('trims to the ink, leaving one pen width of margin, and starts at the top-left', () => {
    const art = strokesToArt([[{ x: 100, y: 80 }, { x: 160, y: 120 }]])!;
    expect(art.w).toBe(60 + 2 * PAD_PEN_WIDTH);
    expect(art.h).toBe(40 + 2 * PAD_PEN_WIDTH);
    expect(art.paths[0]).toEqual(['M', PAD_PEN_WIDTH, PAD_PEN_WIDTH]);
    const pts = artPoints(art);
    expect(Math.min(...pts.map((p) => p.x))).toBe(PAD_PEN_WIDTH);
    expect(Math.min(...pts.map((p) => p.y))).toBe(PAD_PEN_WIDTH);
  });

  it('makes a dot from a single tap, big enough to see', () => {
    const art = strokesToArt([[{ x: 30, y: 30 }]])!;
    expect(isSignatureArt(art)).toBe(true);
    expect(art.paths.map((c) => c[0])).toEqual(['M', 'L']);
    expect(art.w).toBeGreaterThan(0);
  });

  it('uses a straight line for two points and a smooth curve through more', () => {
    expect(strokesToArt([line(2)])!.paths.map((c) => c[0])).toEqual(['M', 'L']);
    const curve = strokesToArt([line(6)])!;
    expect(curve.paths.map((c) => c[0])).toEqual(['M', 'C', 'C', 'C', 'C', 'C']);
  });

  it('passes through every kept point', () => {
    const pts = line(6);
    const art = strokesToArt([pts])!;
    const ends = art.paths.filter((c) => c[0] === 'C').map((c) => [c[5], c[6]]);
    pts.slice(1).forEach((p, i) => {
      expect(ends[i]![0]).toBeCloseTo(p.x - 20 + PAD_PEN_WIDTH, 1);
      expect(ends[i]![1]).toBeCloseTo(p.y - 50 + PAD_PEN_WIDTH, 1);
    });
  });

  it('drops points that are noise within 1.5 units, but keeps the true end', () => {
    const noisy: Point[] = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 40, y: 0 }, { x: 40.4, y: 0.2 }];
    const art = strokesToArt([noisy])!;
    // the points at 0.5, 1 and 40 fall away; the stroke is just its start and its true end
    expect(art.paths).toEqual([['M', PAD_PEN_WIDTH, PAD_PEN_WIDTH], ['L', 40.4 + PAD_PEN_WIDTH, 0.2 + PAD_PEN_WIDTH]]);
  });

  it('keeps separate strokes separate', () => {
    const art = strokesToArt([line(5), line(5, 100)])!;
    expect(art.paths.filter((c) => c[0] === 'M')).toHaveLength(2);
  });

  it('ignores strokes beyond the limit', () => {
    const many = Array.from({ length: MAX_STROKES + 10 }, (_, i) => line(3, i * 4));
    expect(strokesToArt(many)!.paths.filter((c) => c[0] === 'M')).toHaveLength(MAX_STROKES);
  });

  it('refuses a drawing too complex to keep', () => {
    const long = Array.from({ length: MAX_ART_COMMANDS + 100 }, (_, i) => ({ x: i * 2, y: (i % 2) * 5 }));
    expect(strokesToArt([long])).toBeUndefined();
  });

  it('rounds coordinates so saved data stays small', () => {
    const art = strokesToArt([[{ x: 0.123456, y: 0 }, { x: 10.98765, y: 7.777777 }]])!;
    for (const p of artPoints(art)) expect(Math.round(p.x * 100) / 100).toBe(p.x);
  });
});
