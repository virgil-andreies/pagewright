import type { BlobLike } from '@pagewright/core';

export interface PickedFile {
  name: string;
  size: number;
  /** Lazy: large files are only read when needed. */
  read(): Promise<Uint8Array>;
  /**
   * The file as a disk-backed Blob when the platform has one (browsers do). Preferred over `read()`: a big
   * file then costs almost no memory until its pages are actually needed. Adapters without Blobs omit it.
   */
  blob?: BlobLike;
  /**
   * Copies the file into app-private storage and returns that stable copy. Lazy reads from `blob` break if
   * the original changes on disk, which includes saving over the file the user opened. Prefer this to `blob`.
   */
  snapshot?(): Promise<BlobLike>;
  /** FileSystemFileHandle / path, for overwrite-in-place. Opaque to callers. */
  handle?: unknown;
}

export type SaveResult =
  /** `viaDownload`: the browser refused a direct write, so the file went to the downloads folder instead. */
  | { saved: true; name: string; viaDownload?: boolean }
  | { saved: false };

export interface SaveTarget {
  /** Step 2: write the finished document. */
  write(bytes: Uint8Array): Promise<SaveResult>;
}

export interface FileSystemAdapter {
  pickFiles(opts: { multiple: boolean; accept: string[] }): Promise<PickedFile[]>;
  /**
   * Step 1 of saving: let the user choose where to write. Must be called straight from a user gesture,
   * before the slow work, because browsers only allow the picker shortly after a click.
   * Resolves to undefined when the user cancels.
   */
  openSaveTarget(suggestedName: string): Promise<SaveTarget | undefined>;
  /** Called when the OS opens a file with the app ("Open with", drag onto icon, share target). Returns unsubscribe. */
  onOpenRequest(handler: (files: PickedFile[]) => void): () => void;
}

export interface ShareAdapter {
  share(name: string, bytes: Uint8Array): Promise<void>;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Signatures, author name. */
export interface SecureStore extends KeyValueStore {}

export interface DeviceInfo {
  platform: 'web' | 'desktop' | 'ios' | 'android';
  /**
   * The most memory one save may use at its peak. Drives the save-time guard (spec section 7): a save is
   * refused when `SAVE_MEMORY_FACTOR` times the size of its source files exceeds this.
   */
  memoryBudgetMB: number;
}

export interface Platform {
  fs: FileSystemAdapter;
  share: ShareAdapter;
  secure: SecureStore;
  device: DeviceInfo;
}
