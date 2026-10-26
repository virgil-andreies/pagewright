// Checks the published site against the build it was published from (apps/web/dist), right after publishing:
//   pnpm --filter @pagewright/web check-live https://pagewright.<name>.workers.dev
// The browser tests run against the local preview; this makes sure the host serves the same files, in the same
// places, and answers a missing address with the 404 page.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.argv[2];
if (!base) throw new Error('Give the address of the published site, e.g. https://pagewright.example.workers.dev');
const at = (path: string) => new URL(path, base).href;
const dist = resolve(import.meta.dirname, '../dist');
const index = readFileSync(resolve(dist, 'index.html'), 'utf8');
const main = index.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
if (!main) throw new Error('No main file named in dist/index.html: build the app first.');

/** Fetches as a browser opening the address would (the host shows its 404 page only to such requests). */
const get = (path: string) => fetch(at(path), { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });

// A new version is live everywhere within seconds; wait until the start page is the one just built.
let live = '';
for (let i = 0; i < 30 && live !== index; i++) {
  if (i > 0) await new Promise((r) => setTimeout(r, 2000));
  live = await (await get('/')).text();
}

const problems: string[] = [];
if (live !== index) problems.push('the start page is not the one just built');
for (const path of [main, '/browser-check.js', '/favicon.svg', '/pdfjs/cmaps/UniJIS-UCS2-H.bcmap', '/pdfjs/standard_fonts/FoxitFixed.pfb']) {
  const r = await fetch(at(path));
  const same = r.ok && Buffer.from(await r.arrayBuffer()).equals(readFileSync(resolve(dist, `.${path}`)));
  if (!same) problems.push(`${path} is ${r.ok ? 'not the built file' : `missing (${r.status})`}`);
}
const missing = await get('/no-such-page');
const body = await missing.text();
if (missing.status !== 404 || !body.includes('Page not found')) problems.push(`a missing address gets ${missing.status}, not the 404 page`);

if (problems.length) {
  console.error(`The published site at ${base} is not right:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`The published site at ${base} serves this build: start page, app files, PDF.js data and the 404 page.`);
