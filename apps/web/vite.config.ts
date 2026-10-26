import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { headersFor, readHeaderRules } from './host-headers';

/** The app's version, from its package.json: one place to change it. */
const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * Where PDF.js's data (standard fonts, character maps, image decoders) is published: a folder named after its
 * version, so the host can let browsers keep these files (public/_headers) and an update never mixes old and new.
 */
const pdfjsVersion = (JSON.parse(readFileSync(new URL('./node_modules/pdfjs-dist/package.json', import.meta.url), 'utf8')) as { version: string }).version;
const pdfjsData = `pdfjs/${pdfjsVersion}`;

/** The response headers the host adds (public/_headers), applied by the local preview server too. */
function hostHeaders(): Plugin {
  const rules = readHeaderRules(new URL('./public/_headers', import.meta.url));
  return {
    name: 'pagewright-host-headers',
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        for (const [name, value] of headersFor(rules, path)) res.setHeader(name, value);
        next();
      });
    },
  };
}

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
    __PDFJS_DATA__: JSON.stringify(`${pdfjsData}/`),
  },
  // One page and no client-side routes: like the host, answer a missing address with 404, not with the app.
  appType: 'mpa',
  plugins: [
    react(),
    hostHeaders(),
    // PDF.js loads standard fonts, CMaps (CJK etc.) and its WebAssembly image decoders at runtime from these URLs.
    viteStaticCopy({
      targets: [
        // `stripBase`: the files themselves, straight into these folders (the plugin would otherwise rebuild the
        // node_modules/pdfjs-dist/... path inside them, and PDF.js would not find them).
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: `${pdfjsData}/standard_fonts`, rename: { stripBase: true } },
        { src: 'node_modules/pdfjs-dist/cmaps/*', dest: `${pdfjsData}/cmaps`, rename: { stripBase: true } },
        // JBIG2 (black-and-white scans), JPEG 2000 and ICC colour profiles, with plain-JavaScript fallbacks for
        // browsers that turn WebAssembly off (e.g. iOS Lockdown Mode), and their licences. Not quickjs: it runs
        // scripts inside PDFs, which the app does not enable.
        {
          src: ['jbig2*', 'openjpeg*', 'qcms*', 'LICENSE_*'].map((f) => `node_modules/pdfjs-dist/wasm/${f}`),
          dest: `${pdfjsData}/wasm`,
          rename: { stripBase: true },
        },
      ],
    }),
  ],
  build: {
    target: 'es2022',
    // Keep fonts as files rather than inlining small ones as data: URLs: the signature code fetch()es its fonts,
    // and the security policy (public/_headers) only lets the page fetch from the site itself.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
    // PDF.js alone is over 400 kB and both workers are about 1 MB, so Vite's generic 500 kB warning always fires.
    // The real budget is checked by scripts/check-bundle.ts (the main file's compressed size, and what must stay out).
    chunkSizeWarningLimit: 1400,
  },
});
