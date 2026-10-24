import { UNICODE_SUBSETS, type FontFamily } from '@pagewright/core';

export { UNICODE_SUBSETS };

/**
 * The fonts used for text boxes with letters the standard PDF fonts lack (see core/unicode-text.ts). They are
 * open-licence (SIL OFL) Noto fonts from Fontsource, which splits each font into files by alphabet ("subsets").
 */
export const UNICODE_FAMILIES = {
  sans: '@fontsource/noto-sans',
  serif: '@fontsource/noto-serif',
  mono: '@fontsource/noto-sans-mono',
} as const satisfies Record<FontFamily, string>;

/** The file name of one subset of one family, e.g. `noto-sans-cyrillic-400-normal.woff`. */
export function unicodeFontFile(pkg: string, subset: string): string {
  return `${pkg.replace('@fontsource/', '')}-${subset}-400-normal.woff`;
}

/** Where the writer gets the font files it embeds. */
export interface UnicodeFontSource {
  load(family: FontFamily, subset: string): Promise<Uint8Array>;
}

/** A font source that fetches from URLs (`family/subset` -> URL), each file once. For the browser and the save worker. */
export function urlFontSource(urls: Readonly<Record<string, string>>): UnicodeFontSource {
  const cache = new Map<string, Promise<Uint8Array>>();
  return {
    load(family, subset) {
      const key = `${family}/${subset}`;
      let p = cache.get(key);
      if (!p) {
        const url = urls[key];
        if (!url) return Promise.reject(new Error(`The font for ${key} is missing.`));
        p = fetch(url).then(async (r) => {
          if (!r.ok) throw new Error(`Could not load a font needed to save the text (${r.status}).`);
          return new Uint8Array(await r.arrayBuffer());
        });
        p.catch(() => cache.delete(key)); // try again next time
        cache.set(key, p);
      }
      return p;
    },
  };
}
