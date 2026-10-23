import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream } from '@cantoo/pdf-lib';
import {
  History, addAnnotation, addSource, annotationBounds, emptyDocument, memorySource, normalizeRect,
  type Annotation, type InkAnnot, type Point, type ShapeAnnot,
} from '@pagewright/core';
import { PdfJsRenderer, PdfLibWriter, buildInkAppearance, buildShapeAppearance, defaultSaveOpts } from '../src';

const base = {
  id: 'a1', pageId: 'p1', author: 'Ada', createdAt: '2026-01-02T03:04:05Z', modifiedAt: '2026-01-02T03:04:05Z',
  color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, origin: 'app' as const,
};
const P = (x: number, y: number): Point => ({ x, y });
const ink = (strokes: Point[][], width = 3): InkAnnot => ({ ...base, type: 'ink', strokes, width });
const shape = (kind: ShapeAnnot['shape'], extra: Partial<ShapeAnnot> = {}): ShapeAnnot => ({
  ...base, type: 'shape', shape: kind, rect: { x: 20, y: 30, w: 100, h: 60 }, width: 2, ...extra,
});
const lineShape = (kind: 'line' | 'arrow', a = P(10, 10), b = P(110, 60)): ShapeAnnot => shape(kind, { rect: normalizeRect(a, b), line: [a, b] });

describe('buildInkAppearance', () => {
  it('strokes each polyline with round caps and joins', () => {
    const ap = buildInkAppearance(ink([[P(0, 0), P(10, 5), P(20, 0)], [P(30, 30), P(40, 40)]], 4));
    expect(ap.content).toContain('1 0 0 RG');
    expect(ap.content).toContain('4 w');
    expect(ap.content).toContain('1 J 1 j');
    expect(ap.content.match(/^S$/gm)).toHaveLength(2);
    expect(ap.content).toContain('0 0 m\n10 5 l\n20 0 l\nS');
    expect(ap.multiply).toBe(false);
  });

  it('draws a one-point stroke as a zero-length segment (a dot with round caps)', () => {
    expect(buildInkAppearance(ink([[P(5, 5)]])).content).toContain('5 5 m\n5 5 l\nS');
  });

  it('skips empty strokes and sizes the box to include the stroke width', () => {
    const ap = buildInkAppearance(ink([[], [P(10, 10), P(30, 20)]], 4));
    expect(ap.content.match(/ m$/gm)).toHaveLength(1);
    expect(ap.bbox).toEqual([8, 8, 32, 22]);
  });

  it('combines annotation opacity with colour alpha', () => {
    expect(buildInkAppearance({ ...ink([[P(0, 0)]]), opacity: 0.5, color: { r: 0, g: 0, b: 0, a: 0.5 } }).opacity).toBe(0.25);
  });
});

describe('buildShapeAppearance', () => {
  it('strokes a rectangle on its centre line', () => {
    const ap = buildShapeAppearance(shape('rect'));
    expect(ap.content).toContain('20 30 100 60 re\nS');
    expect(ap.bbox).toEqual([19, 29, 121, 91]); // rect plus half the stroke width
  });

  it('fills and strokes with B, and fills only when the width is zero', () => {
    const fill = { r: 0, g: 1, b: 0, a: 1 };
    expect(buildShapeAppearance(shape('rect', { fill })).content).toMatch(/0 1 0 rg\n20 30 100 60 re\nB$/);
    expect(buildShapeAppearance(shape('rect', { fill, width: 0 })).content).toMatch(/re\nf$/);
  });

  it('draws an ellipse with four Bezier arcs through the box edges', () => {
    const { content } = buildShapeAppearance(shape('ellipse'));
    expect(content.match(/ c$/gm)).toHaveLength(4);
    expect(content).toContain('120 60 m'); // right-most point: x + w, mid-height
    expect(content).toContain('70 90'); // top-most point
    expect(content).toMatch(/h\nS$/);
  });

  it('draws a plain line', () => {
    expect(buildShapeAppearance(lineShape('line')).content).toContain('10 10 m\n110 60 l\nS');
  });

  it('draws an arrow as a shaft that stops at the head plus a filled triangle', () => {
    const { content } = buildShapeAppearance(lineShape('arrow', P(0, 0), P(100, 0)));
    expect(content).toMatch(/0 0 m\n[\d.]+ 0 l\nS/);
    const shaftEnd = Number(/0 0 m\n([\d.]+) 0 l/.exec(content)![1]);
    expect(shaftEnd).toBeLessThan(100);
    expect(content).toMatch(/100 0 m\n[\d.-]+ [\d.-]+ l\n[\d.-]+ [\d.-]+ l\nh f$/);
  });

  it('uses the same bounds as the model, so /Rect and the box agree', () => {
    for (const a of [shape('rect'), shape('ellipse'), lineShape('line'), lineShape('arrow')]) {
      const b = annotationBounds(a);
      expect(buildShapeAppearance(a).bbox).toEqual([b.x, b.y, b.x + b.w, b.y + b.h]);
    }
  });
});

