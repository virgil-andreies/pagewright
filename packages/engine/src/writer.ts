import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, degrees } from '@cantoo/pdf-lib';
import { memorySource, normalizeRotation, preflight, readAll, type SourceId, type WorkingDocument } from '@pagewright/core';
import type { UnicodeFontSource } from './unicode-fonts';
import { DefaultAnnotationWriter, embedStampImages, embedUnicodeFonts, type AnnotationWriter } from './annotation-writer';
import type { PdfWriter, Progress, SaveOpts } from './types';

import { AppFailure } from './errors';

export interface PdfLibWriterOptions {
  annotationWriter?: AnnotationWriter;
  memoryBudgetMB?: number;
  /** Where to get the fonts for text boxes in other alphabets. Without it, saving such a box fails with a message. */
  unicodeFonts?: UnicodeFontSource;
  /** Step 8 of the save pipeline: reopen the output and check page count. Defaults to a pdf-lib reload. */
  verify?: (bytes: Uint8Array, expectedPages: number) => Promise<boolean>;
}

const defaultVerify = async (bytes: Uint8Array, expected: number) =>
  (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount() === expected;

export class PdfLibWriter implements PdfWriter {
  private readonly annots: AnnotationWriter;
  private readonly memoryBudgetMB: number;
  private readonly unicodeFonts: UnicodeFontSource | undefined;
  private readonly verify: NonNullable<PdfLibWriterOptions['verify']>;

  constructor(o: PdfLibWriterOptions = {}) {
    this.annots = o.annotationWriter ?? new DefaultAnnotationWriter();
    this.memoryBudgetMB = o.memoryBudgetMB ?? 1536;
    this.unicodeFonts = o.unicodeFonts;
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
          src = await PDFDocument.load(await readAll(s.data), { updateMetadata: false });
        } catch (e) {
          throw new AppFailure({ code: 'CorruptFile', detail: e instanceof Error ? e.message : String(e) });
        }
        loaded.set(ref.sourceId, src);
      }
      const [page] = await copyPageWithout(out, src, ref.sourceIndex, doc.removedImported[ref.id] ?? []);
      if (!page) throw new AppFailure({ code: 'CorruptFile', detail: `page ${ref.sourceIndex} not found` });

      // 4. Rotation: /Rotate = (intrinsic + extra) % 360.
      if (ref.rotation !== 0) {
        page.setRotation(degrees(normalizeRotation(page.getRotation().angle + ref.rotation)));
      }
      out.addPage(page);
      onProgress?.({ phase: 'copy', done: i + 1, total });
    }

    // 5. Annotations. Imported ones already live in the copied page dictionary.
    const all = doc.pages.flatMap((p) => doc.annotations[p.id] ?? []);
    const images = await embedStampImages(out, all);
    const fonts = await embedUnicodeFonts(out, all, this.unicodeFonts);
    for (const [i, ref] of doc.pages.entries()) {
      const page = out.getPage(i);
      for (const annot of doc.annotations[ref.id] ?? []) {
        if (annot.origin === 'imported') continue;
        this.annots.write({ pdf: out, page, images, fonts }, annot);
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

/** PDF.js's id for an annotation object: `20R` for object 20, with the generation appended when it is not 0. */
const annotationId = (ref: PDFRef) => `${ref.objectNumber}R${ref.generationNumber ? ref.generationNumber : ''}`;

/**
 * Copies one page into `out`, leaving out the annotations the user deleted (`removed`, PDF.js ids). They are
 * taken out of the source page's /Annots array *before* copying, so nothing about them (appearance streams,
 * comment text) is carried into the saved file, rather than being left behind as unreachable objects.
 * Replies to a removed annotation and its popup go with it. The source page is restored afterwards, because
 * the same page may be copied again (a duplicate) with a different set of removals.
 */
export async function copyPageWithout(out: PDFDocument, src: PDFDocument, index: number, removed: readonly string[]) {
  if (removed.length === 0) return out.copyPages(src, [index]);
  const node = src.getPage(index).node;
  const key = PDFName.of('Annots');
  const original = node.get(key);
  const annots = node.lookup(key);
  if (!(annots instanceof PDFArray)) return out.copyPages(src, [index]);

  const entries = annots.asArray();
  const idAt = (i: number) => (entries[i] instanceof PDFRef ? annotationId(entries[i] as PDFRef) : undefined);
  const gone = new Set(removed);
  // Pull in what hangs off the removed annotations, until nothing more joins.
  for (let changed = true; changed; ) {
    changed = false;
    entries.forEach((_, i) => {
      const id = idAt(i);
      const dict = annots.lookup(i);
      if (!id || !(dict instanceof PDFDict)) return;
      const link = (name: string) => {
        const v = dict.get(PDFName.of(name));
        return v instanceof PDFRef ? annotationId(v) : undefined;
      };
      const parentGone = [link('IRT'), link('Parent')].some((p) => p && gone.has(p)); // a reply, or a popup of a removed annotation
      if (!gone.has(id) && parentGone) (gone.add(id), (changed = true));
      if (gone.has(id)) {
        const popup = link('Popup');
        if (popup && !gone.has(popup)) (gone.add(popup), (changed = true));
      }
    });
  }

  const kept = src.context.obj(entries.filter((_, i) => !gone.has(idAt(i) ?? '')));
  node.set(key, kept);
  try {
    return await out.copyPages(src, [index]);
  } finally {
    if (original) node.set(key, original);
  }
}
