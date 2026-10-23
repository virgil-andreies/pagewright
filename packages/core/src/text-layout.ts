import type { FreeTextAnnot, Point } from './annotations';
import { WIDTHS, WIN_ANSI } from './font-data';

/**
 * Text layout for free-text annotations, shared by the editor and the PDF writer so line breaks are
 * identical in both. It uses the real advance widths of the standard PDF fonts (Helvetica, Times, Courier),
 * which every viewer has and which need no embedding. They cover Western European text (WinAnsi); other
 * scripts are not representable and are replaced by `?` (see `sanitizeText`).
 */
export type FontFamily = FreeTextAnnot['fontFamily'];

/** Space between the box edge and the text, on every side. */
export const TEXT_PADDING = 2;
/** Line pitch as a multiple of the font size. */
export const LINE_HEIGHT = 1.2;
/** Where the first baseline sits below the top of its line box, as a multiple of the font size. */
export const BASELINE_RATIO = 0.86;
export const DEFAULT_TEXT_WIDTH = 160;
export const DEFAULT_FONT_SIZE = 12;
export const FONT_SIZES = [8, 10, 12, 14, 18, 24, 36] as const;

const byCodePoint = new Map<number, number>(WIN_ANSI as readonly (readonly [number, number])[]);
const FALLBACK = '?';

/** WinAnsi byte for a character, or undefined if the standard fonts cannot show it. */
export function winAnsiByte(ch: string): number | undefined {
  return byCodePoint.get(ch.codePointAt(0)!);
}

export function isSupported(ch: string): boolean {
  return byCodePoint.has(ch.codePointAt(0)!);
}

/**
 * Normalises typed text for storage: line endings become `\n`, tabs become four spaces, other control
 * characters are dropped, and anything the standard fonts cannot show becomes `?`. What is stored is
 * exactly what will be drawn and saved. `replaced` counts the characters that were lost, so the UI can say so.
 */
export function sanitizeText(input: string): { text: string; replaced: number } {
  let replaced = 0;
  let out = '';
  for (const ch of input.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')) {
    if (ch === '\n' || isSupported(ch)) out += ch;
    else if (ch.codePointAt(0)! < 32 || ch === '\u007f') continue; // control characters
    else (out += FALLBACK), replaced++;
  }
  return { text: out, replaced };
}

/** Width of a single line in points. Characters outside WinAnsi count as `?`, as they will be drawn. */
export function textWidth(family: FontFamily, text: string, size: number): number {
  const table = WIDTHS[family] as Record<number, number>;
  let units = 0;
  for (const ch of text) units += table[winAnsiByte(ch) ?? winAnsiByte(FALLBACK)!]!;
  return (units * size) / 1000;
}

/** The text as WinAnsi bytes, ready for a PDF string. Unsupported characters become `?`. */
export function toWinAnsi(text: string): Uint8Array {
  return Uint8Array.from([...text].map((ch) => winAnsiByte(ch) ?? winAnsiByte(FALLBACK)!));
}

/**
 * Greedy word wrap into lines no wider than `maxWidth`. Explicit newlines are kept, runs of spaces are kept
 * inside a line and dropped at a wrap, and a word longer than a line is broken between characters.
 */
export function layoutText(text: string, family: FontFamily, size: number, maxWidth: number): string[] {
  const fits = (s: string) => textWidth(family, s, size) <= maxWidth;
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    let line = '';
    for (let token of paragraph.split(/( +)/).filter((t) => t !== '')) {
      if (fits(line + token)) {
        line += token;
        continue;
      }
      if (token.trim() === '') {
        // Spaces that would overflow end the line and vanish.
        lines.push(line.trimEnd());
        line = '';
        continue;
      }
      if (line.trim() !== '') {
        lines.push(line.trimEnd());
        line = '';
      }
      // Break a word that is wider than a whole line; always take at least one character so we progress.
      while (!fits(token)) {
        const chars = [...token];
        let n = 1;
        while (n < chars.length && fits(chars.slice(0, n + 1).join(''))) n++;
        lines.push(chars.slice(0, n).join(''));
        token = chars.slice(n).join('');
      }
      line = token;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export function lineAdvance(fontSize: number): number {
  return fontSize * LINE_HEIGHT;
}

/** The lines of a free-text annotation, wrapped to its current width. */
export function freeTextLines(a: FreeTextAnnot): string[] {
  return layoutText(a.text, a.fontFamily, a.fontSize, Math.max(0, a.rect.w - 2 * TEXT_PADDING));
}

export function freeTextHeight(lineCount: number, fontSize: number): number {
  return Math.max(1, lineCount) * lineAdvance(fontSize) + 2 * TEXT_PADDING;
}

/**
 * Makes the box exactly tall enough for its text. The top edge stays where it is, because PDF's origin is at
 * the bottom and the text grows downwards from the top.
 */
export function fitFreeText(a: FreeTextAnnot): FreeTextAnnot {
  const h = freeTextHeight(freeTextLines(a).length, a.fontSize);
  if (Math.abs(h - a.rect.h) < 1e-9) return a;
  return { ...a, rect: { ...a.rect, y: a.rect.y + a.rect.h - h, h } };
}

export type TextHandle = 'w' | 'e';

/** Text boxes resize by width only; the height follows the wrapped text. */
export function freeTextHandles(a: FreeTextAnnot): { id: TextHandle; at: Point }[] {
  const midY = a.rect.y + a.rect.h / 2;
  return [
    { id: 'w', at: { x: a.rect.x, y: midY } },
    { id: 'e', at: { x: a.rect.x + a.rect.w, y: midY } },
  ];
}

export function minTextWidth(fontSize: number): number {
  return Math.max(20, fontSize * 2);
}

/** Moves the left or right edge to `to.x` (keeping the other edge) and re-fits the height. */
export function resizeFreeText(a: FreeTextAnnot, handle: TextHandle, to: Point): FreeTextAnnot {
  const min = minTextWidth(a.fontSize);
  const left = a.rect.x;
  const right = a.rect.x + a.rect.w;
  const next =
    handle === 'e'
      ? { x: left, w: Math.max(min, to.x - left) }
      : { x: Math.min(to.x, right - min), w: Math.max(min, right - to.x) };
  return fitFreeText({ ...a, rect: { ...a.rect, ...next } });
}
