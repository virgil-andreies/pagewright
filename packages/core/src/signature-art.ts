import type { Point, Rect } from './annotations';

/**
 * Vector artwork for a signature. A typed signature is the outlines of the letters in a handwriting font, a drawn
 * one is the pen strokes; either way it is stored as plain path data, so the editor, the saved library and the PDF
 * all draw exactly the same shapes and nothing needs a font or an image at save time.
 *
 * Units are arbitrary but consistent: the origin is the top-left corner and y grows downwards, like SVG.
 */
export type PathCmd =
  | readonly ['M', number, number]
  | readonly ['L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z'];

export interface SignatureArt {
  /** Natural size of the artwork. */
  w: number;
  h: number;
  paths: readonly PathCmd[];
  /** `fill`: closed outlines (letters). `stroke`: open lines drawn with a round pen (hand-drawn). */
  mode: 'fill' | 'stroke';
  /** Pen width, in the artwork's units, for `stroke`. */
  strokeWidth?: number;
}

export const DEFAULT_SIGNATURE_WIDTH = 160;

/** The most path commands we accept for one signature: stops a corrupt or hostile saved file from hanging the page. */
export const MAX_ART_COMMANDS = 20000;

/** A quadratic Bezier (what TrueType outlines use) as the equivalent cubic (what PDF and SVG paths use). Exact. */
export function quadToCubic(p0: Point, q: Point, p: Point): readonly ['C', number, number, number, number, number, number] {
  return [
    'C',
    p0.x + (2 / 3) * (q.x - p0.x), p0.y + (2 / 3) * (q.y - p0.y),
    p.x + (2 / 3) * (q.x - p.x), p.y + (2 / 3) * (q.y - p.y),
    p.x, p.y,
  ];
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** The artwork as an SVG path string. */
export function artSvgPath(art: SignatureArt): string {
  return art.paths.map((c) => c[0] + c.slice(1).map((n) => num(n as number)).join(' ')).join(' ');
}

/** Every point the path passes through or is controlled by, for measuring. */
export function artPoints(art: SignatureArt): Point[] {
  const out: Point[] = [];
  for (const c of art.paths) {
    for (let i = 1; i + 1 < c.length + 1; i += 2) out.push({ x: c[i] as number, y: c[i + 1] as number });
  }
  return out;
}

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const ARITY: Record<string, number> = { M: 3, L: 3, C: 7, Z: 1 };

/**
 * Whether `x` is well-formed artwork. Used on data read back from storage, so a damaged or tampered entry is
 * dropped instead of breaking the page or the save.
 */
export function isSignatureArt(x: unknown): x is SignatureArt {
  if (!x || typeof x !== 'object') return false;
  const a = x as Record<string, unknown>;
  if (!isNum(a.w) || !isNum(a.h) || a.w <= 0 || a.h <= 0) return false;
  if (a.mode !== 'fill' && a.mode !== 'stroke') return false;
  if (a.strokeWidth !== undefined && (!isNum(a.strokeWidth) || a.strokeWidth <= 0)) return false;
  if (!Array.isArray(a.paths) || a.paths.length === 0 || a.paths.length > MAX_ART_COMMANDS) return false;
  let started = false;
  for (const c of a.paths) {
    if (!Array.isArray(c) || ARITY[c[0]] !== c.length || !c.slice(1).every(isNum)) return false;
    if (c[0] === 'M') started = true;
    else if (!started) return false; // a path must begin with a move
  }
  return true;
}

/** A new signature's rectangle: the given width, the artwork's own proportions, centred on `center`. */
export function newSignatureRect(art: SignatureArt, center: Point, width = DEFAULT_SIGNATURE_WIDTH): Rect {
  const h = (width * art.h) / art.w;
  return { x: center.x - width / 2, y: center.y - h / 2, w: width, h };
}

/** How much the artwork is enlarged to fill `rect`, keeping its proportions (so the smaller fit wins). */
export function artScale(art: SignatureArt, rect: Rect): number {
  return Math.min(rect.w / art.w, rect.h / art.h);
}
