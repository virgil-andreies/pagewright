import type {
  DeviceInfo, FileSystemAdapter, PickedFile, Platform, SaveTarget, SecureStore, ShareAdapter,
} from './interfaces';

const PDF_TYPE = 'application/pdf';

function fromFile(file: File, handle?: unknown): PickedFile {
  return {
    name: file.name,
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
    ...(handle ? { handle } : {}),
  };
}

// File System Access API bits that lib.dom does not ship in every TS version.
interface FsWindow {
  showSaveFilePicker?: (o: unknown) => Promise<{ name: string; createWritable(): Promise<{ write(d: BufferSource): Promise<void>; close(): Promise<void> }> }>;
  launchQueue?: { setConsumer(fn: (p: { files: { getFile(): Promise<File> }[] }) => void): void };
}

function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: PDF_TYPE }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export class WebFileSystem implements FileSystemAdapter {
  pickFiles(opts: { multiple: boolean; accept: string[] }): Promise<PickedFile[]> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = opts.multiple;
      input.accept = opts.accept.join(',');
      input.addEventListener('change', () => resolve([...(input.files ?? [])].map((f) => fromFile(f))), { once: true });
      input.addEventListener('cancel', () => resolve([]), { once: true });
      input.click();
    });
  }

  /**
   * Asks where to save *before* the (possibly long) save runs: the picker needs the user's click, which
   * expires after a few seconds. Resolves to undefined when the user cancels.
   */
  async openSaveTarget(suggestedName: string): Promise<SaveTarget | undefined> {
    const downloadTarget: SaveTarget = {
      write: async (bytes) => (download(suggestedName, bytes), { saved: true, name: suggestedName }),
    };
    const w = window as unknown as FsWindow;
    if (!w.showSaveFilePicker) return downloadTarget;

    let handle: Awaited<ReturnType<NonNullable<FsWindow['showSaveFilePicker']>>>;
    try {
      handle = await w.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'PDF', accept: { [PDF_TYPE]: ['.pdf'] } }],
      });
    } catch (e) {
      const name = (e as Error).name;
      if (name === 'AbortError') return undefined;
      if (name === 'SecurityError' || name === 'NotAllowedError') return downloadTarget; // no user activation
      throw e;
    }

    return {
      write: async (bytes) => {
        try {
          const stream = await handle.createWritable();
          await stream.write(bytes as BufferSource);
          await stream.close();
          return { saved: true, name: handle.name };
        } catch (e) {
          // The browser refused the write: file open elsewhere or a protected folder. Do not lose the
          // work; hand it over as a download instead.
          const name = (e as Error).name;
          if (name === 'NotAllowedError' || name === 'NoModificationAllowedError' || name === 'SecurityError') {
            download(suggestedName, bytes);
            return { saved: true, name: suggestedName, viaDownload: true };
          }
          throw e;
        }
      },
    };
  }

  onOpenRequest(handler: (files: PickedFile[]) => void): () => void {
    let active = true;
    // PWA file handlers (installed app, "Open with"). Consumers cannot be removed, so gate on a flag.
    (window as unknown as FsWindow).launchQueue?.setConsumer(async (params) => {
      if (!active) return;
      const files = await Promise.all(params.files.map(async (h) => fromFile(await h.getFile(), h)));
      if (files.length) handler(files);
    });
    // Drag and drop onto the window.
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type === PDF_TYPE || f.name.toLowerCase().endsWith('.pdf'));
      if (files.length) handler(files.map((f) => fromFile(f)));
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      active = false;
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }
}

export class WebShare implements ShareAdapter {
  async share(name: string, bytes: Uint8Array): Promise<void> {
    const file = new File([bytes as BlobPart], name, { type: PDF_TYPE });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: name });
    else download(name, bytes);
  }
}

/** IndexedDB-backed key/value store; falls back to memory when IndexedDB is unavailable. */
export class IndexedDbStore implements SecureStore {
  private memory = new Map<string, unknown>();
  private db?: Promise<IDBDatabase | undefined>;

  constructor(private readonly name = 'pagewright') {}

  private open(): Promise<IDBDatabase | undefined> {
    this.db ??= new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(undefined);
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
    return this.db;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    if (!db) return this.memory.get(key) as T | undefined;
    return new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async set(key: string, value: unknown): Promise<void> {
    const db = await this.open();
    if (!db) {
      this.memory.set(key, value);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

export function webDevice(): DeviceInfo {
  const gb = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  return { platform: 'web', memoryBudgetMB: Math.min(1536, Math.max(256, Math.floor(gb * 1024 * 0.4))) };
}

export function createWebPlatform(): Platform {
  return { fs: new WebFileSystem(), share: new WebShare(), secure: new IndexedDbStore(), device: webDevice() };
}
