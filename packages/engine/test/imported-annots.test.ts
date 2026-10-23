import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef } from '@cantoo/pdf-lib';
import {
  History, addAnnotation, addSource, duplicatePages, emptyDocument, idsToRemove, importedAnnotations, memorySource,
  rectToQuad, removeImportedAnnotations, type Annotation, type SourceAnnotation,
} from '@pagewright/core';
import { PdfJsRenderer, PdfLibWriter, defaultSaveOpts, skippedOperations, toSourceAnnotation } from '../src';

describe('skippedOperations', () => {
  const BEGIN = 80;
  const END = 81;
  // ops: 0 text, 1 begin(20R), 2 stroke, 3 stroke, 4 end, 5 text, 6 begin(22R), 7 fill, 8 end, 9 text
  const fn = [1, BEGIN, 2, 2, END, 1, BEGIN, 3, END, 1];
  const args = [[], ['20R'], [], [], [], [], ['22R'], [], [], []];

  it('skips exactly the operations of the hidden annotation, begin and end included', () => {
    expect([...skippedOperations(fn, args, new Set(['20R']), BEGIN, END)]).toEqual([1, 2, 3, 4]);
    expect([...skippedOperations(fn, args, new Set(['22R']), BEGIN, END)]).toEqual([6, 7, 8]);
  });
  it('skips several annotations, and nothing for an unknown id or none', () => {
    expect([...skippedOperations(fn, args, new Set(['20R', '22R']), BEGIN, END)]).toEqual([1, 2, 3, 4, 6, 7, 8]);
    expect(skippedOperations(fn, args, new Set(['99R']), BEGIN, END).size).toBe(0);
    expect(skippedOperations(fn, args, new Set(), BEGIN, END).size).toBe(0);
  });
  it('never touches operations outside annotations', () => {
    const skip = skippedOperations(fn, args, new Set(['20R', '22R']), BEGIN, END);
    for (const i of [0, 5, 9]) expect(skip.has(i)).toBe(false);
  });
  it('stops at the next annotation if an end marker is missing', () => {
    const skip = skippedOperations([BEGIN, 2, BEGIN, 2, END], [['1R'], [], ['2R'], [], []], new Set(['1R']), BEGIN, END);
    expect([...skip]).toEqual([0, 1]); // 2R begins, and is not hidden
  });
});

describe('toSourceAnnotation', () => {
  const base = { id: '5R', subtype: 'Highlight', rect: [10, 20, 110, 50] };

  it('reads the rectangle in either corner order, as a normalised rect', () => {
    expect(toSourceAnnotation({ ...base, rect: [110, 50, 10, 20] }).rect).toEqual({ x: 10, y: 20, w: 100, h: 30 });
  });

  it('turns 0..255 colours into 0..1', () => {
    expect(toSourceAnnotation({ ...base, color: new Uint8ClampedArray([255, 0, 127]) }).color).toEqual({ r: 1, g: 0, b: 127 / 255 });
    expect(toSourceAnnotation(base).color).toBeUndefined();
    expect(toSourceAnnotation({ ...base, color: null }).color).toBeUndefined();
  });

  it('reads quad points whether PDF.js gives one flat array or one array per quad', () => {
    const flat = new Float32Array([0, 10, 10, 10, 0, 0, 10, 0, 20, 10, 30, 10, 20, 0, 30, 0]);
    const q1 = toSourceAnnotation({ ...base, quadPoints: flat }).quads!;
    expect(q1).toHaveLength(2);
    expect(q1[0]).toEqual({ p1: { x: 0, y: 10 }, p2: { x: 10, y: 10 }, p3: { x: 0, y: 0 }, p4: { x: 10, y: 0 } });
    expect(q1[1]!.p1).toEqual({ x: 20, y: 10 });
    const nested = toSourceAnnotation({ ...base, quadPoints: [flat.slice(0, 8), flat.slice(8)] }).quads!;
    expect(nested).toEqual(q1);
  });

  it('reads ink strokes and line coordinates', () => {
    const a = toSourceAnnotation({ ...base, subtype: 'Ink', inkLists: [new Float32Array([1, 2, 3, 4]), new Float32Array([5, 6])] });
    expect(a.strokes).toEqual([[{ x: 1, y: 2 }, { x: 3, y: 4 }], [{ x: 5, y: 6 }]]);
    expect(toSourceAnnotation({ ...base, subtype: 'Line', lineCoordinates: [1, 2, 3, 4] }).line).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
  });

  it('reads text, author, dates, border width and reply links, and leaves out what is missing', () => {
    const a = toSourceAnnotation({
      ...base, contentsObj: { str: 'Hi' }, titleObj: { str: 'Ada' }, creationDate: 'D:2026', modificationDate: 'D:2027',
      borderStyle: { width: 3 }, inReplyTo: '1R', replyType: 'R',
    });
    expect(a).toMatchObject({ contents: 'Hi', author: 'Ada', created: 'D:2026', modified: 'D:2027', borderWidth: 3, inReplyTo: '1R', replyType: 'R' });
    const bare = toSourceAnnotation({ ...base, contentsObj: { str: '' }, inReplyTo: null, replyType: null });
    expect(Object.keys(bare).sort()).toEqual(['id', 'rect', 'subtype']);
  });
});

