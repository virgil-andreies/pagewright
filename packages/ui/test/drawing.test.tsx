// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addAnnotation, type Annotation, type InkAnnot, type ShapeAnnot } from '@pagewright/core';
import { setup } from './helpers';

/** The fake pages are 200 x 300 pt and the viewer shows them at 96/72 px per point. */
const S = 96 / 72;
const PAGE_H = 300;
/** PDF point -> client pixel inside the overlay (jsdom lays everything out at 0,0). */
const px = (x: number, y: number) => ({ clientX: x * S, clientY: (PAGE_H - y) * S });

async function ready() {
  const t = setup();
  await t.open();
  const svg = await waitForOverlay();
  const pageId = t.store.getSnapshot().doc.pages[0]!.id;
  const annots = () => (t.store.getSnapshot().doc.annotations[pageId] ?? []) as Annotation[];
  const tool = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));

  /** Press at the first point, move through the rest, release at the last. */
  const drag = (points: [number, number][], opts: { shift?: boolean; target?: Element } = {}) => {
    const [first, ...rest] = points;
    const target = opts.target ?? svg;
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, ...px(...first!), shiftKey: opts.shift });
    for (const p of rest) fireEvent.pointerMove(svg, { pointerId: 1, ...px(...p), shiftKey: opts.shift });
    fireEvent.pointerUp(svg, { pointerId: 1, ...px(...(rest.at(-1) ?? first!)), shiftKey: opts.shift });
  };
  return { ...t, svg, pageId, annots, tool, drag };
}

async function waitForOverlay(): Promise<SVGSVGElement> {
  const { waitFor } = await import('@testing-library/react');
  return waitFor(() => {
    const el = document.querySelector<SVGSVGElement>('svg.overlay');
    if (!el) throw new Error('overlay not mounted yet');
    return el;
  });
}

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 1);

describe('drawing shapes', () => {
  it('drags out a rectangle in PDF coordinates, as one undo step', async () => {
    const { annots, tool, drag, store } = await ready();
    tool('Rectangle');
    drag([[20, 200], [120, 150]]);
    const [a] = annots() as ShapeAnnot[];
    expect(annots()).toHaveLength(1);
    expect(a).toMatchObject({ type: 'shape', shape: 'rect', origin: 'app', width: 2 });
    near(a!.rect.x, 20); near(a!.rect.y, 150); near(a!.rect.w, 100); near(a!.rect.h, 50);
    expect(store.getSnapshot().undoLabel).toBe('Add annotation');
    store.undo();
    expect(annots()).toHaveLength(0);
  });

  it('draws the same box whichever corner the drag starts from', async () => {
    const { annots, tool, drag } = await ready();
    tool('Ellipse');
    drag([[120, 150], [20, 200]]);
    const a = annots()[0] as ShapeAnnot;
    expect(a.shape).toBe('ellipse');
    near(a.rect.x, 20); near(a.rect.y, 150); near(a.rect.w, 100); near(a.rect.h, 50);
  });

  it('ignores a click that is not a drag', async () => {
    const { annots, tool, drag, store } = await ready();
    tool('Rectangle');
    drag([[50, 50], [50.5, 50.5]]);
    expect(annots()).toHaveLength(0);
    expect(store.getSnapshot().canUndo).toBe(true); // only the file open
    expect(store.getSnapshot().undoLabel).not.toBe('Add annotation');
  });

  it('keeps shapes square with Shift', async () => {
    const { annots, tool, drag } = await ready();
    tool('Rectangle');
    drag([[20, 200], [120, 170]], { shift: true });
    const a = annots()[0] as ShapeAnnot;
    near(a.rect.w, 100); near(a.rect.h, 100);
  });

  it('draws lines and arrows with their end points, and snaps them with Shift', async () => {
    const { annots, tool, drag } = await ready();
    tool('Line');
    drag([[20, 100], [120, 160]]);
    tool('Arrow');
    drag([[20, 50], [120, 54]], { shift: true });
    const [line, arrow] = annots() as ShapeAnnot[];
    expect(line).toMatchObject({ shape: 'line' });
    near(line!.line![0].x, 20); near(line!.line![1].x, 120); near(line!.line![1].y, 160);
    expect(arrow).toMatchObject({ shape: 'arrow' });
    near(arrow!.line![1].y, 50); // snapped to horizontal
  });

  it('shows the shape while dragging, before anything is committed', async () => {
    const { svg, tool, annots } = await ready();
    tool('Rectangle');
    fireEvent.pointerDown(svg, { button: 0, pointerId: 1, ...px(20, 200) });
    fireEvent.pointerMove(svg, { pointerId: 1, ...px(120, 150) });
    expect(svg.querySelector('[data-annot-id="draft"] rect')).not.toBeNull();
    expect(annots()).toHaveLength(0);
    fireEvent.pointerUp(svg, { pointerId: 1, ...px(120, 150) });
    expect(svg.querySelector('[data-annot-id="draft"]')).toBeNull();
    expect(annots()).toHaveLength(1);
  });
});

