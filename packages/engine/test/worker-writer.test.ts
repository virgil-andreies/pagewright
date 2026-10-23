import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import {
  History, memorySource, blobSource, readAll, sourceSize, addAnnotation, addSource, emptyDocument, rectToQuad, rotatePages,
  type HighlightAnnot, type SourceDoc, type WorkingDocument,
} from '@pagewright/core';
import {
  AppFailure, SaveCancelled, WorkerPdfWriter, defaultSaveOpts, handleSaveRequest,
  type SaveMessage, type SaveRequest, type WorkerLike,
} from '../src';

/**
 * An in-process "worker". Messages go through structuredClone with transfer in both directions, so anything
 * that would not survive a real worker boundary (class instances, functions, shared buffers) fails here too.
 */
class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  terminated = false;
  received?: SaveRequest;
  constructor(private readonly delayMs = 0) {}

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    const req = structuredClone(message, { transfer }) as SaveRequest;
    this.received = req;
    setTimeout(() => {
      if (this.terminated) return;
      void handleSaveRequest(req, (m: SaveMessage, t: Transferable[] = []) => {
        if (this.terminated) return;
        const cloned = structuredClone(m, { transfer: t });
        queueMicrotask(() => this.onmessage?.({ data: cloned }));
      });
    }, this.delayMs);
  }

  terminate(): void {
    this.terminated = true;
  }
}

async function source(id: string, pages: number): Promise<SourceDoc> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([200, 300]);
  return { id, name: `${id}.pdf`, data: memorySource(await pdf.save()), pageCount: pages, isEncrypted: false, hasDigitalSignature: false };
}

async function build(...sources: SourceDoc[]): Promise<WorkingDocument> {
  const h = new History(emptyDocument());
  let n = 0;
  sources.forEach((s) => h.execute(addSource(s, undefined, () => `p${++n}`)));
  return h.current;
}

const highlight = (pageId: string): HighlightAnnot => ({
  type: 'highlight', id: 'a1', pageId, author: 'me', createdAt: '2026-01-01T00:00:00Z', modifiedAt: '2026-01-01T00:00:00Z',
  color: { r: 1, g: 1, b: 0, a: 1 }, opacity: 0.5, origin: 'app', quads: [rectToQuad({ x: 10, y: 10, w: 50, h: 10 })],
});

const make = (o: Partial<ConstructorParameters<typeof WorkerPdfWriter>[0]> = {}, delayMs = 0) => {
  const workers: FakeWorker[] = [];
  const writer = new WorkerPdfWriter({
    createWorker: () => {
      const w = new FakeWorker(delayMs);
      workers.push(w);
      return w;
    },
    memoryBudgetMB: 1000,
    ...o,
  });
  return { writer, workers };
};

