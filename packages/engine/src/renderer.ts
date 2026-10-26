import type { Quad, Rect, Rotation, SourceDoc } from '@pagewright/core';
import { memorySource, normalizeRotation, readRange, sourceSize, type Point, type SourceAnnotation } from '@pagewright/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { ImportedAnnotMeta, PageInfo, PdfRenderer, RenderDoc, RenderOpts, TextLayerOpts, TextRun } from './types';
import { AppFailure } from './errors';

type PdfjsModule = typeof import('pdfjs-dist');

export interface PdfJsRendererOptions {
  /**
   * The pdfjs-dist module. Defaults to a dynamic `import('pdfjs-dist')`.
   * Node callers should pass `pdfjs-dist/legacy/build/pdf.mjs`; browsers must set
   * `GlobalWorkerOptions.workerSrc` themselves.
   */
  pdfjs?: PdfjsModule;
  /** URL/path (with trailing slash) of pdfjs-dist/standard_fonts/. Needed in Node to measure and render standard fonts. */
  standardFontDataUrl?: string;
  /**
   * URL/path (with trailing slash) of pdfjs-dist/cmaps/: the character maps for Chinese, Japanese and Korean text in
   * fonts the PDF does not embed. Without them such text shows as missing or wrong characters.
   */
  cMapUrl?: string;
}

const WHOLE_FILE_MAX = 4 * 1024 * 1024;
const INITIAL_CHUNK = 64 * 1024;
const RANGE_CHUNK = 1024 * 1024;

// pdf.js PasswordResponses
const NEED_PASSWORD = 1;
const INCORRECT_PASSWORD = 2;

export class PdfJsRenderer implements PdfRenderer {
  constructor(private readonly opts: PdfJsRendererOptions = {}) {}

  private async lib(): Promise<PdfjsModule> {
    return this.opts.pdfjs ?? (await import('pdfjs-dist'));
  }

  /**
   * How PDF.js reads the file. Small files are handed over whole. Big ones are loaded by byte range, so the
   * main thread never holds a second copy and PDF.js fetches only what the visible pages need.
   */
  private async input(pdfjs: PdfjsModule, source: SourceDoc): Promise<Record<string, unknown>> {
    const size = sourceSize(source.data);
    // PDF.js takes ownership of what it is given, so it always gets a fresh copy.
    if (size <= WHOLE_FILE_MAX) return { data: await readRange(source.data, 0, size) };

    const transport = new pdfjs.PDFDataRangeTransport(size, await readRange(source.data, 0, INITIAL_CHUNK));
    transport.requestDataRange = (begin, end) => {
      readRange(source.data, begin, end).then(
        (chunk) => transport.onDataRange(begin, chunk),
        () => transport.abort(),
      );
    };
    // No auto-fetch: otherwise PDF.js would quietly pull the rest of the file into memory in the background.
    return { range: transport, length: size, disableAutoFetch: true, disableStream: true, rangeChunkSize: RANGE_CHUNK };
  }

  async open(source: SourceDoc, password?: string): Promise<RenderDoc> {
    const pdfjs = await this.lib();
    const task = pdfjs.getDocument({
      ...(await this.input(pdfjs, source)),
      password,
      ...(this.opts.standardFontDataUrl ? { standardFontDataUrl: this.opts.standardFontDataUrl } : {}),
      ...(this.opts.cMapUrl ? { cMapUrl: this.opts.cMapUrl, cMapPacked: true } : {}),
    });
    try {
      return new PdfJsDoc(source.id, await task.promise, pdfjs);
    } catch (e) {
      const err = e as { name?: string; code?: number; message?: string };
      if (err.name === 'PasswordException') {
        throw new AppFailure(
          err.code === INCORRECT_PASSWORD || (err.code !== NEED_PASSWORD && password !== undefined)
            ? { code: 'WrongPassword' }
            : { code: 'PasswordRequired', sourceId: source.id },
        );
      }
      throw new AppFailure({ code: 'CorruptFile', detail: err.message ?? String(e) });
    }
  }
}

class PdfJsDoc implements RenderDoc {
  readonly pageCount: number;

  constructor(readonly sourceId: string, private readonly doc: PDFDocumentProxy, private readonly pdfjs: PdfjsModule) {
    this.pageCount = doc.numPages;
  }

