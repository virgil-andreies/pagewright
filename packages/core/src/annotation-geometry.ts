import type { Annotation, Point, Rect, ShapeAnnot } from './annotations';
import { quadBounds } from './geometry';

/** Edge length of the sticky-note icon, in points. Shared by the appearance writer and hit-testing. */
export const NOTE_SIZE = 20;

export function normalizeRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function unionRects(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

export function pointsBounds(points: readonly Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Tight bounds of everything the annotation draws, including stroke width. */
export function annotationBounds(a: Annotation): Rect {
  switch (a.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return unionRects(a.quads.map(quadBounds));
    case 'ink':
      return inflate(pointsBounds(a.strokes.flat()), a.width / 2);
    case 'shape':
      return inflate(a.line ? pointsBounds(a.line) : a.rect, a.width / 2 + (a.shape === 'arrow' ? arrowHeadSize(a.width) : 0));
    case 'note':
      return { x: a.position.x, y: a.position.y - NOTE_SIZE, w: NOTE_SIZE, h: NOTE_SIZE };
    case 'freetext':
    case 'stamp':
      return a.rect;
  }
}

/** A copy of the annotation moved by (dx, dy) in PDF user space. */
export function translateAnnotation<A extends Annotation>(a: A, dx: number, dy: number): A {
  const p = (pt: Point): Point => ({ x: pt.x + dx, y: pt.y + dy });
  const r = (rc: Rect): Rect => ({ ...rc, x: rc.x + dx, y: rc.y + dy });
  const x = a as Annotation;
  switch (x.type) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return { ...x, quads: x.quads.map((q) => ({ p1: p(q.p1), p2: p(q.p2), p3: p(q.p3), p4: p(q.p4) })) } as A;
    case 'ink':
      return { ...x, strokes: x.strokes.map((s) => s.map(p)) } as A;
    case 'shape':
      return { ...x, rect: r(x.rect), ...(x.line ? { line: [p(x.line[0]), p(x.line[1])] as [Point, Point] } : {}) } as A;
    case 'note':
      return { ...x, position: p(x.position) } as A;
    case 'freetext':
    case 'stamp':
      return { ...x, rect: r(x.rect) } as A;
  }
}

// ---- Ink --------------------------------------------------------------------------------

/**
 * Ramer-Douglas-Peucker: drops points that lie within `tolerance` of the line between their neighbours.
 * Pointer input arrives at 60+ Hz and would otherwise make huge /InkList arrays.
 */
export function simplifyPolyline(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let worst = -1;
    let dist = tolerance;
    for (let i = lo + 1; i < hi; i++) {
      const d = distanceToSegment(points[i]!, points[lo]!, points[hi]!);
      if (d > dist) (dist = d), (worst = i);
    }
    if (worst >= 0) {
      keep[worst] = true;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ---- Shapes -----------------------------------------------------------------------------

export function arrowHeadSize(width: number): number {
  return Math.max(8, width * 4);
}

/**
 * The arrow head as a triangle: [tip, barb1, barb2]. `base` is where the shaft should end so the stroke
 * does not poke through the tip.
 */
export function arrowHead(from: Point, to: Point, width: number): { tip: Point; barbs: [Point, Point]; base: Point } {
  const size = arrowHeadSize(width);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  const barb = (sign: number): Point => ({
    x: to.x - size * Math.cos(angle + sign * spread),
    y: to.y - size * Math.sin(angle + sign * spread),
  });
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  // A very short arrow is all head; keep the shaft from reversing.
  const back = Math.min(size * Math.cos(spread), len);
  return {
    tip: to,
    barbs: [barb(1), barb(-1)],
    base: { x: to.x - back * Math.cos(angle), y: to.y - back * Math.sin(angle) },
  };
}

export type ShapeKind = ShapeAnnot['shape'];

/**
 * Corner b is dragged from corner a. With `constrain` (Shift): rectangles and ellipses become squares and
 * circles, lines and arrows snap to multiples of 45 degrees.
 */
export function constrainDrag(kind: ShapeKind, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (kind === 'rect' || kind === 'ellipse') {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: a.x + Math.sign(dx || 1) * m, y: a.y + Math.sign(dy || 1) * m };
  }
  const len = Math.hypot(dx, dy);
  const snapped = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return { x: a.x + len * Math.cos(snapped), y: a.y + len * Math.sin(snapped) };
}

export type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se' | 'start' | 'end';

export function shapeHandles(s: ShapeAnnot): { id: ResizeHandle; at: Point }[] {
  if (s.line) {
    return [
      { id: 'start', at: s.line[0] },
      { id: 'end', at: s.line[1] },
    ];
  }
  const { x, y, w, h } = s.rect;
  return [
    { id: 'nw', at: { x, y: y + h } },
    { id: 'ne', at: { x: x + w, y: y + h } },
    { id: 'sw', at: { x, y } },
    { id: 'se', at: { x: x + w, y } },
  ];
}

/** Moves one handle to `to`, keeping the opposite corner (or the other end of a line) fixed. */
export function resizeShape(s: ShapeAnnot, handle: ResizeHandle, to: Point): ShapeAnnot {
  if (s.line) {
    const line: [Point, Point] = handle === 'start' ? [to, s.line[1]] : [s.line[0], to];
    return { ...s, line, rect: pointsBounds(line) };
  }
  const { x, y, w, h } = s.rect;
  const anchor: Point = {
    x: handle === 'nw' || handle === 'sw' ? x + w : x,
    y: handle === 'sw' || handle === 'se' ? y + h : y,
  };
  return { ...s, rect: normalizeRect(anchor, to) };
}

/** Does the point touch the annotation, within `slop` points? Used for click selection. */
export function hitTest(a: Annotation, p: Point, slop: number): boolean {
  const near = (r: Rect) => p.x >= r.x - slop && p.x <= r.x + r.w + slop && p.y >= r.y - slop && p.y <= r.y + r.h + slop;
  switch (a.type) {
    case 'ink':
      return a.strokes.some((s) =>
        s.length === 1 ? Math.hypot(p.x - s[0]!.x, p.y - s[0]!.y) <= slop + a.width / 2 : s.some((pt, i) => i > 0 && distanceToSegment(p, s[i - 1]!, pt) <= slop + a.width / 2),
      );
    case 'shape': {
      const reach = slop + a.width / 2;
      if (a.line) return distanceToSegment(p, a.line[0], a.line[1]) <= reach + (a.shape === 'arrow' ? arrowHeadSize(a.width) / 2 : 0);
      const { x, y, w, h } = a.rect;
      if (a.fill && a.fill.a > 0) return near(a.rect);
      if (a.shape === 'ellipse') {
        // Close to the ellipse outline: compare the normalised radius with the stroke reach.
        const rx = Math.max(w / 2, 0.001);
        const ry = Math.max(h / 2, 0.001);
        const nx = (p.x - (x + rx)) / rx;
        const ny = (p.y - (y + ry)) / ry;
        const d = Math.abs(Math.hypot(nx, ny) - 1) * Math.min(rx, ry);
        return d <= reach;
      }
      const inside = near(a.rect);
      const innerOnly = p.x > x + reach && p.x < x + w - reach && p.y > y + reach && p.y < y + h - reach;
      return inside && !innerOnly;
    }
    case 'highlight':
    case 'underline':
    case 'strikeout':
      // Per line, so the gap between two highlighted lines is not part of the annotation.
      return a.quads.some((q) => near(quadBounds(q)));
    default:
      return near(annotationBounds(a));
  }
}
