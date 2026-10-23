// Entry point of the save worker (spec section 9). Bundlers load it with `new Worker(new URL(...))` or Vite's `?worker`.
import { handleSaveRequest } from './save-handler';
import type { SaveRequest } from './save-protocol';

const scope = self as unknown as Worker;

scope.onmessage = (e: MessageEvent<SaveRequest>) => {
  if (e.data?.type === 'save') void handleSaveRequest(e.data, (message, transfer) => scope.postMessage(message, transfer ?? []));
};
