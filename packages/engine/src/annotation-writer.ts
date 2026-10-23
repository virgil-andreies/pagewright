import type { Annotation, RGBA } from '@pagewright/core';
import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFString,
  type PDFDocument, type PDFPage, type PDFRef,
} from '@cantoo/pdf-lib';
import { buildTextMarkupAppearance, type AppearanceStream } from './appearance';

export interface WriteContext {
  pdf: PDFDocument;
  page: PDFPage;
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

function registerAppearance(ctx: WriteContext, ap: AppearanceStream): PDFRef {
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
    Resources: context.obj({ ExtGState: context.obj({ GS: gs }) }),
  });
  return context.register(stream);
}

export class DefaultAnnotationWriter implements AnnotationWriter {
  write(ctx: WriteContext, annot: Annotation): PDFRef {
    switch (annot.type) {
      case 'highlight':
      case 'underline':
      case 'strikeout':
        return this.writeTextMarkup(ctx, annot);
      default:
        throw new UnsupportedAnnotation(annot.type);
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
