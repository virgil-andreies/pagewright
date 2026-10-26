// Builds out/sample.pdf: merged, rotated pages with highlight / underline / strikeout.
// Run from the repo root: pnpm sample
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';
import {
  History, fitFreeText, strokesToArt, newSignatureRect, newStampRect, stampPreset, memorySource, addAnnotation, normalizeRect, addSource, emptyDocument, rectToQuad, rotatePages, setMetadata,
  type Annotation, type PageId, type Point, type Rect, type ShapeAnnot, type SourceDoc,
} from '@pagewright/core';
import { PdfLibWriter, UNICODE_FAMILIES, defaultSaveOpts, unicodeFontFile } from '../src';
import { typedSignatureArt } from '../src/typed-signature';

const SIZE = 18;

interface Line { text: string; x: number; y: number }

async function makeSource(id: string, titles: string[], rotate = 0, cropBox?: [number, number, number, number]) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const lines: Line[][] = [];
  for (const title of titles) {
    const page = pdf.addPage([612, 792]);
    if (rotate) page.setRotation(degrees(rotate));
    if (cropBox) page.setCropBox(...cropBox);
    const pageLines: Line[] = [
      { text: title, x: 72, y: 700 },
      { text: 'The quick brown fox jumps over the lazy dog.', x: 72, y: 660 },
      { text: 'Pack my box with five dozen liquor jugs.', x: 72, y: 620 },
      { text: 'How vexingly quick daft zebras jump!', x: 72, y: 580 },
    ];
    for (const l of pageLines) page.drawText(l.text, { x: l.x, y: l.y, size: SIZE, font, color: rgb(0, 0, 0) });
    page.drawRectangle({ x: 20, y: 20, width: 40, height: 40, borderColor: rgb(1, 0, 0), borderWidth: 2 }); // origin marker
    lines.push(pageLines);
  }
  const bytes = await pdf.save();
  const widthOf = (t: string) => font.widthOfTextAtSize(t, SIZE);
  const src: SourceDoc = { id, name: `${id}.pdf`, data: memorySource(bytes), pageCount: titles.length, isEncrypted: false, hasDigitalSignature: false };
  return { src, lines, widthOf };
}

