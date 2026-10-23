import { describe, expect, it, vi } from 'vitest';
import { AppFailure, type PdfRenderer, type PdfWriter, type RenderDoc } from '@pagewright/engine';
import type { PickedFile, Platform } from '@pagewright/platform';
import { AppStore } from '../src/store';

function file(name: string, content = 'x'): PickedFile {
  const bytes = new TextEncoder().encode(content);
  return { name, size: bytes.length, read: async () => bytes };
}

function fakeDoc(sourceId: string, pageCount: number): RenderDoc {
  return {
    sourceId, pageCount, destroy() {}, renderPage: async () => {}, getTextContent: async () => [],
    getExistingAnnotations: async () => [],
    getPageInfo: async () => ({
      width: 100, height: 100, rotation: 0, mediaBox: { x: 0, y: 0, w: 100, h: 100 }, cropBox: { x: 0, y: 0, w: 100, h: 100 }, userUnit: 1,
    }),
  };
}

function setup(opts: { pages?: Record<string, number>; password?: string; budgetMB?: number } = {}) {
  const saved: { name: string; bytes: Uint8Array }[] = [];
  const events: string[] = [];
  const renderer: PdfRenderer = {
    open: vi.fn(async (source, password) => {
      if (opts.password && password !== opts.password) {
        throw new AppFailure(password === undefined ? { code: 'PasswordRequired', sourceId: source.id } : { code: 'WrongPassword' });
      }
      return fakeDoc(source.id, opts.pages?.[source.name] ?? 3);
    }),
  };
  const writer: PdfWriter = { save: vi.fn(async () => (events.push('write'), new Uint8Array([1, 2, 3]))) };
  const platform = {
    fs: {
      openSaveTarget: vi.fn(async (name: string) => {
        events.push(`dialog ${name}`);
        return { write: async (bytes: Uint8Array) => (saved.push({ name, bytes }), { saved: true as const, name }) };
      }),
    },
    device: { platform: 'web', memoryBudgetMB: opts.budgetMB ?? 1000 },
  } as unknown as Platform;
  let n = 0;
  const store = new AppStore({ renderer, writer, platform, newId: () => `id${++n}` });
  return { store, renderer, writer, platform, saved, events };
}

const ids = (s: AppStore) => s.getSnapshot().doc.pages.map((p) => p.id);
const sel = (s: AppStore) => [...s.getSnapshot().ui.selection];

describe('AppStore: opening', () => {
  it('adds a file as pages and keeps the render doc', async () => {
    const { store } = setup();
    await store.addFiles([file('a.pdf')]);
    expect(store.getSnapshot().doc.pages).toHaveLength(3);
    const src = Object.values(store.getSnapshot().doc.sources)[0]!;
    expect(store.getRenderDoc(src.id)?.pageCount).toBe(3);
    expect(store.getSnapshot().ui.busy).toBeUndefined();
  });

  it('merges multiple files in order', async () => {
    const { store } = setup({ pages: { 'a.pdf': 2, 'b.pdf': 1 } });
    await store.addFiles([file('a.pdf'), file('b.pdf')]);
    expect(store.getSnapshot().doc.pages).toHaveLength(3);
  });

  it('reports corrupt files without changing the document', async () => {
    const { store, renderer } = setup();
    vi.mocked(renderer.open).mockRejectedValueOnce(new AppFailure({ code: 'CorruptFile', detail: 'bad' }));
    await store.addFiles([file('bad.pdf')]);
    expect(store.getSnapshot().ui.error).toEqual({ code: 'CorruptFile', detail: 'bad' });
    expect(store.getSnapshot().doc.pages).toHaveLength(0);
  });

  it('asks for a password, retries on a wrong one, then opens as encrypted with a notice', async () => {
    const { store } = setup({ password: 'secret' });
    const done = store.addFiles([file('locked.pdf')]);
    await vi.waitFor(() => expect(store.getSnapshot().ui.passwordPrompt).toEqual({ fileName: 'locked.pdf', wrong: false }));
    store.submitPassword('nope');
    await vi.waitFor(() => expect(store.getSnapshot().ui.passwordPrompt).toEqual({ fileName: 'locked.pdf', wrong: true }));
    store.submitPassword('secret');
    await done;
    expect(store.getSnapshot().doc.pages).toHaveLength(3);
    expect(Object.values(store.getSnapshot().doc.sources)[0]!.isEncrypted).toBe(true);
    expect(store.getSnapshot().ui.notices[0]).toMatch(/encrypted/);
  });

  it('cancelling the password prompt adds nothing', async () => {
    const { store } = setup({ password: 'secret' });
    const done = store.addFiles([file('locked.pdf')]);
    await vi.waitFor(() => expect(store.getSnapshot().ui.passwordPrompt).toBeDefined());
    store.cancelPassword();
    await done;
    expect(store.getSnapshot().doc.pages).toHaveLength(0);
    expect(store.getSnapshot().ui.busy).toBeUndefined();
  });
});