describe('drawing ink', () => {
  it('records a stroke and simplifies it', async () => {
    const { annots, tool, drag } = await ready();
    tool('Pen');
    // 40 collinear points: should collapse to the two ends.
    drag(Array.from({ length: 40 }, (_, i) => [20 + i * 2, 100 + i] as [number, number]));
    const [a] = annots() as InkAnnot[];
    expect(a).toMatchObject({ type: 'ink', width: 2 });
    expect(a!.strokes).toHaveLength(1);
    expect(a!.strokes[0]!.length).toBeLessThanOrEqual(3);
    near(a!.strokes[0]![0]!.x, 20);
    near(a!.strokes[0]!.at(-1)!.x, 98);
  });

  it('keeps the corners of a stroke', async () => {
    const { annots, tool, drag } = await ready();
    tool('Pen');
    drag([[20, 100], [60, 100], [100, 100], [100, 140], [100, 180]]);
    const a = annots()[0] as InkAnnot;
    expect(a.strokes[0]).toHaveLength(3);
  });

  it('turns a tap into a dot', async () => {
    const { annots, tool, drag } = await ready();
    tool('Pen');
    drag([[50, 50]]);
    const a = annots()[0] as InkAnnot;
    expect(a.strokes).toHaveLength(1);
    expect(a.strokes[0]).toHaveLength(1);
  });
});

