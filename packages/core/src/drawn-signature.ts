import type { Point } from './annotations';
import { MAX_ART_COMMANDS, type PathCmd, type SignatureArt } from './signature-art';

/** Pen width on the drawing pad, in pad units (the pad is `PAD_WIDTH` x `PAD_HEIGHT`). */
export const PAD_PEN_WIDTH = 3;
export const PAD_WIDTH = 560;
export const PAD_HEIGHT = 180;
/** Points closer than this to the previous one are noise from a high-rate pointer and are dropped. */
const MIN_SPACING = 1.5;
/** A signature is at most this many pen strokes; any further ones are ignored. */
export const MAX_STROKES = 40;

const round = (n: number) => Math.round(n * 100) / 100;

function thin(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= MIN_SPACING) out.push(p);
  }
  // Keep the true end of the stroke even when it is within the spacing of the previous point.
  const end = points[points.length - 1];
  if (end && out.length > 1 && out[out.length - 1] !== end) out[out.length - 1] = end;
  return out;
}

/** A smooth curve through the points (Catmull-Rom, as cubic Beziers). A single point becomes a dot. */
function strokeCommands(points: readonly Point[]): PathCmd[] {
  if (points.length === 1) {
    const p = points[0]!;
    return [['M', p.x, p.y], ['L', p.x + 0.01, p.y]]; // a zero-length line with a round pen is a dot
  }
  const cmds: PathCmd[] = [['M', points[0]!.x, points[0]!.y]];
  if (points.length === 2) {
    cmds.push(['L', points[1]!.x, points[1]!.y]);
    return cmds;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[Math.min(points.length - 1, i + 2)]!;
    cmds.push(['C', p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y]);
  }
  return cmds;
}

/**
 * Pen strokes (points in pad units) as signature artwork: smoothed, trimmed to the ink with a margin of one pen
 * width, and drawn with a round pen. Undefined when there is nothing to draw, or the drawing is too complex to keep.
 */
export function strokesToArt(strokes: readonly (readonly Point[])[], penWidth = PAD_PEN_WIDTH): SignatureArt | undefined {
  const kept = strokes.slice(0, MAX_STROKES).map(thin).filter((s) => s.length > 0);
  if (kept.length === 0) return undefined;
  const cmds = kept.flatMap(strokeCommands);
  if (cmds.length > MAX_ART_COMMANDS) return undefined;

  const xs = kept.flat().map((p) => p.x);
  const ys = kept.flat().map((p) => p.y);
  const margin = penWidth;
  const minX = Math.min(...xs) - margin;
  const minY = Math.min(...ys) - margin;
  const w = Math.max(...xs) + margin - minX;
  const h = Math.max(...ys) + margin - minY;

  const paths = cmds.map((c): PathCmd => {
    if (c[0] === 'Z') return c;
    const moved = c.slice(1).map((v, i) => round((v as number) - (i % 2 === 0 ? minX : minY)));
    return [c[0], ...moved] as unknown as PathCmd;
  });
  return { w: round(w), h: round(h), paths, mode: 'stroke', strokeWidth: penWidth };
}
