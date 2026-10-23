import type { Annotation } from './annotations';
import type { SourceData } from './source';

export type SourceId = string;
export type PageId = string;
export type AnnotId = string;
export type Rotation = 0 | 90 | 180 | 270;

export interface SourceDoc {
  id: SourceId;
  name: string;
  /** Never mutated. Blob-backed for opened files, so big documents stay on disk (see source.ts). */
  data: SourceData;
  pageCount: number;
  isEncrypted: boolean;
  hasDigitalSignature: boolean;
}

export interface PageRef {
  id: PageId;
  sourceId: SourceId;
  sourceIndex: number;
  /** Delta applied on top of the source page's own /Rotate. */
  rotation: Rotation;
}

export interface DocMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
}

/** Immutable snapshot; every command returns a new one. */
export interface WorkingDocument {
  readonly sources: Readonly<Record<SourceId, SourceDoc>>;
  readonly pages: readonly PageRef[];
  readonly annotations: Readonly<Record<PageId, readonly Annotation[]>>;
  readonly metadata: Readonly<DocMetadata>;
  readonly dirty: boolean;
}

export type IdGen = () => string;
// Available in browsers, Node 19+, Electron and Capacitor WebViews; declared here to keep `lib` DOM-free.
declare const crypto: { randomUUID(): string };
export const defaultIdGen: IdGen = () => crypto.randomUUID();

export function emptyDocument(): WorkingDocument {
  return { sources: {}, pages: [], annotations: {}, metadata: {}, dirty: false };
}

export function normalizeRotation(deg: number): Rotation {
  const r = ((deg % 360) + 360) % 360;
  if (r !== 0 && r !== 90 && r !== 180 && r !== 270) {
    throw new RangeError(`Rotation must be a multiple of 90, got ${deg}`);
  }
  return r;
}
