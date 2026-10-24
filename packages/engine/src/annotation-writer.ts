import { UNICODE_SUBSETS, freeTextLines, freeTextUnicode, unicodeRuns, annotationBounds, NOTE_SIZE, type Annotation, type FontFamily, type FreeTextAnnot, type InkAnnot, type NoteAnnot, type RGBA, type ShapeAnnot, type StampAnnot, stampPreset } from '@pagewright/core';
import {
  PDFArray, PDFBool, PDFDict, PDFHexString, PDFName, PDFString,
  type PDFDocument, type PDFFont, type PDFPage, type PDFRef,
} from '@cantoo/pdf-lib';
import { UNICODE_FAMILIES, type UnicodeFontSource } from './unicode-fonts';
import fontkit from '@cantoo/fontkit';
import { woffToSfnt } from './woff';
import { buildFreeTextAppearance, buildInkAppearance, buildNoteAppearance, buildShapeAppearance, buildImageStampAppearance, buildSignatureAppearance, buildStampAppearance, buildTextMarkupAppearance, type AppearanceStream } from './appearance';

export interface WriteContext {
  pdf: PDFDocument;
  page: PDFPage;
  /**
   * Image stamps' pictures, already embedded in `pdf` (embedding is asynchronous, writing is not). Keyed by the
   * payload's bytes, so a stamp that was duplicated shares one image object in the file. See `embedStampImages`.
   */
  images?: ReadonlyMap<Uint8Array, PDFRef>;
  /** Embedded fonts for text in other alphabets, keyed `family/subset index`. See `embedUnicodeFonts`. */
  fonts?: ReadonlyMap<string, PDFFont>;
}

export class UnsupportedAnnotation extends Error {
  constructor(readonly annotType: string) {
    super(`Writing "${annotType}" annotations is not implemented yet`);
  }
}

export interface AnnotationWriter {
  /** Adds `annot` to the page as a real annotation with /AP and /NM = annot.id. */
  write(ctx: WriteContext, annot: Annotation): PDFRef;
}

type TextMarkup = Extract<Annotation, { type: 'highlight' | 'underline' | 'strikeout' }>;

const SUBTYPE = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut' } as const;

const colorArray = (c: RGBA) => [c.r, c.g, c.b];

