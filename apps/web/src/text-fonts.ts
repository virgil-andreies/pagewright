import { UNICODE_FAMILIES, UNICODE_SUBSETS } from '@pagewright/engine';
// The same fonts as web fonts, so the editor shows text boxes in other alphabets with the glyphs the PDF will have.
// Each loads only the alphabets a page actually uses.
import '@fontsource/noto-sans/400.css';
import '@fontsource/noto-serif/400.css';
import '@fontsource/noto-sans-mono/400.css';

// URLs of the font files the save worker embeds from, resolved by the bundler. Nothing is downloaded until a
// document with such a text box is saved, and then only the files it needs.
const files = import.meta.glob('/node_modules/@fontsource/noto-*/files/*-400-normal.woff', { query: '?url', import: 'default', eager: true }) as Record<string, string>;

/** `family/subset` -> absolute URL (the worker resolves URLs against its own script, so they must be absolute). */
export const unicodeFontUrls: Record<string, string> = {};
for (const [family, pkg] of Object.entries(UNICODE_FAMILIES)) {
  const name = pkg.replace('@fontsource/', '');
  for (const subset of UNICODE_SUBSETS) {
    const url = files[`/node_modules/${pkg}/files/${name}-${subset}-400-normal.woff`];
    if (url) unicodeFontUrls[`${family}/${subset}`] = new URL(url, location.href).href;
  }
}
