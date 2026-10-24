import { deflateSync } from 'node:zlib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from '@cantoo/pdf-lib';
import { History, addAnnotation, addSource, emptyDocument, memorySource, type Annotation, type StampAnnot } from '@pagewright/core';
import { PdfLibWriter, buildImageStampAppearance, defaultSaveOpts } from '../src';

/** A real PNG, `w` x `h`, every pixel the same colour; `alpha` < 255 gives it transparency. */
function png(w: number, h: number, [r, g, b, alpha]: [number, number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b, alpha]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** The headers of a baseline JPEG (`w` x `h`, three components): enough for pdf-lib, which does not decode JPEGs. */
function jpegHeader(w: number, h: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
}

const base = { pageId: 'p1', author: 'Ada', createdAt: '2026-03-04T05:06:07Z', modifiedAt: '2026-03-04T05:06:07Z', opacity: 1, origin: 'app' as const };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const image = (id: string, bytes: Uint8Array, mime: 'image/png' | 'image/jpeg' = 'image/png', over: Partial<StampAnnot> = {}): StampAnnot => ({
  ...base, id, type: 'stamp', color: BLACK, rect: { x: 50, y: 40, w: 120, h: 60 }, payload: { kind: 'image', mime, bytes }, ...over,
});

async function save(annots: Annotation[]) {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 200]);
  const h = new History(emptyDocument());
  h.execute(addSource({ id: 's', name: 's.pdf', data: memorySource(await pdf.save()), pageCount: 1, isEncrypted: false, hasDigitalSignature: false }, undefined, () => 'p1'));
  annots.forEach((a) => h.execute(addAnnotation(a)));
  return new PdfLibWriter().save(h.current, defaultSaveOpts);
}
const annotsOf = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
const apOf = (d: PDFDict) => d.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
const imageOf = (d: PDFDict) => apOf(d).dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict);

describe('buildImageStampAppearance', () => {
  it('stretches the picture over the rectangle and draws it as /Im1', () => {
    const ap = buildImageStampAppearance(image('i', png(2, 1, [0, 0, 0, 255])));
    expect(ap.bbox).toEqual([50, 40, 170, 100]);
    expect(ap.content).toBe('q 120 0 0 60 50 40 cm /Im1 Do Q');
    expect(ap.image).toBe(true);
    expect(ap.multiply).toBe(false);
  });

  it('uses the annotation opacity only: a picture has no ink colour', () => {
    expect(buildImageStampAppearance(image('i', png(1, 1, [0, 0, 0, 255]), 'image/png', { opacity: 0.4, color: { ...BLACK, a: 0.1 } })).opacity).toBe(0.4);
  });

  it('refuses other stamps', () => {
    expect(() => buildImageStampAppearance({ ...image('i', new Uint8Array()), payload: { kind: 'preset', name: 'Approved' } })).toThrow(/not an image/);
  });
});

describe('writing image stamps', () => {
  it('writes a /Stamp named Image whose appearance draws the embedded PNG', async () => {
    const dict = (await annotsOf(await save([image('i1', png(4, 2, [200, 0, 0, 255]))]))).lookup(0, PDFDict);
    expect(dict.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Stamp'));
    expect(dict.lookup(PDFName.of('Name'))).toBe(PDFName.of('Image'));
    const im = imageOf(dict).lookup(PDFName.of('Im1')) as PDFRawStream;
    expect(im.dict.lookup(PDFName.of('Subtype'))).toBe(PDFName.of('Image'));
    expect(im.dict.lookup(PDFName.of('Width'))).toEqual(PDFNumber.of(4));
    expect(im.dict.lookup(PDFName.of('Height'))).toEqual(PDFNumber.of(2));
  });

  it('keeps a PNG\'s transparency as a soft mask', async () => {
    const dict = (await annotsOf(await save([image('i1', png(2, 2, [0, 0, 255, 100]))]))).lookup(0, PDFDict);
    const im = imageOf(dict).lookup(PDFName.of('Im1')) as PDFRawStream;
    expect(im.dict.get(PDFName.of('SMask'))).toBeInstanceOf(PDFRef);
  });

  it('writes a JPEG as it is, without decoding it again', async () => {
    const bytes = jpegHeader(30, 20);
    const dict = (await annotsOf(await save([image('j1', bytes, 'image/jpeg')]))).lookup(0, PDFDict);
    const im = imageOf(dict).lookup(PDFName.of('Im1')) as PDFRawStream;
    expect(im.dict.lookup(PDFName.of('Filter'))).toBe(PDFName.of('DCTDecode'));
    expect(im.dict.lookup(PDFName.of('Width'))).toEqual(PDFNumber.of(30));
    expect([...im.contents]).toEqual([...bytes]);
  });

  it('stores one picture for stamps that share it (a duplicated stamp), and separate ones otherwise', async () => {
    const shared = png(3, 3, [0, 128, 0, 255]);
    const annots = await annotsOf(await save([image('a', shared), image('b', shared, 'image/png', { rect: { x: 0, y: 0, w: 30, h: 30 } }), image('c', png(3, 3, [0, 0, 0, 255]))]));
    const ref = (i: number) => imageOf(annots.lookup(i, PDFDict)).get(PDFName.of('Im1'));
    expect(ref(0)).toBeInstanceOf(PDFRef);
    expect(ref(0)).toBe(ref(1));
    expect(ref(2)).not.toBe(ref(0));
  });

  it('fails the save with a clear message when a picture is damaged, rather than writing an empty stamp', async () => {
    await expect(save([image('x', new Uint8Array([1, 2, 3]))])).rejects.toThrow(/image stamp could not be saved/);
  });

  it('is drawn by PDF.js: the page shows the picture through the annotation', async () => {
    const bytes = await save([image('i1', png(8, 4, [255, 0, 0, 255]))]);
    const task = pdfjs.getDocument({ data: bytes });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
    expect(ops.fnArray).toContain(pdfjs.OPS.paintImageXObject);
    await task.destroy();
  });
});
