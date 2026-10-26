import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    // PDF.js loads standard fonts and CMaps (CJK etc.) at runtime from these URLs.
    viteStaticCopy({
      targets: [
        // `stripBase`: the files themselves, straight into these folders (the plugin would otherwise rebuild the
        // node_modules/pdfjs-dist/... path inside them, and PDF.js would not find them).
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts', rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'pdfjs/cmaps', rename: { stripBase: true } },
      ],
    }),
  ],
  build: {
    target: 'es2022',
    // PDF.js alone is over 400 kB and both workers are about 1 MB, so Vite's generic 500 kB warning always fires.
    // The real budget is checked by scripts/check-bundle.ts (the main file's compressed size, and what must stay out).
    chunkSizeWarningLimit: 1400,
  },
});
