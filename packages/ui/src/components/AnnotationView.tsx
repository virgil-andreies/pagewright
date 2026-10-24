import { useEffect, useState } from 'react';
import {
  BASELINE_RATIO, NOTE_ICON_LINE, artScale, artSvgPath, NOTE_INK, NOTE_SIZE, TEXT_PADDING, annotationBounds, arrowHead, effectiveRotation, freeTextHandles,
  freeTextLines, lineAdvance, noteIcon, pdfToViewport, quadBounds, shapeHandles, stampHandles, stampLayout, stampPreset, stampScale, textWidth,
  type Annotation, type FontFamily, type FreeTextAnnot, type SignatureArt, type StampAnnot, type NoteAnnot, type PageGeometry, type Point, type Quad, type RGBA, type ShapeAnnot,
} from '@pagewright/core';

export const rgb = (c: { r: number; g: number; b: number }) =>
  `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)})`;

export interface ViewProps {
  geometry: PageGeometry;
  /** CSS pixels per PDF point. */
  scale: number;
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * One annotation as SVG. Everything is computed in PDF space and mapped to the viewport through the page
 * geometry, so rotated and offset pages need no special cases here. Shapes are stroked on their centre
 * line, which is exactly what the PDF appearance stream does.
 */
export function AnnotationView({ annot, geometry, scale, selected }: ViewProps & { annot: Annotation; selected?: boolean }) {
  const vp = (p: Point) => pdfToViewport(geometry, scale, p);
  const pts = (ps: readonly Point[]) => ps.map((p) => { const v = vp(p); return `${v.x},${v.y}`; }).join(' ');
  const quad = (q: Quad) => pts([q.p1, q.p2, q.p4, q.p3]);
  const opacity = annot.opacity * annot.color.a;
  const stroke = rgb(annot.color);

  let body: React.ReactNode = null;
  switch (annot.type) {
    case 'highlight':
      // Opacity goes on the polygon, not on the group: a group with opacity is isolated, and then the multiply blend
      // would only blend with the group itself instead of the page underneath (text would be tinted, not kept dark).
      body = annot.quads.map((q, i) => <polygon key={i} points={quad(q)} fill={stroke} fillOpacity={opacity} style={{ mixBlendMode: 'multiply' }} />);
      break;
    case 'underline':
    case 'strikeout':
      body = annot.quads.map((q, i) => {
        const l = vp(annot.type === 'underline' ? q.p3 : mid(q.p1, q.p3));
        const r = vp(annot.type === 'underline' ? q.p4 : mid(q.p2, q.p4));
        return <line key={i} x1={l.x} y1={l.y} x2={r.x} y2={r.y} stroke={stroke} strokeWidth={Math.max(1, quadBounds(q).h * 0.07 * scale)} strokeLinecap="round" />;
      });
      break;
    case 'ink':
      body = annot.strokes.map((s, i) =>
        s.length === 1 ? (
          <circle key={i} cx={vp(s[0]!).x} cy={vp(s[0]!).y} r={(annot.width * scale) / 2} fill={stroke} />
        ) : (
          <polyline key={i} points={pts(s)} fill="none" stroke={stroke} strokeWidth={annot.width * scale} strokeLinecap="round" strokeLinejoin="round" />
        ),
      );
      break;
    case 'shape':
      body = <ShapeBody shape={annot} vp={vp} scale={scale} />;
      break;
    case 'note':
      body = <NoteBody note={annot} vp={vp} scale={scale} />;
      break;
    case 'freetext':
      body = <FreeTextBody text={annot} geometry={geometry} scale={scale} />;
      break;
    case 'stamp':
      body = <StampBody stamp={annot} geometry={geometry} scale={scale} />;
      break;
    default:
      break; // notes, free text and stamps arrive with their own views
  }
  // Annotations that were already in the file are drawn by PDF.js in the page image: we only outline them when selected.
  if (annot.origin === 'imported') body = null;

  // Notes keep their icon upright, so their box is measured on screen rather than in page space.
  let outline: { x: number; y: number; w: number; h: number };
  if (annot.type === 'note') {
    outline = noteViewportRect(annot, vp, scale);
  } else {
    const b = annotationBounds(annot);
    const a = vp({ x: b.x, y: b.y });
    const c = vp({ x: b.x + b.w, y: b.y + b.h });
    outline = { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(a.x - c.x), h: Math.abs(a.y - c.y) };
  }
  return (
    <g data-annot-id={annot.id} className={`annot${selected ? ' selected' : ''}`} opacity={annot.type === 'highlight' ? undefined : opacity}>
      {body}
      {selected && (
        <rect className="selection-outline" x={outline.x - 2} y={outline.y - 2} width={outline.w + 4} height={outline.h + 4} />
      )}
    </g>
  );
}

/**
 * Where a note's icon is on screen. The note is anchored at its page position, but the icon itself is never
 * rotated with the page (the PDF NoRotate flag), so it always extends right and down from that point.
 */
export function noteViewportRect(note: NoteAnnot, vp: (p: Point) => Point, scale: number) {
  const a = vp(note.position);
  return { x: a.x, y: a.y, w: NOTE_SIZE * scale, h: NOTE_SIZE * scale };
}

/** CSS stacks that map to the same metrics as the PDF standard fonts (Arial is metric-compatible with Helvetica). */
export const FONT_STACKS: Record<FontFamily, string> = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
};

