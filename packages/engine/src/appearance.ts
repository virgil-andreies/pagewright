import type { InkAnnot, Point, Quad, RGBA, ShapeAnnot, TextMarkupAnnot } from '@pagewright/core';
import { annotationBounds, arrowHead, quadBounds } from '@pagewright/core';

/** A Form XObject description, independent of pdf-lib so it can be unit tested as plain data. */
export interface AppearanceStream {
  /** [llx lly urx ury] in page user space; the form Matrix is identity so content uses page coordinates. */
  bbox: [number, number, number, number];
  content: string;
  /** Whether the stream needs the shared /GS ExtGState with Multiply blend. */
  multiply: boolean;
  /** Constant opacity applied through ExtGState /ca and /CA. */
  opacity: number;
}

const n = (v: number) => {
  const s = (Math.round(v * 1000) / 1000).toString();
  return s === '-0' ? '0' : s;
};
const rgb = (c: RGBA) => `${n(c.r)} ${n(c.g)} ${n(c.b)}`;

/** QuadPoints order is TL, TR, BL, BR; the visible outline walks TL, TR, BR, BL. */
function outline(q: Quad) {
  return [q.p1, q.p2, q.p4, q.p3];
}

export function markupBounds(quads: readonly Quad[]): [number, number, number, number] {
  const rects = quads.map(quadBounds);
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return [x1, y1, x2, y2];
}

export function buildTextMarkupAppearance(a: TextMarkupAnnot & { type: 'highlight' | 'underline' | 'strikeout' }): AppearanceStream {
  const ops: string[] = [];
  const lineWidth = (q: Quad) => Math.max(0.5, Math.min(quadBounds(q).h * 0.07, 2));

  if (a.type === 'highlight') {
    ops.push(`${rgb(a.color)} rg`);
    for (const q of a.quads) {
      const [p0, ...rest] = outline(q);
      ops.push(`${n(p0!.x)} ${n(p0!.y)} m`, ...rest.map((p) => `${n(p.x)} ${n(p.y)} l`), 'h f');
    }
  } else {
    ops.push(`${rgb(a.color)} RG`, '1 J');
    for (const q of a.quads) {
      // Bottom edge for underline, mid-line for strikeout.
      const left = a.type === 'underline' ? q.p3 : { x: (q.p1.x + q.p3.x) / 2, y: (q.p1.y + q.p3.y) / 2 };
      const right = a.type === 'underline' ? q.p4 : { x: (q.p2.x + q.p4.x) / 2, y: (q.p2.y + q.p4.y) / 2 };
      ops.push(`${n(lineWidth(q))} w`, `${n(left.x)} ${n(left.y)} m`, `${n(right.x)} ${n(right.y)} l S`);
    }
  }

  return {
    bbox: markupBounds(a.quads),
    content: ops.join('\n'),
    multiply: a.type === 'highlight',
    opacity: a.opacity * a.color.a,
  };
}

const boundsTuple = (a: InkAnnot | ShapeAnnot): [number, number, number, number] => {
  const b = annotationBounds(a);
  return [b.x, b.y, b.x + b.w, b.y + b.h];
};

const move = (p: Point) => `${n(p.x)} ${n(p.y)} m`;
const lineTo = (p: Point) => `${n(p.x)} ${n(p.y)} l`;

/**
 * Ink: round caps and joins. A single-point stroke is drawn as a zero-length segment, which the PDF spec
 * defines as a dot when the cap is round.
 */
export function buildInkAppearance(a: InkAnnot): AppearanceStream {
  const ops = [`${rgb(a.color)} RG`, `${n(a.width)} w`, '1 J 1 j'];
  for (const stroke of a.strokes) {
    if (stroke.length === 0) continue;
    ops.push(move(stroke[0]!));
    if (stroke.length === 1) ops.push(lineTo(stroke[0]!));
    else for (const p of stroke.slice(1)) ops.push(lineTo(p));
    ops.push('S');
  }
  return { bbox: boundsTuple(a), content: ops.join('\n'), multiply: false, opacity: a.opacity * a.color.a };
}

/** Bezier circle constant: control point offset for a quarter arc. */
const KAPPA = 0.5522847498;

/**
 * Shapes are stroked on the centre line of `rect` / `line`, exactly as the editor overlay draws them, so
 * what you see while editing is what other viewers show. `fill.a` is not honoured separately: the whole
 * annotation shares one opacity (one ExtGState).
 */
export function buildShapeAppearance(a: ShapeAnnot): AppearanceStream {
  const ops: string[] = [`${rgb(a.color)} RG`, `${n(a.width)} w`, '1 J 1 j'];
  const hasFill = !!a.fill && a.fill.a > 0;
  if (hasFill) ops.push(`${rgb(a.fill!)} rg`);
  const paint = hasFill ? (a.width > 0 ? 'B' : 'f') : 'S';

  if (a.shape === 'rect') {
    const { x, y, w, h } = a.rect;
    ops.push(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re`, paint);
  } else if (a.shape === 'ellipse') {
    const { x, y, w, h } = a.rect;
    const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, kx = rx * KAPPA, ky = ry * KAPPA;
    const c = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) =>
      `${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x3)} ${n(y3)} c`;
    ops.push(
      `${n(cx + rx)} ${n(cy)} m`,
      c(cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
      c(cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
      c(cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
      c(cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy),
      'h',
      paint,
    );
  } else {
    const [from, to] = a.line ?? [{ x: a.rect.x, y: a.rect.y }, { x: a.rect.x + a.rect.w, y: a.rect.y + a.rect.h }];
    if (a.shape === 'arrow') {
      const head = arrowHead(from, to, a.width);
      ops.push(move(from), lineTo(head.base), 'S');
      // The head is a filled triangle in the stroke colour.
      ops.push(`${rgb(a.color)} rg`, move(head.tip), lineTo(head.barbs[0]), lineTo(head.barbs[1]), 'h f');
    } else {
      ops.push(move(from), lineTo(to), 'S');
    }
  }
  return { bbox: boundsTuple(a), content: ops.join('\n'), multiply: false, opacity: a.opacity * a.color.a };
}
