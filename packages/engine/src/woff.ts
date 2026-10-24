/**
 * WOFF 1.0 to plain TrueType/OpenType (sfnt). WOFF is an sfnt whose tables are compressed one by one with zlib.
 * fontkit reads WOFF but cannot subset it, and pdf-lib subsets every font it embeds, so the files are unpacked
 * first. Inflating uses the platform's DecompressionStream (browsers, workers and Node 18+).
 */
export async function woffToSfnt(woff: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (woff.length < 44 || view.getUint32(0) !== 0x774f4646) return woff; // not 'wOFF': already an sfnt (or not a font at all)
  const flavor = view.getUint32(4);
  const numTables = view.getUint16(12);

  const tables: { tag: number; checksum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const at = 44 + i * 20;
    const tag = view.getUint32(at);
    const offset = view.getUint32(at + 4);
    const compLength = view.getUint32(at + 8);
    const origLength = view.getUint32(at + 12);
    const checksum = view.getUint32(at + 16);
    if (offset + compLength > woff.length) throw new Error('damaged font file');
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? await inflate(raw) : raw;
    if (data.length !== origLength) throw new Error('damaged font file');
    tables.push({ tag, checksum, data });
  }

  // The sfnt header, then a 16-byte record per table, then the tables, each padded to 4 bytes.
  const headerSize = 12 + 16 * numTables;
  const size = tables.reduce((n, t) => n + ((t.data.length + 3) & ~3), headerSize);
  const out = new Uint8Array(size);
  const o = new DataView(out.buffer);
  const log2 = Math.floor(Math.log2(numTables));
  o.setUint32(0, flavor);
  o.setUint16(4, numTables);
  o.setUint16(6, 16 * 2 ** log2);
  o.setUint16(8, log2);
  o.setUint16(10, numTables * 16 - 16 * 2 ** log2);
  let offset = headerSize;
  tables.forEach((t, i) => {
    const rec = 12 + i * 16;
    o.setUint32(rec, t.tag);
    o.setUint32(rec + 4, t.checksum);
    o.setUint32(rec + 8, offset);
    o.setUint32(rec + 12, t.data.length);
    out.set(t.data, offset);
    offset += (t.data.length + 3) & ~3;
  });
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
