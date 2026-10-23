import { useEffect, useRef, useState } from 'react';
import {
  pdfToViewport, quadBounds, viewportToPdf,
  type Annotation, type PageGeometry, type PageRef, type Point, type Quad, type Rect,
} from '@pagewright/core';
import type { TextRun } from '@pagewright/engine';
import { useSnapshot, useUi } from '../react';

const EMPTY: readonly Annotation[] = [];

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const rgb = (c: { r: number; g: number; b: number }) => `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)})`;

/** Text runs whose box overlaps the dragged rectangle (granularity: whole runs for now). */
export function runsInRect(runs: readonly TextRun[], r: Rect): Quad[] {
  return runs.filter((run) => intersects(quadBounds(run.quad), r)).map((run) => run.quad);
}

/**
 * Our annotations are drawn here, not by PDF.js, so editing is instant and independent of the PDF
 * (spec section 5.1). Also hosts the markup tools' pointer input.
 */
export function AnnotationOverlay({ page, geometry, scale, width, height }: {
  page: PageRef; geometry: PageGeometry; scale: number; width: number; height: number;
}) {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const annots = doc.annotations[page.id] ?? EMPTY;
  const tool = ui.activeTool;
  const [runs, setRuns] = useState<TextRun[]>([]);
  const [dragRect, setDragRect] = useState<{ a: Point; b: Point } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Text runs are only needed while a markup tool is active.
  useEffect(() => {
    if (tool === 'select') return;
    const rd = store.getRenderDoc(page.sourceId);
    let live = true;
    rd?.getTextContent(page.sourceIndex).then((r) => live && setRuns(r), () => {});
    return () => {
      live = false;
    };
  }, [store, tool, page.sourceId, page.sourceIndex]);

  const local = (e: React.PointerEvent): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const toViewport = (p: Point) => pdfToViewport(geometry, scale, p);
  const poly = (q: Quad) => [q.p1, q.p2, q.p4, q.p3].map((p) => { const v = toViewport(p); return `${v.x},${v.y}`; }).join(' ');

  const onDown = (e: React.PointerEvent) => {
    if (tool === 'select') return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = local(e);
    setDragRect({ a: p, b: p });
  };
  const onMove = (e: React.PointerEvent) => dragRect && setDragRect({ ...dragRect, b: local(e) });
  const onUp = () => {
    if (!dragRect || tool === 'select') return;
    const a = viewportToPdf(geometry, scale, dragRect.a);
    const b = viewportToPdf(geometry, scale, dragRect.b);
    const rect: Rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    setDragRect(null);
    store.addMarkup(tool, page.id, runsInRect(runs, rect)); // one command on pointer-up
  };

  return (
    <svg
      ref={svgRef}
      className={`overlay tool-${tool}`}
      width={width}
      height={height}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDragRect(null)}
    >
      {annots.map((a) => {
        if (a.type !== 'highlight' && a.type !== 'underline' && a.type !== 'strikeout') return null;
        const selected = ui.selectedAnnot?.id === a.id;
        const common = {
          'data-annot-id': a.id,
          className: `annot${selected ? ' selected' : ''}`,
          onPointerDown: (e: React.PointerEvent) => {
            if (tool !== 'select') return;
            e.stopPropagation();
            store.selectAnnotation({ pageId: page.id, id: a.id });
          },
        };
        return (
          <g key={a.id} {...common} opacity={a.opacity * a.color.a}>
            {a.quads.map((q, i) =>
              a.type === 'highlight' ? (
                <polygon key={i} points={poly(q)} fill={rgb(a.color)} style={{ mixBlendMode: 'multiply' }} />
              ) : (
                <line
                  key={i}
                  {...lineFor(q, a.type, toViewport)}
                  stroke={rgb(a.color)}
                  strokeWidth={Math.max(1, quadBounds(q).h * 0.07 * scale)}
                  strokeLinecap="round"
                />
              ),
            )}
            {selected && a.quads.map((q, i) => <polygon key={`s${i}`} points={poly(q)} className="selection-outline" />)}
          </g>
        );
      })}
      {dragRect && (
        <rect
          className="drag-rect"
          x={Math.min(dragRect.a.x, dragRect.b.x)}
          y={Math.min(dragRect.a.y, dragRect.b.y)}
          width={Math.abs(dragRect.a.x - dragRect.b.x)}
          height={Math.abs(dragRect.a.y - dragRect.b.y)}
        />
      )}
    </svg>
  );
}

function lineFor(q: Quad, type: 'underline' | 'strikeout', toViewport: (p: Point) => Point) {
  const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const l = type === 'underline' ? toViewport(q.p3) : toViewport(mid(q.p1, q.p3));
  const r = type === 'underline' ? toViewport(q.p4) : toViewport(mid(q.p2, q.p4));
  return { x1: l.x, y1: l.y, x2: r.x, y2: r.y };
}