describe('selecting, moving and resizing', () => {
  async function withRect() {
    const t = await ready();
    t.tool('Rectangle');
    t.drag([[20, 200], [120, 150]]);
    t.tool('Select');
    return t;
  }
  const rectOf = (t: { annots: () => Annotation[] }) => (t.annots()[0] as ShapeAnnot).rect;

  it('selects an outline by clicking on it, and deselects by clicking empty space', async () => {
    const t = await withRect();
    t.drag([[70, 200]]); // top edge
    expect(t.store.getSnapshot().ui.selectedAnnot).toEqual({ pageId: t.pageId, id: t.annots()[0]!.id });
    t.drag([[10, 20]]);
    expect(t.store.getSnapshot().ui.selectedAnnot).toBeUndefined();
  });

  it('does not select by clicking inside an unfilled rectangle', async () => {
    const t = await withRect();
    t.drag([[70, 175]]);
    expect(t.store.getSnapshot().ui.selectedAnnot).toBeUndefined();
  });

  it('moves with the pointer as a single undo step', async () => {
    const t = await withRect();
    const before = { ...rectOf(t) };
    const undoStackBefore = t.store.getSnapshot().undoLabel;
    t.drag([[70, 200], [80, 190], [100, 170]]);
    near(rectOf(t).x, before.x + 30); near(rectOf(t).y, before.y - 30);
    near(rectOf(t).w, before.w);
    expect(t.store.getSnapshot().undoLabel).toBe('Edit annotation');
    t.store.undo();
    expect(rectOf(t)).toEqual(before);
    expect(t.store.getSnapshot().undoLabel).toBe(undoStackBefore);
  });

  it('shows a live preview while moving without touching the document', async () => {
    const t = await withRect();
    const before = { ...rectOf(t) };
    fireEvent.pointerDown(t.svg, { button: 0, pointerId: 1, ...px(70, 200) });
    fireEvent.pointerMove(t.svg, { pointerId: 1, ...px(100, 170) });
    expect(rectOf(t)).toEqual(before);
    const live = t.svg.querySelector('[data-annot-id] rect:not(.selection-outline)') as SVGRectElement;
    near(Number(live.getAttribute('x')), 50 * S); // 20 + 30 points
    fireEvent.pointerUp(t.svg, { pointerId: 1, ...px(100, 170) });
  });

  it('a click without movement does not create an undo step', async () => {
    const t = await withRect();
    const label = t.store.getSnapshot().undoLabel;
    t.drag([[70, 200]]);
    expect(t.store.getSnapshot().undoLabel).toBe(label);
  });

  it('resizes from a corner handle, keeping the opposite corner', async () => {
    const t = await withRect();
    t.drag([[70, 200]]); // select
    const handle = t.svg.querySelector('[data-handle="ne"]')!;
    expect(handle).not.toBeNull();
    t.drag([[120, 200], [150, 220]], { target: handle });
    const r = rectOf(t);
    near(r.x, 20); near(r.y, 150); near(r.w, 130); near(r.h, 70);
    t.store.undo();
    near(rectOf(t).w, 100);
  });

  it('shows end handles for a line and moves one end', async () => {
    const t = await ready();
    t.tool('Line');
    t.drag([[20, 100], [120, 100]]);
    t.tool('Select');
    t.drag([[70, 100]]);
    expect([...t.svg.querySelectorAll('[data-handle]')].map((h) => h.getAttribute('data-handle'))).toEqual(['start', 'end']);
    t.drag([[120, 100], [120, 160]], { target: t.svg.querySelector('[data-handle="end"]')! });
    const l = t.annots()[0] as ShapeAnnot;
    near(l.line![0].y, 100); near(l.line![1].y, 160);
    near(l.rect.h, 60);
  });

  it('moves ink', async () => {
    const t = await ready();
    t.tool('Pen');
    t.drag([[20, 100], [60, 140], [100, 100]]);
    t.tool('Select');
    t.drag([[60, 140], [60, 170]]);
    const a = t.annots()[0] as InkAnnot;
    near(a.strokes[0]![1]!.y, 170);
  });

  it('deletes the selected annotation with the Delete key, and undo brings it back', async () => {
    const t = await withRect();
    t.drag([[70, 200]]);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(t.annots()).toHaveLength(0);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(t.annots()).toHaveLength(1);
  });

  it('leaves annotations that came from other tools alone', async () => {
    const t = await ready();
    const imported: ShapeAnnot = {
      type: 'shape', shape: 'rect', id: 'imp', pageId: t.pageId, author: 'x', createdAt: 't', modifiedAt: 't',
      color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, origin: 'imported', rect: { x: 20, y: 150, w: 100, h: 50 }, width: 2,
    };
    t.store.execute(addAnnotation(imported));
    t.tool('Select');
    t.drag([[70, 200], [100, 170]]);
    expect(t.store.getSnapshot().ui.selectedAnnot?.id).toBe('imp'); // selectable...
    expect((t.annots()[0] as ShapeAnnot).rect).toEqual(imported.rect); // ...but not movable
    expect(t.svg.querySelector('[data-handle]')).toBeNull();
  });
});

