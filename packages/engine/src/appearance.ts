import type { Quad, RGBA, TextMarkupAnnot } from '@pagewright/core';
import { quadBounds } from '@pagewright/core';

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
