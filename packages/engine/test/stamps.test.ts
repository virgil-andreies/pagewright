import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import {
  History, STAMP_PRESETS, addAnnotation, addSource, boldTextWidth, emptyDocument, memorySource, newStampRect, stampLayout, stampPreset,
  stampScale, toWinAnsi, type Annotation, type StampAnnot,
} from '@pagewright/core';
import { PdfJsRenderer, PdfLibWriter, UnsupportedAnnotation, buildStampAppearance, defaultSaveOpts } from '../src';

const base = { id: 'st1', pageId: 'p1', author: 'Ada', createdAt: '2026-03-04T05:06:07Z', modifiedAt: '2026-03-04T05:06:07Z', opacity: 1, origin: 'app' as const };
const stamp = (name = 'Approved', over: Partial<StampAnnot> = {}): StampAnnot => {
  const preset = stampPreset(name)!;
  return { ...base, type: 'stamp', color: preset.color, payload: { kind: 'preset', name }, rect: newStampRect(preset, { x: 150, y: 100 }), ...over };
};
const hex = (s: string) => `<${[...toWinAnsi(s)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}>`;

describe('buildStampAppearance', () => {
  it('draws a frame and the bold label in the preset colour, in Helvetica-Bold', () => {
    const a = stamp('Draft');
    const ap = buildStampAppearance(a);
    const c = stampPreset('Draft')!.color;
    expect(ap.font).toBe('sansBold');
    expect(ap.bbox).toEqual([a.rect.x, a.rect.y, a.rect.x + a.rect.w, a.rect.y + a.rect.h]);
    expect(ap.content).toContain(`${c.r} ${c.g} ${c.b} RG`);
    expect(ap.content).toContain(`${c.r} ${c.g} ${c.b} rg`);
    expect(ap.content.match(/ c$/gm)).toHaveLength(4); // rounded corners
    expect(ap.content).toMatch(/^S$/m);
    expect(ap.content).toContain(`${hex('DRAFT')} Tj`);
    expect(ap.multiply).toBe(false);
  });

  it('writes the right label for every preset', () => {
    for (const p of STAMP_PRESETS) expect(buildStampAppearance(stamp(p.name)).content, p.name).toContain(`${hex(p.label)} Tj`);
  });

  it('scales the artwork to the rectangle: natural size at scale 1, doubled at twice the size', () => {
    const l = stampLayout('FINAL');
    const at = (k: number) => buildStampAppearance(stamp('Final', { rect: { x: 10, y: 20, w: l.w * k, h: l.h * k } }));
    const size = (ap: { content: string }) => Number(/\/F1 ([\d.]+) Tf/.exec(ap.content)![1]);
    expect(size(at(1))).toBeCloseTo(l.fontSize);
    expect(size(at(2))).toBeCloseTo(l.fontSize * 2);
    expect(size(at(0.5))).toBeCloseTo(l.fontSize / 2);
  });

  it('keeps the proportions and centres the artwork when the rectangle has other proportions', () => {
    const l = stampLayout('FINAL');
    const rect = { x: 0, y: 0, w: l.w * 2, h: l.h * 4 }; // twice as tall as the artwork needs
    const ap = buildStampAppearance(stamp('Final', { rect }));
    expect(Number(/\/F1 ([\d.]+) Tf/.exec(ap.content)![1])).toBeCloseTo(l.fontSize * stampScale(l, rect)); // limited by the width
    const y = Number(/1 0 0 1 [\d.]+ ([\d.]+) Tm/.exec(ap.content)![1]);
    const s = stampScale(l, rect);
    const top = rect.h - (rect.h - l.h * s) / 2;
    expect(y).toBeCloseTo(top - l.baseline * s, 2);
  });

  it('puts the label inside the frame, horizontally centred, for every preset', () => {
    for (const p of STAMP_PRESETS) {
      const a = stamp(p.name);
      const ap = buildStampAppearance(a);
      const [x, y] = /1 0 0 1 ([\d.]+) ([\d.]+) Tm/.exec(ap.content)!.slice(1).map(Number) as [number, number];
      const size = Number(/\/F1 ([\d.]+) Tf/.exec(ap.content)![1]);
      const width = boldTextWidth(p.label, size);
      expect(x).toBeGreaterThan(a.rect.x);
      expect(x + width).toBeLessThan(a.rect.x + a.rect.w);
      expect(y).toBeGreaterThan(a.rect.y);
      expect(y + size * 0.72).toBeLessThan(a.rect.y + a.rect.h);
      // equal space left and right of the text
      expect(x - a.rect.x).toBeCloseTo(a.rect.x + a.rect.w - (x + width), 1);
    }
  });

  it('combines the annotation opacity with the colour alpha', () => {
    expect(buildStampAppearance(stamp('Void', { opacity: 0.5 })).opacity).toBe(0.5);
  });

  it('refuses what it cannot draw yet instead of drawing something wrong', () => {
    expect(() => buildStampAppearance({ ...stamp(), payload: { kind: 'preset', name: 'Nope' } })).toThrow(/unknown stamp/);
    const typed = { ...stamp(), payload: { kind: 'signature-typed', text: 'Ada', font: 'x' } } as StampAnnot;
    expect(() => buildStampAppearance(typed)).toThrow(/no appearance yet/);
  });
});

