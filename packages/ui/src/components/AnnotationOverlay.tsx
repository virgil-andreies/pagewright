import { useEffect, useRef, useState } from 'react';
import {
  NOTE_FILL, constrainDrag, hitTest, pdfToViewport, quadBounds, resizeFreeText, resizeShape, simplifyPolyline, translateAnnotation, viewportToPdf,
  type Annotation, type PageGeometry, type PageRef, type Point, type Quad, type Rect, type ResizeHandle, type ShapeAnnot, type TextHandle,
} from '@pagewright/core';
import type { TextRun } from '@pagewright/engine';
import { useSnapshot, useUi } from '../react';
import type { MarkupType, ShapeTool } from '../store';
import { AnnotationView, Handles, noteViewportRect } from './AnnotationView';
import { TextEditor } from './TextEditor';

const EMPTY: readonly Annotation[] = [];
const MARKUP_TOOLS: readonly string[] = ['highlight', 'underline', 'strikeout'];
const SHAPE_TOOLS: readonly string[] = ['rect', 'ellipse', 'line', 'arrow'];
/** Drags shorter than this many screen pixels are clicks, not shapes. */
const MIN_DRAG_PX = 3;
/** How close a click must be to count as touching an annotation. */
const HIT_SLOP_PX = 5;

const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Text runs whose box overlaps the dragged rectangle (granularity: whole runs for now). */
export function runsInRect(runs: readonly TextRun[], r: Rect): Quad[] {
  return runs.filter((run) => intersects(quadBounds(run.quad), r)).map((run) => run.quad);
}

type Gesture =
  | { kind: 'markup'; a: Point; b: Point } // viewport coordinates
  | { kind: 'ink'; points: Point[] } // PDF coordinates from here on
  | { kind: 'shape'; tool: ShapeTool; a: Point; b: Point; constrain: boolean }
  | { kind: 'edit'; original: Annotation; current: Annotation; from: Point; handle?: ResizeHandle | TextHandle; moved: boolean };

/**
 * Our annotations are drawn here, not by PDF.js, so editing is instant and independent of the PDF
 * (spec section 5.1). Also hosts the tools' pointer input. A continuous gesture (drag, stroke, resize)
 * commits exactly one command on pointer-up (spec section 4).
 */