describe('WorkerPdfWriter', () => {
  it('produces the same document as the in-process writer, via a clone-safe protocol', async () => {
    const h = new History(emptyDocument());
    h.execute(addSource(await source('a', 2), undefined, (() => { let n = 0; return () => `p${++n}`; })()));
    h.execute(rotatePages(['p1'], 90));
    h.execute(addAnnotation(highlight('p2')));
    const { writer } = make();
    const bytes = await writer.save(h.current, defaultSaveOpts);
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(2);
    expect(out.getPage(0).getRotation().angle).toBe(90);
  });

  it('forwards progress from the worker', async () => {
    const { writer } = make();
    const phases = new Set<string>();
    await writer.save(await build(await source('a', 2)), defaultSaveOpts, (p) => phases.add(p.phase));
    expect([...phases]).toEqual(['copy', 'annotate', 'serialize']);
  });

  it('leaves the callers source bytes intact and sends the worker its own copy', async () => {
    const src = await source('a', 1);
    const before = (await readAll(src.data)).slice();
    const { writer, workers } = make();
    await writer.save(await build(src), defaultSaveOpts);
    expect(sourceSize(src.data)).toBeGreaterThan(0); // not detached by the transfer
    expect(await readAll(src.data)).toEqual(before);
    expect(await readAll(workers[0]!.received!.doc.sources['a']!.data)).toEqual(before);
  });

  it('passes blob-backed sources by reference instead of copying their bytes', async () => {
    const mem = await source('a', 2);
    const src: SourceDoc = { ...mem, data: blobSource(new Blob([(await readAll(mem.data)) as BlobPart])) };
    const { writer, workers } = make();
    const bytes = await writer.save(await build(src), defaultSaveOpts);
    expect(workers[0]!.received!.doc.sources['a']!.data.kind).toBe('blob');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(2);
  });

  it('does not send sources that no longer contribute pages', async () => {
    const doc = await build(await source('a', 1), await source('b', 1));
    const trimmed: WorkingDocument = { ...doc, pages: doc.pages.filter((p) => p.sourceId === 'a') };
    const { writer, workers } = make();
    await writer.save(trimmed, defaultSaveOpts);
    expect(Object.keys(workers[0]!.received!.doc.sources)).toEqual(['a']);
  });

  it('terminates the worker when finished', async () => {
    const { writer, workers } = make();
    await writer.save(await build(await source('a', 1)), defaultSaveOpts);
    expect(workers[0]!.terminated).toBe(true);
  });

  it('refuses before creating a worker when preflight fails', async () => {
    const enc = { ...(await source('a', 1)), isEncrypted: true };
    const { writer, workers } = make();
    await expect(writer.save(await build(enc), defaultSaveOpts)).rejects.toMatchObject({ error: { code: 'EncryptedNotSupported' } });
    expect(workers).toHaveLength(0);
  });

  it('applies the memory guard before copying anything', async () => {
    const big = { ...(await source('a', 1)), data: memorySource(new Uint8Array(3 * 1024 * 1024)) };
    const { writer, workers } = make({ memoryBudgetMB: 1 });
    await expect(writer.save(await build(big), defaultSaveOpts)).rejects.toMatchObject({ error: { code: 'OutOfMemoryRisk' } });
    expect(workers).toHaveLength(0);
  });

  it('maps worker-side AppErrors back to AppFailure', async () => {
    const bad = { ...(await source('a', 1)), data: memorySource(new TextEncoder().encode('not a pdf')) };
    const { writer } = make();
    const err = await writer.save(await build(bad), defaultSaveOpts).catch((e) => e);
    expect(err).toBeInstanceOf(AppFailure);
    expect(err.error.code).toBe('CorruptFile');
  });

  it('reports plain worker errors as Error', async () => {
    const { writer } = make();
    await expect(writer.save(await build(await source('a', 1)), { ...defaultSaveOpts, flattenAnnotations: true })).rejects.toThrow(/flatten/);
  });

  it('runs the main-thread verification step on the result', async () => {
    const verify = vi.fn(async () => false);
    const { writer } = make({ verify });
    await expect(writer.save(await build(await source('a', 2)), defaultSaveOpts)).rejects.toMatchObject({ error: { code: 'SaveVerificationFailed' } });
    expect(verify).toHaveBeenCalledWith(expect.any(Uint8Array), 2);
  });

  it('cancels mid-save: rejects, terminates the worker, ignores late results', async () => {
    const { writer, workers } = make({}, 20);
    const ac = new AbortController();
    const p = writer.save(await build(await source('a', 1)), defaultSaveOpts, undefined, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(SaveCancelled);
    expect(workers[0]!.terminated).toBe(true);
  });

  it('rejects immediately for an already-aborted signal', async () => {
    const { writer, workers } = make();
    const ac = new AbortController();
    ac.abort();
    await expect(writer.save(await build(await source('a', 1)), defaultSaveOpts, undefined, ac.signal)).rejects.toBeInstanceOf(SaveCancelled);
    expect(workers).toHaveLength(0);
  });

  it('reports a crashing worker', async () => {
    const writer = new WorkerPdfWriter({
      memoryBudgetMB: 1000,
      createWorker: () => {
        const w = new FakeWorker();
        w.postMessage = () => queueMicrotask(() => w.onerror?.({ message: 'boom' }));
        return w;
      },
    });
    await expect(writer.save(await build(await source('a', 1)), defaultSaveOpts)).rejects.toThrow('boom');
  });
});