async function save(annots: Annotation[]) {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 200]);
  const h = new History(emptyDocument());
  h.execute(addSource({ id: 's', name: 's.pdf', data: memorySource(await pdf.save()), pageCount: 1, isEncrypted: false, hasDigitalSignature: false }, undefined, () => 'p1'));
  annots.forEach((a, i) => h.execute(addAnnotation({ ...a, id: `${a.id}-${i}` })));
  return new PdfLibWriter().save(h.current, defaultSaveOpts);
}

const annotsOf = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
const get = (d: PDFDict, k: string) => d.lookup(PDFName.of(k));
const nums = (a: PDFArray) => a.asArray().map((n) => (n as PDFNumber).asNumber());

describe('writing ink and shapes to PDF', () => {
  it('writes /Ink with an /InkList, /BS and an appearance stream', async () => {
    const annots = await annotsOf(await save([ink([[P(10, 10), P(50, 40)], [P(60, 60)]], 3)]));
    const a = annots.lookup(0, PDFDict);
    expect(get(a, 'Subtype')).toBe(PDFName.of('Ink'));
    const list = a.lookup(PDFName.of('InkList'), PDFArray);
    expect(list.size()).toBe(2);
    expect(nums(list.lookup(0, PDFArray))).toEqual([10, 10, 50, 40]);
    expect(nums(list.lookup(1, PDFArray))).toEqual([60, 60]);
    expect(get(a, 'BS')).toBeInstanceOf(PDFDict);
    expect(((get(a, 'BS') as PDFDict).lookup(PDFName.of('W')) as PDFNumber).asNumber()).toBe(3);
    expect((get(a, 'NM') as PDFHexString).decodeText()).toBe('a1-0');
    expect(a.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'))).toBeInstanceOf(PDFRawStream);
    expect(nums(a.lookup(PDFName.of('Rect'), PDFArray))).toEqual([8.5, 8.5, 61.5, 61.5]);
  });

  it('maps rect and ellipse to /Square and /Circle with /RD and optional /IC', async () => {
    const annots = await annotsOf(await save([shape('rect'), shape('ellipse', { fill: { r: 0, g: 0, b: 1, a: 1 } })]));
    const sq = annots.lookup(0, PDFDict);
    const ci = annots.lookup(1, PDFDict);
    expect(get(sq, 'Subtype')).toBe(PDFName.of('Square'));
    expect(get(ci, 'Subtype')).toBe(PDFName.of('Circle'));
    expect(nums(sq.lookup(PDFName.of('RD'), PDFArray))).toEqual([1, 1, 1, 1]); // half the stroke width
    expect(nums(sq.lookup(PDFName.of('Rect'), PDFArray))).toEqual([19, 29, 121, 91]);
    expect(get(sq, 'IC')).toBeUndefined();
    expect(nums(ci.lookup(PDFName.of('IC'), PDFArray))).toEqual([0, 0, 1]);
  });

  it('maps line and arrow to /Line with /L and line endings', async () => {
    const annots = await annotsOf(await save([lineShape('line'), lineShape('arrow')]));
    const ln = annots.lookup(0, PDFDict);
    const ar = annots.lookup(1, PDFDict);
    expect(get(ln, 'Subtype')).toBe(PDFName.of('Line'));
    expect(nums(ln.lookup(PDFName.of('L'), PDFArray))).toEqual([10, 10, 110, 60]);
    const le = (d: PDFDict) => d.lookup(PDFName.of('LE'), PDFArray).asArray();
    expect(le(ln)).toEqual([PDFName.of('None'), PDFName.of('None')]);
    expect(le(ar)).toEqual([PDFName.of('None'), PDFName.of('ClosedArrow')]);
  });

  it('is read back by PDF.js with the right subtypes and boxes', async () => {
    const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/');
    const renderer = new PdfJsRenderer({ pdfjs: pdfjs as never, standardFontDataUrl: fonts });
    const bytes = await save([ink([[P(10, 10), P(50, 40)]]), shape('rect'), shape('ellipse'), lineShape('arrow')]);
    const doc = await renderer.open({ id: 'o', name: 'o.pdf', data: memorySource(bytes), pageCount: 1, isEncrypted: false, hasDigitalSignature: false });
    const found = await doc.getExistingAnnotations(0);
    expect(found.map((f) => f.subtype)).toEqual(['Ink', 'Square', 'Circle', 'Line']);
    expect(found[1]!.rect).toEqual({ x: 19, y: 29, w: 102, h: 62 });
    doc.destroy();
  });

  it('keeps a degenerate shape writable (zero-size box, zero-length line)', async () => {
    const bytes = await save([shape('rect', { rect: { x: 5, y: 5, w: 0, h: 0 } }), lineShape('arrow', P(5, 5), P(5, 5))]);
    expect((await annotsOf(bytes)).size()).toBe(2);
  });
});
