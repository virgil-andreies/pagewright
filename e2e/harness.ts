// A small real-browser harness: builds the web app, serves it, and drives it with Chrome through
// puppeteer-core (no browser download: it uses the Chrome or Edge installed on this machine).
// jsdom cannot reproduce real focus, pointer and layout behaviour, so anything that depends on those is
// checked here. Run with `pnpm e2e`.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer, { type Browser, type ElementHandle, type Page } from 'puppeteer-core';

const ROOT = resolve(import.meta.dirname, '..');
export const SHOTS = resolve(ROOT, 'out/e2e');
export const DOWNLOADS = resolve(ROOT, 'out/e2e/downloads');
const PORT = 4173;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome(): string {
  const found = CHROME_CANDIDATES.find((p) => p && existsSync(p));
  if (!found) throw new Error('No Chrome or Edge found. Set CHROME_PATH to its executable.');
  return found;
}

export interface Session {
  browser: Browser;
  page: Page;
  url: string;
  close(): Promise<void>;
}

export async function start(opts: { build?: boolean } = {}): Promise<Session> {
  const web = resolve(ROOT, 'apps/web');
  // E2E_SKIP_BUILD=1 reuses the build already in apps/web/dist (CI builds once and checks its size first).
  if (opts.build !== false && !process.env.E2E_SKIP_BUILD) {
    const built = spawnSync('pnpm', ['exec', 'vite', 'build'], { cwd: web, shell: true, encoding: 'utf8' });
    if (built.status !== 0) throw new Error(`build failed:\n${built.stdout}\n${built.stderr}`);
  }
  const server: ChildProcess = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: web, shell: true, stdio: 'ignore' });
  const url = `http://localhost:${PORT}/`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 100) throw new Error('preview server did not start');
    await new Promise((r) => setTimeout(r, 100));
  }

  mkdirSync(SHOTS, { recursive: true });
  // CI runners do not allow Chrome's own sandbox; there the runner itself is the sandbox.
  const args = process.env.CI ? ['--no-sandbox'] : [];
  const browser = await puppeteer.launch({ executablePath: findChrome(), headless: true, args, defaultViewport: { width: 1360, height: 900 } });
  const page = await browser.newPage();
  // Headless Chrome cannot answer the native Save dialog, so use the app's download fallback instead and
  // collect what it saves.
  await page.evaluateOnNewDocument(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
  rmSync(DOWNLOADS, { recursive: true, force: true });
  mkdirSync(DOWNLOADS, { recursive: true });
  await (await browser.target().createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  page.on('pageerror', (e) => console.log('  [page error]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('  [console error]', m.text()));
  await page.goto(url);
  return {
    browser, page, url,
    async close() {
      await browser.close();
      if (process.platform === 'win32' && server.pid) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { shell: true });
      else server.kill();
    },
  };
}

/** A real mouse click on a button by its visible text. */
export async function clickButton(page: Page, text: string): Promise<void> {
  const el = await findByText(page, 'button', text);
  await el.click();
}

export async function findByText(page: Page, selector: string, text: string): Promise<ElementHandle<Element>> {
  const handle = await page.evaluateHandle(
    (sel, t) => [...document.querySelectorAll(sel)].find((e) => e.textContent?.trim() === t || e.getAttribute('aria-label') === t),
    selector,
    text,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no ${selector} with text "${text}"`);
  return el;
}

/** Opens a PDF through the app's real file chooser, and waits for its first page to be interactive. */
export async function openPdf(page: Page, path: string): Promise<void> {
  const open = await findByText(page, 'button', 'Open');
  const [chooser] = await Promise.all([page.waitForFileChooser(), open.click()]);
  await chooser.accept([path]);
  await page.waitForSelector('svg.overlay', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.page-view canvas')?.getAttribute('width'), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 400)); // let the first render land
}

export async function chooseTool(page: Page, name: string): Promise<void> {
  const el = await findByText(page, '[role=radio]', name);
  await el.click();
}

/** Click at a point relative to the first page's top-left corner, with the real mouse. */
export async function clickOnPage(page: Page, dx: number, dy: number, pageIndex = 0): Promise<void> {
  const box = await (await page.$$('svg.overlay'))[pageIndex]!.boundingBox();
  if (!box) throw new Error('page not visible');
  await page.mouse.click(box.x + dx, box.y + dy);
}

/** A real double-click (two press/release pairs, so the browser fires `dblclick`). */
export async function doubleClickOnPage(page: Page, dx: number, dy: number, pageIndex = 0): Promise<void> {
  const box = await (await page.$$('svg.overlay'))[pageIndex]!.boundingBox();
  if (!box) throw new Error('page not visible');
  await page.mouse.click(box.x + dx, box.y + dy, { count: 2 });
}

export async function dragOnPage(page: Page, from: [number, number], to: [number, number], pageIndex = 0): Promise<void> {
  const box = await (await page.$$('svg.overlay'))[pageIndex]!.boundingBox();
  if (!box) throw new Error('page not visible');
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (from[0] + to[0]) / 2, box.y + (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 4 });
  await page.mouse.up();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
export function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`);
}
export const failureCount = () => failures;

/** Empties the downloads folder, so a scenario never mistakes an earlier scenario's file for its own. */
export function clearDownloads(): void {
  rmSync(DOWNLOADS, { recursive: true, force: true });
  mkdirSync(DOWNLOADS, { recursive: true });
}

/** Waits for a finished download in the downloads folder and returns its path. */
export async function waitForDownload(timeoutMs = 20000): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const done = readdirSync(DOWNLOADS).filter((f) => !f.endsWith('.crdownload') && !f.endsWith('.tmp'));
    if (done.length) {
      await sleep(200);
      return resolve(DOWNLOADS, done[0]!);
    }
    await sleep(100);
  }
  throw new Error('no download appeared');
}

export const count = (page: Page, selector: string) => page.$$eval(selector, (els) => els.length);
