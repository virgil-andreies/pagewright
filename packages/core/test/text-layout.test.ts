import { describe, expect, it } from 'vitest';
import {
  LINE_HEIGHT, TEXT_PADDING, fitFreeText, freeTextHandles, freeTextHeight, freeTextLines, isStandard, isSupported, layoutText,
  minTextWidth, resizeFreeText, sanitizeText, textWidth, toWinAnsi, winAnsiByte, type FreeTextAnnot,
} from '../src';

const freeText = (text: string, over: Partial<FreeTextAnnot> = {}): FreeTextAnnot => ({
  id: 't', pageId: 'p', author: '', createdAt: '', modifiedAt: '', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, origin: 'app',
  type: 'freetext', text, fontSize: 12, fontFamily: 'sans', rect: { x: 10, y: 100, w: 100, h: 20 }, ...over,
});

describe('font metrics', () => {
  it('uses the real Helvetica, Times and Courier advance widths', () => {
    expect(textWidth('sans', ' ', 1000)).toBe(278);
    expect(textWidth('sans', 'A', 1000)).toBe(667);
    expect(textWidth('serif', 'A', 1000)).toBe(722);
    expect(textWidth('mono', 'Ag. ', 1000)).toBe(4 * 600);
    expect(textWidth('sans', 'Hello', 12)).toBeCloseTo(((722 + 556 + 222 + 222 + 556) * 12) / 1000, 6);
  });

  it('scales linearly with the font size and adds up over characters', () => {
    expect(textWidth('serif', 'abc', 20)).toBeCloseTo(2 * textWidth('serif', 'abc', 10), 9);
    expect(textWidth('sans', 'ab', 10)).toBeCloseTo(textWidth('sans', 'a', 10) + textWidth('sans', 'b', 10), 9);
  });

  it('knows which characters the standard fonts can show', () => {
    for (const ch of ['a', 'Z', '0', ' ', 'é', 'ñ', 'ü', '€', '“', '”', '—', '£']) expect(isStandard(ch), ch).toBe(true);
    for (const ch of ['Ω', 'я', 'ă', 'ł', '日', '😀', 'ا']) expect(isStandard(ch), ch).toBe(false);
  });

  it('knows which characters a text box can show at all: the standard fonts, or the embedded ones', () => {
    for (const ch of ['a', '€', 'ă', 'ș', 'ț', 'ł', 'ő', 'ř', 'ğ', 'Ω', 'λ', 'я', 'Ж', 'ї', 'ệ', 'ơ', '₴']) expect(isSupported(ch), ch).toBe(true);
    for (const ch of ['日', '한', '😀', 'ا', 'ש', 'क', '\u0306']) expect(isSupported(ch), ch).toBe(false);
  });

  it('maps characters to WinAnsi bytes', () => {
    expect(winAnsiByte('A')).toBe(0x41);
    expect(winAnsiByte('é')).toBe(0xe9);
    expect(winAnsiByte('€')).toBe(0x80);
    expect(winAnsiByte('Ω')).toBeUndefined();
    expect([...toWinAnsi('Aé€Ω')]).toEqual([0x41, 0xe9, 0x80, 0x3f]);
  });

  it('measures an unsupported character as the ? that will be drawn', () => {
    expect(textWidth('sans', 'Ω', 10)).toBe(textWidth('sans', '?', 10));
  });
});

describe('sanitizeText', () => {
  it('keeps supported text untouched', () => {
    expect(sanitizeText('Crème brûlée, 5 €')).toEqual({ text: 'Crème brûlée, 5 €', replaced: 0 });
  });

  it('normalises line endings and tabs', () => {
    expect(sanitizeText('a\r\nb\rc\td').text).toBe('a\nb\nc    d');
  });

  it('keeps other alphabets, and replaces what cannot be shown, one per character even for emoji', () => {
    expect(sanitizeText('Привет 😀 ok')).toEqual({ text: 'Привет ? ok', replaced: 1 });
    expect(sanitizeText('日本 שלום')).toEqual({ text: '?? ????', replaced: 6 });
  });

  it('joins accents typed separately to their letters, so they can be shown', () => {
    expect(sanitizeText('Ba\u0306ies\u0326 Ta\u0306')).toEqual({ text: 'Băieș Tă', replaced: 0 });
  });

  it('drops control characters silently', () => {
    expect(sanitizeText('a\u0000b\u0007c\u007fd')).toEqual({ text: 'abcd', replaced: 0 });
  });

  it('is idempotent', () => {
    const once = sanitizeText('x\ty Ω\r\nz').text;
    expect(sanitizeText(once)).toEqual({ text: once, replaced: 0 });
  });
});