describe('AppStore: blob-backed files', () => {
  it('keeps the disk-backed blob instead of reading the file into memory', async () => {
    const { store, renderer } = setup();
    const read = vi.fn(async () => new Uint8Array([1]));
    const blob = new Blob([new Uint8Array(100)]);
    await store.addFiles([{ name: 'big.pdf', size: 100, read, blob }]);
    const src = Object.values(store.getSnapshot().doc.sources)[0]!;
    expect(src.data).toEqual({ kind: 'blob', blob });
    expect(read).not.toHaveBeenCalled();
    expect(vi.mocked(renderer.open).mock.calls[0]![0].data.kind).toBe('blob');
  });

  it('prefers the private snapshot over the original blob', async () => {
    const { store } = setup();
    const original = new Blob([new Uint8Array(10)]);
    const copy = new Blob([new Uint8Array(10)]);
    const snapshot = vi.fn(async () => copy);
    await store.addFiles([{ name: 'a.pdf', size: 10, read: async () => new Uint8Array(), blob: original, snapshot }]);
    expect(snapshot).toHaveBeenCalledOnce();
    const data = Object.values(store.getSnapshot().doc.sources)[0]!.data;
    expect(data.kind === 'blob' && data.blob).toBe(copy);
  });

  it('falls back to reading bytes when the platform has no blob', async () => {
    const { store } = setup();
    await store.addFiles([file('a.pdf')]);
    expect(Object.values(store.getSnapshot().doc.sources)[0]!.data.kind).toBe('memory');
  });

  it('detects a signature inside a blob-backed file', async () => {
    const { store } = setup();
    const blob = new Blob(['/Type /Sig /ByteRange [0 1 2 3]']);
    await store.addFiles([{ name: 's.pdf', size: blob.size, read: async () => new Uint8Array(), blob }]);
    expect(Object.values(store.getSnapshot().doc.sources)[0]!.hasDigitalSignature).toBe(true);
  });
});

describe('AppStore: memory guard', () => {
  /** A blob that only claims a size: nothing is allocated, and every read returns nothing. */
  const hugeFile = (name: string, mb: number): PickedFile => {
    const blob = { size: mb * 1024 * 1024, slice: () => blob, arrayBuffer: async () => new ArrayBuffer(0) };
    return { name, size: blob.size, read: async () => new Uint8Array(), blob };
  };

  it('opens a document that is too big to save, warns straight away, and refuses to save it', async () => {
    const { store, writer } = setup({ budgetMB: 450 }); // allows 100 MB of sources
    await store.addFiles([hugeFile('big.pdf', 150)]);
    expect(store.getSnapshot().doc.pages).toHaveLength(3); // still viewable
    const warning = store.getSnapshot().ui.notices.find((n) => /too large to save/.test(n));
    expect(warning).toMatch(/up to 100 MB/);
    expect(await store.save()).toBe(false);
    expect(store.getSnapshot().ui.error).toMatchObject({ code: 'OutOfMemoryRisk', budgetMB: 450 });
    expect(writer.save).not.toHaveBeenCalled();
  });

  it('does not warn about documents that fit', async () => {
    const { store } = setup({ budgetMB: 450 });
    await store.addFiles([hugeFile('ok.pdf', 90)]);
    expect(store.getSnapshot().ui.notices).toEqual([]);
    expect(await store.save()).toBe(true);
  });

  it('warns when merging pushes the total over the limit', async () => {
    const { store } = setup({ budgetMB: 450 });
    await store.addFiles([hugeFile('a.pdf', 60)]);
    expect(store.getSnapshot().ui.notices.some((n) => /too large to save/.test(n))).toBe(false);
    await store.addFiles([hugeFile('b.pdf', 60)]);
    expect(store.getSnapshot().ui.notices.some((n) => /too large to save/.test(n))).toBe(true);
  });

  it('allows saving again once the big source is removed from the document', async () => {
    const { store } = setup({ budgetMB: 450, pages: { 'small.pdf': 1, 'big.pdf': 1 } });
    await store.addFiles([file('small.pdf'), hugeFile('big.pdf', 150)]);
    expect(await store.save()).toBe(false);
    const bigPage = store.getSnapshot().doc.pages[1]!.id;
    store.deletePages([bigPage]);
    expect(await store.save()).toBe(true);
  });
});

