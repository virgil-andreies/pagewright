import type { NoteAnnot, Point, RGBA } from './annotations';
import { NOTE_SIZE } from './annotation-geometry';

/**
 * The sticky-note icon as plain shapes, so the editor (SVG) and the saved PDF (appearance stream) draw the
 * same picture. Coordinates are local: (0, 0) is the top-left corner, x grows right, y grows DOWN, and the
 * icon fills a NOTE_SIZE x NOTE_SIZE box. A PDF /Text annotation anchors this top-left corner at the
 * annotation's `position` (spec: NoRotate keeps the upper-left corner fixed), which is why notes stay
 * upright on rotated pages.
 */
export type IconShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; radius: number; fill: boolean }
  | { kind: 'polygon'; points: Point[]; fill: boolean }
  | { kind: 'line'; from: Point; to: Point };

/** Outline and detail colour, dark enough to read on the default yellow. */
export const NOTE_INK: RGBA = { r: 0.25, g: 0.2, b: 0, a: 1 };
/** Used when a note is created. */
export const NOTE_FILL: RGBA = { r: 1, g: 0.85, b: 0.25, a: 1 };

const N = NOTE_SIZE;

export function noteIcon(icon: NoteAnnot['icon']): IconShape[] {
  if (icon === 'comment') {
    // A speech bubble with a tail at the bottom left.
    return [
      { kind: 'rect', x: 1, y: 1, w: N - 2, h: 14, radius: 3, fill: true },
      { kind: 'polygon', points: [{ x: 4, y: 14 }, { x: 10, y: 14 }, { x: 4, y: 19 }], fill: true },
      { kind: 'line', from: { x: 5, y: 6 }, to: { x: 15, y: 6 } },
      { kind: 'line', from: { x: 5, y: 10 }, to: { x: 12, y: 10 } },
    ];
  }
  // A sheet with three lines of text.
  return [
    { kind: 'rect', x: 1, y: 1, w: N - 2, h: N - 2, radius: 3, fill: true },
    { kind: 'line', from: { x: 5, y: 6 }, to: { x: 15, y: 6 } },
    { kind: 'line', from: { x: 5, y: 10 }, to: { x: 15, y: 10 } },
    { kind: 'line', from: { x: 5, y: 14 }, to: { x: 11, y: 14 } },
  ];
}

/** Stroke width of the outline and detail lines, in the same units. */
export const NOTE_ICON_LINE = 1;
