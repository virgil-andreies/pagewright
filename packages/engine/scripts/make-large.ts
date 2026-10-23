// Writes a large "scanned" PDF for the M0 memory check (spec section 13).
//   pnpm make-large                      -> out/large-300mb.pdf (default 300 MB)
//   pnpm make-large --mb 50 --out out/x.pdf
//
// Each page is one uncompressed 8-bit grayscale image at A4 / 300 dpi (2480 x 3508, 8.7 MB) filled with
// noise, like a scan that cannot be compressed, plus a labelled box in vector text. The file is written by
// hand and streamed to disk, so generating it needs very little memory.
import { randomFillSync } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const targetMB = Number(arg('mb', '300'));
const out = arg('out', 'out/large-300mb.pdf');
const W = 2480;
const H = 3508;
const IMAGE_BYTES = W * H;
const pageCount = Math.max(1, Math.round((targetMB * 1024 * 1024) / IMAGE_BYTES));

// Noise block reused with a different offset per page: random enough to be incompressible and cheap to make.
const noise = Buffer.alloc(IMAGE_BYTES + 4096);
randomFillSync(noise);

mkdirSync(dirname(out), { recursive: true });
const fd = openSync(out, 'w');
let pos = 0;
const offsets: number[] = [];

function write(data: string | Uint8Array): void {
  const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  let done = 0;
  while (done < buf.length) done += writeSync(fd, buf, done, buf.length - done);
  pos += buf.length;
}

function object(num: number, body: string): void {
  offsets[num] = pos;
  write(`${num} 0 obj\n${body}\nendobj\n`);
}

// Object numbers: 1 catalog, 2 pages, 3 font, then per page i: page, content, image.
const pageObj = (i: number) => 4 + i * 3;
const contentObj = (i: number) => 5 + i * 3;
const imageObj = (i: number) => 6 + i * 3;

write('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
object(1, '<< /Type /Catalog /Pages 2 0 R >>');
object(2, `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({ length: pageCount }, (_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

for (let i = 0; i < pageCount; i++) {
  object(
    pageObj(i),
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im ${imageObj(i)} 0 R >> /Font << /F1 3 0 R >> >> /Contents ${contentObj(i)} 0 R >>`,
  );
  const content = `q 595.28 0 0 841.89 0 0 cm /Im Do Q\n1 g 40 770 300 60 re f\nBT /F1 36 Tf 0 g 50 785 Td (Scan page ${i + 1} of ${pageCount}) Tj ET`;
  object(contentObj(i), `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  offsets[imageObj(i)] = pos;
  write(`${imageObj(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${IMAGE_BYTES} >>\nstream\n`);
  write(noise.subarray((i * 997) % 4096, (i * 997) % 4096 + IMAGE_BYTES));
  write('\nendstream\nendobj\n');
  if ((i + 1) % 10 === 0 || i + 1 === pageCount) process.stdout.write(`\r${i + 1}/${pageCount} pages`);
}

const objectCount = imageObj(pageCount - 1) + 1;
const xrefAt = pos;
write(`xref\n0 ${objectCount}\n0000000000 65535 f \n`);
for (let n = 1; n < objectCount; n++) write(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
write(`trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
closeSync(fd);

console.log(`\nwrote ${out}: ${pageCount} pages, ${(pos / 1024 / 1024).toFixed(1)} MB`);