describe('AppStore: page operations and selection', () => {
  async function three() {
    const t = setup();
    await t.store.addFiles([file('a.pdf')]);
    return t;
  }

  it('selects with replace / toggle / range', async () => {
    const { store } = await three();
    const [a, b, c] = ids(store) as [string, string, string];
    store.selectPage(a);
    expect(sel(store)).toEqual([a]);
    store.selectPage(c, 'toggle');
    expect(sel(store).sort()).toEqual([a, c].sort());
    store.selectPage(b);
    store.selectPage(c, 'range');
    expect(sel(store).sort()).toEqual([b, c].sort());
    store.selectAll();
    expect(sel(store)).toHaveLength(3);
    store.clearSelection();
    expect(sel(store)).toEqual([]);
  });

  it('operates on the selection, with undo/redo and labels', async () => {
    const { store } = await three();
    const [a, b] = ids(store) as [string, string, string];
    store.selectPage(b);
    store.rotatePages(90);
    expect(store.getSnapshot().doc.pages[1]!.rotation).toBe(90);
    expect(store.getSnapshot().undoLabel).toBe('Rotate pages');
    store.undo();
    expect(store.getSnapshot().doc.pages[1]!.rotation).toBe(0);
    expect(store.getSnapshot().canRedo).toBe(true);
    store.redo();
    store.movePages(0);
    expect(ids(store)[0]).toBe(b);
    store.selectPage(a);
    store.duplicatePages();
    expect(ids(store)).toHaveLength(4);
  });

  it('prunes deleted pages from the selection and clamps the current page', async () => {
    const { store } = await three();
    const all = ids(store);
    store.selectPage(all[2]!);
    expect(store.getSnapshot().ui.currentPage).toBe(2);
    store.deletePages();
    expect(sel(store)).toEqual([]);
    expect(store.getSnapshot().doc.pages).toHaveLength(2);
    expect(store.getSnapshot().ui.currentPage).toBe(1);
  });

  it('clamps zoom', () => {
    const { store } = setup();
    store.setZoom(99);
    expect(store.getSnapshot().ui.zoom).toBe(4);
    store.setZoom(0);
    expect(store.getSnapshot().ui.zoom).toBe(0.25);
  });

  it('notifies subscribers and returns a new snapshot only on change', async () => {
    const { store } = await three();
    const fn = vi.fn();
    const off = store.subscribe(fn);
    const before = store.getSnapshot();
    expect(store.getSnapshot()).toBe(before);
    store.setTool('highlight');
    expect(fn).toHaveBeenCalled();
    expect(store.getSnapshot()).not.toBe(before);
    off();
  });
});

