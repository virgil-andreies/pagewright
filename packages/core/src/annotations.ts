import type { AnnotId, PageId } from './model';

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
/** PDF QuadPoints order (Acrobat de facto): top-left, top-right, bottom-left, bottom-right. */
export interface Quad { p1: Point; p2: Point; p3: Point; p4: Point }
export interface RGBA { r: number; g: number; b: number; a: number } // 0..1

export interface AnnotComment {
  text: string;
  replies: { id: string; author: string; createdAt: string; text: string }[];
}

interface AnnotBase {
  id: AnnotId;
  pageId: PageId;
  author: string;
  createdAt: string; // ISO 8601
  modifiedAt: string;
  color: RGBA;
  opacity: number;
  comment?: AnnotComment;
  /** 'imported' annotations are display-only in v1. */
  origin: 'app' | 'imported';
}

export interface TextMarkupAnnot extends AnnotBase { quads: Quad[] }
export interface HighlightAnnot extends TextMarkupAnnot { type: 'highlight' }
export interface UnderlineAnnot extends TextMarkupAnnot { type: 'underline' }
export interface StrikeoutAnnot extends TextMarkupAnnot { type: 'strikeout' }

export interface InkAnnot extends AnnotBase {
  type: 'ink';
  strokes: Point[][];
  width: number;
}

export interface ShapeAnnot extends AnnotBase {
  type: 'shape';
  shape: 'rect' | 'ellipse' | 'line' | 'arrow';
  rect: Rect;
  line?: [Point, Point];
  width: number;
  fill?: RGBA;
}

export interface NoteAnnot extends AnnotBase {
  type: 'note';
  position: Point;
  icon: 'note' | 'comment';
}

export interface FreeTextAnnot extends AnnotBase {
  type: 'freetext';
  rect: Rect;
  text: string;
  fontSize: number;
  fontFamily: 'sans' | 'serif' | 'mono';
}

export type StampPayload =
  | { kind: 'preset'; name: string }
  | { kind: 'signature-drawn'; strokes: Point[][] }
  | { kind: 'signature-typed'; text: string; font: string }
  | { kind: 'image'; mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array };

export interface StampAnnot extends AnnotBase {
  type: 'stamp';
  rect: Rect;
  payload: StampPayload;
}

export type Annotation =
  | HighlightAnnot
  | UnderlineAnnot
  | StrikeoutAnnot
  | InkAnnot
  | ShapeAnnot
  | NoteAnnot
  | FreeTextAnnot
  | StampAnnot;
