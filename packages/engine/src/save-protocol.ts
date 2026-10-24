import type { AppError, WorkingDocument } from '@pagewright/core';
import type { Progress, SaveOpts } from './types';

/** Main thread -> save worker. Everything here must survive structured clone (plain data and typed arrays). */
export interface SaveRequest {
  type: 'save';
  id: number;
  doc: WorkingDocument;
  opts: SaveOpts;
  memoryBudgetMB: number;
  /** Font files for text in other alphabets: `family/subset` -> absolute URL. */
  unicodeFontUrls?: Record<string, string>;
}

/** Save worker -> main thread. */
export type SaveMessage =
  | { type: 'progress'; id: number; progress: Progress }
  | { type: 'done'; id: number; bytes: Uint8Array }
  | { type: 'error'; id: number; error: AppError | { code: 'Message'; message: string } };
