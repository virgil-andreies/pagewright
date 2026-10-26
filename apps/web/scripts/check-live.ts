// Checks the published site against the build it was published from (apps/web/dist), right after publishing:
//   pnpm --filter @pagewright/web check-live https://pagewright.<name>.workers.dev
// The browser tests run against the local preview; this makes sure the host serves the same files, in the same
// places, with the response headers in public/_headers, and answers a missing address with the 404 page.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { headersFor, readHeaderRules } from '../host-headers';

const base = process.argv[2];
if (!base) throw new Error('Give the address of the published site, e.g. https://pagewright.example.workers.dev');
const at = (path: string) => new URL(path, base).href;
const dist = resolve(import.meta.dirname, '../dist');
// Line endings aside: a Windows checkout builds the page with CRs in it, the published one comes from Linux.
const index = readFileSync(resolve(dist, 'index.html'), 'utf8').replace(/\r/g, '');
const main = index.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
if (!main) throw new Error('No main file named in dist/index.html: build the app first.');
const pdfjsData = `/pdfjs/${readdirSync(resolve(dist, 'pdfjs'))[0]}`;
const rules = readHeaderRules(resolve(dist, '_headers'));

/** Fetches as a browser opening the address would (the host shows its 404 page only to such requests). */
const get = (path: string) => fetch(at(path), { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });

// A new version is live everywhere within seconds; wait until the start page is the one just built.
let live = '';
for (let i = 0; i < 30 && live !== index; i++) {
  if (i > 0) await new Promise((r) => setTimeout(r, 2000));
  live = (await (await get('/')).text()).replace(/\r/g, '');
}

const problems: string[] = [];
if (live !== index) problems.push('the start page is not the one just built');

/** Every header public/_headers sets for this path must arrive as written. */
function checkHeaders(path: string, r: Response): void {
  for (const [name, want] of headersFor(rules, path)) {
    const got = r.headers.get(name);
    if (got !== want) problems.push(`${path}: ${name} is ${got === null ? 'missing' : `"${got}"`}, not "${want}"`);
  }
}
checkHeaders('/', await get('/'));
const files = [main, '/browser-check.js', '/favicon.svg', ...['cmaps/UniJIS-UCS2-H.bcmap', 'standard_fonts/FoxitFixed.pfb', 'wasm/openjpeg.wasm', 'wasm/jbig2.wasm'].map((f) => `${pdfjsData}/${f}`)];
for (const path of files) {
  const r = await fetch(at(path));
  const same = r.ok && Buffer.from(await r.arrayBuffer()).equals(readFileSync(resolve(dist, `.${path}`)));
  if (!same) problems.push(`${path} is ${r.ok ? 'not the built file' : `missing (${r.status})`}`);
  else checkHeaders(path, r);
}
const missing = await get('/no-such-page');
const body = await missing.text();
if (missing.status !== 404 || !body.includes('Page not found')) problems.push(`a missing address gets ${missing.status}, not the 404 page`);
if ((await fetch(at('/_headers'))).ok) problems.push('the host’s settings file /_headers is published');

if (problems.length) {
  console.error(`The published site at ${base} is not right:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`The published site at ${base} serves this build: start page, app files, PDF.js data, response headers and the 404 page.`);
