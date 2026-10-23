import type { Point, Quad, Rect } from './annotations';
import type { Rotation } from './model';
import { normalizeRotation } from './model';

/**
 * Stored annotation coordinates live in the page's unrotated PDF user space
 * (points, y up). Rotation is applied only when displaying.
 *
 * `userUnit` is carried for callers that need physical size; it does not
 * affect point <-> viewport mapping, which is always `pt * scale`.
 */
export interface PageGeometry {
  cropBox: Rect; // origin may be non-zero
  intrinsicRotation: Rotation;
  extraRotation: Rotation;
  userUnit: number;
}

export function effectiveRotation(g: PageGeometry): Rotation {
  return normalizeRotation(g.intrinsicRotation + g.extraRotation);
}

/** Displayed size in points after rotation. */
export function displaySize(g: PageGeometry): { w: number; h: number } {
  const { w, h } = g.cropBox;
  return effectiveRotation(g) % 180 === 0 ? { w, h } : { w: h, h: w };
}

/** Rotation is clockwise. (u, v) are top-left-origin coordinates in the unrotated page. */
export function pdfToViewport(g: PageGeometry, scale: number, p: Point): Point {
  const { x, y, w, h } = g.cropBox;
  const u = p.x - x;
  const v = h - (p.y - y);
  let dx: number;
  let dy: number;
  switch (effectiveRotation(g)) {
    case 0: dx = u; dy = v; break;
    case 90: dx = h - v; dy = u; break;
    case 180: dx = w - u; dy = h - v; break;
    case 270: dx = v; dy = w - u; break;
  }
  return { x: dx * scale, y: dy * scale };
}

export function viewportToPdf(g: PageGeometry, scale: number, p: Point): Point {
  const { x, y, w, h } = g.cropBox;
  const dx = p.x / scale;
  const dy = p.y / scale;
  let u: number;
  let v: number;
  switch (effectiveRotation(g)) {
    case 0: u = dx; v = dy; break;
    case 90: u = dy; v = h - dx; break;
    case 180: u = w - dx; v = h - dy; break;
    case 270: u = w - dy; v = dx; break;
  }
  return { x: x + u, y: y + h - v };
}

export function rectToQuad(r: Rect): Quad {
  return {
    p1: { x: r.x, y: r.y + r.h },
    p2: { x: r.x + r.w, y: r.y + r.h },
    p3: { x: r.x, y: r.y },
    p4: { x: r.x + r.w, y: r.y },
  };
}

export function quadBounds(q: Quad): Rect {
  const xs = [q.p1.x, q.p2.x, q.p3.x, q.p4.x];
  const ys = [q.p1.y, q.p2.y, q.p3.y, q.p4.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** PDF-style affine matrix [a b c d e f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix = readonly [number, number, number, number, number, number];

export function transformPoint(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function transformQuad(q: Quad, m: Matrix): Quad {
  return {
    p1: transformPoint(m, q.p1),
    p2: transformPoint(m, q.p2),
    p3: transformPoint(m, q.p3),
    p4: transformPoint(m, q.p4),
  };
}
