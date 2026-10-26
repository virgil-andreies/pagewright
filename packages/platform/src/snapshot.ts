import type { BlobLike } from '@pagewright/core';

/**
 * Why this exists: opened files are read lazily (by byte range, from a Blob). A browser `File` is only a
 * reference to the file on disk, and reading it after the original changes fails. Saving over the file you
 * opened is the most natural thing a user does, so without a snapshot a later page render or re-save would
 * break. Copying into the browser's private, origin-scoped storage (OPFS) gives us a stable copy that lives
 * on disk, not in memory, and that nothing else can modify.
 *
 * The copies are private but they are copies of people's documents, so they must not outlive their use. A copy
 * is needed for as long as the tab that opened it is open (undo can bring back pages that read from it), so each
 * tab keeps its copies in a folder of its own and holds a Web Lock named after that folder while it is open. The
 * browser releases the lock when the tab closes or crashes; any folder whose lock is no longer held is deleted
 * the next time the app starts (`cleanUpPrivateCopies`). `deleteAllPrivateCopies` removes everything at once.
 */

// The few OPFS members we use, declared structurally: not every TS lib version ships them.
interface WritableLike { }
interface FileHandleLike {
  createWritable(): Promise<WritableStream & WritableLike>;
  getFile(): Promise<File>;
}
export interface DirHandleLike {
  getDirectoryHandle(name: string, o: { create: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, o: { create: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, o?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, { kind: 'file' | 'directory' }]>;
}
export interface PrivateStorage {
  getDirectory(): Promise<DirHandleLike>;
}
/** The Web Locks API (navigator.locks), as far as we use it. */
export interface LocksLike {
  request(name: string, options: { mode: 'exclusive' }, callback: () => Promise<void>): Promise<unknown>;
  query(): Promise<{ held?: { name?: string }[] }>;
}

const DIR = 'pagewright-sources';
const LOCK_PREFIX = 'pagewright-session-';
/** Without Web Locks, a session folder is taken to be left over once it is this old. */
const STALE_MS = 24 * 60 * 60 * 1000;

/** One tab's claim on its folder of copies. */
export interface PrivateSession {
  /** Starts with the time it was created, so a folder's age can be told without the lock API. */
  readonly id: string;
  /** Settles once the tab holds the lock on its folder (at once where there is no lock API). */
  held?: Promise<void>;
}

export interface SnapshotOptions {
  storage?: PrivateStorage;
  /** The lock API; `null` for none (as in browsers without it). Defaults to `navigator.locks`. */
  locks?: LocksLike | null;
  now?: () => number;
  /** This tab's session; one per page load by default. */
  session?: PrivateSession;
  /** Receives the reason when falling back to the original file. */
  onFallback?: (reason: unknown) => void;
}

let thisTab: PrivateSession | undefined;

function resolveOptions(o: SnapshotOptions) {
  const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { storage?: PrivateStorage; locks?: LocksLike }) : undefined;
  const now = o.now ?? Date.now;
  const session = o.session ?? (thisTab ??= { id: `${now()}-${Math.random().toString(36).slice(2, 10)}` });
  return { storage: o.storage ?? nav?.storage, locks: o.locks === null ? undefined : (o.locks ?? nav?.locks), now, session };
}

/** Takes the lock on this tab's folder and keeps it until the tab goes away. */
function hold(session: PrivateSession, locks: LocksLike | undefined): Promise<void> {
  session.held ??= new Promise<void>((resolve) => {
    if (!locks) return resolve();
    locks
      .request(LOCK_PREFIX + session.id, { mode: 'exclusive' }, () => {
        resolve();
        return new Promise<void>(() => {}); // never settles: the lock is held for as long as the tab lives
      })
      .catch(() => resolve());
  });
  return session.held;
}

async function rootDir(storage: PrivateStorage | undefined): Promise<DirHandleLike> {
  if (!storage?.getDirectory) throw new Error('private storage is not available');
  return (await storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
}

/**
 * Copies `file` into this tab's private folder and returns the stable copy. Streams the data, so a 300 MB file is
 * never held in memory. If anything goes wrong (no OPFS, quota, unsupported browser) it falls back to the
 * original `file`: still lazy, just not protected against the original changing.
 */
export async function snapshotToPrivateStorage(file: File, o: SnapshotOptions = {}): Promise<BlobLike> {
  const { storage, locks, now, session } = resolveOptions(o);
  let dir: DirHandleLike | undefined;
  let name: string | undefined;
  try {
    const root = await rootDir(storage);
    // The lock comes first, so another tab cleaning up never sees this folder without it.
    await hold(session, locks);
    dir = await root.getDirectoryHandle(session.id, { create: true });
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

/**
 * Deletes the copies no open tab needs any more: folders whose tab has closed (its lock is gone), and loose files
 * from versions that kept no folders. Call when the app starts. Without the lock API, a folder counts as left over
 * after a day. Best effort: it never throws.
 */
export async function cleanUpPrivateCopies(o: SnapshotOptions = {}): Promise<void> {
  const { storage, locks, now, session } = resolveOptions(o);
  try {
    const root = await rootDir(storage);
    const held = locks ? new Set(((await locks.query()).held ?? []).map((l) => l.name)) : undefined;
    for await (const [name, entry] of root.entries()) {
      if (name === session.id) continue;
      const leftOver =
        entry.kind === 'file' ||
        (held ? !held.has(LOCK_PREFIX + name) : now() - Number(name.split('-')[0]) > STALE_MS || !Number.isFinite(Number(name.split('-')[0])));
      if (leftOver) await root.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch {
    /* no private storage: nothing to clean */
  }
}

/** Deletes every copy, this tab's included: for "delete everything stored on this device", before a restart. */
export async function deleteAllPrivateCopies(o: SnapshotOptions = {}): Promise<void> {
  const { storage } = resolveOptions(o);
  if (!storage?.getDirectory) return;
  try {
    await (await storage.getDirectory()).removeEntry(DIR, { recursive: true });
  } catch {
    /* nothing there */
  }
}
