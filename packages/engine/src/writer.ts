import { PDFDocument, degrees } from '@cantoo/pdf-lib';
import { normalizeRotation, preflight, type AppError, type SourceId, type WorkingDocument } from '@pagewright/core';
import { DefaultAnnotationWriter, type AnnotationWriter } from './annotation-writer';
import type { PdfWriter, Progress, SaveOpts } from './types';

/** Thrown for any condition expressed as an AppError (see core/policies). */
export class AppFailure extends Error {
  constructor(readonly error: AppError) {
    super(error.code);
  }
}

export interface PdfLibWriterOptions {
  annotationWriter?: AnnotationWriter;
  memoryBudgetMB?: number;
  /** Step 8 of the save pipeline: reopen the output and check page count. Defaults to a pdf-lib reload. */
  verify?: (bytes: Uint8Array, expectedPages: number) => Promise<boolean>;
}

const defaultVerify = async (bytes: Uint8Array, expected: number) =>
  (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount() === expected;

export class PdfLibWriter implements PdfWriter {
  private readonly annots: AnnotationWriter;
  private readonly memoryBudgetMB: number;
  private readonly verify: NonNullable<PdfLibWriterOptions['verify']>;

  constructor(o: PdfLibWriterOptions = {}) {
    this.annots = o.annotationWriter ?? new DefaultAnnotationWriter();
    this.memoryBudgetMB = o.memoryBudgetMB ?? 1536;
    this.verify = o.verify ?? defaultVerify;
  }

  async save(doc: WorkingDocument, opts: SaveOpts, onProgress?: (p: Progress) => void): Promise<Uint8Array> {
    // 1. Preflight. Signed sources are a warning the UI must have confirmed before calling save.
    const pre = preflight(doc, { memoryBudgetMB: this.memoryBudgetMB });
    if (pre.errors[0]) throw new AppFailure(pre.errors[0]);
    if (opts.flattenAnnotations) throw new Error('flattenAnnotations is not implemented yet');

    // 2-3. Load each used source once, copy pages in order (one copy per occurrence).
    const out = await PDFDocument.create();
    const loaded = new Map<SourceId, PDFDocument>();
    const total = doc.pages.length;

    for (const [i, ref] of doc.pages.entries()) {
      let src = loaded.get(ref.sourceId);
      if (!src) {
        const s = doc.sources[ref.sourceId];
        if (!s) throw new AppFailure({ code: 'CorruptFile', detail: `missing source ${ref.sourceId}` });
        try {
          src = await PDFDocument.load(s.bytes, { updateMetadata: false });
        } catch (e) {
          throw new AppFailure({ code: 'CorruptFile', detail: e instanceof Error ? e.message : String(e) });
        }
        loaded.set(ref.sourceId, src);
      }
      const [page] = await out.copyPages(src, [ref.sourceIndex]);
      if (!page) throw new AppFailure({ code: 'CorruptFile', detail: `page ${ref.sourceIndex} not found` });

      // 4. Rotation: /Rotate = (intrinsic + extra) % 360.
      if (ref.rotation !== 0) {
        page.setRotation(degrees(normalizeRotation(page.getRotation().angle + ref.rotation)));
      }
      out.addPage(page);
      onProgress?.({ phase: 'copy', done: i + 1, total });
    }

    // 5. Annotations. Imported ones already live in the copied page dictionary.
    for (const [i, ref] of doc.pages.entries()) {
      const page = out.getPage(i);
      for (const annot of doc.annotations[ref.id] ?? []) {
        if (annot.origin === 'imported') continue;
        this.annots.write({ pdf: out, page }, annot);
      }
      onProgress?.({ phase: 'annotate', done: i + 1, total });
    }

    // 6. Metadata.
    const m = doc.metadata;
    if (m.title !== undefined) out.setTitle(m.title);
    if (m.author !== undefined) out.setAuthor(m.author);
    if (m.subject !== undefined) out.setSubject(m.subject);
    if (m.keywords) out.setKeywords(m.keywords);
    out.setProducer(opts.producer);
    out.setCreator(opts.producer);

    // 7. Serialize.
    const bytes = await out.save({ useObjectStreams: opts.useObjectStreams });
    onProgress?.({ phase: 'serialize', done: total, total });

    // 8. Verify.
    if (!(await this.verify(bytes, total))) throw new AppFailure({ code: 'SaveVerificationFailed' });
    return bytes;
  }
}