describe('layoutText', () => {
  const widest = (lines: string[], family = 'sans' as const, size = 12) => Math.max(...lines.map((l) => textWidth(family, l, size)));

  it('keeps short text on one line', () => {
    expect(layoutText('Hello world', 'sans', 12, 500)).toEqual(['Hello world']);
  });

  it('wraps at word boundaries without exceeding the width', () => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps running far away';
    const lines = layoutText(text, 'sans', 12, 100);
    expect(lines.length).toBeGreaterThan(3);
    expect(widest(lines)).toBeLessThanOrEqual(100);
    expect(lines.join(' ')).toBe(text); // nothing lost, nothing added
  });

  it('never starts a wrapped line with a space and never ends one with a space', () => {
    for (const l of layoutText('one two three four five six seven eight nine ten', 'serif', 12, 60)) {
      expect(l).toBe(l.trim());
    }
  });

  it('keeps explicit newlines and blank lines', () => {
    expect(layoutText('a\n\nb\n', 'sans', 12, 500)).toEqual(['a', '', 'b', '']);
  });

  it('keeps runs of spaces inside a line', () => {
    expect(layoutText('a   b', 'sans', 12, 500)).toEqual(['a   b']);
  });

  it('breaks a word that is longer than a line, between characters', () => {
    const lines = layoutText('Supercalifragilisticexpialidocious', 'mono', 10, 60); // 10 monospace chars per line
    expect(lines.every((l) => l.length <= 10)).toBe(true);
    expect(lines.join('')).toBe('Supercalifragilisticexpialidocious');
  });

  it('puts a long word on its own line instead of splitting a short one before it', () => {
    expect(layoutText('hi Supercalifragilisticexpialidocious', 'mono', 10, 60)).toEqual([
      'hi', 'Supercalif', 'ragilistic', 'expialidoc', 'ious',
    ]);
  });

  it('always makes progress, even when nothing fits', () => {
    const lines = layoutText('wide', 'sans', 36, 1);
    expect(lines.join('')).toBe('wide');
    expect(layoutText('abc', 'sans', 12, 0).join('')).toBe('abc');
  });

  it('returns one empty line for empty text', () => {
    expect(layoutText('', 'sans', 12, 100)).toEqual(['']);
  });

  it('is the same for any text that survives sanitising (no characters lost, any width)', () => {
    const samples = ['The rain in Spain stays mainly in the plain.', 'Ünïcödé — “quoted” text € 5', 'a b  c   d\ne f', 'x'.repeat(80)];
    for (const text of samples) {
      for (const width of [15, 40, 90, 250]) {
        for (const family of ['sans', 'serif', 'mono'] as const) {
          const lines = layoutText(text, family, 12, width);
          expect(lines.join('').replace(/\s/g, ''), `${family} ${width}`).toBe(text.replace(/\s/g, ''));
        }
      }
    }
  });

  it('wraps differently for different fonts, because the widths differ', () => {
    const text = 'iiiiiiiiii WWWWWWWWWW';
    expect(layoutText(text, 'sans', 12, 80)).not.toEqual(layoutText(text, 'mono', 12, 80));
  });
});

describe('fitting a text box', () => {
  it('sizes the height to the wrapped lines plus padding', () => {
    const a = freeText('one\ntwo\nthree');
    expect(freeTextLines(a)).toEqual(['one', 'two', 'three']);
    expect(freeTextHeight(3, 12)).toBeCloseTo(3 * 12 * LINE_HEIGHT + 2 * TEXT_PADDING);
    expect(fitFreeText(a).rect.h).toBeCloseTo(3 * 12 * LINE_HEIGHT + 2 * TEXT_PADDING);
  });

  it('keeps the top edge where it was, since PDF grows upwards from the bottom', () => {
    const a = freeText('one\ntwo\nthree');
    const top = a.rect.y + a.rect.h;
    const fitted = fitFreeText(a);
    expect(fitted.rect.y + fitted.rect.h).toBeCloseTo(top);
    expect(fitted.rect.y).toBeLessThan(a.rect.y); // grew downwards on the page
  });

  it('gives an empty box one line of height and is idempotent', () => {
    const empty = fitFreeText(freeText(''));
    expect(empty.rect.h).toBeCloseTo(freeTextHeight(1, 12));
    expect(fitFreeText(empty)).toBe(empty);
  });

  it('grows when the font gets bigger and wraps more', () => {
    const small = fitFreeText(freeText('some words that will need wrapping around', { fontSize: 10 }));
    const big = fitFreeText(freeText('some words that will need wrapping around', { fontSize: 24 }));
    expect(big.rect.h).toBeGreaterThan(small.rect.h * 2);
  });
});

describe('resizing a text box', () => {
  const box = freeText('word '.repeat(12).trim(), { rect: { x: 50, y: 200, w: 200, h: 40 } });

  it('offers handles in the middle of the left and right edges', () => {
    const a = fitFreeText(box);
    expect(freeTextHandles(a)).toEqual([
      { id: 'w', at: { x: 50, y: a.rect.y + a.rect.h / 2 } },
      { id: 'e', at: { x: 250, y: a.rect.y + a.rect.h / 2 } },
    ]);
  });

  it('moves the right edge and keeps the left, re-fitting the height', () => {
    const wide = resizeFreeText(fitFreeText(box), 'e', { x: 400, y: 0 });
    expect(wide.rect).toMatchObject({ x: 50, w: 350 });
    const narrow = resizeFreeText(fitFreeText(box), 'e', { x: 100, y: 0 });
    expect(narrow.rect.w).toBe(50);
    expect(narrow.rect.h).toBeGreaterThan(wide.rect.h); // narrower means more lines
  });

  it('moves the left edge and keeps the right', () => {
    const r = resizeFreeText(fitFreeText(box), 'w', { x: 20, y: 0 });
    expect(r.rect.x).toBe(20);
    expect(r.rect.x + r.rect.w).toBe(250);
  });

  it('never gets narrower than the minimum, from either side', () => {
    const min = minTextWidth(12);
    expect(resizeFreeText(box, 'e', { x: 0, y: 0 }).rect.w).toBe(min);
    const w = resizeFreeText(box, 'w', { x: 1000, y: 0 });
    expect(w.rect.w).toBe(min);
    expect(w.rect.x + w.rect.w).toBe(250);
  });

  it('keeps the top edge fixed while the height changes', () => {
    const fitted = fitFreeText(box);
    const top = fitted.rect.y + fitted.rect.h;
    const r = resizeFreeText(fitted, 'e', { x: 120, y: 0 });
    expect(r.rect.y + r.rect.h).toBeCloseTo(top);
  });
});
