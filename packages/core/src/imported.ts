import type { Annotation, AnnotComment, Point, Quad, Rect, RGBA } from './annotations';
import { NOTE_FILL } from './note-icon';
import { rectToQuad } from './geometry';
import { NOTE_SIZE } from './annotation-geometry';

/**
 * Annotations that were already in the PDF when it was opened (made by Acrobat, Preview and so on). The
 * renderer reports them in this plain form; `importedAnnotations` turns them into the editor's own types so they
 * can be selected, listed with their comments and deleted. They are never drawn by the editor (PDF.js already
 * draws them in the page image) and never written back (they are still in the source).
 */
export interface SourceAnnotation {
  /** PDF.js's id for the annotation, e.g. `20R`. Stable for a given source file. */
  id: string;
  subtype: string;
  /** PDF user space, normalised so w and h are not negative. */
  rect: Rect;
  /** 0..1 */
  color?: { r: number; g: number; b: number };
  contents?: string;
  author?: string;
  /** PDF dates (`D:20260102030405Z`). */
  created?: string;
  modified?: string;
  quads?: Quad[];
  strokes?: Point[][];
  line?: [Point, Point];
  borderWidth?: number;
  /** For replies: the id of the annotation being replied to. */
  inReplyTo?: string;
  replyType?: string;
}

/** Ids of imported annotations carry this prefix so they can never collide with the editor's own ids. */
export const IMPORTED_PREFIX = 'pdf:';

export const isImportedId = (id: string) => id.startsWith(IMPORTED_PREFIX);
export const pdfIdOf = (id: string) => (isImportedId(id) ? id.slice(IMPORTED_PREFIX.length) : id);

/** `D:YYYYMMDDHHmmSS` with an optional zone, as an ISO string; anything unreadable gives ''. */
export function parsePdfDate(s: string | undefined): string {
  const m = /^D?:?(\d{4})(\d\d)?(\d\d)?(\d\d)?(\d\d)?(\d\d)?/.exec(s ?? '');
  if (!m) return '';
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00'] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}Z`;
  return Number.isNaN(Date.parse(iso)) ? '' : iso;
}

/** Subtypes that are part of how a page works rather than something the user would select or delete. */
const NOT_SELECTABLE = new Set(['Link', 'Widget', 'Popup']);
const MARKUP: Record<string, 'highlight' | 'underline' | 'strikeout'> = {
  Highlight: 'highlight', Underline: 'underline', Squiggly: 'underline', StrikeOut: 'strikeout',
};

const rgba = (c: SourceAnnotation['color'], fallback: RGBA): RGBA => (c ? { ...c, a: 1 } : fallback);
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };
const YELLOW: RGBA = { r: 1, g: 0.9, b: 0, a: 1 };

/**
 * The editor's view of a page's original annotations, in the order they appear in the file. Replies are folded
 * into the comment of the annotation they answer, and popups, links and form fields are left out.
 */
export function importedAnnotations(list: readonly SourceAnnotation[], pageId: string): Annotation[] {
  const known = new Set(list.map((a) => a.id));
  const repliesTo = new Map<string, SourceAnnotation[]>();
  for (const a of list) {
    if (a.inReplyTo && known.has(a.inReplyTo)) repliesTo.set(a.inReplyTo, [...(repliesTo.get(a.inReplyTo) ?? []), a]);
  }

  const out: Annotation[] = [];
  for (const a of list) {
    if (NOT_SELECTABLE.has(a.subtype)) continue;
    if (a.inReplyTo && known.has(a.inReplyTo)) continue; // shown inside its parent's thread
    const replies = (repliesTo.get(a.id) ?? []).map((r) => ({
      id: IMPORTED_PREFIX + r.id, author: r.author || 'Unknown', createdAt: parsePdfDate(r.created) || parsePdfDate(r.modified), text: r.contents ?? '',
    }));
    const text = (a.contents ?? '').trim();
    const comment: AnnotComment | undefined = text || replies.length ? { text, replies } : undefined;
    const base = {
      id: IMPORTED_PREFIX + a.id,
      pageId,
      author: a.author || 'Unknown',
      createdAt: parsePdfDate(a.created) || parsePdfDate(a.modified),
      modifiedAt: parsePdfDate(a.modified) || parsePdfDate(a.created),
      opacity: 1,
      origin: 'imported' as const,
    };
    const withComment = comment ? { comment } : {};
    const width = a.borderWidth && a.borderWidth > 0 ? a.borderWidth : 1;

    const markup = MARKUP[a.subtype];
    if (markup) {
      out.push({ ...base, ...withComment, type: markup, color: rgba(a.color, YELLOW), quads: a.quads?.length ? a.quads : [rectToQuad(a.rect)] });
    } else if (a.subtype === 'Ink') {
      out.push({ ...base, ...withComment, type: 'ink', color: rgba(a.color, BLACK), width, strokes: a.strokes ?? [] });
    } else if (a.subtype === 'Square' || a.subtype === 'Circle') {
      out.push({ ...base, ...withComment, type: 'shape', shape: a.subtype === 'Square' ? 'rect' : 'ellipse', color: rgba(a.color, BLACK), width, rect: a.rect });
    } else if (a.subtype === 'Line') {
      out.push({ ...base, ...withComment, type: 'shape', shape: 'line', color: rgba(a.color, BLACK), width, rect: a.rect, ...(a.line ? { line: a.line } : {}) });
    } else if (a.subtype === 'Text') {
      // A note: the icon hangs from the upper-left corner of its rectangle.
      out.push({ ...base, comment: comment ?? { text: '', replies }, type: 'note', color: rgba(a.color, NOTE_FILL), position: { x: a.rect.x, y: a.rect.y + a.rect.h }, icon: 'note' });
    } else if (a.subtype === 'FreeText') {
      out.push({ ...base, type: 'freetext', color: BLACK, rect: a.rect, text: a.contents ?? '', fontSize: 12, fontFamily: 'sans', ...(replies.length ? { comment: { text: '', replies } } : {}) });
    } else {
      // Stamps, polygons, carets, attachments and the rest: all the editor needs is something to select and delete.
      out.push({ ...base, ...withComment, type: 'stamp', color: rgba(a.color, BLACK), rect: a.rect.w >= 1 && a.rect.h >= 1 ? a.rect : { ...a.rect, w: NOTE_SIZE, h: NOTE_SIZE }, payload: { kind: 'preset', name: a.subtype } });
    }
  }
  return out;
}

/**
 * The PDF.js ids to remove when the user deletes `annotId`: the annotation itself and every reply under it
 * (replies of replies included), so no orphaned thread is left in the saved file.
 */
export function idsToRemove(list: readonly SourceAnnotation[], annotId: string): string[] {
  const root = pdfIdOf(annotId);
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    for (const a of list) if (a.inReplyTo === out[i] && !out.includes(a.id)) out.push(a.id);
  }
  return out;
}