  async getPageInfo(index: number): Promise<PageInfo> {
    const page = await this.doc.getPage(index + 1);
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
    const cropBox: Rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    const rotation = normalizeRotation(page.rotate);
    const swap = rotation % 180 !== 0;
    return {
      width: swap ? cropBox.h : cropBox.w,
      height: swap ? cropBox.w : cropBox.h,
      rotation,
      // pdf.js only exposes the visible box (CropBox clipped to MediaBox); callers that need
      // the raw MediaBox must read it from the writer side.
      mediaBox: cropBox,
      cropBox,
      userUnit: page.userUnit,
    };
  }

  async renderPage(index: number, opts: RenderOpts, signal?: AbortSignal): Promise<void> {
    const page = await this.doc.getPage(index + 1);
    const rotation: Rotation = normalizeRotation(page.rotate + opts.extraRotation);
    const viewport = page.getViewport({ scale: opts.scale, rotation });
    opts.target.width = Math.ceil(viewport.width);
    opts.target.height = Math.ceil(viewport.height);
    // 0 = DISABLE, 1 = ENABLE. Our own annotations are drawn by the UI overlay, never here.
    const annotationMode = opts.withAnnotations === 'source' ? 1 : 0;
    let operationsFilter: ((index: number) => boolean) | undefined;
    if (annotationMode === 1 && opts.hideAnnotations?.length) {
      // PDF.js wraps each annotation's drawing in begin/end markers carrying its id: skip the deleted ones' ranges.
      const list = await page.getOperatorList({ annotationMode });
      const skip = skippedOperations(list.fnArray, list.argsArray, new Set(opts.hideAnnotations), this.pdfjs.OPS.beginAnnotation, this.pdfjs.OPS.endAnnotation);
      if (skip.size > 0) operationsFilter = (i) => !skip.has(i);
    }
    const task = page.render({ canvas: opts.target as HTMLCanvasElement, viewport, annotationMode, ...(operationsFilter ? { operationsFilter } : {}) });
    const onAbort = () => task.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) onAbort();
      await task.promise;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      page.cleanup();
    }
  }

  async renderTextLayer(index: number, opts: TextLayerOpts, signal?: AbortSignal): Promise<void> {
    const page = await this.doc.getPage(index + 1);
    const viewport = page.getViewport({ scale: opts.scale, rotation: normalizeRotation(page.rotate + opts.extraRotation) });
    const { container } = opts;
    container.replaceChildren();
    // The text layer sizes everything from these (see pdf_viewer.css).
    container.style.setProperty('--total-scale-factor', String(opts.scale));
    container.style.setProperty('--scale-round-x', '1px');
    container.style.setProperty('--scale-round-y', '1px');
    const layer = new this.pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport });
    const onAbort = () => layer.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal?.aborted) onAbort();
      await layer.render();
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async getTextContent(index: number): Promise<TextRun[]> {
    const page = await this.doc.getPage(index + 1);
    const content = await page.getTextContent();
    const runs: TextRun[] = [];
    for (const item of content.items) {
      if (!('str' in item) || item.str === '') continue;
      runs.push({ text: item.str, quad: textQuad(item.transform as number[], item.width, item.height) });
    }
    return runs;
  }

  async getSourceAnnotations(index: number): Promise<SourceAnnotation[]> {
    const page = await this.doc.getPage(index + 1);
    return (await page.getAnnotations()).map((a) => toSourceAnnotation(a as unknown as RawAnnotation));
  }

  async getExistingAnnotations(index: number): Promise<ImportedAnnotMeta[]> {
    const page = await this.doc.getPage(index + 1);
    const annots = await page.getAnnotations();
    return annots.map((a) => {
      const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = a.rect as number[];
      return {
        subtype: String(a.subtype),
        rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
        ...(typeof a.id === 'string' ? { name: a.id } : {}),
      };
    });
  }

  destroy(): void {
    void this.doc.loadingTask.destroy();
  }
}

/**
 * Text item -> quad in PDF user space. `transform` is [a b c d e f] with (e, f) the baseline origin and
 * (a, b) the writing direction; `width`/`height` are in user-space units. A 22% descent is assumed
 * below the baseline, which matches how the sample highlights sit on Helvetica glyphs.
 */
export function textQuad(transform: number[], width: number, height: number): Quad {
  const [a = 1, b = 0, , , e = 0, f = 0] = transform;
  const len = Math.hypot(a, b) || 1;
  const ux = a / len;
  const uy = b / len;
  const nx = -uy;
  const ny = ux;
  const descent = height * 0.22;
  const bl = { x: e - nx * descent, y: f - ny * descent };
  const br = { x: bl.x + ux * width, y: bl.y + uy * width };
  const tl = { x: bl.x + nx * height, y: bl.y + ny * height };
  const tr = { x: br.x + nx * height, y: br.y + ny * height };
  return { p1: tl, p2: tr, p3: bl, p4: br };
}

