// Builds out/sample.pdf: merged, rotated pages with highlight / underline / strikeout.
// Run from the repo root: pnpm sample
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';
import {
  History, fitFreeText, memorySource, addAnnotation, normalizeRect, addSource, emptyDocument, rectToQuad, rotatePages, setMetadata,
  type Annotation, type PageId, type Point, type Rect, type ShapeAnnot, type SourceDoc,
} from '@pagewright/core';
import { PdfLibWriter, defaultSaveOpts } from '../src';

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

  // Extra rotation on top of the source rotation: p2 -> 90, p3 -> 90 + 90.
  h.execute(rotatePages(['p2', 'p3'], 90));

  const bytes = await new PdfLibWriter().save(h.current, defaultSaveOpts, (p) => {
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
