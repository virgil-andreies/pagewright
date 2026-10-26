import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PdfJsRenderer, WorkerPdfWriter, createSignatureMaker, pdfjsVerify, type WorkerLike } from '@pagewright/engine';
import SaveWorker from '@pagewright/engine/src/save.worker.ts?worker';
import { createWebPlatform } from '@pagewright/platform';
import { AppShell, AppStore, browserImageLoader } from '@pagewright/ui';
import { signatureFonts } from './signature-fonts';
import { unicodeFontUrls } from './text-fonts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const platform = createWebPlatform();
const pdfjsData = `${import.meta.env.BASE_URL}${__PDFJS_DATA__}`;
const renderer = new PdfJsRenderer({
  pdfjs,
  standardFontDataUrl: `${pdfjsData}standard_fonts/`,
  cMapUrl: `${pdfjsData}cmaps/`,
  wasmUrl: `${pdfjsData}wasm/`,
});
// Saving runs in a worker (spec section 9); the result is verified here with PDF.js.
const writer = new WorkerPdfWriter({
  // A real Worker's MessageEvent has the `data` we read; WorkerLike just names that subset.
  createWorker: () => new SaveWorker() as unknown as WorkerLike,
  memoryBudgetMB: platform.device.memoryBudgetMB,
  verify: pdfjsVerify(renderer),
  unicodeFontUrls,
});
// Typed signatures are drawn once, from handwriting fonts, into vector artwork; see signature-fonts.ts.
const store = new AppStore({ renderer, writer, platform, signatureMaker: createSignatureMaker(signatureFonts), imageLoader: browserImageLoader });

// Handy for poking at state from the console while developing.
if (import.meta.env.DEV) (window as unknown as { pagewright: unknown }).pagewright = store;

// public/browser-check.js has already put up a message if this browser is too old to run the app.
if (!(window as unknown as { __pagewrightUnsupported?: boolean }).__pagewrightUnsupported) {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppShell
        store={store}
        brand={{
          name: 'Pagewright PDF',
          icon: `${import.meta.env.BASE_URL}favicon.svg`,
          version: __APP_VERSION__,
          commit: __APP_COMMIT__,
          sourceUrl: 'https://github.com/virgil-andreies/pagewright',
        }}
      />
    </StrictMode>,
  );
}