/** PDF date string: D:YYYYMMDDHHmmSSZ */
export function pdfDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `D:${d.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
}

type FontKey = FontFamily | 'sansBold';

const FONTS: Record<FontKey, { base: string; da: string }> = {
  sans: { base: 'Helvetica', da: 'Helv' },
  sansBold: { base: 'Helvetica-Bold', da: 'HeBo' },
  serif: { base: 'Times-Roman', da: 'TiRo' },
  mono: { base: 'Courier', da: 'Cour' },
};

/** One font object per family per document, shared by every annotation that uses it. */
const fontRefs = new WeakMap<PDFDocument, Map<FontKey, PDFRef>>();

function standardFont(pdf: PDFDocument, family: FontKey): PDFRef {
  let perDoc = fontRefs.get(pdf);
  if (!perDoc) fontRefs.set(pdf, (perDoc = new Map()));
  let ref = perDoc.get(family);
  if (!ref) {
    ref = pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: FONTS[family].base, Encoding: 'WinAnsiEncoding' }));
    perDoc.set(family, ref);
  }
  return ref;
}

/**
 * Embeds the picture of every image stamp that will be written, once per distinct image. Call before writing the
 * annotations, and pass the result as `WriteContext.images`. A picture pdf-lib cannot read fails the save with a
 * message that says which stamp is the problem, rather than writing a stamp that shows nothing.
 */
export async function embedStampImages(pdf: PDFDocument, annots: Iterable<Annotation>): Promise<Map<Uint8Array, PDFRef>> {
  const refs = new Map<Uint8Array, PDFRef>();
  for (const a of annots) {
    if (a.type !== 'stamp' || a.origin === 'imported' || a.payload.kind !== 'image' || refs.has(a.payload.bytes)) continue;
    const { bytes, mime } = a.payload;
    try {
      const image = mime === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      refs.set(bytes, image.ref);
    } catch (e) {
      throw new Error(`An image stamp could not be saved because its picture is damaged (${e instanceof Error ? e.message : String(e)}). Delete it and add the image again.`);
    }
  }
  return refs;
}

/**
 * Turning off what would make the font draw other glyphs than the characters one by one (ligatures, contextual
 * forms, composed accents): the layout counts each character's own width, and the editor draws them the same way.
 */
const PLAIN_GLYPHS = { liga: false, clig: false, calt: false, rlig: false, dlig: false, ccmp: false, locl: false, kern: false };

const fontKey = (family: string, subset: number) => `${family}/${subset}`;

/**
 * Embeds the fonts that text boxes in other alphabets need: for each family, only the files (subsets) whose
 * letters are used, and of those only the glyphs used (pdf-lib subsets the font when the file is saved).
 * Call before writing the annotations, and pass the result as `WriteContext.fonts`.
 */
export async function embedUnicodeFonts(pdf: PDFDocument, annots: Iterable<Annotation>, source: UnicodeFontSource | undefined): Promise<Map<string, PDFFont>> {
  const needed = new Map<string, { family: FreeTextAnnot['fontFamily']; subset: number }>();
  for (const a of annots) {
    if (a.type !== 'freetext' || a.origin === 'imported' || !freeTextUnicode(a)) continue;
    for (const line of freeTextLines(a)) for (const r of unicodeRuns(a.fontFamily, line)) needed.set(fontKey(a.fontFamily, r.subset), { family: a.fontFamily, subset: r.subset });
  }
  const fonts = new Map<string, PDFFont>();
  if (needed.size === 0) return fonts;
  if (!source) throw new Error('Text boxes in other alphabets cannot be saved here, because the fonts they need are not available.');
  pdf.registerFontkit(fontkit);
  for (const [key, { family, subset }] of needed) {
    const bytes = await woffToSfnt(await source.load(family, UNICODE_SUBSETS[subset]!));
    // A subset font's name starts with a six-letter tag and '+' (PDF 32000 9.6.4), unique per subset in the file.
    const tag = `PW${String.fromCharCode(65 + ['sans', 'serif', 'mono'].indexOf(family))}${String.fromCharCode(65 + subset)}AA`;
    const name = `${tag}+${UNICODE_FAMILIES[family].replace('@fontsource/', '').replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase())}`;
    fonts.set(key, await pdf.embedFont(bytes, { subset: true, features: PLAIN_GLYPHS, customName: name }));
  }
  return fonts;
}

function registerAppearance(ctx: WriteContext, ap: AppearanceStream, image?: PDFRef): PDFRef {
  const { context } = ctx.pdf;
  const gs = context.obj({
    Type: 'ExtGState',
    ca: ap.opacity,
    CA: ap.opacity,
    ...(ap.multiply ? { BM: 'Multiply' } : {}),
  });
  const stream = context.stream(`/GS gs\n${ap.content}`, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: ap.bbox,
    Resources: context.obj({
      ExtGState: context.obj({ GS: gs }),
      ...(ap.font ? { Font: context.obj({ F1: standardFont(ctx.pdf, ap.font) }) } : {}),
      ...(image ? { XObject: context.obj({ Im1: image }) } : {}),
      ...(ap.unicodeFonts
        ? { Font: context.obj(Object.fromEntries(ap.unicodeFonts.subsets.map((s) => [`U${s}`, ctx.fonts!.get(fontKey(ap.unicodeFonts!.family, s))!.ref]))) }
        : {}),
    }),
  });
  return context.register(stream);
}

/** Print + NoZoom + NoRotate: what viewers use for note icons, which stay upright and the same size. */
const NOTE_FLAGS = 4 + 8 + 16;

export class DefaultAnnotationWriter implements AnnotationWriter {
  write(ctx: WriteContext, annot: Annotation): PDFRef {
    const ref = this.writeOne(ctx, annot);
    this.writeReplies(ctx, annot, ref);
    return ref;
  }

  /**
   * Replies are /Text annotations that point at their parent with /IRT and /RT /R, which is how Acrobat and
   * other viewers rebuild a comment thread. They sit at the parent's upper-left corner and have no
   * appearance of their own, so viewers stack their icon under the parent's.
   */
  private writeReplies(ctx: WriteContext, annot: Annotation, parent: PDFRef): void {
    const replies = annot.comment?.replies ?? [];
    if (replies.length === 0) return;
    const b = annotationBounds(annot);
    const rect = [b.x, b.y + b.h - NOTE_SIZE, b.x + NOTE_SIZE, b.y + b.h];
    const { context } = ctx.pdf;
    for (const reply of replies) {
      const dict = context.obj({ Type: 'Annot', Subtype: 'Text', Name: 'Comment', Rect: rect, F: NOTE_FLAGS, Open: false });
      dict.set(PDFName.of('IRT'), parent);
      dict.set(PDFName.of('RT'), PDFName.of('R'));
      dict.set(PDFName.of('NM'), PDFHexString.fromText(reply.id));
      dict.set(PDFName.of('T'), PDFHexString.fromText(reply.author));
      dict.set(PDFName.of('M'), PDFString.of(pdfDate(reply.createdAt)));
      dict.set(PDFName.of('CreationDate'), PDFString.of(pdfDate(reply.createdAt)));
      dict.set(PDFName.of('Contents'), PDFHexString.fromText(reply.text));
      this.attach(ctx, dict);
    }
  }

  private writeOne(ctx: WriteContext, annot: Annotation): PDFRef {
    switch (annot.type) {
      case 'highlight':
      case 'underline':
      case 'strikeout':
        return this.writeTextMarkup(ctx, annot);
      case 'ink':
        return this.writeInk(ctx, annot);
      case 'shape':
        return this.writeShape(ctx, annot);
      case 'note':
        return this.writeNote(ctx, annot);
      case 'freetext':
        return this.writeFreeText(ctx, annot);
      case 'stamp':
        return this.writeStamp(ctx, annot);
      default: {
        // Every annotation type is written. If a new one is added to the model, this stops compiling until it is handled.
        const unhandled: never = annot;
        throw new UnsupportedAnnotation(String((unhandled as { type?: string }).type));
      }
    }
  }

  private writeTextMarkup(ctx: WriteContext, annot: TextMarkup): PDFRef {
    const ap = buildTextMarkupAppearance(annot);
    // Underline/strikeout strokes extend past the quad edge; widen the box so they are not clipped.
    if (annot.type !== 'highlight') {
      const [a, b, c, d] = ap.bbox;
      ap.bbox = [a - 1, b - 1, c + 1, d + 1];
    }
    const dict = this.commonEntries(ctx, annot, SUBTYPE[annot.type], ap.bbox);
    dict.set(
      PDFName.of('QuadPoints'),
      ctx.pdf.context.obj(
        annot.quads.flatMap((q) => [q.p1.x, q.p1.y, q.p2.x, q.p2.y, q.p3.x, q.p3.y, q.p4.x, q.p4.y]),
      ),
    );
    dict.set(PDFName.of('AP'), ctx.pdf.context.obj({ N: registerAppearance(ctx, ap) }));
    return this.attach(ctx, dict);
  }

  private writeInk(ctx: WriteContext, annot: InkAnnot): PDFRef {
    const ap = buildInkAppearance(annot);
    const { context } = ctx.pdf;
    const dict = this.commonEntries(ctx, annot, 'Ink', ap.bbox);
    dict.set(PDFName.of('InkList'), context.obj(annot.strokes.filter((s) => s.length > 0).map((s) => s.flatMap((p) => [p.x, p.y]))));
    dict.set(PDFName.of('BS'), context.obj({ W: annot.width, S: 'S' }));
    dict.set(PDFName.of('AP'), context.obj({ N: registerAppearance(ctx, ap) }));
    return this.attach(ctx, dict);
  }

  private writeFreeText(ctx: WriteContext, annot: FreeTextAnnot): PDFRef {
    const fonts = ctx.fonts;
    const ap = buildFreeTextAppearance(annot, (family, subset, text) => {
      const font = fonts?.get(fontKey(family, subset));
      if (!font) throw new UnsupportedAnnotation('freetext (font not embedded)');
      return font.encodeText(text).toString();
    });
    const { context } = ctx.pdf;
    const dict = this.commonEntries(ctx, annot, 'FreeText', ap.bbox);
    // For FreeText, /C is the box background, not the text colour: leave it out so viewers draw no fill.
    dict.delete(PDFName.of('C'));
    // /Contents is the visible text here, so a separate comment text has no place to live (replies still do).
    dict.set(PDFName.of('Contents'), PDFHexString.fromText(annot.text));
    dict.set(PDFName.of('DA'), PDFString.of(`${colorArray(annot.color).join(' ')} rg /${FONTS[annot.fontFamily].da} ${annot.fontSize} Tf`));
    dict.set(PDFName.of('Q'), ctx.pdf.context.obj(0));
    dict.set(PDFName.of('BS'), context.obj({ W: 0, S: 'S' }));
    dict.set(PDFName.of('AP'), context.obj({ N: registerAppearance(ctx, ap) }));
    return this.attach(ctx, dict);
  }

  private writeStamp(ctx: WriteContext, annot: StampAnnot): PDFRef {
    let name: string;
    let subject: string;
    let ap: AppearanceStream;
    let image: PDFRef | undefined;
    if (annot.payload.kind === 'preset') {
      const preset = stampPreset(annot.payload.name);
      if (!preset) throw new UnsupportedAnnotation(`stamp "${annot.payload.name}"`);
      [name, subject, ap] = [preset.name, preset.label, buildStampAppearance(annot)];
    } else if (annot.payload.kind === 'signature') {
      [name, subject, ap] = ['Signature', 'Signature', buildSignatureAppearance(annot)];
    } else {
      image = ctx.images?.get(annot.payload.bytes);
      // Without the embedded picture the stamp would be an empty box: refuse rather than lose the image silently.
      if (!image) throw new UnsupportedAnnotation('stamp (image not embedded)');
      [name, subject, ap] = ['Image', 'Image', buildImageStampAppearance(annot)];
    }
    const dict = this.commonEntries(ctx, annot, 'Stamp', ap.bbox);
    // /Name is the stamp's icon name and /Subj is what viewers list it as. /Contents stays free for a comment.
    dict.set(PDFName.of('Name'), PDFName.of(name));
    dict.set(PDFName.of('Subj'), PDFHexString.fromText(subject));
    dict.set(PDFName.of('AP'), ctx.pdf.context.obj({ N: registerAppearance(ctx, ap, image) }));
    return this.attach(ctx, dict);
  }

  private writeNote(ctx: WriteContext, annot: NoteAnnot): PDFRef {
    const ap = buildNoteAppearance(annot);
    const dict = this.commonEntries(ctx, annot, 'Text', ap.bbox);
    dict.set(PDFName.of('Name'), PDFName.of(annot.icon === 'comment' ? 'Comment' : 'Note'));
    dict.set(PDFName.of('F'), ctx.pdf.context.obj(NOTE_FLAGS));
    dict.set(PDFName.of('Open'), PDFBool.False);
    dict.set(PDFName.of('AP'), ctx.pdf.context.obj({ N: registerAppearance(ctx, ap) }));
    return this.attach(ctx, dict);
  }

  private writeShape(ctx: WriteContext, annot: ShapeAnnot): PDFRef {
    const ap = buildShapeAppearance(annot);
    const { context } = ctx.pdf;
    const subtype = { rect: 'Square', ellipse: 'Circle', line: 'Line', arrow: 'Line' }[annot.shape];
    const dict = this.commonEntries(ctx, annot, subtype, ap.bbox);
    dict.set(PDFName.of('BS'), context.obj({ W: annot.width, S: 'S' }));
    if (annot.shape === 'line' || annot.shape === 'arrow') {
      const [a, b] = annot.line ?? [{ x: annot.rect.x, y: annot.rect.y }, { x: annot.rect.x + annot.rect.w, y: annot.rect.y + annot.rect.h }];
      dict.set(PDFName.of('L'), context.obj([a.x, a.y, b.x, b.y]));
      dict.set(PDFName.of('LE'), context.obj(['None', annot.shape === 'arrow' ? 'ClosedArrow' : 'None']));
    } else {
      // /Rect is the outer box (stroke included); /RD says how far the shape itself is inset from it.
      const r = annot.width / 2;
      dict.set(PDFName.of('RD'), context.obj([r, r, r, r]));
      if (annot.fill && annot.fill.a > 0) dict.set(PDFName.of('IC'), context.obj(colorArray(annot.fill)));
    }
    dict.set(PDFName.of('AP'), context.obj({ N: registerAppearance(ctx, ap) }));
    return this.attach(ctx, dict);
  }

  /** Entries shared by every annotation (spec section 5.3). */
  private commonEntries(ctx: WriteContext, annot: Annotation, subtype: string, rect: number[]): PDFDict {
    const dict = ctx.pdf.context.obj({
      Type: 'Annot',
      Subtype: subtype,
      Rect: rect,
      F: 4,
      C: colorArray(annot.color),
      CA: annot.opacity * annot.color.a,
    });
    dict.set(PDFName.of('NM'), PDFHexString.fromText(annot.id));
    dict.set(PDFName.of('T'), PDFHexString.fromText(annot.author));
    dict.set(PDFName.of('M'), PDFString.of(pdfDate(annot.modifiedAt)));
    dict.set(PDFName.of('CreationDate'), PDFString.of(pdfDate(annot.createdAt)));
    if (annot.comment?.text) dict.set(PDFName.of('Contents'), PDFHexString.fromText(annot.comment.text));
    return dict;
  }

  private attach(ctx: WriteContext, dict: PDFDict): PDFRef {
    const ref = ctx.pdf.context.register(dict);
    const existing = ctx.page.node.lookup(PDFName.of('Annots'));
    if (existing instanceof PDFArray) existing.push(ref);
    else ctx.page.node.set(PDFName.of('Annots'), ctx.pdf.context.obj([ref]));
    return ref;
  }
}