describe('AppStore: saving', () => {
  it('saves through the writer and platform, then marks the document clean', async () => {
    const { store, writer, saved } = setup();
    await store.addFiles([file('report.pdf')]);
    expect(store.getSnapshot().doc.dirty).toBe(true);
    expect(await store.save()).toBe(true);
    expect(writer.save).toHaveBeenCalledOnce();
    expect(saved[0]!.name).toBe('report-edited.pdf');
    expect(store.getSnapshot().doc.dirty).toBe(false);
  });

  it('tells the user when the browser refused a direct write and the file was downloaded instead', async () => {
    const { store, platform } = setup();
    await store.addFiles([file('a.pdf')]);
    vi.mocked(platform.fs.openSaveTarget).mockResolvedValueOnce({
      write: async () => ({ saved: true, name: 'a-edited.pdf', viaDownload: true }),
    });
    expect(await store.save()).toBe(true);
    expect(store.getSnapshot().doc.dirty).toBe(false);
    expect(store.getSnapshot().ui.notices.some((n) => /downloads folder/.test(n))).toBe(true);
  });

  it('opens the save dialog before doing the slow work', async () => {
    const { store, events } = setup();
    await store.addFiles([file('a.pdf')]);
    await store.save();
    expect(events).toEqual(['dialog a-edited.pdf', 'write']);
  });

  it('does nothing when the user cancels the save dialog', async () => {
    const { store, platform, writer } = setup();
    await store.addFiles([file('a.pdf')]);
    vi.mocked(platform.fs.openSaveTarget).mockResolvedValueOnce(undefined);
    expect(await store.save()).toBe(false);
    expect(writer.save).not.toHaveBeenCalled();
    expect(store.getSnapshot().doc.dirty).toBe(true);
    expect(store.getSnapshot().ui.error).toBeUndefined();
  });

  it('cancelling a running save is not an error and leaves the document dirty', async () => {
    const { store, writer } = setup();
    await store.addFiles([file('a.pdf')]);
    vi.mocked(writer.save).mockImplementationOnce(
      (_d, _o, _p, signal) =>
        new Promise((_, reject) => signal!.addEventListener('abort', () => reject(Object.assign(new Error('Save cancelled'), { name: 'AbortError' })))),
    );
    const p = store.save();
    await vi.waitFor(() => expect(store.getSnapshot().ui.busy).toBe('Saving'));
    store.cancelSave();
    expect(await p).toBe(false);
    const ui = store.getSnapshot().ui;
    expect(ui.error).toBeUndefined();
    expect(ui.busy).toBeUndefined();
    expect(store.getSnapshot().doc.dirty).toBe(true);
    expect(await store.save()).toBe(true); // usable again afterwards
  });

  it('ignores a second save while one is running', async () => {
    const { store, writer } = setup();
    await store.addFiles([file('a.pdf')]);
    let release!: () => void;
    vi.mocked(writer.save).mockImplementationOnce(() => new Promise((r) => (release = () => r(new Uint8Array([1])))));
    const first = store.save();
    await vi.waitFor(() => expect(store.getSnapshot().ui.busy).toBe('Saving'));
    expect(await store.save()).toBe(false);
    release();
    expect(await first).toBe(true);
  });

  it('blocks saving an encrypted source', async () => {
    const { store, writer } = setup({ password: 'p' });
    const done = store.addFiles([file('locked.pdf')]);
    await vi.waitFor(() => expect(store.getSnapshot().ui.passwordPrompt).toBeDefined());
    store.submitPassword('p');
    await done;
    expect(await store.save()).toBe(false);
    expect(store.getSnapshot().ui.error).toEqual({ code: 'EncryptedNotSupported' });
    expect(writer.save).not.toHaveBeenCalled();
  });

  it('asks for confirmation before saving a signed document', async () => {
    const { store, writer } = setup();
    await store.addFiles([file('signed.pdf', '/Type /Sig /ByteRange [0 10 20 30]')]);
    expect(await store.save()).toBe(false);
    expect(store.getSnapshot().ui.saveWarning).toEqual({ code: 'SignedDocumentWarning' });
    expect(writer.save).not.toHaveBeenCalled();
    expect(await store.save(true)).toBe(true);
    expect(store.getSnapshot().ui.notices.some((n) => /signatures/i.test(n))).toBe(true);
  });

  it('shows each notice once per session', async () => {
    const { store } = setup({ pages: { 'a.pdf': 1, 'b.pdf': 1 } });
    await store.addFiles([file('a.pdf'), file('b.pdf')]);
    await store.save();
    await store.save();
    expect(store.getSnapshot().ui.notices.filter((n) => /Bookmarks/.test(n))).toHaveLength(1);
  });

  it('surfaces writer failures as errors', async () => {
    const { store, writer } = setup();
    await store.addFiles([file('a.pdf')]);
    vi.mocked(writer.save).mockRejectedValueOnce(new AppFailure({ code: 'SaveVerificationFailed' }));
    expect(await store.save()).toBe(false);
    expect(store.getSnapshot().ui.error).toEqual({ code: 'SaveVerificationFailed' });
    expect(store.getSnapshot().ui.busy).toBeUndefined();
  });

  it('extracts the selection to a new file', async () => {
    const { store, writer, saved } = setup();
    await store.addFiles([file('a.pdf')]);
    store.selectPage(ids(store)[1]!);
    expect(await store.extract()).toBe(true);
    const sub = vi.mocked(writer.save).mock.calls[0]![0];
    expect(sub.pages).toHaveLength(1);
    expect(saved[0]!.name).toBe('extract.pdf');
  });
});
