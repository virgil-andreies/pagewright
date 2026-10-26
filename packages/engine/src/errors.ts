import type { AppError } from '@pagewright/core';

/**
 * Thrown for any condition expressed as an AppError (see core/policies). Kept apart from the writer so that code
 * which only needs the error (the renderer, the worker client, the app) does not pull pdf-lib into the main bundle.
 */
export class AppFailure extends Error {
  constructor(readonly error: AppError) {
    super(error.code);
  }
}
