import type { FontFamily, FreeTextAnnot, InkAnnot, NoteAnnot, Point, Quad, RGBA, ShapeAnnot, TextMarkupAnnot } from '@pagewright/core';
import { BASELINE_RATIO, NOTE_ICON_LINE, TEXT_PADDING, freeTextLines, lineAdvance, toWinAnsi, NOTE_INK, NOTE_SIZE, annotationBounds, arrowHead, noteIcon, quadBounds } from '@pagewright/core';

/** A Form XObject description, independent of pdf-lib so it can be unit tested as plain data. */
export interface AppearanceStream {
  /** [llx lly urx ury] in page user space; the form Matrix is identity so content uses page coordinates. */
  bbox: [number, number, number, number];
  content: string;
  /** Whether the stream needs the shared /GS ExtGState with Multiply blend. */
  multiply: boolean;
  /** Constant opacity applied through ExtGState /ca and /CA. */
  opacity: number;
  /** A standard font the content refers to as /F1; the writer adds it to the stream's resources. */
  font?: FontFamily;
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

/**
 * The sticky-note icon, drawn from the same shapes the editor uses. Its box is the annotation's /Rect:
 * NOTE_SIZE square with the upper-left corner at the note's position.
 */
export function buildNoteAppearance(a: NoteAnnot): AppearanceStream {
  const { x: x0, y: y0 } = a.position;
  const X = (u: number) => n(x0 + u);
  const Y = (v: number) => n(y0 - v); // the icon's y grows down, PDF's grows up
  const ops = [`${rgb(a.color)} rg`, `${rgb(NOTE_INK)} RG`, `${NOTE_ICON_LINE} w`, '1 J 1 j'];

  for (const shape of noteIcon(a.icon)) {
    if (shape.kind === 'line') {
      ops.push(`${X(shape.from.x)} ${Y(shape.from.y)} m`, `${X(shape.to.x)} ${Y(shape.to.y)} l`, 'S');
    } else if (shape.kind === 'polygon') {
      const [first, ...rest] = shape.points;
      ops.push(`${X(first!.x)} ${Y(first!.y)} m`, ...rest.map((p) => `${X(p.x)} ${Y(p.y)} l`), shape.fill ? 'h B' : 'h S');
    } else {
      const { x, y, w, h, radius: r } = shape;
      const k = r * (1 - KAPPA); // distance from a corner to the Bezier control point
      const [l, t, rt, b] = [x, y, x + w, y + h];
      ops.push(
        `${X(l + r)} ${Y(t)} m`,
        `${X(rt - r)} ${Y(t)} l`,
        `${X(rt - k)} ${Y(t)} ${X(rt)} ${Y(t + k)} ${X(rt)} ${Y(t + r)} c`,
        `${X(rt)} ${Y(b - r)} l`,
        `${X(rt)} ${Y(b - k)} ${X(rt - k)} ${Y(b)} ${X(rt - r)} ${Y(b)} c`,
        `${X(l + r)} ${Y(b)} l`,
        `${X(l + k)} ${Y(b)} ${X(l)} ${Y(b - k)} ${X(l)} ${Y(b - r)} c`,
        `${X(l)} ${Y(t + r)} l`,
        `${X(l)} ${Y(t + k)} ${X(l + k)} ${Y(t)} ${X(l + r)} ${Y(t)} c`,
        shape.fill ? 'h B' : 'h S',
      );
    }
  }
  return {
    bbox: [x0, y0 - NOTE_SIZE, x0 + NOTE_SIZE, y0],
    content: ops.join('\n'),
    multiply: false,
    opacity: a.opacity * a.color.a,
  };
}

const hex = (bytes: Uint8Array) => `<${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}>`;

/**
 * Free text: each wrapped line is positioned absolutely, so the saved page matches the editor line for line.
 * Text is encoded as WinAnsi and shown with one of the standard fonts (/F1), which the writer supplies.
 */
export function buildFreeTextAppearance(a: FreeTextAnnot): AppearanceStream {
  const { x, y, w, h } = a.rect;
  const ops = ['BT', `/F1 ${n(a.fontSize)} Tf`, `${rgb(a.color)} rg`];
  freeTextLines(a).forEach((line, i) => {
    if (line === '') return;
    const baseline = y + h - TEXT_PADDING - BASELINE_RATIO * a.fontSize - i * lineAdvance(a.fontSize);
    ops.push(`1 0 0 1 ${n(x + TEXT_PADDING)} ${n(baseline)} Tm`, `${hex(toWinAnsi(line))} Tj`);
  });
  ops.push('ET');
  return { bbox: [x, y, x + w, y + h], content: ops.join('\n'), multiply: false, opacity: a.opacity * a.color.a, font: a.fontFamily };
}
