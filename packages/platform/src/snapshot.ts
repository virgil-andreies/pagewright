import type { BlobLike } from '@pagewright/core';

/**
 * Why this exists: opened files are read lazily (by byte range, from a Blob). A browser `File` is only a
 * reference to the file on disk, and reading it after the original changes fails. Saving over the file you
 * opened is the most natural thing a user does, so without a snapshot a later page render or re-save would
 * break. Copying into the browser's private, origin-scoped storage (OPFS) gives us a stable copy that lives
 * on disk, not in memory, and that nothing else can modify.
 */

// The few OPFS members we use, declared structurally: not every TS lib version ships them.
interface WritableLike { }
interface FileHandleLike {
  createWritable(): Promise<WritableStream & WritableLike>;
  getFile(): Promise<File>;
}
interface DirHandleLike {
  getDirectoryHandle(name: string, o: { create: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, o: { create: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
  entries(): AsyncIterable<[string, { kind: 'file' | 'directory'; getFile?: () => Promise<File> }]>;
}
export interface PrivateStorage {
  getDirectory(): Promise<DirHandleLike>;
}

const DIR = 'pagewright-sources';
const STALE_MS = 24 * 60 * 60 * 1000;

export interface SnapshotOptions {
  storage?: PrivateStorage;
  now?: () => number;
  /** Receives the reason when falling back to the original file. */
  onFallback?: (reason: unknown) => void;
}

/**
 * Copies `file` into private storage and returns the stable copy. Streams the data, so a 300 MB file is
 * never held in memory. If anything goes wrong (no OPFS, quota, unsupported browser) it falls back to the
 * original `file`: still lazy, just not protected against the original changing.
 */
export async function snapshotToPrivateStorage(file: File, o: SnapshotOptions = {}): Promise<BlobLike> {
  const storage = o.storage ?? (typeof navigator !== 'undefined' ? (navigator.storage as unknown as PrivateStorage) : undefined);
  const now = o.now ?? Date.now;
  let dir: DirHandleLike | undefined;
  let name: string | undefined;
  try {
    if (!storage?.getDirectory) throw new Error('private storage is not available');
    dir = await (await storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
    await removeStale(dir, now());
    name = `${now()}-${Math.random().toString(36).slice(2)}.pdf`;
    const handle = await dir.getFileHandle(name, { create: true });
    await file.stream().pipeTo(await handle.createWritable());
    return await handle.getFile();
  } catch (e) {
    o.onFallback?.(e);
    if (dir && name) await dir.removeEntry(name).catch(() => {}); // do not leave a partial copy behind
    return file;
  }
}

/** Leftovers from sessions that never cleaned up (closed tab, crash). Best effort. */
async function removeStale(dir: DirHandleLike, nowMs: number): Promise<void> {
  try {
    for await (const [entryName, entry] of dir.entries()) {
      if (entry.kind !== 'file' || !entry.getFile) continue;
      const age = nowMs - (await entry.getFile()).lastModified;
      if (age > STALE_MS) await dir.removeEntry(entryName).catch(() => {});
    }
  } catch {
    /* listing is optional */
  }
}