/** A PNG made pixel by pixel (8-bit RGBA): `pixel` gives [r, g, b, alpha] for each one. */
function png(w: number, h: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = table[(c ^ x) & 0xff]! ^ (c >>> 8);
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
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Array.from({ length: h }, (_, y) => Buffer.from([0, ...Array.from({ length: w }, (_, x) => pixel(x, y)).flat()]));
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Uint8Array(Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
}

/** Rect covering `phrase` inside `line` (Helvetica metrics, so it lines up with the glyphs). */
function span(line: Line, phrase: string, widthOf: (t: string) => number) {
  const start = line.text.indexOf(phrase);
  if (start < 0) throw new Error(`"${phrase}" not in "${line.text}"`);
  return {
    x: line.x + widthOf(line.text.slice(0, start)),
    y: line.y - SIZE * 0.22,
    w: widthOf(phrase),
    h: SIZE * 1.0,
  };
}

function markup(type: 'highlight' | 'underline' | 'strikeout', pageId: PageId, id: string, rect: ReturnType<typeof span>, color: { r: number; g: number; b: number }, comment?: string): Annotation {
  return {
    type, id, pageId, author: 'Pagewright sample', createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(),
    color: { ...color, a: 1 }, opacity: type === 'highlight' ? 0.6 : 1, origin: 'app',
    quads: [rectToQuad(rect)],
    ...(comment ? { comment: { text: comment, replies: [] } } : {}),
  };
}

async function main() {
  const a = await makeSource('A', ['Document A, page 1', 'Document A, page 2']);
  const b = await makeSource('B', ['Document B (source /Rotate 90)'], 90);
  const c = await makeSource('C', ['Document C (offset CropBox)'], 0, [50, 100, 450, 600]);
  const d = await makeSource('D', ['Document D (ink and shapes)']);

  let n = 0;
  const h = new History(emptyDocument());
  for (const s of [a.src, b.src, c.src, d.src]) h.execute(addSource(s, undefined, () => `p${++n}`));
  // p1,p2 = A; p3 = B; p4 = C; p5 = D
  h.execute(setMetadata({ title: 'Pagewright sample', author: 'Pagewright', keywords: ['sample', 'test'] }));

  const yellow = { r: 1, g: 0.9, b: 0 };
  const red = { r: 0.9, g: 0.1, b: 0.1 };
  const blue = { r: 0.1, g: 0.3, b: 0.9 };

  const [a1, a2] = a.lines as [Line[], Line[]];
  h.execute(addAnnotation(markup('highlight', 'p1', 'hl-1', span(a1[1]!, 'brown fox jumps', a.widthOf), yellow, 'Highlight with a comment')));
  h.execute(addAnnotation(markup('underline', 'p1', 'ul-1', span(a1[2]!, 'five dozen', a.widthOf), blue)));
  h.execute(addAnnotation(markup('strikeout', 'p1', 'so-1', span(a1[3]!, 'daft zebras', a.widthOf), red)));
  h.execute(addAnnotation(markup('highlight', 'p2', 'hl-2', span(a2[1]!, 'lazy dog', a.widthOf), yellow)));
  h.execute(addAnnotation(markup('highlight', 'p3', 'hl-3', span(b.lines[0]![1]!, 'quick brown', b.widthOf), yellow)));
  h.execute(addAnnotation(markup('highlight', 'p4', 'hl-4', span(c.lines[0]![1]!, 'quick brown', c.widthOf), yellow)));


  // Ink and shapes. Unrotated page (p5), then the same kinds on rotated / offset pages to check geometry.
  const red2 = { r: 0.86, g: 0.15, b: 0.15, a: 1 };
  const blue2 = { r: 0.15, g: 0.4, b: 0.9, a: 1 };
  const green2 = { r: 0.1, g: 0.6, b: 0.3, a: 1 };
  const common = { author: 'Pagewright sample', createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(), opacity: 1, origin: 'app' as const };
  const shape = (id: string, pageId: string, kind: 'rect' | 'ellipse' | 'line' | 'arrow', rect: Rect, color: typeof red2, width: number, extra: Partial<ShapeAnnot> = {}): Annotation => ({
    ...common, type: 'shape', shape: kind, id, pageId, rect, color, width, ...extra,
  });
  const lineOf = (id: string, pageId: string, kind: 'line' | 'arrow', a: Point, b: Point, color: typeof red2, width: number) =>
    shape(id, pageId, kind, normalizeRect(a, b), color, width, { line: [a, b] });
  const squiggle = Array.from({ length: 60 }, (_, i): Point => ({ x: 72 + i * 8, y: 520 + 40 * Math.sin(i / 5) }));

  h.execute(addAnnotation({ ...common, type: 'ink', id: 'ink-1', pageId: 'p5', color: red2, width: 3, strokes: [squiggle] }));
  h.execute(addAnnotation({ ...common, type: 'ink', id: 'ink-dot', pageId: 'p5', color: blue2, width: 10, strokes: [[{ x: 520, y: 520 }]] }));
  h.execute(addAnnotation(shape('rect-1', 'p5', 'rect', { x: 72, y: 380, w: 180, h: 90 }, blue2, 4)));
  h.execute(addAnnotation(shape('rect-fill', 'p5', 'rect', { x: 290, y: 380, w: 120, h: 90 }, green2, 2, { fill: { r: 0.8, g: 0.95, b: 0.8, a: 1 } })));
  h.execute(addAnnotation(shape('ell-1', 'p5', 'ellipse', { x: 440, y: 380, w: 100, h: 90 }, red2, 3)));
  h.execute(addAnnotation(lineOf('line-1', 'p5', 'line', { x: 72, y: 330 }, { x: 300, y: 270 }, green2, 3)));
  h.execute(addAnnotation(lineOf('arrow-1', 'p5', 'arrow', { x: 340, y: 270 }, { x: 540, y: 340 }, blue2, 3)));
  h.execute(addAnnotation(lineOf('arrow-thick', 'p5', 'arrow', { x: 72, y: 200 }, { x: 300, y: 200 }, red2, 8)));
  // Rotated page (p3 shows at 180 degrees) and offset-CropBox page (p4): the boxes must sit on the text.
  h.execute(addAnnotation(shape('rect-p3', 'p3', 'rect', { x: 66, y: 652, w: 410, h: 30 }, red2, 2)));
  h.execute(addAnnotation(lineOf('arrow-p3', 'p3', 'arrow', { x: 72, y: 560 }, { x: 300, y: 610 }, blue2, 2)));
  h.execute(addAnnotation(shape('rect-p4', 'p4', 'rect', { x: 66, y: 652, w: 410, h: 30 }, red2, 2)));
  h.execute(addAnnotation(shape('ell-p2', 'p2', 'ellipse', { x: 66, y: 650, w: 410, h: 40 }, blue2, 2)));

  // Notes and comment threads. The note on p3 sits on a rotated page: viewers keep its icon upright.
  const reply = (id: string, author: string, text: string) => ({ id, author, createdAt: new Date().toISOString(), text });
  const noteColor = { r: 1, g: 0.85, b: 0.25, a: 1 };
  h.execute(addAnnotation({ ...common, type: 'note', id: 'note-1', pageId: 'p1', color: noteColor, icon: 'note', position: { x: 480, y: 700 },
    comment: { text: 'A note with a short thread.', replies: [reply('note-1-r1', 'Grace', 'Agreed, and here is a reply.'), reply('note-1-r2', 'Ada', 'And a second reply.')] } }));
  h.execute(addAnnotation({ ...common, type: 'note', id: 'note-2', pageId: 'p1', color: noteColor, icon: 'comment', position: { x: 520, y: 700 },
    comment: { text: 'The speech-bubble icon.', replies: [] } }));
  h.execute(addAnnotation({ ...common, type: 'note', id: 'note-p3', pageId: 'p3', color: noteColor, icon: 'note', position: { x: 480, y: 700 },
    comment: { text: 'Icon should stay upright on a rotated page.', replies: [] } }));
  h.execute(addAnnotation({ ...common, type: 'note', id: 'note-p4', pageId: 'p4', color: noteColor, icon: 'comment', position: { x: 300, y: 560 },
    comment: { text: 'On the offset-CropBox page.', replies: [] } }));

  // Free text in each standard font, with wrapping and accents; plus the rotated and offset-CropBox pages.
  const text = (id: string, pageId: string, family: 'sans' | 'serif' | 'mono', size: number, x: number, top: number, w: number, body: string, color = red2): Annotation =>
    fitFreeText({ ...common, type: 'freetext', id, pageId, color, fontFamily: family, fontSize: size, text: body, rect: { x, y: top, w, h: 0 } });
  const long = 'The quick brown fox jumps over the lazy dog. Crème brûlée, façade, naïve, año, Zürich, 5 €, “quoted” and em—dash.';
  h.execute(addAnnotation(text('ft-sans', 'p5', 'sans', 12, 72, 160, 220, 'Sans (Helvetica): ' + long, blue2)));
  h.execute(addAnnotation(text('ft-serif', 'p5', 'serif', 12, 320, 160, 220, 'Serif (Times): ' + long, green2)));
  h.execute(addAnnotation(text('ft-mono', 'p5', 'mono', 10, 72, 90, 460, 'Mono (Courier): ' + long, red2)));
  h.execute(addAnnotation(text('ft-big', 'p5', 'sans', 24, 72, 40, 460, 'Large text', blue2)));
  h.execute(addAnnotation(text('ft-p3', 'p3', 'sans', 14, 72, 540, 300, 'Free text on a rotated page turns with the page.')));
  h.execute(addAnnotation(text('ft-p4', 'p4', 'serif', 14, 72, 540, 300, 'Free text on the offset-CropBox page.', blue2)));
  // Other alphabets, on the rotated page: these boxes embed only the Noto letters they use.
  h.execute(addAnnotation(text('ft-uni-sans', 'p2', 'sans', 12, 72, 460, 300, 'Noto Sans: Mulțumesc! Zażółć gęślą jaźń. Καλημέρα. Съешь же ещё этих булок. Tiếng Việt.', blue2)));
  h.execute(addAnnotation(text('ft-uni-serif', 'p2', 'serif', 12, 72, 380, 300, 'Noto Serif: Dobrý den, Ελληνικά, Українська, Şcoală.', green2)));
  h.execute(addAnnotation(text('ft-uni-mono', 'p2', 'mono', 10, 72, 320, 300, 'Noto Sans Mono: Ğğ İı Şş — Ђђ Љљ — Ωω', red2)));

  // Preset stamps: on the plain page, the rotated page and the offset-CropBox page.
  const stampAt = (id: string, pageId: string, name: string, cx: number, cy: number, width = 150): Annotation => {
    const preset = stampPreset(name)!;
    return { ...common, type: 'stamp', id, pageId, color: preset.color, payload: { kind: 'preset', name }, rect: newStampRect(preset, { x: cx, y: cy }, width) };
  };
  h.execute(addAnnotation(stampAt('stamp-p1a', 'p1', 'Approved', 200, 330)));
  h.execute(addAnnotation(stampAt('stamp-p1b', 'p1', 'Confidential', 420, 330, 190)));
  h.execute(addAnnotation(stampAt('stamp-p1c', 'p1', 'NotApproved', 200, 250)));
  h.execute(addAnnotation(stampAt('stamp-p3', 'p3', 'Void', 300, 450)));
  h.execute(addAnnotation(stampAt('stamp-p4', 'p4', 'Draft', 250, 400)));

  // Typed signatures, drawn from real handwriting fonts into vector outlines (the same code the app uses).
  const gv = (set: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`../node_modules/@fontsource/great-vibes/files/great-vibes-${set}-400-normal.woff`, import.meta.url))));
  const signed = (id: string, pageId: string, text: string, cx: number, cy: number, color = blue2): Annotation => {
    const { art } = typedSignatureArt([gv('latin'), gv('latin-ext')], text)!;
    return { ...common, type: 'stamp', id, pageId, color, payload: { kind: 'signature', art }, rect: newSignatureRect(art, { x: cx, y: cy }, 200) };
  };
  h.execute(addAnnotation(signed('sig-p1', 'p1', 'Ada Lovelace', 300, 150)));
  h.execute(addAnnotation(signed('sig-p3', 'p3', 'Ada Lovelace', 300, 380, red2)));
  h.execute(addAnnotation(signed('sig-p4', 'p4', 'Łukasz Żółć', 250, 300, green2)));

  // Newer features, below the other alphabets on p2 (a page turned sideways, so rotation is checked once more):
  // a filled, half-transparent rectangle partly over the text above it, a filled ellipse at 70%, a pen stroke at 50%,
  // two picture stamps (one with a transparent background, one opaque) and a hand-drawn signature.
  h.execute(addAnnotation(shape('rect-see-through', 'p2', 'rect', { x: 60, y: 240, w: 230, h: 90 }, blue2, 3, { fill: blue2, opacity: 0.5 })));
  h.execute(addAnnotation(shape('ell-fill', 'p2', 'ellipse', { x: 320, y: 230, w: 200, h: 100 }, red2, 3, { fill: { r: 1, g: 0.85, b: 0.1, a: 1 }, opacity: 0.7 })));
  const wave = Array.from({ length: 50 }, (_, i): Point => ({ x: 72 + i * 9, y: 190 + 18 * Math.sin(i / 3) }));
  h.execute(addAnnotation({ ...common, type: 'ink', id: 'ink-half', pageId: 'p2', color: green2, width: 6, opacity: 0.5, strokes: [wave] }));
  const picture = (id: string, bytes: Uint8Array, cx: number, cy: number, w: number, h: number): Annotation => ({
    ...common, type: 'stamp', id, pageId: 'p2', color: { r: 0, g: 0, b: 0, a: 1 }, payload: { kind: 'image', mime: 'image/png', bytes },
    rect: { x: cx - w / 2, y: cy - h / 2, w, h },
  });
  // A logo: a green disc with a white tick, the corners transparent so the page shows through.
  const nearSegment = (x: number, y: number, a: Point, b: Point) => {
    const t = Math.max(0, Math.min(1, ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2)));
    return Math.hypot(x - (a.x + t * (b.x - a.x)), y - (a.y + t * (b.y - a.y)));
  };
  const logo = png(160, 160, (x, y) => {
    if (Math.hypot(x - 80, y - 80) > 76) return [0, 0, 0, 0];
    // The tick, in picture rows (y grows downwards): down to the bottom of the V, then up to the right.
    const tick = Math.min(nearSegment(x, y, { x: 44, y: 82 }, { x: 70, y: 108 }), nearSegment(x, y, { x: 70, y: 108 }, { x: 120, y: 52 })) < 8;
    return tick ? [255, 255, 255, 255] : [26, 153, 77, 255];
  });
  // A photo-like picture: an opaque colour gradient.
  const photo = png(240, 150, (x, y) => [Math.round((x / 240) * 255), Math.round((y / 150) * 200), 200, 255]);
  h.execute(addAnnotation(picture('img-logo', logo, 130, 100, 80, 80)));
  h.execute(addAnnotation(picture('img-photo', photo, 300, 100, 160, 100)));
  // A signature drawn by hand: pen strokes turned into artwork, as the Draw pad does.
  // Looping pen strokes, like joined-up handwriting, and a flourish underneath (pad units: y grows downwards).
  const loops = Array.from({ length: 140 }, (_, i): Point => ({ x: 20 + i * 2.4 + 14 * Math.cos(i / 3.2), y: 60 - 26 * Math.sin(i / 3.2) * (1 - i / 220) }));
  const underline = Array.from({ length: 30 }, (_, i): Point => ({ x: 30 + i * 12, y: 104 - 6 * Math.sin(i / 9) }));
  h.execute(addAnnotation({
    ...common, type: 'stamp', id: 'sig-drawn', pageId: 'p2', color: blue2, payload: { kind: 'signature', art: strokesToArt([loops, underline])! },
    rect: newSignatureRect(strokesToArt([loops, underline])!, { x: 480, y: 100 }, 170),
  }));

  // Extra rotation on top of the source rotation: p2 -> 90, p3 -> 90 + 90.
  h.execute(rotatePages(['p2', 'p3'], 90));

  // The Noto files for text in other alphabets, read from node_modules (the app fetches the same files).
  const unicodeFonts = {
    load: async (family: 'sans' | 'serif' | 'mono', subset: string) => {
      const pkg = UNICODE_FAMILIES[family];
      return new Uint8Array(readFileSync(fileURLToPath(new URL(`../node_modules/${pkg}/files/${unicodeFontFile(pkg, subset)}`, import.meta.url))));
    },
  };
  const bytes = await new PdfLibWriter({ unicodeFonts }).save(h.current, defaultSaveOpts, (p) => {
    if (p.done === p.total) console.log(`${p.phase}: ${p.total} pages`);
  });

  mkdirSync('out', { recursive: true });
  writeFileSync('out/sample.pdf', bytes);
  console.log(`wrote out/sample.pdf (${bytes.byteLength} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
