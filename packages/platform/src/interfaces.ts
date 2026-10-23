export interface PickedFile {
  name: string;
  size: number;
  /** Lazy: large files are only read when needed. */
  read(): Promise<Uint8Array>;
  /** FileSystemFileHandle / path, for overwrite-in-place. Opaque to callers. */
  handle?: unknown;
}

export type SaveResult =
  /** `viaDownload`: the browser refused a direct write, so the file went to the downloads folder instead. */
  | { saved: true; name: string; viaDownload?: boolean }
  | { saved: false };

export interface FileSystemAdapter {
  pickFiles(opts: { multiple: boolean; accept: string[] }): Promise<PickedFile[]>;
  saveFile(suggestedName: string, bytes: Uint8Array): Promise<SaveResult>;
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
  /** Drives the save-time memory guard (spec section 7). */
  memoryBudgetMB: number;
}

export interface Platform {
  fs: FileSystemAdapter;
  share: ShareAdapter;
  secure: SecureStore;
  device: DeviceInfo;
}
