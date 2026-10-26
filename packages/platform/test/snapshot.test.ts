import { describe, expect, it, vi } from 'vitest';
import {
  cleanUpPrivateCopies, deleteAllPrivateCopies, snapshotToPrivateStorage, type DirHandleLike, type LocksLike, type PrivateSession, type PrivateStorage,
} from '../src';

type Node = { kind: 'file'; file: File } | { kind: 'directory'; entries: Map<string, Node> };

/** An in-memory stand-in for OPFS: folders and files, just enough of the handle API. */
function fakeStorage(opts: { failWrite?: boolean; noDirectory?: boolean } = {}) {
  const top: Node = { kind: 'directory', entries: new Map() };
  const handle = (node: Extract<Node, { kind: 'directory' }>): DirHandleLike => ({
    getDirectoryHandle: async (name, o) => {
      let child = node.entries.get(name);
      if (!child) {
        if (!o.create) throw new Error(`no folder ${name}`);
        node.entries.set(name, (child = { kind: 'directory', entries: new Map() }));
      }
      if (child.kind !== 'directory') throw new Error(`${name} is a file`);
      return handle(child);
    },
    getFileHandle: async (name) => ({
      createWritable: async () => {
        if (opts.failWrite) throw new Error('quota exceeded');
        const chunks: Uint8Array[] = [];
        return new WritableStream<Uint8Array>({
          write: (c) => void chunks.push(c),
          close: () => void node.entries.set(name, { kind: 'file', file: new File(chunks as BlobPart[], name) }),
        });
      },
      getFile: async () => (node.entries.get(name) as Extract<Node, { kind: 'file' }>).file,
    }),
    removeEntry: async (name, o) => {
      const child = node.entries.get(name);
      if (child?.kind === 'directory' && child.entries.size > 0 && !o?.recursive) throw new Error('folder not empty');
      node.entries.delete(name);
    },
    entries: async function* () {
      for (const [name, child] of node.entries) yield [name, { kind: child.kind }] as [string, { kind: 'file' | 'directory' }];
    },
  });
  const storage = (opts.noDirectory ? {} : { getDirectory: async () => handle(top as Extract<Node, { kind: 'directory' }>) }) as unknown as PrivateStorage;
  const root = () => (top as Extract<Node, { kind: 'directory' }>).entries.get('pagewright-sources') as Extract<Node, { kind: 'directory' }> | undefined;
  /** What is in the app's folder: session folders with their files, and loose files. */
  const contents = () => [...(root()?.entries ?? [])].map(([name, n]) => (n.kind === 'directory' ? `${name}/ (${n.entries.size})` : name));
  return { storage, root, contents };
}

/** A stand-in for navigator.locks: a lock is held until its callback's promise settles (here: never). */
function fakeLocks() {
  const held = new Set<string>();
  const order: string[] = [];
  const locks: LocksLike = {
    request: async (name, _o, cb) => {
      held.add(name);
      order.push(`lock ${name}`);
      return cb();
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) }),
  };
  /** A tab closing: the browser lets go of its lock. */
  const release = (name: string) => held.delete(name);
  return { locks, held, order, release };
}

let now = 1_000_000_000_000;
const clock = () => now;
const session = (id: string): PrivateSession => ({ id });

const original = (text: string) => new File([text], 'in.pdf');
const text = async (b: { arrayBuffer(): Promise<ArrayBuffer> }) => new TextDecoder().decode(await b.arrayBuffer());