/**
 * Free text uses the shared layout, so the lines break exactly where they will in the saved PDF. Each line
 * is stretched to its PDF width (`textLength`), so even if the browser substitutes a different font the
 * text occupies the same space as the saved page. The text turns with the page, like any PDF annotation
 * without the NoRotate flag.
 */
function FreeTextBody({ text, geometry, scale }: { text: FreeTextAnnot; geometry: PageGeometry; scale: number }) {
  const anchor = pdfToViewport(geometry, scale, { x: text.rect.x, y: text.rect.y + text.rect.h });
  const rotation = effectiveRotation(geometry);
  return (
    <g
      transform={`translate(${anchor.x} ${anchor.y}) rotate(${rotation}) scale(${scale})`}
      fill={rgb(text.color)}
      fontFamily={FONT_STACKS[text.fontFamily]}
      fontSize={text.fontSize}
      style={{ whiteSpace: 'pre' }}
    >
      {freeTextLines(text).map((line, i) =>
        line === '' ? null : (
          <text
            key={i}
            x={TEXT_PADDING}
            y={TEXT_PADDING + BASELINE_RATIO * text.fontSize + i * lineAdvance(text.fontSize)}
            textLength={textWidth(text.fontFamily, line, text.fontSize)}
            lengthAdjust="spacing"
          >
            {line}
          </text>
        ),
      )}
    </g>
  );
}

/**
 * A preset stamp, drawn from the same layout the saved PDF uses: the artwork keeps its proportions and is centred
 * in the stamp's rectangle. It turns with the page, like any annotation without the NoRotate flag.
 */
function StampBody({ stamp, geometry, scale }: { stamp: StampAnnot; geometry: PageGeometry; scale: number }) {
  if (stamp.payload.kind === 'signature') return <SignatureBody stamp={stamp} art={stamp.payload.art} geometry={geometry} scale={scale} />;
  if (stamp.payload.kind === 'image') return <ImageBody stamp={stamp} bytes={stamp.payload.bytes} mime={stamp.payload.mime} geometry={geometry} scale={scale} />;
  const preset = stampPreset(stamp.payload.name);
  if (!preset) return null;
  const L = stampLayout(preset.label);
  const s = stampScale(L, stamp.rect);
  const anchor = pdfToViewport(geometry, scale, { x: stamp.rect.x, y: stamp.rect.y + stamp.rect.h });
  const colour = rgb(stamp.color);
  return (
    <g
      transform={`translate(${anchor.x} ${anchor.y}) rotate(${effectiveRotation(geometry)}) scale(${scale}) translate(${(stamp.rect.w - L.w * s) / 2} ${(stamp.rect.h - L.h * s) / 2}) scale(${s})`}
    >
      <rect x={L.border / 2} y={L.border / 2} width={L.w - L.border} height={L.h - L.border} rx={L.radius} fill="none" stroke={colour} strokeWidth={L.border} />
      <text
        x={L.textX}
        y={L.baseline}
        fill={colour}
        fontSize={L.fontSize}
        fontWeight="bold"
        fontFamily={FONT_STACKS.sans}
        textLength={L.textWidth}
        lengthAdjust="spacing"
      >
        {preset.label}
      </text>
    </g>
  );
}

/** A visual signature: its vector artwork, scaled into the rectangle with its proportions kept, turning with the page. */
function SignatureBody({ stamp, art, geometry, scale }: { stamp: StampAnnot; art: SignatureArt; geometry: PageGeometry; scale: number }) {
  const s = artScale(art, stamp.rect);
  const anchor = pdfToViewport(geometry, scale, { x: stamp.rect.x, y: stamp.rect.y + stamp.rect.h });
  const colour = rgb(stamp.color);
  return (
    <g
      transform={`translate(${anchor.x} ${anchor.y}) rotate(${effectiveRotation(geometry)}) scale(${scale}) translate(${(stamp.rect.w - art.w * s) / 2} ${(stamp.rect.h - art.h * s) / 2}) scale(${s})`}
    >
      <path
        d={artSvgPath(art)}
        fill={art.mode === 'fill' ? colour : 'none'}
        stroke={art.mode === 'stroke' ? colour : 'none'}
        strokeWidth={art.strokeWidth ?? 1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  );
}

/** A blob URL for some bytes, revoked when they are no longer shown. Stamps that share a picture each get their own. */
function useObjectUrl(bytes: Uint8Array, mime: string): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return; // test environments without blobs
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, mime]);
  return url;
}