// ---- A source PDF made by "another tool": built directly with pdf-lib ------------------------------------------

const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/');
const renderer = new PdfJsRenderer({ pdfjs: pdfjs as never, standardFontDataUrl: fonts });
const hex = (s: string) => PDFHexString.fromText(s);

/**
 * One page with: a highlight carrying a comment and a popup, the popup, two replies to the highlight, an unrelated
 * square, and a note. Returns the saved bytes.
 */
async function otherToolsPdf(opts: { indirectAnnots?: boolean } = {}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const ctx = pdf.context;
  const annot = (extra: Record<string, unknown>) => ctx.obj({ Type: 'Annot', F: 4, ...extra });
  const highlight = ctx.register(annot({ Subtype: 'Highlight', Rect: [10, 300, 110, 320], QuadPoints: [10, 320, 110, 320, 10, 300, 110, 300], C: [1, 1, 0] }));
  const popup = ctx.register(annot({ Subtype: 'Popup', Rect: [120, 300, 220, 360], Open: false }));
  const h = ctx.lookup(highlight, PDFDict);
  h.set(PDFName.of('T'), hex('Ada'));
  h.set(PDFName.of('Contents'), hex('SECRET-COMMENT-TEXT'));
  h.set(PDFName.of('Popup'), popup);
  ctx.lookup(popup, PDFDict).set(PDFName.of('Parent'), highlight);
  const reply = (text: string) => {
    const r = ctx.register(annot({ Subtype: 'Text', Rect: [10, 300, 30, 320], RT: 'R', Name: 'Comment' }));
    const d = ctx.lookup(r, PDFDict);
    d.set(PDFName.of('IRT'), highlight);
    d.set(PDFName.of('Contents'), hex(text));
    d.set(PDFName.of('T'), hex('Bob'));
    return r;
  };
  const r1 = reply('SECRET-REPLY-ONE');
  const r2 = reply('SECRET-REPLY-TWO');
  const square = ctx.register(annot({ Subtype: 'Square', Rect: [50, 100, 150, 160], C: [0, 0, 1], BS: { W: 2 } }));
  ctx.lookup(square, PDFDict).set(PDFName.of('Contents'), hex('KEEP-THIS-TEXT'));
  const note = ctx.register(annot({ Subtype: 'Text', Rect: [200, 350, 220, 370], Name: 'Note' }));
  ctx.lookup(note, PDFDict).set(PDFName.of('Contents'), hex('KEEP-THE-NOTE'));

  const list = [highlight, popup, r1, r2, square, note];
  if (opts.indirectAnnots) page.node.set(PDFName.of('Annots'), ctx.register(ctx.obj(list)));
  else page.node.set(PDFName.of('Annots'), ctx.obj(list));
  return pdf.save();
}

const sourceDoc = (bytes: Uint8Array) => ({ id: 's', name: 'other.pdf', data: memorySource(bytes), pageCount: 1, isEncrypted: false, hasDigitalSignature: false });

async function open(bytes: Uint8Array) {
  return renderer.open(sourceDoc(bytes));
}

const outputAnnots = async (bytes: Uint8Array, page = 0) => {
  const arr = (await PDFDocument.load(bytes)).getPage(page).node.lookup(PDFName.of('Annots'), PDFArray);
  return arr.asArray().map((_, i) => {
    const d = arr.lookup(i, PDFDict);
    const text = d.lookup(PDFName.of('Contents'));
    return { subtype: (d.lookup(PDFName.of('Subtype')) as PDFName).decodeText(), contents: text instanceof PDFHexString ? text.decodeText() : undefined };
  });
};
/** Every text string in every object of the file, found by parsing it (so compressed object streams are included). */
const allStrings = async (bytes: Uint8Array) => {
  const out: string[] = [];
  for (const [, obj] of (await PDFDocument.load(bytes)).context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    for (const [, v] of obj.entries()) if (v instanceof PDFHexString) out.push(v.decodeText());
  }
  return out;
};
const contains = (bytes: Uint8Array, text: string) => new TextDecoder('latin1').decode(bytes).includes(hex(text).toString().slice(1, -1));

