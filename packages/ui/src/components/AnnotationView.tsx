import {
  annotationBounds, arrowHead, pdfToViewport, quadBounds, shapeHandles,
  type Annotation, type PageGeometry, type Point, type Quad, type RGBA, type ShapeAnnot,
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
      body = annot.quads.map((q, i) => <polygon key={i} points={quad(q)} fill={stroke} style={{ mixBlendMode: 'multiply' }} />);
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
    default:
      break; // notes, free text and stamps arrive with their own views
  }

  const b = annotationBounds(annot);
  const a = vp({ x: b.x, y: b.y });
  const c = vp({ x: b.x + b.w, y: b.y + b.h });
  return (
    <g data-annot-id={annot.id} className={`annot${selected ? ' selected' : ''}`} opacity={opacity}>
      {body}
      {selected && (
        <rect
          className="selection-outline"
          x={Math.min(a.x, c.x) - 2}
          y={Math.min(a.y, c.y) - 2}
          width={Math.abs(a.x - c.x) + 4}
          height={Math.abs(a.y - c.y) + 4}
        />
      )}
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

/** Resize handles for a selected shape. They carry `data-handle` so the overlay can tell them apart. */
export function Handles({ shape, geometry, scale }: ViewProps & { shape: ShapeAnnot }) {
  return (
    <>
      {shapeHandles(shape).map((h) => {
        const v = pdfToViewport(geometry, scale, h.at);
        return <circle key={h.id} className="handle" data-handle={h.id} cx={v.x} cy={v.y} r={6} />;
      })}
    </>
  );
}

export type { RGBA };
