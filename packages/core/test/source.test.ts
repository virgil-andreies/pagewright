import { describe, expect, it } from 'vitest';
import { blobSource, memorySource, preflight, readAll, readRange, sourceSize, type BlobLike, History, addSource, emptyDocument } from '../src';

// core has no DOM types; Node and browsers both provide a global Blob.
const Blob = (globalThis as unknown as { Blob: new (parts: Uint8Array[]) => BlobLike }).Blob;

const bytes = Uint8Array.from({ length: 100 }, (_, i) => i);

describe.each([
  ['memory', () => memorySource(bytes)],
  ['blob', () => blobSource(new Blob([bytes]))],
] as const)('%s source', (_name, make) => {
  it('reports its size', () => {
    expect(sourceSize(make())).toBe(100);
  });

  it('reads everything', async () => {
    expect([...(await readAll(make()))]).toEqual([...bytes]);
  });

  it('reads a range as a standalone copy', async () => {
    const r = await readRange(make(), 10, 14);
    expect([...r]).toEqual([10, 11, 12, 13]);
    expect(r.byteOffset).toBe(0);
    expect(r.buffer.byteLength).toBe(4); // structured clone would copy the whole backing buffer otherwise
  });

  it('clamps out-of-range requests', async () => {
    expect((await readRange(make(), 95, 500)).length).toBe(5);
    expect((await readRange(make(), 200, 300)).length).toBe(0);
    expect((await readRange(make(), -5, 3)).length).toBe(3);
  });
});

it('readAll on a memory source does not copy', async () => {
  expect(await readAll(memorySource(bytes))).toBe(bytes);
});

it('preflight counts blob-backed sources by size', () => {
  const h = new History(emptyDocument());
  h.execute(
    addSource(
      { id: 'a', name: 'a.pdf', data: blobSource(new Blob([new Uint8Array(3 * 1024 * 1024)])), pageCount: 1, isEncrypted: false, hasDigitalSignature: false },
      undefined,
      () => 'p1',
    ),
  );
  expect(preflight(h.current, { memoryBudgetMB: 1 }).errors).toEqual([{ code: 'OutOfMemoryRisk', estimateMB: 14, budgetMB: 1 }]);
});
