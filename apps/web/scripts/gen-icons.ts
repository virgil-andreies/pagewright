// Renders public/favicon.svg into the PNG icons browsers and phones ask for, using Chrome (as the real-browser
// checks do), so the PNGs always match the SVG. Run from the repo root after changing the icon:
//   pnpm exec tsx apps/web/scripts/gen-icons.ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const PUBLIC = resolve(import.meta.dirname, '../public');
const SIZES: Record<string, number> = {
  'favicon-32.png': 32, // tabs and bookmarks in browsers without SVG icons
  'apple-touch-icon.png': 180, // iPhone and iPad home screens
  'icon-192.png': 192, // Android home screens (and a web app manifest, later)
  'icon-512.png': 512,
};

const chrome = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));
if (!chrome) throw new Error('No Chrome or Edge found. Set CHROME_PATH to its executable.');

const svg = readFileSync(resolve(PUBLIC, 'favicon.svg'), 'utf8');
const browser = await puppeteer.launch({ executablePath: chrome });
try {
  const page = await browser.newPage();
  for (const [name, size] of Object.entries(SIZES)) {
    await page.setViewport({ width: size, height: size });
    // iOS rounds home-screen icons itself and shows transparent corners as black: give it a square tile.
    const art = name === 'apple-touch-icon.png' ? svg.replace('rx="14" fill="#2563eb"', 'rx="0" fill="#2563eb"') : svg;
    await page.setContent(`<html><body style="margin:0;background:transparent">${art.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: resolve(PUBLIC, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log(`wrote ${name}`);
  }
} finally {
  await browser.close();
}
