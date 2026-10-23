import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PdfJsRenderer, PdfLibWriter, pdfjsVerify } from '@pagewright/engine';
import { createWebPlatform } from '@pagewright/platform';
import { AppShell, AppStore } from '@pagewright/ui';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const platform = createWebPlatform();
const renderer = new PdfJsRenderer({
  pdfjs,
  standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
});
// TODO(M0): move the writer into save.worker.ts (spec section 9).
const writer = new PdfLibWriter({ memoryBudgetMB: platform.device.memoryBudgetMB, verify: pdfjsVerify(renderer) });
const store = new AppStore({ renderer, writer, platform });

// Handy for poking at state from the console while developing.
if (import.meta.env.DEV) (window as unknown as { pagewright: unknown }).pagewright = store;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppShell store={store} />
  </StrictMode>,
);
