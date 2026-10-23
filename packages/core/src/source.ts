/**
 * Where a source PDF's bytes live. Plain data (no methods), so it survives structured clone to workers.
 *
 * - `memory`: the whole file as a Uint8Array. Simple; used for files the app creates and in tests.
 * - `blob`: a `Blob`/`File`. Browsers keep these on disk, so a 300 MB file costs almost no memory until
 *   it is actually read, and readers can fetch just the byte ranges they need.
 */
export type SourceData =
  | { readonly kind: 'memory'; readonly bytes: Uint8Array }
  | { readonly kind: 'blob'; readonly blob: BlobLike };

/** The slice of the DOM `Blob` API we use, so `core` stays free of DOM types. `Blob` and `File` satisfy it. */
export interface BlobLike {
  readonly size: number;
  slice(start?: number, end?: number): BlobLike;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function memorySource(bytes: Uint8Array): SourceData {
  return { kind: 'memory', bytes };
}

export function blobSource(blob: BlobLike): SourceData {
  return { kind: 'blob', blob };
}

export function sourceSize(data: SourceData): number {
  return data.kind === 'memory' ? data.bytes.byteLength : data.blob.size;
}

/**
 * The whole file. For a memory source this is the same array (not a copy): do not mutate or transfer it.
 * For a blob source it reads everything into memory, so only call it where the whole file is really needed.
 */
export async function readAll(data: SourceData): Promise<Uint8Array> {
  return data.kind === 'memory' ? data.bytes : new Uint8Array(await data.blob.arrayBuffer());
}

/**
 * Bytes `[start, end)` as a fresh array that the caller owns. Always a copy: handing out a view would make
 * structured clone serialise the entire backing buffer.
 */
export async function readRange(data: SourceData, start: number, end: number): Promise<Uint8Array> {
  const size = sourceSize(data);
  const from = Math.max(0, Math.min(start, size));
  const to = Math.max(from, Math.min(end, size));
  if (data.kind === 'memory') return data.bytes.slice(from, to);
  return new Uint8Array(await data.blob.slice(from, to).arrayBuffer());
}
