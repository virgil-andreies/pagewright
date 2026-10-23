import { describe, expect, it, vi } from 'vitest';
import { snapshotToPrivateStorage, type PrivateStorage } from '../src';

/** An in-memory stand-in for OPFS: just enough of the handle API. */
function fakeStorage(opts: { failWrite?: boolean; noDirectory?: boolean } = {}) {
  const files = new Map<string, File>();
  const dir = {
    getDirectoryHandle: async () => dir,
    getFileHandle: async (name: string) => ({
      createWritable: async () => {
        if (opts.failWrite) throw new Error('quota exceeded');
        const chunks: Uint8Array[] = [];
        return new WritableStream<Uint8Array>({
          write: (c) => void chunks.push(c),
          close: () => void files.set(name, new File(chunks as BlobPart[], name, { lastModified: now })),
        });
      },
      getFile: async () => files.get(name)!,
    }),
    removeEntry: async (name: string) => void files.delete(name),
    entries: async function* () {
      for (const [name, f] of files) yield [name, { kind: 'file' as const, getFile: async () => f }] as const;
    },
  };
  const storage = (opts.noDirectory ? {} : { getDirectory: async () => dir }) as unknown as PrivateStorage;
  return { storage, files };
}

let now = 1_000_000_000_000;
const clock = () => now;

const original = (text: string) => new File([text], 'in.pdf', { lastModified: now });
const text = async (b: { arrayBuffer(): Promise<ArrayBuffer> }) => new TextDecoder().decode(await b.arrayBuffer());

describe('snapshotToPrivateStorage', () => {
  it('returns a stable copy that survives the original changing', async () => {
    const { storage, files } = fakeStorage();
    const file = original('hello pdf');
    const snap = await snapshotToPrivateStorage(file, { storage, now: clock });
    expect(snap).not.toBe(file);
    expect(snap.size).toBe(9);
    expect(await text(snap)).toBe('hello pdf');
    expect(files.size).toBe(1);
    // "Saving over the original" cannot reach the copy: it is a different file.
    expect(await text(snap)).toBe('hello pdf');
  });

  it('removes copies left behind by earlier sessions, keeps recent ones', async () => {
    const { storage, files } = fakeStorage();
    files.set('old.pdf', new File(['x'], 'old.pdf', { lastModified: now - 25 * 60 * 60 * 1000 }));
    files.set('recent.pdf', new File(['x'], 'recent.pdf', { lastModified: now - 60 * 1000 }));
    await snapshotToPrivateStorage(original('a'), { storage, now: clock });
    expect([...files.keys()]).toContain('recent.pdf');
    expect([...files.keys()]).not.toContain('old.pdf');
    expect(files.size).toBe(2);
  });

  it('falls back to the original file when private storage is unavailable', async () => {
    const file = original('x');
    const onFallback = vi.fn();
    expect(await snapshotToPrivateStorage(file, { storage: fakeStorage({ noDirectory: true }).storage, onFallback })).toBe(file);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('falls back when writing fails (e.g. quota) and leaves no partial copy', async () => {
    const { storage, files } = fakeStorage({ failWrite: true });
    const file = original('x');
    const onFallback = vi.fn();
    expect(await snapshotToPrivateStorage(file, { storage, now: clock, onFallback })).toBe(file);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ message: 'quota exceeded' }));
    expect(files.size).toBe(0);
  });

  it('works without any storage object at all', async () => {
    const file = original('x');
    expect(await snapshotToPrivateStorage(file, { storage: undefined, onFallback: () => {} })).toBeDefined();
  });
});
