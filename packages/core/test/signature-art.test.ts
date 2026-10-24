import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIGNATURE_WIDTH, MAX_ART_COMMANDS, artPoints, artScale, artSvgPath, isSignatureArt, newSignatureRect, quadToCubic, type PathCmd, type SignatureArt,
} from '../src';

const art = (over: Partial<SignatureArt> = {}): SignatureArt => ({
  w: 200, h: 50, mode: 'fill',
  paths: [['M', 0, 0], ['L', 100, 0], ['C', 100, 10, 90, 20, 80, 30], ['Z']],
  ...over,
});

describe('quadToCubic', () => {
  it('is exact: both curves pass through the same points', () => {
    const p0 = { x: 0, y: 0 };
    const q = { x: 30, y: 60 };
    const p = { x: 90, y: 0 };
    const [, c1x, c1y, c2x, c2y, ex, ey] = quadToCubic(p0, q, p);
    const quad = (t: number) => ({
      x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * q.x + t ** 2 * p.x,
      y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * q.y + t ** 2 * p.y,
    });
    const cubic = (t: number) => ({
      x: (1 - t) ** 3 * p0.x + 3 * (1 - t) ** 2 * t * c1x + 3 * (1 - t) * t ** 2 * c2x + t ** 3 * ex,
      y: (1 - t) ** 3 * p0.y + 3 * (1 - t) ** 2 * t * c1y + 3 * (1 - t) * t ** 2 * c2y + t ** 3 * ey,
    });
    for (const t of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      expect(cubic(t).x).toBeCloseTo(quad(t).x, 9);
      expect(cubic(t).y).toBeCloseTo(quad(t).y, 9);
    }
  });
  it('ends where the quadratic ends', () => {
    const c = quadToCubic({ x: 1, y: 2 }, { x: 5, y: 6 }, { x: 9, y: 10 });
    expect([c[5], c[6]]).toEqual([9, 10]);
  });
});

describe('artSvgPath', () => {
  it('writes the commands as an SVG path, rounded to two decimals', () => {
    expect(artSvgPath(art({ paths: [['M', 0, 0], ['L', 1.23456, 2], ['C', 1, 2, 3, 4, 5.999, 6], ['Z']] }))).toBe('M0 0 L1.23 2 C1 2 3 4 6 6 Z');
  });
  it('is empty for no paths', () => {
    expect(artSvgPath({ ...art(), paths: [] })).toBe('');
  });
});

describe('artPoints', () => {
  it('lists end points and control points, and ignores closes', () => {
    expect(artPoints(art())).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 10 }, { x: 90, y: 20 }, { x: 80, y: 30 }]);
  });
});

describe('isSignatureArt', () => {
  it('accepts well-formed fill and stroke artwork', () => {
    expect(isSignatureArt(art())).toBe(true);
    expect(isSignatureArt(art({ mode: 'stroke', strokeWidth: 2 }))).toBe(true);
  });

  it('survives a round trip through JSON, which is how it is stored', () => {
    expect(isSignatureArt(JSON.parse(JSON.stringify(art())))).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['no size', { ...art(), w: undefined }],
    ['zero width', art({ w: 0 })],
    ['negative height', art({ h: -1 })],
    ['NaN size', art({ w: Number.NaN })],
    ['an unknown mode', { ...art(), mode: 'dotted' }],
    ['a bad pen width', art({ mode: 'stroke', strokeWidth: 0 })],
    ['no paths', art({ paths: [] })],
    ['paths that are not a list', { ...art(), paths: 'M0 0' }],
    ['a command with the wrong number of numbers', art({ paths: [['M', 0, 0], ['L', 1]] as unknown as PathCmd[] })],
    ['an unknown command', art({ paths: [['M', 0, 0], ['Q', 1, 2, 3, 4]] as unknown as PathCmd[] })],
    ['a non-number coordinate', art({ paths: [['M', 0, '0']] as unknown as PathCmd[] })],
    ['an infinite coordinate', art({ paths: [['M', 0, Number.POSITIVE_INFINITY]] as unknown as PathCmd[] })],
    ['a path that does not start with a move', art({ paths: [['L', 1, 1], ['Z']] })],
  ])('rejects %s', (_name, value) => {
    expect(isSignatureArt(value)).toBe(false);
  });

  it('rejects absurdly long paths, so damaged storage cannot hang the page', () => {
    const many: PathCmd[] = [['M', 0, 0], ...Array.from({ length: MAX_ART_COMMANDS }, (): PathCmd => ['L', 1, 1])];
    expect(isSignatureArt(art({ paths: many }))).toBe(false);
    expect(isSignatureArt(art({ paths: many.slice(0, MAX_ART_COMMANDS) }))).toBe(true);
  });
});

describe('newSignatureRect', () => {
  it('is the default width, the artwork’s proportions, centred on the point', () => {
    const r = newSignatureRect(art({ w: 300, h: 60 }), { x: 100, y: 200 });
    expect(r.w).toBe(DEFAULT_SIGNATURE_WIDTH);
    expect(r.h).toBeCloseTo(32);
    expect(r.x + r.w / 2).toBeCloseTo(100);
    expect(r.y + r.h / 2).toBeCloseTo(200);
  });
  it('takes another width', () => {
    expect(newSignatureRect(art({ w: 100, h: 50 }), { x: 0, y: 0 }, 40)).toEqual({ x: -20, y: -10, w: 40, h: 20 });
  });
});

describe('artScale', () => {
  it('fits the artwork inside the rectangle, keeping proportions', () => {
    expect(artScale(art({ w: 100, h: 50 }), { x: 0, y: 0, w: 200, h: 100 })).toBe(2);
    expect(artScale(art({ w: 100, h: 50 }), { x: 0, y: 0, w: 400, h: 100 })).toBe(2); // limited by the height
    expect(artScale(art({ w: 100, h: 50 }), { x: 0, y: 0, w: 100, h: 500 })).toBe(1); // limited by the width
  });
});
