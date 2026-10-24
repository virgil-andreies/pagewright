import type { FreeTextAnnot } from './annotations';
import type { FontFamily } from './text-layout';
import { UNICODE_RUNS } from './unicode-font-data';

export { UNICODE_RUNS };

/**
 * Text boxes are written with the standard PDF fonts (Helvetica, Times, Courier) when they can be: those need no
 * embedding and every viewer has them, but they only cover Western European text (WinAnsi). A box with any other
 * letter (Polish, Czech, Romanian, Cyrillic, Greek, Vietnamese...) is written instead with Noto Sans, Noto Serif or
 * Noto Sans Mono, embedding only the letters used. The whole box changes font, never a single line, so it reads
 * evenly. Scripts that need a shaping engine (Arabic, Hebrew, Indic) or very large fonts (Chinese, Japanese, Korean)
 * are not covered and still become `?`.
 *
 * The Noto fonts come split by alphabet into several files ("subsets"); each character is drawn from the first
 * file that has it, so a line may use more than one font object in the PDF.
 */
export const UNICODE_SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese'] as const;

type Entry = readonly [subset: number, width: number];

const tables = new Map<FontFamily, Map<number, Entry>>();
function table(family: FontFamily): Map<number, Entry> {
  let t = tables.get(family);
  if (!t) {
    t = new Map();
    for (const run of UNICODE_RUNS[family] as readonly (readonly number[])[]) {
      const [first, subset] = run as readonly [number, number];
      for (let i = 2; i < run.length; i++) t.set(first + i - 2, [subset, run[i]!]);
    }
    tables.set(family, t);
  }
  return t;
}

/** Whether the Noto fonts can show this character (in every family). */
export function hasUnicodeGlyph(ch: string): boolean {
  return table('sans').has(ch.codePointAt(0)!);
}

/** Advance width of one character in the family's Noto font, in 1/1000 em; undefined if it has none. */
export function unicodeWidth(family: FontFamily, ch: string): number | undefined {
  return table(family).get(ch.codePointAt(0)!)?.[1];
}

/** The pieces of a line that come from the same font file, in order. */
export function unicodeRuns(family: FontFamily, line: string): { subset: number; text: string }[] {
  const t = table(family);
  const out: { subset: number; text: string }[] = [];
  for (const ch of line) {
    const subset = t.get(ch.codePointAt(0)!)?.[0] ?? 0; // (layout never lets an unknown character get this far)
    const last = out[out.length - 1];
    if (last && last.subset === subset) last.text += ch;
    else out.push({ subset, text: ch });
  }
  return out;
}

/**
 * Whether a free-text box needs the embedded fonts: one of its characters is outside what the standard fonts show,
 * and the embedded fonts have it. (A character neither has is drawn as `?`, which needs no change of font.)
 */
export function usesUnicodeFont(a: Pick<FreeTextAnnot, 'text'>, isStandard: (ch: string) => boolean): boolean {
  for (const ch of a.text) if (ch !== '\n' && !isStandard(ch) && hasUnicodeGlyph(ch)) return true;
  return false;
}
