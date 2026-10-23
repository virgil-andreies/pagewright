import type { SourceId, WorkingDocument } from './model';

export type AppError =
  | { code: 'PasswordRequired'; sourceId: SourceId }
  | { code: 'WrongPassword' }
  | { code: 'EncryptedNotSupported' } // save/edit blocked in v1
  | { code: 'CorruptFile'; detail: string }
  | { code: 'OutOfMemoryRisk'; estimateMB: number }
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
  /** Refuse when the sum of used source sizes exceeds this (default 1.5 GB desktop, 400 MB mobile). */
  memoryBudgetMB: number;
}

const MB = 1024 * 1024;

/** Spec section 7 step 1 + memory guard. Only sources that still contribute pages are considered. */
export function preflight(doc: WorkingDocument, opts: PreflightOpts): PreflightResult {
  const used = new Set(doc.pages.map((p) => p.sourceId));
  const sources = Object.values(doc.sources).filter((s) => used.has(s.id));
  const result: PreflightResult = { errors: [], warnings: [], notices: [] };

  if (sources.some((s) => s.isEncrypted)) result.errors.push({ code: 'EncryptedNotSupported' });

  const estimateMB = Math.ceil(sources.reduce((n, s) => n + s.bytes.byteLength, 0) / MB);
  if (estimateMB > opts.memoryBudgetMB) result.errors.push({ code: 'OutOfMemoryRisk', estimateMB });

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
  OutOfMemoryRisk: { message: 'These files are too large to process safely on this device.', action: 'Remove some files' },
  SignedDocumentWarning: { message: 'Saving will invalidate existing digital signatures.', action: 'Save anyway or cancel' },
  SaveVerificationFailed: { message: 'The saved file failed verification and was discarded.', action: 'Retry save' },
};

export function describeError(e: AppError): { message: string; action: string } {
  return MESSAGES[e.code];
}
