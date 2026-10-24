import type { SaveMessage, SaveRequest } from './save-protocol';
import { urlFontSource } from './unicode-fonts';
import { AppFailure, PdfLibWriter } from './writer';

/**
 * The body of the save worker, kept free of `self` so it runs (and is tested) anywhere.
 * Verification (step 8) is left to the caller: PDF.js has its own worker on the main thread.
 */
export async function handleSaveRequest(
  req: SaveRequest,
  post: (message: SaveMessage, transfer?: Transferable[]) => void,
): Promise<void> {
  try {
    const writer = new PdfLibWriter({
      memoryBudgetMB: req.memoryBudgetMB,
      verify: async () => true,
      unicodeFonts: req.unicodeFontUrls ? urlFontSource(req.unicodeFontUrls) : undefined,
    });
    const bytes = await writer.save(req.doc, req.opts, (progress) => post({ type: 'progress', id: req.id, progress }));
    post({ type: 'done', id: req.id, bytes }, [bytes.buffer]);
  } catch (e) {
    post({
      type: 'error',
      id: req.id,
      error: e instanceof AppFailure ? e.error : { code: 'Message', message: e instanceof Error ? e.message : String(e) },
    });
  }
}
