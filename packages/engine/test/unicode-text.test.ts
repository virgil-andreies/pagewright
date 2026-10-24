import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import fontkit from '@cantoo/fontkit';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import {
  History, UNICODE_RUNS, UNICODE_SUBSETS, addAnnotation, addSource, emptyDocument, freeTextLines, memorySource, textWidth, unicodeWidth,
  type FontFamily, type FreeTextAnnot,
} from '@pagewright/core';
import { PdfLibWriter, UNICODE_FAMILIES, buildFreeTextAppearance, defaultSaveOpts, unicodeFontFile, type UnicodeFontSource } from '../src';

const require = createRequire(import.meta.url);
const fileOf = (family: FontFamily, subset: string) => {
  const pkg = UNICODE_FAMILIES[family];
  return join(dirname(require.resolve(`${pkg}/package.json`)), 'files', unicodeFontFile(pkg, subset));
};
/** The real font files, read from node_modules, and a record of which were asked for. */
const fileSource = () => {
  const load = vi.fn(async (family: FontFamily, subset: string) => new Uint8Array(readFileSync(fileOf(family, subset))));
  return { load } satisfies UnicodeFontSource;
};

const box = (text: string, over: Partial<FreeTextAnnot> = {}): FreeTextAnnot => ({
  id: 't1', pageId: 'p1', author: 'Ana', createdAt: '2026-03-04T05:06:07Z', modifiedAt: '2026-03-04T05:06:07Z', opacity: 1, origin: 'app',
  type: 'freetext', color: { r: 0, g: 0, b: 0, a: 1 }, rect: { x: 40, y: 40, w: 220, h: 60 }, text, fontSize: 12, fontFamily: 'sans', ...over,
});

/** `null`: an app with no fonts to embed. */
async function save(annots: FreeTextAnnot[], source: UnicodeFontSource | null = fileSource()) {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 200]);
  const h = new History(emptyDocument());
  h.execute(addSource({ id: 's', name: 's.pdf', data: memorySource(await pdf.save()), pageCount: 1, isEncrypted: false, hasDigitalSignature: false }, undefined, () => 'p1'));
  annots.forEach((a) => h.execute(addAnnotation(a)));
  return new PdfLibWriter({ unicodeFonts: source ?? undefined }).save(h.current, defaultSaveOpts);
}
const apOf = async (bytes: Uint8Array, i = 0) => {
  const annots = (await PDFDocument.load(bytes)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  return annots.lookup(i, PDFDict).lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
};
const fontsOf = (ap: PDFRawStream) => ap.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict);

