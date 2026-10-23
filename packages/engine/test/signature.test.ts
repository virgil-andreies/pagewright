import { describe, expect, it } from 'vitest';
import { blobSource, memorySource } from '@pagewright/core';
import { detectSignature } from '../src';

const enc = (s: string) => new TextEncoder().encode(s);
const SIGNED = '<< /Type /Sig /Filter /Adobe.PPKLite /Contents <00ff00ff> /ByteRange [0 10 20 30] >>';

describe('detectSignature', () => {
  it.each([
    ['memory', (b: Uint8Array) => memorySource(b)],
    ['blob', (b: Uint8Array) => blobSource(new Blob([b as BlobPart]))],
  ])('works on %s sources', async (_n, make) => {
    expect(await detectSignature(make(enc('x'.repeat(500) + SIGNED + 'y'.repeat(500))))).toBe(true);
    expect(await detectSignature(make(enc('x'.repeat(1000))))).toBe(false);
  });

  it('ignores a /ByteRange that is not in a signature dictionary', async () => {
    expect(await detectSignature(memorySource(enc('<< /ByteRange [0 1 2 3] /Foo /Bar >>')))).toBe(false);
  });

  it('is not fooled by /Type /Sig text far from any /ByteRange', async () => {
    const far = '/Type /Sig' + ' '.repeat(100 * 1024) + '/ByteRange [0 1 2 3]';
    expect(await detectSignature(memorySource(enc(far)))).toBe(false);
  });

  it('finds a signature whose /Contents string is long (/ByteRange comes after it)', async () => {
    const long = '<< /Type /Sig /Contents <' + '0'.repeat(32 * 1024) + '> /ByteRange [0 1 2 3] >>';
    expect(await detectSignature(memorySource(enc(long)))).toBe(true);
  });

  it('finds the marker wherever a chunk boundary falls inside it', async () => {
    const text = 'x'.repeat(97) + SIGNED + 'y'.repeat(200);
    for (let chunk = 16; chunk < 160; chunk += 7) {
      expect(await detectSignature(memorySource(enc(text)), chunk), `chunk ${chunk}`).toBe(true);
    }
  });

  it('copes with binary noise full of slashes and near-misses', async () => {
    const noise = new Uint8Array(1 << 20).map((_, i) => ((i * 2654435761) >>> 24) & 0xff);
    noise.set(enc('/ByteRang/ByteRange'), 1000); // a near miss followed by a real needle without a signature
    expect(await detectSignature(memorySource(noise), 64 * 1024)).toBe(false);
    noise.set(enc(SIGNED), 500_000);
    expect(await detectSignature(memorySource(noise), 64 * 1024)).toBe(true);
  });
});