/** An image stamp: the picture stretched over the rectangle (which has its proportions), turning with the page. */
function ImageBody({ stamp, bytes, mime, geometry, scale }: { stamp: StampAnnot; bytes: Uint8Array; mime: string; geometry: PageGeometry; scale: number }) {
  const url = useObjectUrl(bytes, mime);
  const anchor = pdfToViewport(geometry, scale, { x: stamp.rect.x, y: stamp.rect.y + stamp.rect.h });
  return (
    <g transform={`translate(${anchor.x} ${anchor.y}) rotate(${effectiveRotation(geometry)}) scale(${scale})`} opacity={stamp.opacity}>
      {url ? (
        <image href={url} width={stamp.rect.w} height={stamp.rect.h} preserveAspectRatio="none" />
      ) : (
        <rect width={stamp.rect.w} height={stamp.rect.h} fill="none" stroke="#999" strokeDasharray="4 3" />
      )}
    </g>
  );
}

function NoteBody({ note, vp, scale }: { note: NoteAnnot; vp: (p: Point) => Point; scale: number }) {
  const a = vp(note.position);
  const fill = rgb(note.color);
  const ink = rgb(NOTE_INK);
  return (
    <g transform={`translate(${a.x} ${a.y}) scale(${scale})`} strokeLinecap="round" strokeLinejoin="round" strokeWidth={NOTE_ICON_LINE} stroke={ink}>
      {noteIcon(note.icon).map((s, i) => {
        if (s.kind === 'line') return <line key={i} x1={s.from.x} y1={s.from.y} x2={s.to.x} y2={s.to.y} />;
        if (s.kind === 'polygon') return <polygon key={i} points={s.points.map((p) => `${p.x},${p.y}`).join(' ')} fill={s.fill ? fill : 'none'} />;
        return <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx={s.radius} fill={s.fill ? fill : 'none'} />;
      })}
    </g>
  );
}

function ShapeBody({ shape: s, vp, scale }: { shape: ShapeAnnot; vp: (p: Point) => Point; scale: number }) {
  const stroke = rgb(s.color);
  const common = { stroke, strokeWidth: s.width * scale, fill: 'none' as string, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const fill = s.fill && s.fill.a > 0 ? rgb(s.fill) : 'none';

  if (s.shape === 'line' || s.shape === 'arrow') {
    const [from, to] = s.line ?? [{ x: s.rect.x, y: s.rect.y }, { x: s.rect.x + s.rect.w, y: s.rect.y + s.rect.h }];
    if (s.shape === 'line') {
      const a = vp(from), b = vp(to);
      return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...common} />;
    }
    const head = arrowHead(from, to, s.width);
    const a = vp(from), base = vp(head.base);
    const tri = [head.tip, ...head.barbs].map((p) => { const v = vp(p); return `${v.x},${v.y}`; }).join(' ');
    return (
      <>
        <line x1={a.x} y1={a.y} x2={base.x} y2={base.y} {...common} />
        <polygon points={tri} fill={stroke} />
      </>
    );
  }

  // Rotation by multiples of 90 keeps boxes axis-aligned, so two opposite corners are enough.
  const p = vp({ x: s.rect.x, y: s.rect.y });
  const q = vp({ x: s.rect.x + s.rect.w, y: s.rect.y + s.rect.h });
  const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y), w = Math.abs(p.x - q.x), h = Math.abs(p.y - q.y);
  return s.shape === 'rect' ? (
    <rect x={x} y={y} width={w} height={h} {...common} fill={fill} />
  ) : (
    <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} fill={fill} />
  );
}

/** Resize handles for a selected shape or text box. They carry `data-handle` so the overlay can tell them apart. */
export function Handles({ shape, geometry, scale }: ViewProps & { shape: ShapeAnnot | FreeTextAnnot | StampAnnot }) {
  const handles = shape.type === 'freetext' ? freeTextHandles(shape) : shape.type === 'stamp' ? stampHandles(shape) : shapeHandles(shape);
  return (
    <>
      {handles.map((h) => {
        const v = pdfToViewport(geometry, scale, h.at);
        return <circle key={h.id} className="handle" data-handle={h.id} cx={v.x} cy={v.y} r={6} />;
      })}
    </>
  );
}

export type { RGBA };
