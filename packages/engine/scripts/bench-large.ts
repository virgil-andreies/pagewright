// Measures the open -> edit -> save path on a big PDF, in Node (M0 memory check, spec section 13).
//   pnpm bench-large out/large-300mb.pdf
//
// Peak memory is sampled every 10 ms. Node's rss is a fair stand-in for a browser tab's footprint, but
// phones are the real target: use this to compare changes, and confirm on a device.
import { openAsBlob, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { History, addAnnotation, addSource, blobSource, deletePages, emptyDocument, rectToQuad, type SourceDoc } from '@pagewright/core';
import { PdfJsRenderer, PdfLibWriter, defaultSaveOpts, detectSignature, pdfjsVerify } from '../src';

const file = process.argv[2];
if (!file) {
  console.error('usage: pnpm bench-large <file.pdf>');
  process.exit(1);
}

const MB = 1024 * 1024;
const mem = () => {
  const m = process.memoryUsage();
  return { rss: m.rss / MB, buffers: m.arrayBuffers / MB, heap: m.heapUsed / MB };
};

interface Row { phase: string; ms: number; rssBefore: number; rssPeak: number; rssAfter: number; note: string }
const rows: Row[] = [];

async function phase<T>(name: string, fn: () => Promise<T>, note: (r: T) => string = () => ''): Promise<T> {
  global.gc?.();
  const before = mem().rss;
  let peak = before;
  const timer = setInterval(() => (peak = Math.max(peak, mem().rss)), 10);
  const t0 = performance.now();
  try {
    const result = await fn();
    const ms = performance.now() - t0;
    peak = Math.max(peak, mem().rss);
    rows.push({ phase: name, ms, rssBefore: before, rssPeak: peak, rssAfter: mem().rss, note: note(result) });
    return result;
  } finally {
    clearInterval(timer);
  }
}

const fonts = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)).replaceAll('\\', '/');
const renderer = new PdfJsRenderer({ pdfjs: pdfjs as never, standardFontDataUrl: fonts });

console.log(`file: ${file} (${(statSync(file).size / MB).toFixed(1)} MB), node ${process.version}\n`);

// What the browser gives us for a picked file: a disk-backed Blob. Nothing is read until needed.
const blob = await openAsBlob(file);
const data = blobSource(blob);
const source: SourceDoc = { id: 's', name: 'big.pdf', data, pageCount: 0, isEncrypted: false, hasDigitalSignature: false };

await phase('scan for digital signatures (chunked)', () => detectSignature(data), (signed) => (signed ? 'signed' : 'not signed'));
const rd = await phase('open with PDF.js (store: renderer.open)', () => renderer.open(source), (d) => `${d.pageCount} pages`);
await phase('first page info + text', async () => {
  await rd.getPageInfo(0);
  return (await rd.getTextContent(0)).length;
}, (n) => `${n} text runs`);

const h = new History(emptyDocument());
let n = 0;
h.execute(addSource({ ...source, pageCount: rd.pageCount }, undefined, () => `p${++n}`));
h.execute(deletePages(['p1']));
h.execute(
  addAnnotation({
    type: 'highlight', id: 'h1', pageId: 'p2', author: 'bench', createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString(),
    color: { r: 1, g: 1, b: 0, a: 1 }, opacity: 0.5, origin: 'app', quads: [rectToQuad({ x: 50, y: 780, w: 200, h: 30 })],
  }),
);


const writer = new PdfLibWriter({ memoryBudgetMB: 4096, verify: async () => true });
const saved = await phase('save (the worker): delete 1 page + 1 highlight', () => writer.save(h.current, defaultSaveOpts), (b) => `${(b.length / MB).toFixed(0)} MB out`);

await phase('verify output with PDF.js', () => pdfjsVerify(renderer)(saved, h.current.pages.length), (ok) => (ok ? 'ok' : 'FAILED'));

rd.destroy();

const pad = (s: string | number, w: number) => String(s).padStart(w);
console.log(`${'phase'.padEnd(46)} ${pad('time', 9)} ${pad('rss before', 11)} ${pad('rss peak', 9)} ${pad('rss after', 10)}  note`);
for (const r of rows) {
  console.log(
    `${r.phase.padEnd(46)} ${pad((r.ms / 1000).toFixed(2) + ' s', 9)} ${pad(r.rssBefore.toFixed(0) + ' MB', 11)} ${pad(r.rssPeak.toFixed(0) + ' MB', 9)} ${pad(r.rssAfter.toFixed(0) + ' MB', 10)}  ${r.note}`,
  );
}
console.log(`\noverall peak rss: ${Math.max(...rows.map((r) => r.rssPeak)).toFixed(0)} MB for a ${(blob.size / MB).toFixed(0)} MB file`);
