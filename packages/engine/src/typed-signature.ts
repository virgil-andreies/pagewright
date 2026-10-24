import * as fontkitModule from '@cantoo/fontkit';
import { quadToCubic, type PathCmd, type Point, type SignatureArt } from '@pagewright/core';

// The package exposes `create` either at the top or under `default`, depending on the bundler and module format.
type Fontkit = typeof fontkitModule;
const fk: Fontkit = (fontkitModule as unknown as { create?: unknown }).create ? fontkitModule : (fontkitModule as unknown as { default: Fontkit }).default;

export interface TypedSignatureResult {
  art: SignatureArt;
  /** Characters none of the font's files could draw. They are left out of the artwork. */
  missing: string[];
}

/** A glyph outline's commands, which fontkit types do not describe. */
interface RawCommand {
  command: 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath';
  args: number[];
}

/** Height of one em in the artwork's units. */
const EM = 100;
const PADDING = 2;
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Draws `text` in a handwriting font as vector outlines.
 *
 * `fontFiles` are the font's files in order of preference, usually one per character set (Latin, extended Latin,
 * Cyrillic ...). Each character is drawn from the first file that has it, and the text is laid out run by run so
 * ligatures and contextual forms (which script fonts rely on to join their letters) are applied. The result is
 * plain path data in the artwork's units: y grows downwards and the top-left of the ink is at (padding, padding).
 * Returns undefined when nothing could be drawn.
 */
export function typedSignatureArt(fontFiles: readonly Uint8Array[], text: string): TypedSignatureResult | undefined {
  // (a font file, never a collection of fonts: those are .ttc files, which no style uses)
  const fonts = fontFiles.map((bytes) => fk.create(bytes) as fontkitModule.Font);
  const clean = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (fonts.length === 0 || clean === '') return undefined;

  // Which font draws each character; spaces go with their neighbour so a word is never split by a space.
  const owner: number[] = [];
  const missing: string[] = [];
  let last = 0;
  for (const ch of clean) {
    if (ch === ' ') {
      owner.push(last);
      continue;
    }
    const found = fonts.findIndex((f) => f.hasGlyphForCodePoint(ch.codePointAt(0)!));
    if (found < 0) {
      if (!missing.includes(ch)) missing.push(ch);
      continue; // left out: it has no entry in `owner`, so it is dropped below
    }
    owner.push((last = found));
  }
  const drawable = [...clean].filter((ch) => ch === ' ' || !missing.includes(ch));

  // Runs of consecutive characters from the same font.
  const runs: { font: number; text: string }[] = [];
  drawable.forEach((ch, i) => {
    const font = owner[i]!;
    const run = runs.at(-1);
    if (run && run.font === font) run.text += ch;
    else runs.push({ font, text: ch });
  });

  // Collect outlines in font units with y up, scaled to EM and flipped to y down.
  const cmds: PathCmd[] = [];
  let pen = 0;
  for (const run of runs) {
    const font = fonts[run.font]!;
    const k = EM / font.unitsPerEm;
    const laid = font.layout(run.text);
    laid.glyphs.forEach((glyph, i) => {
      const pos = laid.positions?.[i] ?? { xOffset: 0, yOffset: 0, xAdvance: glyph.advanceWidth };
      const ox = pen + pos.xOffset * k;
      const oy = -pos.yOffset * k;
      const at = (x: number, y: number): Point => ({ x: ox + x * k, y: oy - y * k });
      let cur: Point = { x: 0, y: 0 };
      for (const c of (glyph.path as unknown as { commands: RawCommand[] }).commands) {
        const a = c.args;
        if (c.command === 'moveTo') {
          cur = at(a[0]!, a[1]!);
          cmds.push(['M', cur.x, cur.y]);
        } else if (c.command === 'lineTo') {
          cur = at(a[0]!, a[1]!);
          cmds.push(['L', cur.x, cur.y]);
        } else if (c.command === 'quadraticCurveTo') {
          const q = at(a[0]!, a[1]!);
          const p = at(a[2]!, a[3]!);
          cmds.push(quadToCubic(cur, q, p));
          cur = p;
        } else if (c.command === 'bezierCurveTo') {
          const c1 = at(a[0]!, a[1]!);
          const c2 = at(a[2]!, a[3]!);
          cur = at(a[4]!, a[5]!);
          cmds.push(['C', c1.x, c1.y, c2.x, c2.y, cur.x, cur.y]);
        } else {
          cmds.push(['Z']);
        }
      }
      pen += pos.xAdvance * k;
    });
  }
  if (!cmds.some((c) => c[0] !== 'Z' && c[0] !== 'M')) return undefined; // only spaces or empty glyphs

  // Move the ink to the top-left corner with a little padding, and measure it.
  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of cmds) for (let i = 1; i < c.length; i += 2) (xs.push(c[i] as number), ys.push(c[i + 1] as number));
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const shift = (c: PathCmd): PathCmd => {
    if (c[0] === 'Z') return c;
    return [c[0], ...c.slice(1).map((n, i) => round((n as number) - (i % 2 === 0 ? minX : minY) + PADDING))] as unknown as PathCmd;
  };
  return {
    art: {
      w: round(Math.max(...xs) - minX + 2 * PADDING),
      h: round(Math.max(...ys) - minY + 2 * PADDING),
      paths: cmds.map(shift),
      mode: 'fill',
    },
    missing,
  };
}

/** A font as the signature maker needs it. */
export interface SignatureFontSource {
  id: string;
  label: string;
  /** Loads the font's files, most preferred first (for example Latin, then extended Latin, then Cyrillic). */
  load(): Promise<Uint8Array[]>;
}

/** What the editor asks for when it wants to turn typed text into artwork. */
export interface SignatureMaker {
  fonts: readonly { id: string; label: string }[];
  make(text: string, fontId: string): Promise<TypedSignatureResult>;
}

/** Wraps a set of fonts, loading each only when first used and keeping it for next time. */
export function createSignatureMaker(sources: readonly SignatureFontSource[]): SignatureMaker {
  const loaded = new Map<string, Promise<Uint8Array[]>>();
  return {
    fonts: sources.map(({ id, label }) => ({ id, label })),
    async make(text, fontId) {
      const source = sources.find((s) => s.id === fontId);
      if (!source) throw new Error(`Unknown signature style "${fontId}"`);
      let files = loaded.get(fontId);
      if (!files) {
        files = source.load();
        loaded.set(fontId, files);
        files.catch(() => loaded.delete(fontId)); // a failed load is tried again next time
      }
      const result = typedSignatureArt(await files, text);
      if (!result) throw new Error('There is nothing to draw: try a name with letters in it.');
      return result;
    },
  };
}
