import type { Annotation, Rect, Quad, Rotation, SourceAnnotation, SourceDoc, SourceId, WorkingDocument } from '@pagewright/core';

// ---- Renderer (section 5.1); PDF.js implementation lands separately ------------------

export interface PdfRenderer {
  /** May throw an AppError with code 'PasswordRequired'. */
  open(source: SourceDoc, password?: string): Promise<RenderDoc>;
}

export interface RenderDoc {
  readonly sourceId: SourceId;
  readonly pageCount: number;
  getPageInfo(index: number): Promise<PageInfo>;
  renderPage(index: number, opts: RenderOpts, signal?: AbortSignal): Promise<void>;
  getTextContent(index: number): Promise<TextRun[]>;
  /**
   * Fills `opts.container` with a transparent, selectable copy of the page's text, positioned exactly over the
   * rendered page, so the browser can select and copy it. Replaces whatever the container held. The caller
   * supplies the stylesheet (see the `.textLayer` rules in the ui package) and a container that is positioned
   * over the page at the same size as the canvas.
   */
  renderTextLayer(index: number, opts: TextLayerOpts, signal?: AbortSignal): Promise<void>;
  getExistingAnnotations(index: number): Promise<ImportedAnnotMeta[]>;
  /** The annotations already in the source page, in detail, for selecting, reading and deleting them. */
  getSourceAnnotations(index: number): Promise<SourceAnnotation[]>;
  destroy(): void;
}

export interface PageInfo {
  /** Points, after the intrinsic /Rotate. */
  width: number;
  height: number;
  rotation: Rotation;
  mediaBox: Rect;
  cropBox: Rect;
  userUnit: number;
}

export interface RenderOpts {
  scale: number;
  extraRotation: Rotation;
  withAnnotations: 'none' | 'source';
  /** Annotations from the source page to leave out of the picture (PDF.js ids such as `20R`): the ones the user deleted. */
  hideAnnotations?: readonly string[];
  target: HTMLCanvasElement | OffscreenCanvas;
}

export interface TextLayerOpts {
  /** CSS pixels per point: the same value the canvas is rendered at, before devicePixelRatio. */
  scale: number;
  extraRotation: Rotation;
  container: HTMLElement;
}

export interface TextRun {
  text: string;
  quad: Quad;
  charBoxes?: Rect[];
}

export interface ImportedAnnotMeta {
  subtype: string;
  rect: Rect;
  name?: string;
}

// ---- Writer (section 5.2) ------------------------------------------------------------

export interface SaveOpts {
  flattenAnnotations: boolean;
  useObjectStreams: boolean;
  producer: string;
}

export const defaultSaveOpts: SaveOpts = {
  flattenAnnotations: false,
  useObjectStreams: true,
  producer: 'Pagewright PDF',
};

export type Progress = { phase: 'copy' | 'annotate' | 'serialize'; done: number; total: number };

export interface PdfWriter {
  /** Writers that run in a worker honour `signal` by terminating it and rejecting with SaveCancelled. */
  save(doc: WorkingDocument, opts: SaveOpts, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Annotation kinds the writer can currently emit; others throw UnsupportedAnnotation. */
export type AnnotationOf<T extends Annotation['type']> = Extract<Annotation, { type: T }>;
