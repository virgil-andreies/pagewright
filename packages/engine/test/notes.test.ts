import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import {
  PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef,
} from '@cantoo/pdf-lib';
import {
  History, NOTE_FILL, NOTE_SIZE, addAnnotation, addSource, emptyDocument, memorySource, rectToQuad,
  type Annotation, type HighlightAnnot, type NoteAnnot,
} from '@pagewright/core';
import { PdfJsRenderer, PdfLibWriter, buildNoteAppearance, defaultSaveOpts } from '../src';

const base = { id: 'n1', pageId: 'p1', author: 'Ada', createdAt: '2026-03-04T05:06:07Z', modifiedAt: '2026-03-04T05:06:07Z', opacity: 1, origin: 'app' as const };
const reply = (id: string, text: string, author = 'Bob') => ({ id, author, createdAt: '2026-03-05T00:00:00Z', text });

const note = (extra: Partial<NoteAnnot> = {}): NoteAnnot => ({
  ...base, type: 'note', position: { x: 50, y: 150 }, icon: 'note', color: NOTE_FILL, ...extra,
});
const highlight = (extra: Partial<HighlightAnnot> = {}): HighlightAnnot => ({
  ...base, id: 'h1', type: 'highlight', color: { r: 1, g: 1, b: 0, a: 1 }, quads: [rectToQuad({ x: 10, y: 20, w: 100, h: 12 })], ...extra,
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

describe('buildNoteAppearance', () => {
  it('fills the box NOTE_SIZE square below and right of the position', () => {
    expect(buildNoteAppearance(note()).bbox).toEqual([50, 150 - NOTE_SIZE, 50 + NOTE_SIZE, 150]);
  });

  it('draws a filled sheet with three lines for a note, in the note colour', () => {
    const { content } = buildNoteAppearance(note());
    expect(content).toContain('1 0.85 0.25 rg');
    expect(content.match(/ c$/gm)).toHaveLength(4); // rounded corners
    expect(content.match(/^S$/gm)).toHaveLength(3); // text lines
    expect(content).toContain('h B');
  });

  it('draws a speech bubble with a tail for a comment icon', () => {
    const { content } = buildNoteAppearance(note({ icon: 'comment' }));
    expect(content.match(/^S$/gm)).toHaveLength(2);
    expect(content.match(/h B/g)).toHaveLength(2); // bubble and tail
  });

  it('never draws outside its box', () => {
    for (const icon of ['note', 'comment'] as const) {
      const ap = buildNoteAppearance(note({ icon, position: { x: 13.5, y: 77.25 } }));
      const [x1, y1, x2, y2] = ap.bbox;
      for (const line of ap.content.split('\n')) {
        const ns = line.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
        if (!/ (m|l|c)$/.test(line)) continue;
        for (let i = 0; i < ns.length; i += 2) {
          expect(ns[i]!).toBeGreaterThanOrEqual(x1 - 0.001);
          expect(ns[i]!).toBeLessThanOrEqual(x2 + 0.001);
          expect(ns[i + 1]!).toBeGreaterThanOrEqual(y1 - 0.001);
          expect(ns[i + 1]!).toBeLessThanOrEqual(y2 + 0.001);
        }
      }
    }
  });
});

describe('writing notes', () => {
  it('writes /Text with icon name, upright-and-fixed-size flags, closed popup and the comment', async () => {
    const annots = await annotsOf(await save([note({ comment: { text: 'Check this figure', replies: [] } })]));
    const a = annots.lookup(0, PDFDict);
    expect(get(a, 'Subtype')).toBe(PDFName.of('Text'));
    expect(get(a, 'Name')).toBe(PDFName.of('Note'));
    expect(get(a, 'F')).toEqual(PDFNumber.of(28)); // print + no-zoom + no-rotate
    expect(get(a, 'Open')).toBe(PDFBool.False);
    expect(text(a, 'Contents')).toBe('Check this figure');
    expect(text(a, 'T')).toBe('Ada');
    expect(text(a, 'NM')).toBe('n1');
    expect(nums(a.lookup(PDFName.of('Rect'), PDFArray))).toEqual([50, 130, 70, 150]);
    expect(a.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'))).toBeInstanceOf(PDFRawStream);
  });

  it('names the comment icon /Comment', async () => {
    const a = (await annotsOf(await save([note({ icon: 'comment' })]))).lookup(0, PDFDict);
    expect(get(a, 'Name')).toBe(PDFName.of('Comment'));
  });

  it('omits /Contents for a note with no text yet', async () => {
    const a = (await annotsOf(await save([note()]))).lookup(0, PDFDict);
    expect(get(a, 'Contents')).toBeUndefined();
  });

  it('keeps the same flags and rect on a rotated page (the viewer keeps the icon upright)', async () => {
    const a = (await annotsOf(await save([note()], 90))).lookup(0, PDFDict);
    expect(get(a, 'F')).toEqual(PDFNumber.of(28));
    expect(nums(a.lookup(PDFName.of('Rect'), PDFArray))).toEqual([50, 130, 70, 150]);
  });
});

describe('writing comments and replies', () => {
  it('writes a comment on a highlight as /Contents of the highlight itself', async () => {
    const a = (await annotsOf(await save([highlight({ comment: { text: 'Why?', replies: [] } })]))).lookup(0, PDFDict);
    expect(get(a, 'Subtype')).toBe(PDFName.of('Highlight'));
    expect(text(a, 'Contents')).toBe('Why?');
  });

  it('links each reply to its parent with /IRT and /RT /R', async () => {
    const annots = await annotsOf(
      await save([highlight({ comment: { text: 'Why?', replies: [reply('r1', 'Because.'), reply('r2', 'Thanks', 'Cy')] } })]),
    );
    expect(annots.size()).toBe(3);
    const parentRef = annots.get(0) as PDFRef;
    expect(parentRef).toBeInstanceOf(PDFRef);
    for (const [i, id, body, author] of [[1, 'r1', 'Because.', 'Bob'], [2, 'r2', 'Thanks', 'Cy']] as const) {
      const r = annots.lookup(i, PDFDict);
      expect(get(r, 'Subtype')).toBe(PDFName.of('Text'));
      expect(r.get(PDFName.of('IRT'))).toBe(parentRef); // the very same indirect object
      expect(get(r, 'RT')).toBe(PDFName.of('R'));
      expect(text(r, 'Contents')).toBe(body);
      expect(text(r, 'T')).toBe(author);
      expect(text(r, 'NM')).toBe(id);
      expect(get(r, 'AP')).toBeUndefined();
    }
  });

  it('places replies at the upper-left corner of the parent', async () => {
    const annots = await annotsOf(await save([note({ comment: { text: 'a', replies: [reply('r1', 'b')] } })]));
    expect(nums(annots.lookup(1, PDFDict).lookup(PDFName.of('Rect'), PDFArray))).toEqual([50, 130, 70, 150]);
    const onHighlight = await annotsOf(await save([highlight({ comment: { text: 'a', replies: [reply('r1', 'b')] } })]));
    const [x, y2] = [10, 32]; // the highlight's bounds start at x = 10, top edge at y = 32
    expect(nums(onHighlight.lookup(1, PDFDict).lookup(PDFName.of('Rect'), PDFArray))).toEqual([x, y2 - NOTE_SIZE, x + NOTE_SIZE, y2]);
  });

  it('writes replies in order, each after its parent, and for several annotations independently', async () => {
    const annots = await annotsOf(
      await save([
        note({ id: 'a', comment: { text: '1', replies: [reply('a1', 'x')] } }),
        highlight({ id: 'b', comment: { text: '2', replies: [reply('b1', 'y')] } }),
      ]),
    );
    expect(annots.size()).toBe(4);
    const order = [0, 1, 2, 3].map((i) => text(annots.lookup(i, PDFDict), 'NM'));
    expect(order).toEqual(['a', 'a1', 'b', 'b1']);
    expect(annots.lookup(3, PDFDict).get(PDFName.of('IRT'))).toBe(annots.get(2));
  });

  it('writes nothing extra for a comment without replies', async () => {
    expect((await annotsOf(await save([highlight({ comment: { text: 'x', replies: [] } })]))).size()).toBe(1);
  });

  it('is read back by PDF.js as /Text annotations', async () => {
    const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/');
    const renderer = new PdfJsRenderer({ pdfjs: pdfjs as never, standardFontDataUrl: fonts });
    const bytes = await save([note({ comment: { text: 'hi', replies: [reply('r1', 'yo')] } })]);
    const doc = await renderer.open({ id: 'o', name: 'o.pdf', data: memorySource(bytes), pageCount: 1, isEncrypted: false, hasDigitalSignature: false });
    const found = await doc.getExistingAnnotations(0);
    expect(found.map((f) => f.subtype)).toEqual(['Text', 'Text']);
    expect(found[0]!.rect).toEqual({ x: 50, y: 130, w: 20, h: 20 });
    doc.destroy();
  });
});
