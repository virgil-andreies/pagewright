import { memorySource, preflight, type SourceDoc, type WorkingDocument } from '@pagewright/core';
import type { SaveMessage, SaveRequest } from './save-protocol';
import type { PdfWriter, Progress, SaveOpts } from './types';
import { AppFailure } from './writer';

/** The subset of `Worker` we use, so tests can supply an in-process fake. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((e: { data: SaveMessage }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
}

export class SaveCancelled extends Error {
  constructor() {
    super('Save cancelled');
    this.name = 'AbortError';
  }
}

export interface WorkerPdfWriterOptions {
  /** One worker is created per save and terminated afterwards, so its memory is always released. */
  createWorker(): WorkerLike;
  memoryBudgetMB: number;
  /** Step 8 of the save pipeline, run on the main thread (e.g. `pdfjsVerify`). Defaults to accepting the output. */
  verify?: (bytes: Uint8Array, expectedPages: number) => Promise<boolean>;
}

/**
 * Runs the save pipeline in a worker so large documents do not freeze the UI.
 *
 * Blob-backed sources (opened files) are passed by reference, so nothing is copied on the main thread.
 * In-memory sources are copied once and the copy is transferred (not cloned): the worker owns it and frees
 * it when terminated, while the originals in the working document stay intact for later edits and re-saves.
 */
export class WorkerPdfWriter implements PdfWriter {
  private nextId = 1;

  constructor(private readonly o: WorkerPdfWriterOptions) {}

  async save(doc: WorkingDocument, opts: SaveOpts, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) throw new SaveCancelled();
    // Fail fast, before copying hundreds of megabytes.
    const pre = preflight(doc, { memoryBudgetMB: this.o.memoryBudgetMB });
    if (pre.errors[0]) throw new AppFailure(pre.errors[0]);

    const used = new Set(doc.pages.map((p) => p.sourceId));
    const sources: Record<string, SourceDoc> = {};
    const transfer: Transferable[] = [];
    for (const [id, s] of Object.entries(doc.sources)) {
      if (!used.has(id)) continue; // unused sources are not sent at all
      if (s.data.kind === 'blob') {
        sources[id] = s; // a Blob/File is cloned by reference: no bytes are copied, the worker reads what it needs
      } else {
        const bytes = s.data.bytes.slice();
        sources[id] = { ...s, data: memorySource(bytes) };
        transfer.push(bytes.buffer);
      }
    }
    const request: SaveRequest = {
      type: 'save', id: this.nextId++, doc: { ...doc, sources }, opts, memoryBudgetMB: this.o.memoryBudgetMB,
    };

    const bytes = await this.run(request, transfer, onProgress, signal);
    if (this.o.verify && !(await this.o.verify(bytes, doc.pages.length))) throw new AppFailure({ code: 'SaveVerificationFailed' });
    return bytes;
  }

  private run(req: SaveRequest, transfer: Transferable[], onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const worker = this.o.createWorker();
      const finish = (fn: () => void) => {
        signal?.removeEventListener('abort', onAbort);
        worker.onmessage = worker.onerror = null;
        worker.terminate();
        fn();
      };
      const onAbort = () => finish(() => reject(new SaveCancelled()));

      worker.onmessage = ({ data }) => {
        if (data.id !== req.id) return;
        if (data.type === 'progress') onProgress?.(data.progress);
        else if (data.type === 'done') finish(() => resolve(data.bytes));
        else finish(() => reject(data.error.code === 'Message' ? new Error(data.error.message) : new AppFailure(data.error)));
      };
      worker.onerror = (e) => finish(() => reject(new Error(e.message ?? 'The save worker crashed')));
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage(req, transfer);
    });
  }
}
