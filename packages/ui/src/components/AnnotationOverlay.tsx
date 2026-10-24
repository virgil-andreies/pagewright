import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  NOTE_FILL, constrainDrag, hitTest, pdfToViewport, resizeFreeText, resizeShape, resizeStamp, simplifyPolyline, translateAnnotation, viewportToPdf,
  type Annotation, type PageGeometry, type PageRef, type Point, type ResizeHandle, type ShapeAnnot, type StampHandle, type TextHandle,
} from '@pagewright/core';
import { useSnapshot, useUi } from '../react';
import { hasSelection } from '../selection';
import type { ShapeTool } from '../store';
import { AnnotationView, Handles, noteViewportRect } from './AnnotationView';
import { TextEditor } from './TextEditor';

const EMPTY: readonly Annotation[] = [];
const MARKUP_TOOLS: readonly string[] = ['highlight', 'underline', 'strikeout'];
const TEXT_MARKUP: readonly string[] = ['highlight', 'underline', 'strikeout'];
/** A press that moves less than this before release is a click, not a drag. */
const CLICK_SLOP_PX = 4;
const SHAPE_TOOLS: readonly string[] = ['rect', 'ellipse', 'line', 'arrow'];
/** Drags shorter than this many screen pixels are clicks, not shapes. */
const MIN_DRAG_PX = 3;
/** How close a click must be to count as touching an annotation. */
const HIT_SLOP_PX = 5;

type Gesture =
  | { kind: 'ink'; points: Point[] } // PDF coordinates
  | { kind: 'shape'; tool: ShapeTool; a: Point; b: Point; constrain: boolean }
  | { kind: 'edit'; original: Annotation; current: Annotation; from: Point; handle?: ResizeHandle | TextHandle | StampHandle; moved: boolean };

/**
 * Our annotations are drawn here, not by PDF.js, so editing is instant and independent of the PDF
 * (spec section 5.1). The host element also receives all pointer input for the page and passes it to the
 * active tool, and it contains the page's text layer (`children`) so that selecting text with the Select and
 * markup tools is the browser's own selection. A continuous gesture (drag, stroke, resize) commits exactly one
 * command on pointer-up (spec section 4).
 */
