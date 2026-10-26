import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFHexString, PDFName } from '@cantoo/pdf-lib';
import { memorySource } from '@pagewright/core';
import { PdfJsRenderer } from '../src';

const dir = (name: string) => fileURLToPath(new URL(`../node_modules/pdfjs-dist/${name}/`, import.meta.url)).replaceAll('\\', '/');

/**
 * A page of text in a Chinese, Japanese or Korean font the PDF does not embed, as office software in those
 * languages often writes: the text is stored as codes of a predefined character map (for example UniJIS-UCS2-H),
 * which a viewer must load to know which characters they are.
 */
async function cjkPdf(encoding: string, registry: string, ordering: string, font: string, text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 200]);
  const ctx = pdf.context;
  const descendant = ctx.obj({
    Type: 'Font', Subtype: 'CIDFontType0', BaseFont: font,
    CIDSystemInfo: { Registry: PDFHexString.fromText(registry), Ordering: PDFHexString.fromText(ordering), Supplement: 2 },
    FontDescriptor: ctx.obj({ Type: 'FontDescriptor', FontName: font, Flags: 4, FontBBox: [0, -150, 1000, 880], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80 }),
  });
  const type0 = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: font, Encoding: encoding, DescendantFonts: [ctx.register(descendant)] }));
  page.node.setFontDictionary(PDFName.of('F1'), type0);
  // UCS-2 codes: two bytes per character, the character's own Unicode number.
  const codes = [...text].map((ch) => ch.codePointAt(0)!.toString(16).padStart(4, '0')).join('');
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream(`BT /F1 24 Tf 40 100 Td <${codes}> Tj ET`)));
  return pdf.save();
}

const textOf = async (renderer: PdfJsRenderer, bytes: Uint8Array) => {
  const doc = await renderer.open({ id: 's', name: 's.pdf', data: memorySource(bytes), pageCount: 1, isEncrypted: false, hasDigitalSignature: false });
  try {
    return (await doc.getTextContent(0)).map((r) => r.text).join('');
  } finally {
    doc.destroy();
  }
};

describe('text in fonts the PDF does not embed, in Chinese, Japanese and Korean', () => {
  const withMaps = new PdfJsRenderer({ pdfjs: pdfjs as never, standardFontDataUrl: dir('standard_fonts'), cMapUrl: dir('cmaps') });
  const withoutMaps = new PdfJsRenderer({ pdfjs: pdfjs as never, standardFontDataUrl: dir('standard_fonts') });

  it('is read as the right characters once PDF.js knows where its character maps are', async () => {
    expect(await textOf(withMaps, await cjkPdf('UniJIS-UCS2-H', 'Adobe', 'Japan1', 'KozMinPr6N-Regular', '日本語のテキスト'))).toBe('日本語のテキスト');
    expect(await textOf(withMaps, await cjkPdf('UniGB-UCS2-H', 'Adobe', 'GB1', 'STSong-Light', '中文文本'))).toBe('中文文本');
    expect(await textOf(withMaps, await cjkPdf('UniKS-UCS2-H', 'Adobe', 'Korea1', 'HYSMyeongJo-Medium', '한국어'))).toBe('한국어');
  });

  it('comes out wrong without them, which is what the setting fixes', async () => {
    expect(await textOf(withoutMaps, await cjkPdf('UniJIS-UCS2-H', 'Adobe', 'Japan1', 'KozMinPr6N-Regular', '日本語のテキスト'))).not.toBe('日本語のテキスト');
  });
});