describe('line style', () => {
  it('only shows the style controls when they apply', async () => {
    const t = await ready();
    expect(screen.queryByLabelText('Line style')).toBeNull();
    t.tool('Pen');
    expect(screen.getByLabelText('Line style')).toBeTruthy();
    t.tool('Highlight');
    expect(screen.queryByLabelText('Line style')).toBeNull();
  });

  it('draws new shapes in the chosen colour and width', async () => {
    const t = await ready();
    t.tool('Rectangle');
    fireEvent.click(screen.getByLabelText('Blue'));
    fireEvent.click(screen.getByLabelText('Width 8'));
    t.drag([[20, 200], [120, 150]]);
    const a = t.annots()[0]!;
    expect(a.color).toMatchObject({ r: 0.15, g: 0.4, b: 0.9 });
    expect((a as ShapeAnnot).width).toBe(8);
    expect(screen.getByLabelText('Blue').getAttribute('aria-pressed')).toBe('true');
  });

  it('restyles the selected annotation as one undo step', async () => {
    const t = await ready();
    t.tool('Rectangle');
    t.drag([[20, 200], [120, 150]]);
    t.tool('Select');
    t.drag([[70, 200]]);
    fireEvent.click(screen.getByLabelText('Green'));
    expect(t.annots()[0]!.color).toMatchObject({ r: 0.1, g: 0.6, b: 0.3 });
    expect(t.store.getSnapshot().undoLabel).toBe('Edit annotation');
    fireEvent.click(screen.getByLabelText('Width 4'));
    expect((t.annots()[0] as ShapeAnnot).width).toBe(4);
    t.store.undo();
    expect((t.annots()[0] as ShapeAnnot).width).toBe(2);
    expect(t.annots()[0]!.color).toMatchObject({ g: 0.6 }); // the colour change is still there
  });

  it('switches tools with the keyboard', async () => {
    const t = await ready();
    for (const [key, name] of [['p', 'ink'], ['r', 'rect'], ['e', 'ellipse'], ['l', 'line'], ['a', 'arrow'], ['v', 'select']] as const) {
      fireEvent.keyDown(window, { key });
      expect(t.store.getSnapshot().ui.activeTool).toBe(name);
    }
  });
});

describe('fast gestures', () => {
  // A mouse move and the release can arrive before React has re-rendered. The release must use the latest position,
  // not the last one that was drawn, or a quick flick loses its final stretch.
  const quick = (host: Element, events: [string, [number, number]][]) =>
    act(() => {
      for (const [type, [x, y]] of events) {
        const e = new MouseEvent(type, { bubbles: true, clientX: px(x, y).clientX, clientY: px(x, y).clientY, button: 0 });
        Object.assign(e, { pointerId: 1 });
        host.dispatchEvent(e);
      }
    });

  it('a drag released at once still ends where the pointer last was', async () => {
    const t = await ready();
    t.tool('Rectangle');
    quick(t.svg.parentElement!, [['pointerdown', [20, 200]], ['pointermove', [60, 180]], ['pointermove', [120, 150]], ['pointerup', [120, 150]]]);
    const [a] = t.annots() as ShapeAnnot[];
    near(a!.rect.w, 100);
    near(a!.rect.h, 50);
  });

  it('a move released at once still lands where the pointer last was', async () => {
    const t = await ready();
    t.tool('Rectangle');
    t.drag([[20, 200], [120, 150]]);
    t.tool('Select');
    quick(t.svg.parentElement!, [['pointerdown', [70, 200]], ['pointermove', [80, 190]], ['pointermove', [100, 170]], ['pointerup', [100, 170]]]);
    near((t.annots()[0] as ShapeAnnot).rect.x, 50);
  });

  it('a pen stroke released at once keeps its last point', async () => {
    const t = await ready();
    t.tool('Pen');
    quick(t.svg.parentElement!, [['pointerdown', [20, 100]], ['pointermove', [60, 100]], ['pointermove', [100, 100]], ['pointermove', [140, 100]], ['pointerup', [140, 100]]]);
    const a = t.annots()[0] as InkAnnot;
    near(a.strokes[0]!.at(-1)!.x, 140);
  });
});