async function save(annots: Annotation[], rotate = 0) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 200]);
  if (rotate) page.setRotation({ type: 'degrees', angle: rotate } as never);
  const h = new History(emptyDocument());
  h.execute(addSource({ id: 's', name: 's.pdf', data: memorySource(await pdf.save()), pageCount: 1, isEncrypted: false, hasDigitalSignature: false }, undefined, () => 'p1'));
  annots.forEach((a) => h.execute(addAnnotation(a)));
  return new PdfLibWriter().save(h.current, defaultSaveOpts);
}
const annotsOf = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
const get = (d: PDFDict, k: string) => d.lookup(PDFName.of(k));
const text = (d: PDFDict, k: string) => (get(d, k) as PDFHexString).decodeText();
const nums = (a: PDFArray) => a.asArray().map((x) => (x as PDFNumber).asNumber());

describe('writing stamps', () => {
  it('writes /Stamp with its name, label, box and appearance', async () => {
    const a = stamp('Confidential');
    const dict = (await annotsOf(await save([a]))).lookup(0, PDFDict);
    expect(get(dict, 'Subtype')).toBe(PDFName.of('Stamp'));
    expect(get(dict, 'Name')).toBe(PDFName.of('Confidential'));
    expect(text(dict, 'Subj')).toBe('CONFIDENTIAL');
    expect(get(dict, 'F')).toEqual(PDFNumber.of(4));
    expect(text(dict, 'NM')).toBe('st1');
    const rect = nums(dict.lookup(PDFName.of('Rect'), PDFArray));
    expect(rect[0]).toBeCloseTo(a.rect.x, 3);
    expect(rect[2]).toBeCloseTo(a.rect.x + a.rect.w, 3);
    expect(dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'))).toBeInstanceOf(PDFRawStream);
  });

  it('draws with the Helvetica-Bold standard font, shared between stamps', async () => {
    const annots = await annotsOf(await save([stamp('Draft'), stamp('Void', { id: 'st2' })]));
    const fontRef = (i: number) =>
      (annots.lookup(i, PDFDict).lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream).dict
        .lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict).get(PDFName.of('F1'));
    expect(fontRef(0)).toBeInstanceOf(PDFRef);
    expect(fontRef(0)).toBe(fontRef(1));
    const font = annots.lookup(0, PDFDict).lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    const f = font.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F1'), PDFDict);
    expect(f.lookup(PDFName.of('BaseFont'))).toBe(PDFName.of('Helvetica-Bold'));
    expect(f.lookup(PDFName.of('Encoding'))).toBe(PDFName.of('WinAnsiEncoding'));
  });

  it('leaves /Contents free for a comment, and writes replies', async () => {
    const withComment = stamp('Approved', { comment: { text: 'Approved by me', replies: [{ id: 'r1', author: 'Bob', createdAt: '2026-03-05T00:00:00Z', text: 'Thanks' }] } });
    const annots = await annotsOf(await save([withComment]));
    expect(text(annots.lookup(0, PDFDict), 'Contents')).toBe('Approved by me');
    expect(annots.size()).toBe(2);
    expect(annots.lookup(1, PDFDict).get(PDFName.of('IRT'))).toBe(annots.get(0));
  });

  it('keeps the same box and appearance on a rotated page: the stamp turns with the page', async () => {
    const plain = (await annotsOf(await save([stamp()]))).lookup(0, PDFDict);
    const rotated = (await annotsOf(await save([stamp()], 90))).lookup(0, PDFDict);
    expect(nums(rotated.lookup(PDFName.of('Rect'), PDFArray))).toEqual(nums(plain.lookup(PDFName.of('Rect'), PDFArray)));
    expect(get(rotated, 'F')).toEqual(PDFNumber.of(4)); // not NoRotate
  });

  it('says plainly that signatures and images cannot be written yet, rather than writing something wrong', async () => {
    for (const payload of [
      { kind: 'signature-typed', text: 'Ada', font: 'x' },
      { kind: 'signature-drawn', strokes: [] },
      { kind: 'image', mime: 'image/png', bytes: new Uint8Array(1) },
    ] as const) {
      await expect(save([{ ...stamp(), payload } as Annotation])).rejects.toBeInstanceOf(UnsupportedAnnotation);
    }
  });

  it('is read back by PDF.js as a Stamp in the right place', async () => {
    const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/');
    const renderer = new PdfJsRenderer({ pdfjs: pdfjs as never, standardFontDataUrl: fonts });
    const a = stamp('Approved');
    const doc = await renderer.open({ id: 'o', name: 'o.pdf', data: memorySource(await save([a])), pageCount: 1, isEncrypted: false, hasDigitalSignature: false });
    const [found] = await doc.getExistingAnnotations(0);
    expect(found!.subtype).toBe('Stamp');
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(found!.rect[k]).toBeCloseTo(a.rect[k], 2);
    doc.destroy();
  });
});
