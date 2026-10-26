// Checks the built app (apps/web/dist) against its size budget, so the first download stays small:
//   pnpm --filter web build && pnpm --filter web check-bundle
// The main file must stay under the budget, and the parts that are loaded only when needed (pdf-lib, which saves
// in the background worker, and the font engine for typed signatures) must not slip back into it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Compressed size of the main file, as a browser downloads it. Today about 260 KB: room to grow, but not much. */
const BUDGET_GZIP_KB = 300;

const assets = resolve(import.meta.dirname, '../dist/assets');
const files = readdirSync(assets);
const main = files.find((f) => /^index-.*\.js$/.test(f));
if (!main) throw new Error('No main file in dist/assets: build the app first (pnpm --filter web build).');

const code = readFileSync(resolve(assets, main));
const gzipKB = Math.round(gzipSync(code).length / 1024);
const problems: string[] = [];
if (gzipKB > BUDGET_GZIP_KB) problems.push(`the main file is ${gzipKB} KB compressed, over the ${BUDGET_GZIP_KB} KB budget`);

// Error messages built into the libraries that must stay out of the main file (checked to be present in the save
// worker and the typed-signature file, and absent from the main file).
const text = code.toString('latin1');
const outsiders: Record<string, string[]> = {
  'pdf-lib': ['No PDF header found', 'Failed to parse PDF document'],
  'the font engine (fontkit)': ['Unknown font format'],
};
for (const [what, markers] of Object.entries(outsiders)) {
  if (markers.some((m) => text.includes(m))) problems.push(`${what} is in the main file again; it should load only when needed`);
}
if (!files.some((f) => /^typed-signature-.*\.js$/.test(f))) problems.push('typed signatures are no longer a separate file');

const total = files.reduce((n, f) => n + statSync(resolve(assets, f)).size, 0);
console.log(`main file: ${Math.round(code.length / 1024)} KB (${gzipKB} KB compressed); all assets: ${Math.round(total / 1024)} KB`);
if (problems.length > 0) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('  ✓ within budget');