/** Step 8 of the save pipeline using pdf.js: the output must open and have the expected page count. */
export function pdfjsVerify(renderer: PdfJsRenderer) {
  return async (bytes: Uint8Array, expectedPages: number): Promise<boolean> => {
    const doc = await renderer.open({
      id: 'verify', name: 'verify.pdf', data: memorySource(bytes), pageCount: expectedPages, isEncrypted: false, hasDigitalSignature: false,
    });
    try {
      if (doc.pageCount !== expectedPages) return false;
      await doc.getPageInfo(expectedPages - 1);
      return true;
    } catch {
      return false;
    } finally {
      doc.destroy();
    }
  };
}

/**
 * The operation indices to leave out so that the annotations in `hide` are not drawn. PDF.js emits
 * `beginAnnotation(id, ...)` and `endAnnotation` around each annotation's drawing; everything from a matching
 * begin to its end (both included) is skipped.
 */
export function skippedOperations(
  fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>, hide: ReadonlySet<string>, begin: number, end: number,
): Set<number> {
  const skip = new Set<number>();
  let skipping = false;
  for (let i = 0; i < fnArray.length; i++) {
    if (fnArray[i] === begin) skipping = hide.has(String((argsArray[i] as unknown[] | undefined)?.[0]));
    if (skipping) skip.add(i);
    if (fnArray[i] === end) skipping = false;
  }
  return skip;
}

/** The parts of PDF.js's annotation data we read. Numbers arrive as typed arrays. */
interface RawAnnotation {
  id: string;
  subtype: string;
  rect: ArrayLike<number>;
  color?: ArrayLike<number> | null;
  contentsObj?: { str?: string };
  titleObj?: { str?: string };
  creationDate?: string;
  modificationDate?: string;
  quadPoints?: ArrayLike<number> | ArrayLike<ArrayLike<number>>;
  inkLists?: ArrayLike<ArrayLike<number>>;
  lineCoordinates?: ArrayLike<number>;
  borderStyle?: { width?: number };
  inReplyTo?: string | null;
  replyType?: string | null;
}

const chunk = (flat: ArrayLike<number>, n: number): number[][] => {
  const out: number[][] = [];
  for (let i = 0; i + n <= flat.length; i += n) out.push(Array.from({ length: n }, (_, k) => flat[i + k]!));
  return out;
};

/** PDF.js data -> our plain description. Quad points come in PDF order: top-left, top-right, bottom-left, bottom-right. */
export function toSourceAnnotation(a: RawAnnotation): SourceAnnotation {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = Array.from(a.rect);
  const out: SourceAnnotation = {
    id: a.id,
    subtype: a.subtype,
    rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) },
  };
  if (a.color && a.color.length >= 3) out.color = { r: a.color[0]! / 255, g: a.color[1]! / 255, b: a.color[2]! / 255 };
  if (a.contentsObj?.str) out.contents = a.contentsObj.str;
  if (a.titleObj?.str) out.author = a.titleObj.str;
  if (a.creationDate) out.created = a.creationDate;
  if (a.modificationDate) out.modified = a.modificationDate;
  if (a.borderStyle?.width !== undefined) out.borderWidth = a.borderStyle.width;
  if (a.inReplyTo) out.inReplyTo = a.inReplyTo;
  if (a.replyType) out.replyType = a.replyType;

  if (a.quadPoints && a.quadPoints.length > 0) {
    const first = (a.quadPoints as ArrayLike<unknown>)[0];
    const quads: number[][] = typeof first === 'number' ? chunk(a.quadPoints as ArrayLike<number>, 8) : Array.from(a.quadPoints as ArrayLike<ArrayLike<number>>, (q) => Array.from(q));
    const pt = (q: number[], i: number): Point => ({ x: q[i]!, y: q[i + 1]! });
    out.quads = quads.filter((q) => q.length >= 8).map((q): Quad => ({ p1: pt(q, 0), p2: pt(q, 2), p3: pt(q, 4), p4: pt(q, 6) }));
  }
  if (a.inkLists?.length) {
    out.strokes = Array.from(a.inkLists, (flat) => chunk(flat, 2).map(([x, y]): Point => ({ x: x!, y: y! })));
  }
  if (a.lineCoordinates && a.lineCoordinates.length >= 4) {
    const [lx1, ly1, lx2, ly2] = Array.from(a.lineCoordinates);
    out.line = [{ x: lx1!, y: ly1! }, { x: lx2!, y: ly2! }];
  }
  return out;
}
