import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, degrees } from '@cantoo/pdf-lib';
import {
  History, memorySource, readAll, addAnnotation, addSource, emptyDocument, rotatePages, rectToQuad,
  type HighlightAnnot, type SourceDoc
} from '@pagewright/core';
import { AppFailure, PdfLibWriter, defaultSaveOpts, buildTextMarkupAppearance } from '../src';

async function makePdf(pages: number, opts: { rotate?: number; cropBox?: [number, number, number, number] } = {}) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = pdf.addPage([200, 300]);
    if (opts.rotate) p.setRotation(degrees(opts.rotate));
    if (opts.cropBox) p.setCropBox(...opts.cropBox);
  }
  return pdf.save();
}

const source = async (id: string, pageCount: number, o: Parameters<typeof makePdf>[1] = {}, over: Partial<SourceDoc> = {}): Promise<SourceDoc> => ({
  id, name: `${id}.pdf`, data: memorySource(await makePdf(pageCount, o)), pageCount, isEncrypted: false, hasDigitalSignature: false, ...over,
});

const highlight = (pageId: string, id = 'annot-1'): HighlightAnnot => ({
  type: 'highlight', id, pageId, author: 'Ada', createdAt: '2026-01-02T03:04:05Z', modifiedAt: '2026-01-02T03:04:05Z',
  color: { r: 1, g: 1, b: 0, a: 1 }, opacity: 0.5, origin: 'app',
  quads: [rectToQuad({ x: 10, y: 20, w: 100, h: 12 })],
  comment: { text: 'look here', replies: [] },
});

function build(sources: SourceDoc[]) {
  const h = new History(emptyDocument());
  let n = 0;
  sources.forEach((s) => h.execute(addSource(s, undefined, () => `p${++n}`)));
  return h;
}

const writer = new PdfLibWriter();
const get = (d: PDFDict, k: string) => d.lookup(PDFName.of(k));

describe('PdfLibWriter', () => {
  it('merges, reorders pages and keeps count', async () => {
    const h = build([await source('a', 2), await source('b', 3)]);
    const bytes = await writer.save(h.current, defaultSaveOpts);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(5);
  });

  it('applies rotation on top of the intrinsic /Rotate', async () => {
    const h = build([await source('a', 2, { rotate: 90 })]);
    h.execute(rotatePages(['p1'], 90));
    const out = await PDFDocument.load(await writer.save(h.current, defaultSaveOpts));
    expect(out.getPage(0).getRotation().angle).toBe(180);
    expect(out.getPage(1).getRotation().angle).toBe(90);
  });

  it('writes a highlight as a real annotation with /AP, /NM and comment', async () => {
    const h = build([await source('a', 1)]);
    h.execute(addAnnotation(highlight('p1')));
    const out = await PDFDocument.load(await writer.save(h.current, defaultSaveOpts));
    const annots = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(annots.size()).toBe(1);
    const a = annots.lookup(0, PDFDict);
    expect(get(a, 'Subtype')).toBe(PDFName.of('Highlight'));
    expect((get(a, 'NM') as PDFHexString).decodeText()).toBe('annot-1');
    expect((get(a, 'Contents') as PDFHexString).decodeText()).toBe('look here');
    expect(get(a, 'F')).toEqual(PDFNumber.of(4));
    expect(a.lookup(PDFName.of('QuadPoints'), PDFArray).size()).toBe(8);

    const n = a.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
    expect(n).toBeInstanceOf(PDFRawStream);
    const stream = n as PDFRawStream;
    expect(stream.dict.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Form'));
    const gs = stream.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of('GS'), PDFDict);
    expect(gs.lookup(PDFName.of('BM'))).toBe(PDFName.of('Multiply'));
  });

  it('keeps coordinates for a page with a non-zero CropBox (absolute user space)', async () => {
    const h = build([await source('a', 1, { cropBox: [50, 50, 100, 100] })]);
    const a = { ...highlight('p1'), quads: [rectToQuad({ x: 60, y: 70, w: 30, h: 10 })] };
    h.execute(addAnnotation(a));
    const out = await PDFDocument.load(await writer.save(h.current, defaultSaveOpts));
    const rect = out.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict).lookup(PDFName.of('Rect'), PDFArray);
    expect(rect.asArray().map((n) => (n as PDFNumber).asNumber())).toEqual([60, 70, 90, 80]);
  });

  it('writes each annotation to the right page after reorder/duplicate', async () => {
    const h = build([await source('a', 2)]);
    h.execute(addAnnotation(highlight('p2', 'on-second')));
    const out = await PDFDocument.load(await writer.save(h.current, defaultSaveOpts));
    expect(out.getPage(0).node.lookup(PDFName.of('Annots'))).toBeUndefined();
    expect(out.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray).size()).toBe(1);
  });

  it('reports progress through all three phases', async () => {
    const h = build([await source('a', 2)]);
    const phases = new Set<string>();
    await writer.save(h.current, defaultSaveOpts, (p) => phases.add(p.phase));
    expect([...phases]).toEqual(['copy', 'annotate', 'serialize']);
  });

  it('refuses encrypted sources', async () => {
    const h = build([await source('a', 1, {}, { isEncrypted: true })]);
    await expect(writer.save(h.current, defaultSaveOpts)).rejects.toMatchObject({ error: { code: 'EncryptedNotSupported' } });
  });

  it('fails loudly when verification fails', async () => {
    const h = build([await source('a', 1)]);
    const w = new PdfLibWriter({ verify: async () => false });
    await expect(w.save(h.current, defaultSaveOpts)).rejects.toBeInstanceOf(AppFailure);
  });

  it('does not mutate the source bytes', async () => {
    const s = await source('a', 1);
    const copy = (await readAll(s.data)).slice();
    const h = build([s]);
    h.execute(addAnnotation(highlight('p1')));
    await writer.save(h.current, defaultSaveOpts);
    expect(await readAll(s.data)).toEqual(copy);
  });
});

describe('buildTextMarkupAppearance', () => {
  it('fills quads for highlight and strokes for underline', () => {
    const q = [rectToQuad({ x: 0, y: 0, w: 10, h: 10 })];
    const base = { ...highlight('p'), quads: q };
    const hl = buildTextMarkupAppearance(base);
    expect(hl.content).toContain('rg');
    expect(hl.content).toMatch(/h f$/);
    expect(hl.multiply).toBe(true);
    expect(hl.opacity).toBe(0.5);
    const ul = buildTextMarkupAppearance({ ...base, type: 'underline' });
    expect(ul.content).toContain('RG');
    expect(ul.content).toMatch(/0 0 m\n10 0 l S$/);
    expect(ul.multiply).toBe(false);
    const so = buildTextMarkupAppearance({ ...base, type: 'strikeout' });
    expect(so.content).toMatch(/0 5 m\n10 5 l S$/);
  });
});