describe('reading annotations from another tool with PDF.js', () => {
  it('reports ids, types, text, authors, quads and the reply links', async () => {
    const doc = await open(await otherToolsPdf());
    const list = await doc.getSourceAnnotations(0);
    // PDF.js reports popups last, not in file order.
    expect(list.map((a) => a.subtype).sort()).toEqual(['Highlight', 'Popup', 'Square', 'Text', 'Text', 'Text']);
    const by = (contents: string) => list.find((a) => a.contents === contents)!;
    const [hl, r1, r2] = [by('SECRET-COMMENT-TEXT'), by('SECRET-REPLY-ONE'), by('SECRET-REPLY-TWO')] as [SourceAnnotation, SourceAnnotation, SourceAnnotation];
    expect(hl).toMatchObject({ contents: 'SECRET-COMMENT-TEXT', author: 'Ada', color: { r: 1, g: 1, b: 0 } });
    expect(hl.quads).toHaveLength(1);
    expect(hl.rect).toEqual({ x: 10, y: 300, w: 100, h: 20 });
    expect(r1).toMatchObject({ inReplyTo: hl.id, replyType: 'R', contents: 'SECRET-REPLY-ONE', author: 'Bob' });
    expect(r2.inReplyTo).toBe(hl.id);
    doc.destroy();
  });

  it('becomes editor annotations with the replies folded into the comment, and no popup', async () => {
    const doc = await open(await otherToolsPdf());
    const mapped = importedAnnotations(await doc.getSourceAnnotations(0), 'p1');
    expect(mapped.map((a) => a.type)).toEqual(['highlight', 'shape', 'note']);
    expect(mapped[0]!.comment).toMatchObject({ text: 'SECRET-COMMENT-TEXT', replies: [{ text: 'SECRET-REPLY-ONE', author: 'Bob' }, { text: 'SECRET-REPLY-TWO' }] });
    expect(mapped.every((a) => a.origin === 'imported')).toBe(true);
    doc.destroy();
  });

  it('gives the same ids that the writer can find in the file', async () => {
    const bytes = await otherToolsPdf();
    const doc = await open(bytes);
    const ids = (await doc.getSourceAnnotations(0)).map((a) => a.id);
    const arr = (await PDFDocument.load(bytes)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    expect(arr.asArray().map((r) => `${(r as PDFRef).objectNumber}R`).sort()).toEqual([...ids].sort());
    doc.destroy();
  });
});

describe('saving with deleted annotations', () => {
  /** Saves after deleting the original annotation whose text is `removeText` (and what hangs off it). */
  async function saveWithout(removeText: string | undefined, extra: (h: History) => void = () => {}, opts: { indirectAnnots?: boolean; objectStreams?: boolean } = {}) {
    const bytes = await otherToolsPdf(opts);
    const rd = await open(bytes);
    const list = await rd.getSourceAnnotations(0);
    rd.destroy();
    const h = new History(emptyDocument());
    h.execute(addSource(sourceDoc(bytes), undefined, () => 'p1'));
    if (removeText) h.execute(removeImportedAnnotations('p1', idsToRemove(list, `pdf:${list.find((a) => a.contents === removeText)!.id}`)));
    extra(h);
    return { out: await new PdfLibWriter().save(h.current, { ...defaultSaveOpts, useObjectStreams: opts.objectStreams ?? true }), list, h };
  }

  it('keeps every annotation when nothing was deleted', async () => {
    const { out } = await saveWithout(undefined);
    expect((await outputAnnots(out)).map((a) => a.subtype)).toEqual(['Highlight', 'Popup', 'Text', 'Text', 'Square', 'Text']);
  });

  it('drops a deleted annotation together with its popup and both replies, and keeps the rest', async () => {
    const { out } = await saveWithout('SECRET-COMMENT-TEXT');
    const left = await outputAnnots(out);
    expect(left).toEqual([{ subtype: 'Square', contents: 'KEEP-THIS-TEXT' }, { subtype: 'Text', contents: 'KEEP-THE-NOTE' }]);
  });

  it('leaves no trace of the deleted comment or replies anywhere in the saved file', async () => {
    // Uncompressed, so the bytes can be searched directly...
    const plain = (await saveWithout('SECRET-COMMENT-TEXT', () => {}, { objectStreams: false })).out;
    for (const secret of ['SECRET-COMMENT-TEXT', 'SECRET-REPLY-ONE', 'SECRET-REPLY-TWO']) expect(contains(plain, secret), secret).toBe(false);
    expect(contains(plain, 'KEEP-THIS-TEXT')).toBe(true);
    expect(contains(plain, 'KEEP-THE-NOTE')).toBe(true);
    // ...and with the default compressed save, by reading every object in the file.
    const packed = (await saveWithout('SECRET-COMMENT-TEXT')).out;
    const texts = await allStrings(packed);
    for (const secret of ['SECRET-COMMENT-TEXT', 'SECRET-REPLY-ONE', 'SECRET-REPLY-TWO']) expect(texts, secret).not.toContain(secret);
    expect(texts).toContain('KEEP-THIS-TEXT');
  });

  it('would find the text if it had been kept (so the checks above mean something)', async () => {
    expect(contains((await saveWithout(undefined, () => {}, { objectStreams: false })).out, 'SECRET-COMMENT-TEXT')).toBe(true);
    expect(await allStrings((await saveWithout(undefined)).out)).toContain('SECRET-COMMENT-TEXT');
  });

  it('deleting just a reply leaves the annotation and the other reply', async () => {
    const { out } = await saveWithout('SECRET-REPLY-ONE');
    const left = await outputAnnots(out);
    expect(left.map((a) => a.contents ?? a.subtype)).toEqual(['SECRET-COMMENT-TEXT', 'Popup', 'SECRET-REPLY-TWO', 'KEEP-THIS-TEXT', 'KEEP-THE-NOTE']);
  });

  it('deleting an unrelated annotation removes only that one', async () => {
    const { out } = await saveWithout('KEEP-THIS-TEXT');
    expect((await outputAnnots(out)).map((a) => a.subtype)).toEqual(['Highlight', 'Popup', 'Text', 'Text', 'Text']);
  });

  it('works when /Annots is an indirect array', async () => {
    const { out } = await saveWithout('SECRET-COMMENT-TEXT', () => {}, { indirectAnnots: true });
    expect((await outputAnnots(out)).map((a) => a.contents)).toEqual(['KEEP-THIS-TEXT', 'KEEP-THE-NOTE']);
  });

  it('keeps annotations the editor added alongside, and counts only what is left', async () => {
    const mine: Annotation = {
      type: 'highlight', id: 'mine', pageId: 'p1', author: 'me', createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z',
      color: { r: 1, g: 1, b: 0, a: 1 }, opacity: 0.5, origin: 'app', quads: [rectToQuad({ x: 10, y: 200, w: 50, h: 12 })],
    };
    const { out } = await saveWithout('SECRET-COMMENT-TEXT', (h) => h.execute(addAnnotation(mine)));
    expect((await outputAnnots(out)).map((a) => a.subtype)).toEqual(['Square', 'Text', 'Highlight']);
  });

  it('treats each copy of a duplicated page on its own, and does not disturb the source between copies', async () => {
    const bytes = await otherToolsPdf();
    const rd = await open(bytes);
    const list = await rd.getSourceAnnotations(0);
    rd.destroy();
    const h = new History(emptyDocument());
    h.execute(addSource(sourceDoc(bytes), undefined, () => 'p1'));
    let n = 0;
    h.execute(duplicatePages(['p1'], () => `c${++n}`));
    h.execute(duplicatePages([h.current.pages[1]!.id], () => `d${++n}`)); // three pages: p1, copy of p1's copy... all from source page 0
    const [a, b, c] = h.current.pages.map((p) => p.id) as [string, string, string];
    h.execute(removeImportedAnnotations(b, idsToRemove(list, `pdf:${list.find((x) => x.contents === 'SECRET-COMMENT-TEXT')!.id}`))); // only the middle one loses the highlight thread
    h.execute(removeImportedAnnotations(c, [list.find((x) => x.contents === 'KEEP-THIS-TEXT')!.id])); // the last loses only the square
    expect(a).toBe('p1');
    const out = await new PdfLibWriter().save(h.current, defaultSaveOpts);
    expect((await outputAnnots(out, 0)).length).toBe(6);
    expect((await outputAnnots(out, 1)).map((x) => x.subtype)).toEqual(['Square', 'Text']);
    expect((await outputAnnots(out, 2)).map((x) => x.subtype)).toEqual(['Highlight', 'Popup', 'Text', 'Text', 'Text']);
  });

  it('is unaffected for a page that has no annotations at all', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const bytes = await pdf.save();
    const h = new History(emptyDocument());
    h.execute(addSource(sourceDoc(bytes), undefined, () => 'p1'));
    h.execute(removeImportedAnnotations('p1', ['20R']));
    const out = await new PdfLibWriter().save(h.current, defaultSaveOpts);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(1);
  });
});
