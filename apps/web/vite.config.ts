import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    react(),
    // PDF.js loads standard fonts and CMaps (CJK etc.) at runtime from these URLs.
    viteStaticCopy({
      targets: [
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'pdfjs/standard_fonts' },
        { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'pdfjs/cmaps' },
      ],
    }),
  ],
  build: { target: 'es2022' },
});
