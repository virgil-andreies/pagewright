import type { Point, Quad, Rect } from './annotations';
import type { PageGeometry } from './geometry';
import { rectToQuad, viewportToPdf } from './geometry';

/**
 * A browser reports a text selection as many rectangles: one per text fragment, plus boxes for whole elements
 * that the selection fully covers, so the same words are often covered several times. To highlight them we
 * want one clean rectangle per line. This works on any consistent coordinate space (screen pixels or points).
 */
export interface LineRectOptions {
  /** Rectangles thinner or shorter than this are noise (zero-width line breaks, caret boxes). */
  minSize?: number;
  /** Neighbouring rectangles on a line are joined when the gap between them is at most this fraction of the line height. */
  maxGap?: number;
}

const area = (r: Rect) => r.w * r.h;

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** How much of `inner` lies inside `outer`, from 0 to 1. */
const coveredBy = (inner: Rect, outer: Rect) => overlap(inner, outer) / (area(inner) || 1);

export function mergeRectsIntoLines(input: readonly Rect[], opts: LineRectOptions = {}): Rect[] {
  const minSize = opts.minSize ?? 1;
  const maxGap = opts.maxGap ?? 0.35;

  // 1. Drop noise, then drop anything that is (almost) inside a bigger rectangle.
  const sized = input.filter((r) => r.w >= minSize && r.h >= minSize);
  const bySize = [...sized].sort((a, b) => area(b) - area(a));
  const kept: Rect[] = [];
  for (const r of bySize) if (!kept.some((k) => coveredBy(r, k) >= 0.9)) kept.push(r);

  // 2. Group into lines: rectangles whose vertical extents mostly overlap belong together.
  const lines: Rect[][] = [];
  for (const r of kept.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((l) => {
      const ref = l[0]!;
      const shared = Math.min(ref.y + ref.h, r.y + r.h) - Math.max(ref.y, r.y);
      return shared > 0.5 * Math.min(ref.h, r.h);
    });
    if (line) line.push(r);
    else lines.push([r]);
  }

  // 3. Within a line, join rectangles that touch or nearly touch (a gap of a space or so).
  const out: Rect[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    let cur = { ...line[0]! };
    for (const r of line.slice(1)) {
      const gap = r.x - (cur.x + cur.w);
      if (gap <= maxGap * Math.max(cur.h, r.h)) {
        const top = Math.min(cur.y, r.y);
        const bottom = Math.max(cur.y + cur.h, r.y + r.h);
        const right = Math.max(cur.x + cur.w, r.x + r.w);
        cur = { x: cur.x, y: top, w: right - cur.x, h: bottom - top };
      } else {
        out.push(cur);
        cur = { ...r };
      }
    }
    out.push(cur);
  }
  // Reading order: top to bottom, then left to right.
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * A rectangle in the page view's pixel space (origin at the page's top-left corner, as displayed) as a quad in
 * PDF user space. Page rotation is a multiple of 90 degrees, so two opposite corners are enough.
 */
export function viewRectToQuad(geometry: PageGeometry, scale: number, r: Rect): Quad {
  const a = viewportToPdf(geometry, scale, { x: r.x, y: r.y });
  const b = viewportToPdf(geometry, scale, { x: r.x + r.w, y: r.y + r.h });
  const lo: Point = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
  return rectToQuad({ x: lo.x, y: lo.y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
}