export function AnnotationOverlay({ page, geometry, scale, width, height }: {
  page: PageRef; geometry: PageGeometry; scale: number; width: number; height: number;
}) {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const annots = doc.annotations[page.id] ?? EMPTY;
  const tool = ui.activeTool;
  const [runs, setRuns] = useState<TextRun[]>([]);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Text runs are only needed while a text-markup tool is active.
  useEffect(() => {
    if (!MARKUP_TOOLS.includes(tool)) return;
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
  const toPdf = (p: Point) => viewportToPdf(geometry, scale, p);
  const toViewport = (p: Point) => pdfToViewport(geometry, scale, p);

  const selectedId = ui.selectedAnnot?.pageId === page.id ? ui.selectedAnnot.id : undefined;
  const selected = annots.find((a) => a.id === selectedId);

  /** Notes are hit on screen (their icon never rotates with the page); everything else in page space. */
  const touches = (a: Annotation, screen: Point, pdf: Point) => {
    if (a.type !== 'note') return hitTest(a, pdf, HIT_SLOP_PX / scale);
    const r = noteViewportRect(a, toViewport, scale);
    return screen.x >= r.x - HIT_SLOP_PX && screen.x <= r.x + r.w + HIT_SLOP_PX && screen.y >= r.y - HIT_SLOP_PX && screen.y <= r.y + r.h + HIT_SLOP_PX;
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = local(e);
    const pdf = toPdf(p);
    store.commitText(); // clicking anywhere finishes the text being typed

    if (tool === 'text') {
      // Clicking existing text edits it; clicking empty page starts a new box with its upper-left corner there.
      const hit = [...annots].reverse().find((a) => a.type === 'freetext' && a.origin === 'app' && touches(a, p, pdf));
      if (hit) store.editText(page.id, hit.id);
      else store.beginText(page.id, pdf);
      return;
    }

    if (tool === 'select') {
      const handle = (e.target as SVGElement).dataset?.handle as ResizeHandle | TextHandle | undefined;
      if (handle && (selected?.type === 'shape' || selected?.type === 'freetext') && selected.origin === 'app') {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setGesture({ kind: 'edit', original: selected, current: selected, from: pdf, handle, moved: false });
        return;
      }
      const hit = [...annots].reverse().find((a) => touches(a, p, pdf));
      store.selectAnnotation(hit ? { pageId: page.id, id: hit.id } : undefined);
      if (hit && hit.origin === 'app') {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setGesture({ kind: 'edit', original: hit, current: hit, from: pdf, moved: false });
      }
      return;
    }

    if (tool === 'note') {
      // The click is the icon's upper-left corner. The note exists once it has text (see the comments panel).
      store.beginNote(page.id, pdf);
      return;
    }

    e.currentTarget.setPointerCapture?.(e.pointerId);
    store.selectAnnotation(undefined);
    if (MARKUP_TOOLS.includes(tool)) setGesture({ kind: 'markup', a: p, b: p });
    else if (tool === 'ink') setGesture({ kind: 'ink', points: [pdf] });
    else if (SHAPE_TOOLS.includes(tool)) setGesture({ kind: 'shape', tool: tool as ShapeTool, a: pdf, b: pdf, constrain: e.shiftKey });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!gesture) return;
    const p = local(e);
    const pdf = toPdf(p);
    switch (gesture.kind) {
      case 'markup':
        setGesture({ ...gesture, b: p });
        break;
      case 'ink': {
        const last = gesture.points.at(-1)!;
        if (Math.hypot(pdf.x - last.x, pdf.y - last.y) * scale >= 1) setGesture({ ...gesture, points: [...gesture.points, pdf] });
        break;
      }
      case 'shape':
        setGesture({ ...gesture, b: pdf, constrain: e.shiftKey });
        break;
      case 'edit': {
        const { original, handle, from } = gesture;
        const current =
          handle && original.type === 'freetext'
            ? resizeFreeText(original, handle as TextHandle, pdf)
            : handle && original.type === 'shape'
              ? resizeShape(original, handle as ResizeHandle, pdf)
              : translateAnnotation(original, pdf.x - from.x, pdf.y - from.y);
        const start = toViewport(from);
        setGesture({ ...gesture, current, moved: gesture.moved || Math.hypot(p.x - start.x, p.y - start.y) >= 1 });
        break;
      }
    }
  };

  const onUp = () => {
    const g = gesture;
    setGesture(null);
    if (!g) return;
    switch (g.kind) {
      case 'markup': {
        const a = toPdf(g.a);
        const b = toPdf(g.b);
        const rect: Rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
        store.addMarkup(tool as MarkupType, page.id, runsInRect(runs, rect));
        break;
      }
      case 'ink':
        store.addInk(page.id, [simplifyPolyline(g.points, 0.75 / scale)]);
        break;
      case 'shape': {
        const end = g.constrain ? constrainDrag(g.tool, g.a, g.b) : g.b;
        if (Math.hypot(end.x - g.a.x, end.y - g.a.y) * scale >= MIN_DRAG_PX) store.addShape(page.id, g.tool, g.a, end);
        break;
      }
      case 'edit':
        if (g.moved) store.updateAnnotation(g.current);
        break;
    }
  };

  // What to draw: the stored annotations, with the one being edited replaced by its live preview, and the
  // one being typed in left out (its text box is on screen instead).
  const typing = ui.textEdit?.pageId === page.id ? ui.textEdit : undefined;
  const shown = annots
    .filter((a) => a.id !== typing?.id)
    .map((a) => (gesture?.kind === 'edit' && gesture.original.id === a.id ? gesture.current : a));
  const shownSelected = shown.find((a) => a.id === selectedId);
  const draft = gesture ? draftAnnotation(gesture, page.id, ui.drawStyle) : undefined;

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'select') return;
    const r = svgRef.current!.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    const hit = [...annots].reverse().find((a) => a.type === 'freetext' && a.origin === 'app' && touches(a, p, toPdf(p)));
    if (hit) store.editText(page.id, hit.id);
  };

  return (
    <>
    <svg
      ref={svgRef}
      className={`overlay tool-${tool}`}
      width={width}
      height={height}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setGesture(null)}
      onDoubleClick={onDoubleClick}
    >
      {shown.map((a) => (
        <AnnotationView key={a.id} annot={a} geometry={geometry} scale={scale} selected={a.id === selectedId} />
      ))}
      {tool === 'select' && !typing && (shownSelected?.type === 'shape' || shownSelected?.type === 'freetext') && shownSelected.origin === 'app' && (
        <Handles shape={shownSelected} geometry={geometry} scale={scale} />
      )}
      {draft && <AnnotationView annot={draft} geometry={geometry} scale={scale} />}
      {ui.draftNote?.pageId === page.id && (
        <g opacity={0.6} data-testid="draft-note">
          <AnnotationView annot={ghostNote(ui.draftNote.position, page.id)} geometry={geometry} scale={scale} />
        </g>
      )}
      {gesture?.kind === 'markup' && (
        <rect
          className="drag-rect"
          x={Math.min(gesture.a.x, gesture.b.x)}
          y={Math.min(gesture.a.y, gesture.b.y)}
          width={Math.abs(gesture.a.x - gesture.b.x)}
          height={Math.abs(gesture.a.y - gesture.b.y)}
        />
      )}
    </svg>
    {typing && <TextEditor key={typing.id ?? `new-${typing.position.x}-${typing.position.y}`} edit={typing} geometry={geometry} scale={scale} />}
    </>
  );
}

/** Where the note being written will go. Never stored. */
function ghostNote(position: Point, pageId: string): Annotation {
  return {
    type: 'note', id: 'draft-note', pageId, author: '', createdAt: '', modifiedAt: '', opacity: 1, origin: 'app',
    color: NOTE_FILL, position, icon: 'note',
  };
}

/** A throw-away annotation that shows the gesture in progress; never stored. */
function draftAnnotation(g: Gesture, pageId: string, style: { color: ShapeAnnot['color']; width: number; fill?: ShapeAnnot['fill'] }): Annotation | undefined {
  const base = { id: 'draft', pageId, author: '', createdAt: '', modifiedAt: '', opacity: 1, origin: 'app' as const, color: style.color, width: style.width };
  if (g.kind === 'ink') return { ...base, type: 'ink', strokes: [g.points] };
  if (g.kind === 'shape') {
    const end = g.constrain ? constrainDrag(g.tool, g.a, g.b) : g.b;
    const isLine = g.tool === 'line' || g.tool === 'arrow';
    const rect = { x: Math.min(g.a.x, end.x), y: Math.min(g.a.y, end.y), w: Math.abs(g.a.x - end.x), h: Math.abs(g.a.y - end.y) };
    return {
      ...base, type: 'shape', shape: g.tool, rect,
      ...(isLine ? { line: [g.a, end] as [Point, Point] } : style.fill ? { fill: style.fill } : {}),
    };
  }
  return undefined;
}
