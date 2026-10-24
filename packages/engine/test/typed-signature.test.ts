import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import {
  History, addAnnotation, addSource, artPoints, emptyDocument, isSignatureArt, memorySource, newSignatureRect, type Annotation, type SignatureArt, type StampAnnot,
} from '@pagewright/core';
import {
  PdfJsRenderer, PdfLibWriter, buildSignatureAppearance, createSignatureMaker, defaultSaveOpts, typedSignatureArt,
} from '../src';

const font = (pkg: string, file: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../node_modules/@fontsource/${pkg}/files/${file}.woff`, import.meta.url))));
const gv = (subset: string) => font('great-vibes', `great-vibes-${subset}-400-normal`);
const latin = [gv('latin')];
const latinAndExt = [gv('latin'), gv('latin-ext')];

describe('typedSignatureArt', () => {
  it('draws a name as closed outlines, ready to use', () => {
    const { art, missing } = typedSignatureArt(latin, 'Ada Lovelace')!;
    expect(missing).toEqual([]);
    expect(art.mode).toBe('fill');
    expect(art.w).toBeGreaterThan(art.h);
    expect(isSignatureArt(art)).toBe(true);
    expect(art.paths[0]![0]).toBe('M');
    expect(art.paths.at(-1)![0]).toBe('Z');
    expect(art.paths.some((c) => c[0] === 'C')).toBe(true);
    expect(art.paths.every((c) => c[0] !== ('Q' as string))).toBe(true); // quadratics were converted to cubics
  });

  it('keeps every point inside the artwork box, with the ink starting at the padding', () => {
    const { art } = typedSignatureArt(latin, 'Ada Lovelace')!;
    const pts = artPoints(art);
    expect(Math.min(...pts.map((p) => p.x))).toBeCloseTo(2, 1);
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(2, 1);
    expect(Math.max(...pts.map((p) => p.x))).toBeLessThanOrEqual(art.w);
    expect(Math.max(...pts.map((p) => p.y))).toBeLessThanOrEqual(art.h);
  });

  it('is a sensible size: roughly one em tall, wider for longer names', () => {
    const short = typedSignatureArt(latin, 'Ada')!.art;
    const long = typedSignatureArt(latin, 'Ada Lovelace Byron')!.art;
    expect(short.h).toBeGreaterThan(30);
    expect(short.h).toBeLessThan(250);
    expect(long.w).toBeGreaterThan(short.w * 2);
  });

  it('is plain data that survives JSON, which is how it is stored', () => {
    const { art } = typedSignatureArt(latin, 'Ada')!;
    const again = JSON.parse(JSON.stringify(art)) as SignatureArt;
    expect(again).toEqual(art);
    expect(isSignatureArt(again)).toBe(true);
  });

  it('gives the same artwork for the same input', () => {
    expect(typedSignatureArt(latin, 'Ada')).toEqual(typedSignatureArt(latin, 'Ada'));
  });

  it('draws different artwork in a different font', () => {
    const other = [font('dancing-script', 'dancing-script-latin-400-normal')];
    expect(typedSignatureArt(other, 'Ada')!.art).not.toEqual(typedSignatureArt(latin, 'Ada')!.art);
  });

  it('treats runs of spaces and surrounding space as one space', () => {
    expect(typedSignatureArt(latin, '  Ada   Lovelace ')).toEqual(typedSignatureArt(latin, 'Ada Lovelace'));
  });

  it('treats a letter and its combining-accent form alike', () => {
    expect(typedSignatureArt(latinAndExt, 'Zoë')).toEqual(typedSignatureArt(latinAndExt, 'Zoë'));
  });

  it('returns nothing for empty or blank text', () => {
    expect(typedSignatureArt(latin, '')).toBeUndefined();
    expect(typedSignatureArt(latin, '   \n\t ')).toBeUndefined();
    expect(typedSignatureArt([], 'Ada')).toBeUndefined();
  });

  describe('characters outside a font file', () => {
    it('are reported and left out, and the rest is still drawn', () => {
      const r = typedSignatureArt(latin, 'Łukasz')!;
      expect(r.missing).toEqual(['Ł']);
      expect(isSignatureArt(r.art)).toBe(true);
    });

    it('are drawn once another file of the font supplies them', () => {
      const withoutL = typedSignatureArt(latin, 'Łukasz')!;
      const withExt = typedSignatureArt(latinAndExt, 'Łukasz')!;
      expect(withExt.missing).toEqual([]);
      expect(withExt.art.paths.length).toBeGreaterThan(withoutL.art.paths.length);
      expect(withExt.art.w).toBeGreaterThan(withoutL.art.w);
    });

    it('can leave nothing to draw', () => {
      expect(typedSignatureArt(latin, 'Привет')).toBeUndefined();
    });

    it('are drawn from the Cyrillic file when it is supplied', () => {
      const r = typedSignatureArt([gv('latin'), gv('cyrillic')], 'Ada Привет')!;
      expect(r.missing).toEqual([]);
      expect(r.art.w).toBeGreaterThan(typedSignatureArt(latin, 'Ada')!.art.w);
    });

    it('lists each missing character once', () => {
      expect(typedSignatureArt(latin, 'ЖЖЖ Ada')!.missing).toEqual(['Ж']);
    });
  });
});

describe('createSignatureMaker', () => {
  const source = (id: string, label = id) => ({ id, label, load: vi.fn(async () => latinAndExt) });

  it('lists the fonts it was given', () => {
    const maker = createSignatureMaker([source('a', 'Style A'), source('b', 'Style B')]);
    expect(maker.fonts).toEqual([{ id: 'a', label: 'Style A' }, { id: 'b', label: 'Style B' }]);
  });

  it('draws text in the chosen font', async () => {
    const maker = createSignatureMaker([source('a')]);
    const { art, missing } = await maker.make('Ada', 'a');
    expect(isSignatureArt(art)).toBe(true);
    expect(missing).toEqual([]);
  });

  it('loads each font once, however many signatures are made', async () => {
    const a = source('a');
    const maker = createSignatureMaker([a]);
    await Promise.all([maker.make('Ada', 'a'), maker.make('Bob', 'a')]);
    await maker.make('Cy', 'a');
    expect(a.load).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown font and text with nothing to draw, with a message a person can read', async () => {
    const maker = createSignatureMaker([source('a')]);
    await expect(maker.make('Ada', 'nope')).rejects.toThrow(/Unknown signature style/);
    await expect(maker.make('   ', 'a')).rejects.toThrow(/nothing to draw/);
  });

  it('tries a failed load again next time', async () => {
    let fail = true;
    const flaky = { id: 'f', label: 'f', load: vi.fn(async () => { if (fail) throw new Error('network'); return latin; }) };
    const maker = createSignatureMaker([flaky]);
    await expect(maker.make('Ada', 'f')).rejects.toThrow('network');
    fail = false;
    await expect(maker.make('Ada', 'f')).resolves.toBeDefined();
    expect(flaky.load).toHaveBeenCalledTimes(2);
  });
});

// ---- Drawing and writing a signature -----------------------------------------------------------------------------

const base = { id: 'sig1', pageId: 'p1', author: 'Ada', createdAt: '2026-03-04T05:06:07Z', modifiedAt: '2026-03-04T05:06:07Z', opacity: 1, origin: 'app' as const };
const signature = (art: SignatureArt, over: Partial<StampAnnot> = {}): StampAnnot => ({
  ...base, type: 'stamp', color: { r: 0.05, g: 0.1, b: 0.5, a: 1 }, payload: { kind: 'signature', art }, rect: newSignatureRect(art, { x: 150, y: 100 }), ...over,
});
const typed = () => typedSignatureArt(latin, 'Ada Lovelace')!.art;

describe('buildSignatureAppearance', () => {
  it('fills the letter outlines in the ink colour', () => {
    const ap = buildSignatureAppearance(signature(typed()));
    expect(ap.content).toMatch(/^0\.05 0\.1 0\.5 rg\n/);
    expect(ap.content).toMatch(/\nf$/);
    expect(ap.content.match(/ m$/gm)!.length).toBeGreaterThan(3); // one subpath per letter shape
    expect(ap.content.match(/ c$/gm)!.length).toBeGreaterThan(50);
    expect(ap.font).toBeUndefined();
  });

  it('draws inside the rectangle, scaled with its proportions kept and centred', () => {
    const art = typed();
    const rect = { x: 20, y: 30, w: 200, h: 200 }; // much taller than the artwork needs
    const ap = buildSignatureAppearance(signature(art, { rect }));
    const nums = [...ap.content.matchAll(/(-?[\d.]+) (-?[\d.]+) [mlc]$/gm)].map((m) => [Number(m[1]), Number(m[2])] as const);
    const xs = nums.map((n) => n[0]);
    const ys = nums.map((n) => n[1]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(rect.x - 0.01);
    expect(Math.max(...xs)).toBeLessThanOrEqual(rect.x + rect.w + 0.01);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(rect.y - 0.01);
    expect(Math.max(...ys)).toBeLessThanOrEqual(rect.y + rect.h + 0.01);
    // limited by the width, so it spans the width and is centred vertically
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(rect.w * 0.9);
    const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(mid).toBeCloseTo(rect.y + rect.h / 2, 0);
  });

  it('is upright: the first letter is at the left and the top of the artwork is higher on the page', () => {
    const art: SignatureArt = { w: 100, h: 50, mode: 'fill', paths: [['M', 0, 0], ['L', 100, 0], ['L', 100, 50], ['Z']] };
    const ap = buildSignatureAppearance(signature(art, { rect: { x: 0, y: 0, w: 100, h: 50 } }));
    expect(ap.content).toContain('0 50 m'); // artwork's top-left is the page's upper-left
    expect(ap.content).toContain('100 50 l');
    expect(ap.content).toContain('100 0 l');
  });

  it('draws pen strokes as lines with a round pen, scaled with the artwork', () => {
    const art: SignatureArt = { w: 100, h: 50, mode: 'stroke', strokeWidth: 3, paths: [['M', 0, 0], ['L', 100, 50]] };
    const ap = buildSignatureAppearance(signature(art, { rect: { x: 0, y: 0, w: 200, h: 100 } }));
    expect(ap.content).toContain('3 w'.replace('3', '6')); // scale 2: the pen is twice as wide
    expect(ap.content).toContain('1 J 1 j');
    expect(ap.content).toMatch(/RG\n/);
    expect(ap.content).toMatch(/\nS$/);
  });

  it('refuses anything that is not a signature', () => {
    expect(() => buildSignatureAppearance({ ...signature(typed()), payload: { kind: 'preset', name: 'Draft' } })).toThrow(/not a signature/);
  });

  it('combines opacity with colour alpha', () => {
    expect(buildSignatureAppearance(signature(typed(), { opacity: 0.5 })).opacity).toBe(0.5);
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

describe('writing a signature', () => {
  it('writes a /Stamp named Signature with a vector appearance and no font', async () => {
    const dict = (await annotsOf(await save([signature(typed())]))).lookup(0, PDFDict);
    expect(get(dict, 'Subtype')).toBe(PDFName.of('Stamp'));
    expect(get(dict, 'Name')).toBe(PDFName.of('Signature'));
    expect((get(dict, 'Subj') as PDFHexString).decodeText()).toBe('Signature');
    const ap = dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    const res = ap.dict.lookup(PDFName.of('Resources'), PDFDict);
    expect(res.lookup(PDFName.of('Font'))).toBeUndefined(); // nothing to embed: the letters are outlines
    expect(new TextDecoder('latin1').decode(ap.contents)).toMatch(/ c\n/);
  });

  it('keeps the file small', async () => {
    const bytes = await save([signature(typed())]);
    expect(bytes.byteLength).toBeLessThan(60_000);
  });

  it('writes a hand-drawn (stroke) signature too', async () => {
    const art: SignatureArt = { w: 100, h: 40, mode: 'stroke', strokeWidth: 2, paths: [['M', 0, 20], ['C', 20, 0, 40, 40, 60, 20], ['L', 100, 10]] };
    const dict = (await annotsOf(await save([signature(art)]))).lookup(0, PDFDict);
    expect(get(dict, 'Name')).toBe(PDFName.of('Signature'));
  });

  it('is read back by PDF.js as a Stamp, in the right place', async () => {
    const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/');
    const renderer = new PdfJsRenderer({ pdfjs: pdfjs as never, standardFontDataUrl: fonts });
    const a = signature(typed());
    const doc = await renderer.open({ id: 'o', name: 'o.pdf', data: memorySource(await save([a])), pageCount: 1, isEncrypted: false, hasDigitalSignature: false });
    const [found] = await doc.getExistingAnnotations(0);
    expect(found!.subtype).toBe('Stamp');
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(found!.rect[k]).toBeCloseTo(a.rect[k], 2);
    doc.destroy();
  });

  it('turns with a rotated page like any annotation', async () => {
    const plain = (await annotsOf(await save([signature(typed())]))).lookup(0, PDFDict);
    const rotated = (await annotsOf(await save([signature(typed())], 90))).lookup(0, PDFDict);
    expect(get(rotated, 'Rect')!.toString()).toBe(get(plain, 'Rect')!.toString());
  });
});
