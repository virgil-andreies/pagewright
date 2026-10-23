// Builds out/sample.pdf: merged, rotated pages with highlight / underline / strikeout.
// Run from the repo root: pnpm sample
import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';
import {
  History, addAnnotation, addSource, emptyDocument, rectToQuad, rotatePages, setMetadata,
  type Annotation, type PageId, type SourceDoc,
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
  const src: SourceDoc = { id, name: `${id}.pdf`, bytes, pageCount: titles.length, isEncrypted: false, hasDigitalSignature: false };
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

  let n = 0;
  const h = new History(emptyDocument());
  for (const s of [a.src, b.src, c.src]) h.execute(addSource(s, undefined, () => `p${++n}`));
  // p1,p2 = A; p3 = B; p4 = C
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
