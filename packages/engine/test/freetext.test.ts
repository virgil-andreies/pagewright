import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, StandardFonts,
} from '@cantoo/pdf-lib';
import {
  BASELINE_RATIO, History, TEXT_PADDING, addAnnotation, addSource, emptyDocument, fitFreeText, freeTextLines, isStandard,
  lineAdvance, memorySource, textWidth, toWinAnsi,
  type Annotation, type FontFamily, type FreeTextAnnot,
} from '@pagewright/core';
import { PdfJsRenderer, PdfLibWriter, buildFreeTextAppearance, defaultSaveOpts } from '../src';

const FAMILIES: [FontFamily, StandardFonts][] = [
  ['sans', StandardFonts.Helvetica], ['serif', StandardFonts.TimesRoman], ['mono', StandardFonts.Courier],
];

describe('core font data agrees with pdf-lib', () => {
  it.each(FAMILIES)('%s: same characters, same widths, same WinAnsi bytes', async (family, std) => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(std);
    const theirs = new Set(font.getCharacterSet().filter((cp) => cp >= 32));
    // Every code point in the BMP plus the first astral plane block people actually type (emoji).
    for (let cp = 32; cp < 0x10000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      expect(isStandard(String.fromCodePoint(cp)), `U+${cp.toString(16)}`).toBe(theirs.has(cp));
    }
    expect(isStandard('😀')).toBe(false);
    for (const cp of theirs) {
      const ch = String.fromCodePoint(cp);
      expect(textWidth(family, ch, 1000), ch).toBeCloseTo(font.widthOfTextAtSize(ch, 1000), 2);
      const bytes = font.encodeText(ch).toString().slice(1, -1); // "<41>" -> "41"
      expect([...toWinAnsi(ch)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase(), ch).toBe(bytes.toUpperCase());
    }
  });

  it('measures whole strings as the sum of character advances, which is what Tj draws', async () => {
    // pdf-lib's widthOfTextAtSize also applies kerning pairs, but PDF text-show operators do not, so it
    // would disagree with what viewers draw. The sum of per-character widths is the right figure.
    const pdf = await PDFDocument.create();
    for (const [family, std] of FAMILIES) {
      const font = await pdf.embedFont(std);
      for (const text of ['The quick brown fox', 'Crème brûlée — 5 € “quoted”', 'iiii WWWW', 'AVATAR To', '']) {
        for (const size of [8, 12, 17.5, 36]) {
          const sum = [...text].reduce((n, ch) => n + font.widthOfTextAtSize(ch, size), 0);
          expect(textWidth(family, text, size)).toBeCloseTo(sum, 3);
        }
      }
    }
  });
});