/** The text PDF.js reads out of the page's drawing, annotations included: what a viewer will show, glyph by glyph. */
async function drawnText(bytes: Uint8Array): Promise<string> {
  const task = pdfjs.getDocument({ data: bytes });
  const doc = await task.promise;
  const ops = await (await doc.getPage(1)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
  let out = '';
  ops.fnArray.forEach((fn, i) => {
    if (fn === pdfjs.OPS.showText) out += (ops.argsArray[i][0] as ({ unicode: string } | number)[]).map((g) => (typeof g === 'number' ? '' : g.unicode)).join('');
    if (fn === pdfjs.OPS.setTextMatrix) out += '|';
  });
  await task.destroy();
  return out;
}

describe('the generated width table', () => {
  it('agrees with the font files, for every character of every family', () => {
    for (const family of Object.keys(UNICODE_FAMILIES) as FontFamily[]) {
      const fonts = UNICODE_SUBSETS.map((s) => fontkit.create(readFileSync(fileOf(family, s))) as unknown as { unitsPerEm: number; glyphForCodePoint(cp: number): { id: number; advanceWidth: number } });
      let checked = 0;
      for (const run of UNICODE_RUNS[family] as readonly (readonly number[])[]) {
        const [first, subset] = run as unknown as [number, number];
        for (let i = 2; i < run.length; i++) {
          const g = fonts[subset]!.glyphForCodePoint(first + i - 2);
          expect(g.id, `${family} U+${(first + i - 2).toString(16)}`).not.toBe(0);
          expect(run[i]).toBeCloseTo((g.advanceWidth * 1000) / fonts[subset]!.unitsPerEm, 2);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(1500);
    }
  });
});

describe('text boxes in other alphabets', () => {
  it('keeps Western European text on the standard fonts, with nothing embedded', async () => {
    const source = fileSource();
    const ap = await apOf(await save([box('Café crème, 5 €')], source));
    expect(fontsOf(ap).lookup(PDFName.of('F1'), PDFDict).lookup(PDFName.of('BaseFont'))).toBe(PDFName.of('Helvetica'));
    expect(source.load).not.toHaveBeenCalled();
  });

  it('writes Romanian, Polish, Greek and Russian with embedded fonts that viewers read back as the same text', async () => {
    const text = 'Mulțumesc, Łódź!\nΚαλημέρα — Привет';
    const bytes = await save([box(text)]);
    expect(await drawnText(bytes)).toBe('|Mulțumesc, Łódź!|Καλημέρα — Привет');
  });

  it('embeds only the files whose letters are used, each as a subset font with a ToUnicode map', async () => {
    const source = fileSource();
    const ap = await apOf(await save([box('Zażółć gęślą jaźń')], source));
    expect(source.load.mock.calls.map((c) => c[1]).sort()).toEqual(['latin', 'latin-ext']);
    const fonts = fontsOf(ap);
    expect(fonts.keys().map((k) => k.decodeText()).sort()).toEqual(['U0', 'U1']);
    const f = fonts.lookup(PDFName.of('U1'), PDFDict);
    expect(f.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Type0'));
    expect(f.get(PDFName.of('ToUnicode'))).toBeInstanceOf(PDFRef);
    expect((f.lookup(PDFName.of('BaseFont')) as PDFName).decodeText()).toBe('PWABAA+NotoSans'); // a subset: tag, then the font's name
  });

  it('keeps the file small: only the glyphs used are embedded', async () => {
    const plain = await save([box('Hello')]);
    const unicode = await save([box('Привет, мир')]);
    expect(unicode.length - plain.length).toBeLessThan(30_000);
  });

  it('shares one font object between boxes of the same family', async () => {
    const bytes = await save([box('Ąą', { id: 'a' }), box('Ęę', { id: 'b', rect: { x: 40, y: 120, w: 220, h: 30 } })]);
    const ref = async (i: number) => (await apOf(bytes, i)).dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict).get(PDFName.of('U1'));
    expect(await ref(0)).toBe(await ref(1));
  });

  it('measures exactly as the embedded font draws, so line breaks agree with the editor', async () => {
    for (const family of ['sans', 'serif', 'mono'] as const) {
      const text = 'Ştiinţă și tehnică: Ελληνικά, Українська, Tiếng Việt';
      const pdf = await PDFDocument.create();
      pdf.registerFontkit(fontkit);
      for (const [si, subset] of UNICODE_SUBSETS.entries()) {
        const font = await pdf.embedFont(readFileSync(fileOf(family, subset)), { subset: true, features: { liga: false, kern: false } });
        const own = [...text].filter((ch) => unicodeWidth(family, ch) !== undefined && fontkitHas(family, subset, ch) && firstSubset(family, ch) === si).join('');
        if (own) expect(font.widthOfTextAtSize(own, 10), `${family} ${subset}`).toBeCloseTo(textWidth(family, own, 10, true), 3);
      }
    }
  });

  it('wraps by the embedded font\'s widths and writes each line where the editor shows it', async () => {
    const a = box('Съешь же ещё этих мягких французских булок', { rect: { x: 40, y: 40, w: 120, h: 60 } });
    const lines = freeTextLines(a);
    expect(lines.length).toBeGreaterThan(2);
    for (const l of lines) expect(textWidth('sans', l, 12, true)).toBeLessThanOrEqual(120 - 4);
    expect(await drawnText(await save([a]))).toBe(`|${lines.join('|')}`);
  });

  it('works in every family', async () => {
    for (const fontFamily of ['sans', 'serif', 'mono'] as const) {
      expect(await drawnText(await save([box('Ελληνικά ăîâșț', { fontFamily })]))).toBe('|Ελληνικά ăîâșț');
    }
  });

  it('says plainly when the fonts are not available, rather than writing question marks', async () => {
    await expect(save([box('Привет')], null)).rejects.toThrow(/other alphabets cannot be saved here/);
    expect(() => buildFreeTextAppearance(box('Привет'))).toThrow(/embedded fonts/);
  });

  it('switches font objects within a line where the letters come from different files', () => {
    const ap = buildFreeTextAppearance(box('Aя'), (_f, subset, text) => `<${subset}:${text}>`);
    expect(ap.content).toContain('/U0 12 Tf\n<0:A> Tj\n/U2 12 Tf\n<2:я> Tj');
    expect(ap.unicodeFonts).toEqual({ family: 'sans', subsets: [0, 2] });
    expect(ap.font).toBeUndefined();
  });
});

const fontkitCache = new Map<string, { glyphForCodePoint(cp: number): { id: number } }>();
function fontkitHas(family: FontFamily, subset: string, ch: string): boolean {
  const key = `${family}/${subset}`;
  if (!fontkitCache.has(key)) fontkitCache.set(key, fontkit.create(readFileSync(fileOf(family, subset))) as never);
  return fontkitCache.get(key)!.glyphForCodePoint(ch.codePointAt(0)!).id !== 0;
}
function firstSubset(family: FontFamily, ch: string): number {
  return UNICODE_SUBSETS.findIndex((s) => fontkitHas(family, s, ch));
}
