# Test files from PDF.js

These small PDFs are copied unchanged from the test suite of [PDF.js](https://github.com/mozilla/pdf.js/tree/master/test/pdfs)
(Apache License 2.0). Each page is a single image in a format that needs PDF.js's WebAssembly decoders; the
browser tests (`scanned` scenario in `run.ts`) check that the app shows them.

| File | Image format |
|---|---|
| `jbig2_symbol_offset.pdf` | JBIG2, as used by black-and-white document scanners |
| `jp2k-resetprob.pdf` | JPEG 2000 |
