import { describe, expect, it } from 'vitest';
import {
  NOTE_SIZE, annotationBounds, arrowHead, arrowHeadSize, constrainDrag, hitTest, normalizeRect, rectToQuad,
  resizeShape, shapeHandles, simplifyPolyline, translateAnnotation,
  type Annotation, type InkAnnot, type Point, type ShapeAnnot,
} from '../src';

const base = { id: 'a', pageId: 'p', author: 'me', createdAt: 't', modifiedAt: 't', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, origin: 'app' as const };
const P = (x: number, y: number): Point => ({ x, y });

const ink = (strokes: Point[][], width = 2): InkAnnot => ({ ...base, type: 'ink', strokes, width });
const rect = (r = { x: 10, y: 20, w: 100, h: 50 }, width = 2, extra: Partial<ShapeAnnot> = {}): ShapeAnnot => ({ ...base, type: 'shape', shape: 'rect', rect: r, width, ...extra });
const line = (a: Point, b: Point, shape: 'line' | 'arrow' = 'line', width = 2): ShapeAnnot => ({
  ...base, type: 'shape', shape, rect: normalizeRect(a, b), line: [a, b], width,
});

describe('simplifyPolyline', () => {
  it('keeps the ends and drops points on a straight line', () => {
    const pts = Array.from({ length: 50 }, (_, i) => P(i, 2 * i));
    expect(simplifyPolyline(pts, 0.1)).toEqual([P(0, 0), P(49, 98)]);
  });

  it('keeps corners', () => {
    const pts = [P(0, 0), P(5, 0), P(10, 0), P(10, 5), P(10, 10)];
    expect(simplifyPolyline(pts, 0.1)).toEqual([P(0, 0), P(10, 0), P(10, 10)]);
  });

  it('keeps a curve within the tolerance of the original', () => {
    const pts = Array.from({ length: 200 }, (_, i) => P(i, 30 * Math.sin(i / 20)));
    const out = simplifyPolyline(pts, 0.5);
    expect(out.length).toBeLessThan(pts.length / 3);
    // every dropped point is within tolerance of the simplified path
    for (const p of pts) {
      const d = Math.min(...out.slice(1).map((b, i) => Math.hypot(0, 0) + segDist(p, out[i]!, b)));
      expect(d).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it('passes short inputs through, including a single point (a dot)', () => {
    expect(simplifyPolyline([P(1, 1)], 5)).toEqual([P(1, 1)]);
    expect(simplifyPolyline([P(1, 1), P(2, 2)], 5)).toEqual([P(1, 1), P(2, 2)]);
    expect(simplifyPolyline([], 5)).toEqual([]);
  });
});

function segDist(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

describe('annotationBounds', () => {
  it('includes the stroke width for ink and shapes', () => {
    expect(annotationBounds(ink([[P(10, 10), P(30, 20)]], 4))).toEqual({ x: 8, y: 8, w: 24, h: 14 });
    expect(annotationBounds(rect({ x: 10, y: 20, w: 100, h: 50 }, 2))).toEqual({ x: 9, y: 19, w: 102, h: 52 });
  });

  it('adds room for an arrow head', () => {
    const b = annotationBounds(line(P(0, 0), P(100, 0), 'arrow', 2));
    expect(b.w).toBeGreaterThan(100);
    expect(b.x).toBeCloseTo(-1 - arrowHeadSize(2));
  });

  it('covers markup quads, notes, text and stamps', () => {
    const hl: Annotation = { ...base, type: 'highlight', quads: [rectToQuad({ x: 0, y: 0, w: 10, h: 5 }), rectToQuad({ x: 20, y: 30, w: 10, h: 5 })] };
    expect(annotationBounds(hl)).toEqual({ x: 0, y: 0, w: 30, h: 35 });
    expect(annotationBounds({ ...base, type: 'note', position: P(5, 50), icon: 'note' })).toEqual({ x: 5, y: 50 - NOTE_SIZE, w: NOTE_SIZE, h: NOTE_SIZE });
    expect(annotationBounds({ ...base, type: 'freetext', rect: { x: 1, y: 2, w: 3, h: 4 }, text: 't', fontSize: 12, fontFamily: 'sans' })).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
});

describe('translateAnnotation', () => {
  it('moves every annotation type and leaves the original untouched', () => {
    const all: Annotation[] = [
      { ...base, type: 'highlight', quads: [rectToQuad({ x: 0, y: 0, w: 10, h: 5 })] },
      ink([[P(0, 0), P(1, 1)]]),
      rect(),
      line(P(0, 0), P(10, 10)),
      { ...base, type: 'note', position: P(3, 4), icon: 'comment' },
      { ...base, type: 'freetext', rect: { x: 1, y: 1, w: 5, h: 5 }, text: 't', fontSize: 12, fontFamily: 'sans' },
      { ...base, type: 'stamp', rect: { x: 1, y: 1, w: 5, h: 5 }, payload: { kind: 'preset', name: 'Approved' } },
    ];
    for (const a of all) {
      const before = annotationBounds(a);
      const moved = translateAnnotation(a, 7, -3);
      const after = annotationBounds(moved);
      expect(after.x).toBeCloseTo(before.x + 7);
      expect(after.y).toBeCloseTo(before.y - 3);
      expect(after.w).toBeCloseTo(before.w);
      expect(annotationBounds(a)).toEqual(before);
    }
  });

  it('keeps a line and its bounding rect in step', () => {
    const m = translateAnnotation(line(P(0, 0), P(10, 20)), 5, 5);
    expect(m.line).toEqual([P(5, 5), P(15, 25)]);
    expect(m.rect).toEqual({ x: 5, y: 5, w: 10, h: 20 });
  });
});

describe('arrowHead', () => {
  it('points at the tip with barbs behind it, and the shaft ends inside the head', () => {
    const { tip, barbs, base: b } = arrowHead(P(0, 0), P(100, 0), 2);
    expect(tip).toEqual(P(100, 0));
    expect(barbs[0].x).toBeLessThan(100);
    expect(barbs[0].y).toBeCloseTo(-barbs[1].y); // symmetric about the shaft
    expect(b.x).toBeLessThan(100);
    expect(b.x).toBeGreaterThan(barbs[0].x - 1);
    expect(b.y).toBeCloseTo(0);
  });

  it('survives a zero-length arrow', () => {
    const h = arrowHead(P(5, 5), P(5, 5), 2);
    expect(Number.isFinite(h.base.x) && Number.isFinite(h.barbs[0].y)).toBe(true);
  });
});

describe('constrainDrag', () => {
  it('makes rectangles and ellipses square, in any drag direction', () => {
    expect(constrainDrag('rect', P(0, 0), P(10, 4))).toEqual(P(10, 10));
    expect(constrainDrag('ellipse', P(0, 0), P(-3, 8))).toEqual(P(-8, 8));
    expect(constrainDrag('rect', P(0, 0), P(0, 0))).toEqual(P(0, 0));
  });

  it('snaps lines to 45 degree steps and keeps their length', () => {
    const r = constrainDrag('line', P(0, 0), P(10, 1));
    expect(r.y).toBeCloseTo(0);
    expect(r.x).toBeCloseTo(Math.hypot(10, 1));
    const d = constrainDrag('arrow', P(0, 0), P(10, 8));
    expect(d.x).toBeCloseTo(d.y);
  });
});

describe('resizeShape', () => {
  it('moves a corner and keeps the opposite one fixed', () => {
    const r = resizeShape(rect({ x: 10, y: 20, w: 100, h: 50 }), 'ne', P(150, 100));
    expect(r.rect).toEqual({ x: 10, y: 20, w: 140, h: 80 });
    const sw = resizeShape(rect({ x: 10, y: 20, w: 100, h: 50 }), 'sw', P(0, 0));
    expect(sw.rect).toEqual({ x: 0, y: 0, w: 110, h: 70 });
  });

  it('flips instead of going negative when dragged past the opposite corner', () => {
    const r = resizeShape(rect({ x: 10, y: 20, w: 100, h: 50 }), 'se', P(-20, 100));
    expect(r.rect).toEqual({ x: -20, y: 70, w: 30, h: 30 });
    expect(r.rect.w).toBeGreaterThanOrEqual(0);
  });

  it('moves one end of a line and updates its bounding rect', () => {
    const l = resizeShape(line(P(0, 0), P(10, 10)), 'end', P(30, 5));
    expect(l.line).toEqual([P(0, 0), P(30, 5)]);
    expect(l.rect).toEqual({ x: 0, y: 0, w: 30, h: 5 });
  });

  it('offers corner handles for boxes and end handles for lines', () => {
    expect(shapeHandles(rect()).map((h) => h.id).sort()).toEqual(['ne', 'nw', 'se', 'sw']);
    expect(shapeHandles(line(P(0, 0), P(1, 1))).map((h) => h.id)).toEqual(['start', 'end']);
    const ne = shapeHandles(rect({ x: 10, y: 20, w: 100, h: 50 })).find((h) => h.id === 'ne')!;
    expect(ne.at).toEqual(P(110, 70)); // PDF y points up, so "north" is the larger y
  });
});

describe('hitTest', () => {
  it('hits an unfilled rectangle on its outline but not in its middle', () => {
    const r = rect({ x: 0, y: 0, w: 100, h: 100 }, 2);
    expect(hitTest(r, P(0, 50), 3)).toBe(true);
    expect(hitTest(r, P(50, 50), 3)).toBe(false);
    expect(hitTest(r, P(200, 50), 3)).toBe(false);
  });

  it('hits a filled rectangle anywhere inside', () => {
    expect(hitTest(rect({ x: 0, y: 0, w: 100, h: 100 }, 2, { fill: { r: 1, g: 0, b: 0, a: 1 } }), P(50, 50), 3)).toBe(true);
  });

  it('hits an ellipse near its outline only', () => {
    const e: ShapeAnnot = { ...rect({ x: 0, y: 0, w: 100, h: 60 }), shape: 'ellipse' };
    expect(hitTest(e, P(0, 30), 3)).toBe(true);
    expect(hitTest(e, P(50, 60), 3)).toBe(true);
    expect(hitTest(e, P(50, 30), 3)).toBe(false);
    expect(hitTest(e, P(3, 3), 3)).toBe(false); // corner of the bounding box is outside an ellipse
  });

  it('hits a line within the slop and a dot made of one point', () => {
    const l = line(P(0, 0), P(100, 0));
    expect(hitTest(l, P(50, 3), 3)).toBe(true);
    expect(hitTest(l, P(50, 10), 3)).toBe(false);
    expect(hitTest(ink([[P(10, 10)]], 4), P(11, 11), 2)).toBe(true);
    expect(hitTest(ink([[P(10, 10)]], 4), P(30, 30), 2)).toBe(false);
  });

  it('hits text markup per line, not across the gap between lines', () => {
    const hl: Annotation = { ...base, type: 'highlight', quads: [rectToQuad({ x: 0, y: 0, w: 100, h: 10 }), rectToQuad({ x: 0, y: 40, w: 100, h: 10 })] };
    expect(hitTest(hl, P(50, 5), 2)).toBe(true);
    expect(hitTest(hl, P(50, 45), 2)).toBe(true);
    expect(hitTest(hl, P(50, 25), 2)).toBe(false);
  });

  it('hits ink along its path', () => {
    const a = ink([[P(0, 0), P(50, 0), P(50, 50)]], 2);
    expect(hitTest(a, P(25, 2), 2)).toBe(true);
    expect(hitTest(a, P(25, 25), 2)).toBe(false);
  });
});