describe('snapshotToPrivateStorage', () => {
  it('returns a stable copy, kept in this tab’s own folder', async () => {
    const { storage, contents } = fakeStorage();
    const { locks } = fakeLocks();
    const file = original('hello pdf');
    const snap = await snapshotToPrivateStorage(file, { storage, locks, now: clock, session: session(`${now}-a`) });
    expect(snap).not.toBe(file);
    expect(await text(snap)).toBe('hello pdf');
    expect(contents()).toEqual([`${now}-a/ (1)`]);
  });

  it('holds the lock on its folder before the folder exists, so no other tab can clean it up in between', async () => {
    const { storage, root } = fakeStorage();
    const { locks, order } = fakeLocks();
    const tab = session(`${now}-a`);
    const request = locks.request;
    locks.request = async (name, o, cb) => {
      order.push(`folder existed: ${!!root()?.entries.has(tab.id)}`);
      return request(name, o, cb);
    };
    await snapshotToPrivateStorage(original('x'), { storage, locks, now: clock, session: tab });
    await snapshotToPrivateStorage(original('y'), { storage, locks, now: clock, session: tab });
    expect(order).toEqual(['folder existed: false', `lock pagewright-session-${tab.id}`]); // and only once
  });

  it('falls back to the original file when private storage is unavailable', async () => {
    const file = original('x');
    const onFallback = vi.fn();
    expect(await snapshotToPrivateStorage(file, { storage: fakeStorage({ noDirectory: true }).storage, session: session('s'), onFallback })).toBe(file);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('falls back when writing fails (e.g. quota) and leaves no partial copy', async () => {
    const { storage, contents } = fakeStorage({ failWrite: true });
    const file = original('x');
    const onFallback = vi.fn();
    expect(await snapshotToPrivateStorage(file, { storage, now: clock, session: session(`${now}-a`), onFallback })).toBe(file);
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ message: 'quota exceeded' }));
    expect(contents()).toEqual([`${now}-a/ (0)`]);
  });

  it('works without any storage object at all', async () => {
    const file = original('x');
    expect(await snapshotToPrivateStorage(file, { storage: undefined, session: session('s'), onFallback: () => {} })).toBeDefined();
  });
});

describe('cleanUpPrivateCopies', () => {
  it('deletes the copies of tabs that have closed, at any age, and keeps those of open tabs', async () => {
    const { storage, contents } = fakeStorage();
    const { locks, release } = fakeLocks();
    const closed = session(`${now - 60_000}-closed`);
    const open = session(`${now - 60_000}-open`);
    const mine = session(`${now}-mine`);
    for (const tab of [closed, open, mine]) await snapshotToPrivateStorage(original('x'), { storage, locks, now: clock, session: tab });
    release(`pagewright-session-${closed.id}`); // that tab was closed a minute after opening the file
    await cleanUpPrivateCopies({ storage, locks, now: clock, session: mine });
    expect(contents().sort()).toEqual([`${mine.id}/ (1)`, `${open.id}/ (1)`].sort());
  });

  it('deletes loose copies left by older versions, which kept no folders', async () => {
    const { storage, root, contents } = fakeStorage();
    const { locks } = fakeLocks();
    await snapshotToPrivateStorage(original('x'), { storage, locks, now: clock, session: session(`${now}-mine`) });
    root()!.entries.set('1699999999999-old.pdf', { kind: 'file', file: new File(['x'], 'old.pdf') });
    await cleanUpPrivateCopies({ storage, locks, now: clock, session: session(`${now}-mine`) });
    expect(contents()).toEqual([`${now}-mine/ (1)`]);
  });

  it('without the lock API, deletes folders older than a day', async () => {
    const { storage, contents } = fakeStorage();
    const old = session(`${now - 25 * 3600_000}-old`);
    const recent = session(`${now - 3600_000}-recent`);
    for (const tab of [old, recent]) await snapshotToPrivateStorage(original('x'), { storage, locks: null, now: clock, session: tab });
    await cleanUpPrivateCopies({ storage, locks: null, now: clock, session: session(`${now}-mine`) });
    expect(contents()).toEqual([`${recent.id}/ (1)`]);
  });

  it('never throws, even with no private storage', async () => {
    await expect(cleanUpPrivateCopies({ storage: undefined, session: session('s') })).resolves.toBeUndefined();
  });
});

describe('deleteAllPrivateCopies', () => {
  it('removes every copy, this tab’s included', async () => {
    const { storage, root } = fakeStorage();
    const { locks } = fakeLocks();
    for (const id of ['a', 'b']) await snapshotToPrivateStorage(original('x'), { storage, locks, now: clock, session: session(`${now}-${id}`) });
    await deleteAllPrivateCopies({ storage, session: session(`${now}-a`) });
    expect(root()).toBeUndefined();
  });
});
