import type { SourceId, WorkingDocument } from './model';
import { sourceSize } from './source';

export type AppError =
  | { code: 'PasswordRequired'; sourceId: SourceId }
  | { code: 'WrongPassword' }
  | { code: 'EncryptedNotSupported' } // save/edit blocked in v1
  | { code: 'CorruptFile'; detail: string }
  /** `estimateMB`: expected peak of this save; `budgetMB`: what the device allows. */
  | { code: 'OutOfMemoryRisk'; estimateMB: number; budgetMB: number }
  | { code: 'SignedDocumentWarning' }
  | { code: 'SaveVerificationFailed' };

export type Notice = 'OutlinesDropped' | 'SignaturesInvalidated';

export interface PreflightResult {
  /** Blocking errors: save must not proceed. */
  errors: AppError[];
  /** Needs explicit user confirmation before saving. */
  warnings: AppError[];
  /** Non-fatal, shown once per session. */
  notices: Notice[];
}

export interface PreflightOpts {
  /** The most memory one save may use at its peak (see SAVE_MEMORY_FACTOR). Comes from `DeviceInfo`. */
  memoryBudgetMB: number;
}

const MB = 1024 * 1024;

/**
 * Peak memory of a save, as a multiple of the total size of the source files it reads. Measured with the
 * pdf-lib pipeline on a 299 MB scanned PDF (about 1.3 GB in Chrome, 1.5 GB in Node): the worker holds the
 * whole input and builds the whole output, and the page keeps its own working set. Even deleting almost
 * every page does not help, because the source is loaded whole.
 */
export const SAVE_MEMORY_FACTOR = 4.5;

export function estimateSavePeakMB(sourceBytes: number): number {
  return Math.ceil((sourceBytes * SAVE_MEMORY_FACTOR) / MB);
}

/** The largest total source size (MB) a device with this save budget accepts. */
export function maxSaveSourceMB(memoryBudgetMB: number): number {
  return Math.floor(memoryBudgetMB / SAVE_MEMORY_FACTOR);
}

/** Spec section 7 step 1 + memory guard. Only sources that still contribute pages are considered. */
export function preflight(doc: WorkingDocument, opts: PreflightOpts): PreflightResult {
  const used = new Set(doc.pages.map((p) => p.sourceId));
  const sources = Object.values(doc.sources).filter((s) => used.has(s.id));
  const result: PreflightResult = { errors: [], warnings: [], notices: [] };

  if (sources.some((s) => s.isEncrypted)) result.errors.push({ code: 'EncryptedNotSupported' });

  const estimateMB = estimateSavePeakMB(sources.reduce((n, s) => n + sourceSize(s.data), 0));
  if (estimateMB > opts.memoryBudgetMB) result.errors.push({ code: 'OutOfMemoryRisk', estimateMB, budgetMB: opts.memoryBudgetMB });

  if (sources.some((s) => s.hasDigitalSignature)) {
    result.warnings.push({ code: 'SignedDocumentWarning' });
    result.notices.push('SignaturesInvalidated');
  }
  if (sources.length > 1) result.notices.push('OutlinesDropped');

  return result;
}

const MESSAGES: Record<AppError['code'], { message: string; action: string }> = {
  PasswordRequired: { message: 'This PDF is password protected.', action: 'Enter password' },
  WrongPassword: { message: 'That password is incorrect.', action: 'Try again' },
  EncryptedNotSupported: {
    message: 'Saving encrypted PDFs is not supported yet. You can still view this file.',
    action: 'Remove the file or continue viewing',
  },
  CorruptFile: { message: 'This file is damaged or is not a valid PDF.', action: 'Choose another file' },
  OutOfMemoryRisk: { message: 'These files are too large to save safely on this device.', action: 'Remove some files' },
  SignedDocumentWarning: { message: 'Saving will invalidate existing digital signatures.', action: 'Save anyway or cancel' },
  SaveVerificationFailed: { message: 'The saved file failed verification and was discarded.', action: 'Retry save' },
};

export function describeError(e: AppError): { message: string; action: string } {
  if (e.code === 'OutOfMemoryRisk') {
    const limit = maxSaveSourceMB(e.budgetMB);
    return {
      message: `These files are too large to save safely on this device: saving needs about ${e.estimateMB} MB of memory, and this device allows about ${e.budgetMB} MB (source files up to ${limit} MB in total). You can still view and mark them up.`,
      action: 'Remove some files or use a device with more memory',
    };
  }
  return MESSAGES[e.code];
}
