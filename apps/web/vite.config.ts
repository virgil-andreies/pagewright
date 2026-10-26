import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

/** The app's version, from its package.json: one place to change it. */
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** The code version the app is built from, so a problem report says exactly which build it came from. */
function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7); // building on GitHub
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit()),
  },
  // One page and no client-side routes: like the host, answer a missing address with 404, not with the app.
  appType: 'mpa',
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