const base = {
  id: 'f1', pageId: 'p1', author: 'Ada', createdAt: '2026-03-04T05:06:07Z', modifiedAt: '2026-03-04T05:06:07Z', opacity: 1, origin: 'app' as const,
};
const freeText = (text: string, over: Partial<FreeTextAnnot> = {}): FreeTextAnnot =>
  fitFreeText({
    ...base, type: 'freetext', text, fontSize: 12, fontFamily: 'sans', color: { r: 0.1, g: 0.2, b: 0.9, a: 1 },
    rect: { x: 40, y: 120, w: 120, h: 20 }, ...over,
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
const contentOf = (a: PDFDict) => new TextDecoder('latin1').decode((a.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream).contents);
const fontOf = (a: PDFDict) =>
  (a.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream).dict.lookup(PDFName.of('Resources'), PDFDict)
    .lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F1'), PDFDict);

describe('buildFreeTextAppearance', () => {
  it('fills the annotation box and uses the chosen standard font', () => {
    const a = freeText('Hello', { fontFamily: 'serif' });
    const ap = buildFreeTextAppearance(a);
    expect(ap.bbox).toEqual([a.rect.x, a.rect.y, a.rect.x + a.rect.w, a.rect.y + a.rect.h]);
    expect(ap.font).toBe('serif');
    expect(ap.content).toContain('/F1 12 Tf');
    expect(ap.content).toContain('0.1 0.2 0.9 rg');
    expect(ap.content).toMatch(/^BT\n/);
    expect(ap.content).toMatch(/\nET$/);
  });

  it('puts the first baseline just below the padded top of the box and each line one pitch lower', () => {
    const a = freeText('one\ntwo\nthree');
    const ys = [...buildFreeTextAppearance(a).content.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)].map((m) => Number(m[2]));
    const top = a.rect.y + a.rect.h;
    expect(ys).toHaveLength(3);
    expect(ys[0]).toBeCloseTo(top - TEXT_PADDING - BASELINE_RATIO * 12, 2);
    expect(ys[0]! - ys[1]!).toBeCloseTo(lineAdvance(12), 2);
    expect(ys[1]! - ys[2]!).toBeCloseTo(lineAdvance(12), 2);
    expect(Number(/1 0 0 1 ([\d.]+) /.exec(buildFreeTextAppearance(a).content)![1])).toBeCloseTo(a.rect.x + TEXT_PADDING);
  });

  it('shows one string per wrapped line, WinAnsi encoded', () => {
    const a = freeText('Crème brûlée is a very good dessert to have after dinner', { rect: { x: 0, y: 100, w: 90, h: 20 } });
    const lines = freeTextLines(a);
    expect(lines.length).toBeGreaterThan(2);
    const shown = [...buildFreeTextAppearance(a).content.matchAll(/<([0-9A-F]*)> Tj/g)].map((m) => m[1]);
    expect(shown).toEqual(lines.map((l) => [...toWinAnsi(l)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()));
    expect(shown[0]).toContain('E8'); // è
  });

  it('skips blank lines but keeps their space', () => {
    const ys = [...buildFreeTextAppearance(freeText('a\n\nb')).content.matchAll(/ ([\d.]+) Tm/g)].map((m) => Number(m[1]));
    expect(ys).toHaveLength(2);
    expect(ys[0]! - ys[1]!).toBeCloseTo(2 * lineAdvance(12), 2);
  });

  it('writes characters no font has as ?', () => {
    const a = freeText('日'); // not representable: should already have been sanitised, but stay safe
    expect(buildFreeTextAppearance(a).content).toContain('<3F> Tj');
  });

  it('combines opacity with colour alpha', () => {
    expect(buildFreeTextAppearance(freeText('x', { opacity: 0.5, color: { r: 0, g: 0, b: 0, a: 0.5 } })).opacity).toBe(0.25);
  });
});

describe('writing free text', () => {
  it('writes /FreeText with the text as /Contents, a default appearance, and no background colour', async () => {
    const a = (await annotsOf(await save([freeText('Hello world', { fontFamily: 'mono', fontSize: 14 })]))).lookup(0, PDFDict);
    expect(get(a, 'Subtype')).toBe(PDFName.of('FreeText'));
    expect(text(a, 'Contents')).toBe('Hello world');
    expect((get(a, 'DA') as PDFString).decodeText()).toBe('0.1 0.2 0.9 rg /Cour 14 Tf');
    expect(get(a, 'Q')).toEqual(PDFNumber.of(0));
    expect(get(a, 'F')).toEqual(PDFNumber.of(4));
    expect(get(a, 'C')).toBeUndefined(); // /C would be drawn as a fill behind the text
    expect(text(a, 'NM')).toBe('f1');
    expect(contentOf(a)).toContain('/F1 14 Tf');
  });

  it.each([['sans', 'Helvetica'], ['serif', 'Times-Roman'], ['mono', 'Courier']] as const)(
    'embeds the %s font as %s with WinAnsi encoding',
    async (family, base) => {
      const a = (await annotsOf(await save([freeText('x', { fontFamily: family })]))).lookup(0, PDFDict);
      const font = fontOf(a);
      expect(font.lookup(PDFName.of('BaseFont'))).toBe(PDFName.of(base));
      expect(font.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Type1'));
      expect(font.lookup(PDFName.of('Encoding'))).toBe(PDFName.of('WinAnsiEncoding'));
    },
  );

  it('shares one font object between annotations that use the same family', async () => {
    const annots = await annotsOf(await save([freeText('a'), freeText('b', { id: 'f2' }), freeText('c', { id: 'f3', fontFamily: 'serif' })]));
    const ref = (i: number) =>
      (annots.lookup(i, PDFDict).lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream).dict
        .lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict).get(PDFName.of('F1'));
    expect(ref(0)).toBeInstanceOf(PDFRef);
    expect(ref(0)).toBe(ref(1));
    expect(ref(0)).not.toBe(ref(2));
  });

  it('keeps /Contents as the text when the annotation also has a comment, and still writes the replies', async () => {
    const withComment = freeText('Visible text', {
      comment: { text: 'a private remark', replies: [{ id: 'r1', author: 'Bob', createdAt: '2026-03-05T00:00:00Z', text: 'reply' }] },
    });
    const annots = await annotsOf(await save([withComment]));
    expect(text(annots.lookup(0, PDFDict), 'Contents')).toBe('Visible text');
    expect(annots.size()).toBe(2);
    expect(annots.lookup(1, PDFDict).get(PDFName.of('IRT'))).toBe(annots.get(0));
  });

  it('writes the same box and appearance on a rotated page: the text rotates with the page', async () => {
    const plain = (await annotsOf(await save([freeText('Hello')]))).lookup(0, PDFDict);
    const rotated = (await annotsOf(await save([freeText('Hello')], 90))).lookup(0, PDFDict);
    expect(nums(rotated.lookup(PDFName.of('Rect'), PDFArray))).toEqual(nums(plain.lookup(PDFName.of('Rect'), PDFArray)));
    expect(contentOf(rotated)).toBe(contentOf(plain));
    expect(get(rotated, 'F')).toEqual(PDFNumber.of(4)); // not NoRotate
  });

  it('is read back by PDF.js as a FreeText annotation in the right place', async () => {
    const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/');
    const renderer = new PdfJsRenderer({ pdfjs: pdfjs as never, standardFontDataUrl: fonts });
    const a = freeText('Hello world');
    const doc = await renderer.open({ id: 'o', name: 'o.pdf', data: memorySource(await save([a])), pageCount: 1, isEncrypted: false, hasDigitalSignature: false });
    const [found] = await doc.getExistingAnnotations(0);
    expect(found!.subtype).toBe('FreeText');
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(found!.rect[k]).toBeCloseTo(a.rect[k], 3);
    doc.destroy();
  });
});