export function AnnotationOverlay({ page, geometry, scale, width, height, children }: {
  page: PageRef; geometry: PageGeometry; scale: number; width: number; height: number; children?: ReactNode;
}) {
  const { store, pages } = useUi();
  const { doc, ui, imported: originals } = useSnapshot();
  const annots = doc.annotations[page.id] ?? EMPTY;
  // What the user can click: the annotations that were already in the file (underneath), then the ones made here.
  const original = originals[page.id] ?? EMPTY;
  const clickable = [...original, ...annots];
  const tool = ui.activeTool;
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  /** Set while a press landed on an annotation, so the browser does not also start a text selection. */
  const suppressSelection = useRef(false);
  /** A press on marked-up text in the Select tool, waiting to see whether it was a click or the start of a text selection. */
  const markupPress = useRef<{ id: string; at: Point } | null>(null);
  /** A press of the Text or Note tool, waiting for its release. */
  const clickAt = useRef<{ tool: string; pdf: Point; screen: Point } | null>(null);

  // Let the selection code find this page: its element, and how to map screen points onto the page.
  useEffect(() => {
    if (!hostRef.current) return;
    pages.set(page.id, { host: hostRef.current, geometry, scale });
    return () => {
      pages.delete(page.id);
    };
  });

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = hostRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toPdf = (p: Point) => viewportToPdf(geometry, scale, p);
  const toViewport = (p: Point) => pdfToViewport(geometry, scale, p);

  const selectedId = ui.selectedAnnot?.pageId === page.id ? ui.selectedAnnot.id : undefined;
  const selected = clickable.find((a) => a.id === selectedId);

  /** Notes are hit on screen (their icon never rotates with the page); everything else in page space. */
  const touches = (a: Annotation, screen: Point, pdf: Point) => {
    if (a.type !== 'note') return hitTest(a, pdf, HIT_SLOP_PX / scale);
    const r = noteViewportRect(a, toViewport, scale);
    return screen.x >= r.x - HIT_SLOP_PX && screen.x <= r.x + r.w + HIT_SLOP_PX && screen.y >= r.y - HIT_SLOP_PX && screen.y <= r.y + r.h + HIT_SLOP_PX;
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const p = local(e);
    const pdf = toPdf(p);
    markupPress.current = null;
    store.commitText(); // clicking anywhere finishes the text being typed

    if (tool === 'text' || tool === 'note' || tool === 'stamp') {
      // The first two open a text box, which must take keyboard focus. If it did so now, the browser would finish
      // this very press (mousedown) by moving focus to the page, and the new box would lose it at once and be
      // discarded. So wait for the release, when the browser is done with focus. Capture the pointer so the
      // release is seen even if the mouse has moved off the page.
      e.currentTarget.setPointerCapture?.(e.pointerId);
      clickAt.current = { tool, pdf, screen: p };
      return;
    }

    if (tool === 'select') {
      const handle = (e.target as SVGElement).dataset?.handle as ResizeHandle | TextHandle | StampHandle | undefined;
      if (handle && (selected?.type === 'shape' || selected?.type === 'freetext' || selected?.type === 'stamp') && selected.origin === 'app') {
        suppressSelection.current = true;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setGesture({ kind: 'edit', original: selected, current: selected, from: pdf, handle, moved: false });
        return;
      }
      const hit = [...clickable].reverse().find((a) => touches(a, p, pdf));
      if (hit && TEXT_MARKUP.includes(hit.type)) {
        // Marked-up text sits on top of real text, so this press may be the start of selecting that text. Leave it to
        // the browser (no grab, no move: markup stays on its text) and decide when the button comes up.
        markupPress.current = { id: hit.id, at: p };
        return;
      }
      store.selectAnnotation(hit ? { pageId: page.id, id: hit.id } : undefined);
      // Pressing on an annotation grabs it; pressing anywhere else is left to the browser, which starts selecting text.
      if (hit) suppressSelection.current = true;
      if (hit && hit.origin === 'app') {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        setGesture({ kind: 'edit', original: hit, current: hit, from: pdf, moved: false });
      }
      return;
    }

    store.selectAnnotation(undefined);
    if (MARKUP_TOOLS.includes(tool)) return; // the browser selects text; the selection becomes the markup on release
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (tool === 'ink') setGesture({ kind: 'ink', points: [pdf] });
    else if (SHAPE_TOOLS.includes(tool)) setGesture({ kind: 'shape', tool: tool as ShapeTool, a: pdf, b: pdf, constrain: e.shiftKey });
  };

  const onMove = (e: React.PointerEvent) => {
    if (!gesture) return;
    const p = local(e);
    const pdf = toPdf(p);
    switch (gesture.kind) {
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
              : handle && original.type === 'stamp'
                ? resizeStamp(original, handle as StampHandle, pdf)
                : translateAnnotation(original, pdf.x - from.x, pdf.y - from.y);
        const start = toViewport(from);
        setGesture({ ...gesture, current, moved: gesture.moved || Math.hypot(p.x - start.x, p.y - start.y) >= 1 });
        break;
      }
    }
  };

  const onUp = (e: React.PointerEvent) => {
    suppressSelection.current = false;
    const press = markupPress.current;
    markupPress.current = null;
    if (press) {
      // A click selects the markup. A drag was a text selection, so the markup stays unselected.
      const at = local(e);
      const clicked = Math.hypot(at.x - press.at.x, at.y - press.at.y) < CLICK_SLOP_PX && !hasSelection();
      store.selectAnnotation(clicked ? { pageId: page.id, id: press.id } : undefined);
      return;
    }
    const click = clickAt.current;
    clickAt.current = null;
    if (click && click.tool === tool) {
      if (click.tool === 'stamp') {
        store.addStamp(page.id, click.pdf); // centred on the click
      } else if (click.tool === 'note') {
        // The click is the icon's upper-left corner. The note exists once it has text (see the comments panel).
        store.beginNote(page.id, click.pdf);
      } else {
        // Clicking existing text edits it; clicking empty page starts a new box with its upper-left corner there.
        const hit = [...annots].reverse().find((a) => a.type === 'freetext' && a.origin === 'app' && touches(a, click.screen, click.pdf));
        if (hit) store.editText(page.id, hit.id);
        else store.beginText(page.id, click.pdf);
      }
      return;
    }
    const g = gesture;
    setGesture(null);
    if (!g) return;
    switch (g.kind) {
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
    const p = local(e);
    const hit = [...annots].reverse().find((a) => a.type === 'freetext' && a.origin === 'app' && touches(a, p, toPdf(p)));
    if (hit) store.editText(page.id, hit.id);
  };

  return (
    <div
      ref={hostRef}
      className={`overlay-host tool-${tool}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => ((clickAt.current = null), (suppressSelection.current = false), setGesture(null))}
      onMouseDown={(e) => suppressSelection.current && e.preventDefault()}
      onDoubleClick={onDoubleClick}
    >
      {children}
      <svg className="overlay" width={width} height={height}>
        {original.filter((a) => a.id === selectedId).map((a) => (
          <AnnotationView key={a.id} annot={a} geometry={geometry} scale={scale} selected />
        ))}
        {shown.map((a) => (
          <AnnotationView key={a.id} annot={a} geometry={geometry} scale={scale} selected={a.id === selectedId} />
        ))}
        {tool === 'select' && !typing && (shownSelected?.type === 'shape' || shownSelected?.type === 'freetext' || shownSelected?.type === 'stamp') && shownSelected.origin === 'app' && (
          <Handles shape={shownSelected} geometry={geometry} scale={scale} />
        )}
        {draft && <AnnotationView annot={draft} geometry={geometry} scale={scale} />}
        {ui.draftNote?.pageId === page.id && (
          <g opacity={0.6} data-testid="draft-note">
            <AnnotationView annot={ghostNote(ui.draftNote.position, page.id)} geometry={geometry} scale={scale} />
          </g>
        )}
      </svg>
      {typing && <TextEditor key={typing.id ?? `new-${typing.position.x}-${typing.position.y}`} edit={typing} geometry={geometry} scale={scale} />}
    </div>
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
