import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import {
  History, addAnnotation, addSource, emptyDocument, rectToQuad, quadBounds, rotatePages,
  type HighlightAnnot, type SourceDoc,
} from '@pagewright/core';
import { AppFailure, PdfJsRenderer, PdfLibWriter, defaultSaveOpts, pdfjsVerify } from '../src';

const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/');
const renderer = new PdfJsRenderer({ pdfjs: pdfjs as never, standardFontDataUrl: fonts });

async function source(rotate = 0, crop?: [number, number, number, number]): Promise<SourceDoc> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 400]);
  if (rotate) page.setRotation(degrees(rotate));
  if (crop) page.setCropBox(...crop);
  page.drawText('Hello world', { x: 50, y: 200, size: 20, font });
  return { id: 's', name: 's.pdf', bytes: await pdf.save(), pageCount: 1, isEncrypted: false, hasDigitalSignature: false };
}

async function helveticaWidth(text: string, size: number) {
  const pdf = await PDFDocument.create();
  return (await pdf.embedFont(StandardFonts.Helvetica)).widthOfTextAtSize(text, size);
}

describe('PdfJsRenderer', () => {
  it('reports page info including rotation and CropBox', async () => {
    const doc = await renderer.open(await source(90, [10, 20, 200, 300]));
    const info = await doc.getPageInfo(0);
    expect(doc.pageCount).toBe(1);
    expect(info.rotation).toBe(90);
    expect(info.cropBox).toEqual({ x: 10, y: 20, w: 200, h: 300 });
    expect(info.width).toBe(300); // swapped by the 90 degree rotation
    expect(info.height).toBe(200);
    doc.destroy();
  });

  it('returns text quads in PDF user space that match where the text was drawn', async () => {
    const doc = await renderer.open(await source());
    const [run] = await doc.getTextContent(0);
    expect(run!.text).toBe('Hello world');
    const b = quadBounds(run!.quad);
    expect(b.x).toBeCloseTo(50, 0);
    expect(b.w).toBeCloseTo(await helveticaWidth('Hello world', 20), 0);
    // baseline at y=200 with ~22% descent below it and the font height above
    expect(b.y).toBeLessThan(200);
    expect(b.y + b.h).toBeGreaterThan(200);
    doc.destroy();
  });

  it('does not consume the caller bytes', async () => {
    const s = await source();
    await renderer.open(s);
    expect(s.bytes.byteLength).toBeGreaterThan(0);
  });

  it('sees annotations written by the engine, so other viewers can too', async () => {
    const h = new History(emptyDocument());
    h.execute(addSource(await source(), undefined, () => 'p1'));
    h.execute(rotatePages(['p1'], 90));
    const hl: HighlightAnnot = {
      type: 'highlight', id: 'n1', pageId: 'p1', author: 'a', createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z',
      color: { r: 1, g: 1, b: 0, a: 1 }, opacity: 0.5, origin: 'app', quads: [rectToQuad({ x: 50, y: 195, w: 100, h: 20 })],
    };
    h.execute(addAnnotation(hl));
    const writer = new PdfLibWriter({ verify: pdfjsVerify(renderer) });
    const bytes = await writer.save(h.current, defaultSaveOpts);
    const out = await renderer.open({ id: 'o', name: 'o.pdf', bytes, pageCount: 1, isEncrypted: false, hasDigitalSignature: false });
    expect((await out.getPageInfo(0)).rotation).toBe(90);
    const annots = await out.getExistingAnnotations(0);
    expect(annots).toHaveLength(1);
    expect(annots[0]!.subtype).toBe('Highlight');
    expect(annots[0]!.rect).toEqual({ x: 50, y: 195, w: 100, h: 20 });
    out.destroy();
  });

  it('pdfjsVerify rejects a wrong page count', async () => {
    const s = await source();
    expect(await pdfjsVerify(renderer)(s.bytes, 1)).toBe(true);
    expect(await pdfjsVerify(renderer)(s.bytes, 2)).toBe(false);
  });

  it('maps garbage input to CorruptFile', async () => {
    const bad: SourceDoc = { id: 'x', name: 'x.pdf', bytes: new TextEncoder().encode('not a pdf'), pageCount: 0, isEncrypted: false, hasDigitalSignature: false };
    await expect(renderer.open(bad)).rejects.toMatchObject({ error: { code: 'CorruptFile' } });
    await expect(renderer.open(bad)).rejects.toBeInstanceOf(AppFailure);
  });
});
