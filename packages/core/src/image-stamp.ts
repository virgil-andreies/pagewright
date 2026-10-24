import type { Point, Rect } from './annotations';
import type { WorkingDocument } from './model';
import { MIN_STAMP_WIDTH } from './stamp';

export type ImageMime = 'image/png' | 'image/jpeg';

/** The largest image file we try to read at all. Bigger than this is a photo library, not a stamp. */
export const MAX_IMAGE_FILE_BYTES = 30 * 1024 * 1024;
/** Images are scaled down so their longer side is at most this many pixels: sharp in print at stamp sizes, and small. */
export const MAX_IMAGE_SIDE = 2000;
/** Images longer than this many times their width (or the other way round) are refused: a stamp is not a ruler. */
export const MAX_IMAGE_ASPECT = 10;
/** A new image stamp fits in a box this many points wide and tall (unless the image is smaller). */
export const IMAGE_STAMP_BOX = 200;

/** The image type, from the first bytes of the file (the name and the type the browser reports can lie). */
export function sniffImage(bytes: Uint8Array): ImageMime | undefined {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return undefined;
}

/**
 * A new image stamp's rectangle, centred on `center`: one point per pixel, but no bigger than `IMAGE_STAMP_BOX`
 * either way and no narrower than the smallest stamp. The image's proportions are kept.
 */
export function newImageStampRect(width: number, height: number, center: Point): Rect {
  const s = Math.min(1, IMAGE_STAMP_BOX / width, IMAGE_STAMP_BOX / height);
  let w = width * s;
  let h = height * s;
  if (w < MIN_STAMP_WIDTH) [w, h] = [MIN_STAMP_WIDTH, (h * MIN_STAMP_WIDTH) / w];
  return { x: center.x - w / 2, y: center.y - h / 2, w, h };
}

/** The image data held by image stamps in the document, each distinct image counted once (duplicates share it). */
export function imageStampBytes(doc: Pick<WorkingDocument, 'annotations'>): number {
  const seen = new Set<Uint8Array>();
  for (const list of Object.values(doc.annotations)) {
    for (const a of list) if (a.type === 'stamp' && a.origin !== 'imported' && a.payload.kind === 'image') seen.add(a.payload.bytes);
  }
  let n = 0;
  for (const b of seen) n += b.byteLength;
  return n;
}
