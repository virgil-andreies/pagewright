import { describe, expect, it, vi } from 'vitest';
import { quadBounds, type PageGeometry } from '@pagewright/core';
import { applySelectionMarkup, hasSelection, selectionToMarkup, type PageRegistry } from '../src/selection';
import { file, setup } from './store-helpers';

type R = [x: number, y: number, w: number, h: number];
const domRect = ([x, y, w, h]: R) => ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h }) as DOMRect;

/** A stand-in for window.getSelection(): each range reports the client rectangles the browser would. */
function fakeSelection(ranges: R[][], collapsed = false) {
  const removeAllRanges = vi.fn();
  return {
    selection: {
      rangeCount: ranges.length,
      isCollapsed: collapsed,
      getRangeAt: (i: number) => ({ getClientRects: () => ranges[i]!.map(domRect) }),
      removeAllRanges,
    } as unknown as Selection,
    removeAllRanges,
  };
}

const geometry = (rotation: 0 | 90 | 180 | 270 = 0): PageGeometry => ({
  cropBox: { x: 0, y: 0, w: 200, h: 300 }, intrinsicRotation: 0, extraRotation: rotation, userUnit: 1,
});

/** A page whose top-left corner is at (left, top) on screen. */
const pageAt = (left: number, top: number, w = 266.67, h = 400): { host: HTMLElement; geometry: PageGeometry; scale: number } => ({
  host: { getBoundingClientRect: () => domRect([left, top, w, h]) } as unknown as HTMLElement,
  geometry: geometry(),
  scale: 96 / 72,
});

describe('selectionToMarkup', () => {
  it('turns the selected text into one quad per line, in PDF space', () => {
    const pages: PageRegistry = new Map([['p1', pageAt(100, 50)]]);
    // Two lines, each reported twice (element box + text box), as browsers do.
    const { selection } = fakeSelection([[[140, 100, 120, 16], [140, 100, 120, 16], [110, 120, 80, 16], [110, 119, 80, 18]]]);
    const marks = selectionToMarkup(selection, pages);
    expect(marks).toHaveLength(1);
    expect(marks[0]!.pageId).toBe('p1');
    expect(marks[0]!.quads).toHaveLength(2);
    const [l1, l2] = marks[0]!.quads.map(quadBounds);
    // page-relative x = 140 - 100 = 40 px = 30 pt; width 120 px = 90 pt
    expect(l1!.x).toBeCloseTo(30);
    expect(l1!.w).toBeCloseTo(90);
    expect(l2!.x).toBeCloseTo(7.5);
    expect(l1!.y).toBeGreaterThan(l2!.y); // the first line is higher on the page, and PDF y points up
  });

  it('joins the pieces of one line that the browser reports separately', () => {
    const pages: PageRegistry = new Map([['p1', pageAt(0, 0)]]);
    const { selection } = fakeSelection([[[10, 10, 40, 14], [50, 10, 30, 14], [83, 10, 20, 14]]]);
    expect(selectionToMarkup(selection, pages)[0]!.quads).toHaveLength(1);
  });

  it('gives each page its own markup when the selection spans pages', () => {
    const pages: PageRegistry = new Map([['p1', pageAt(0, 0)], ['p2', pageAt(0, 420)]]);
    const { selection } = fakeSelection([[[10, 350, 100, 14]], [[10, 430, 100, 14]]]);
    const marks = selectionToMarkup(selection, pages);
    expect(marks.map((m) => [m.pageId, m.quads.length])).toEqual([['p1', 1], ['p2', 1]]);
    // Both are at the same page-relative x, but page two's quad is measured from its own top edge.
    expect(quadBounds(marks[1]!.quads[0]!).y).toBeGreaterThan(quadBounds(marks[0]!.quads[0]!).y);
  });

  it('ignores selected text that is not on a page (toolbar, comments panel)', () => {
    const pages: PageRegistry = new Map([['p1', pageAt(100, 100)]]);
    const { selection } = fakeSelection([[[10, 10, 80, 14], [500, 500, 80, 14], [120, 130, 60, 14]]]);
    const marks = selectionToMarkup(selection, pages);
    expect(marks[0]!.quads).toHaveLength(1);
  });

  it('uses each page’s own rotation', () => {
    const rotated: PageRegistry = new Map([['p1', { ...pageAt(0, 0, 400, 266.67), geometry: geometry(90) }]]);
    const { selection } = fakeSelection([[[40, 20, 80, 14]]]);
    const b = quadBounds(selectionToMarkup(selection, rotated)[0]!.quads[0]!);
    // On a page turned 90 degrees, a wide, short screen rectangle is a tall, narrow one in the page.
    expect(b.h).toBeGreaterThan(b.w);
    expect(b.h).toBeCloseTo(80 / (96 / 72));
  });

  it.each([[null], [fakeSelection([], false).selection], [fakeSelection([[[0, 0, 10, 10]]], true).selection]])(
    'returns nothing for no selection, an empty one, or a collapsed one',
    (selection) => {
      expect(selectionToMarkup(selection as Selection | null, new Map([['p1', pageAt(0, 0)]]))).toEqual([]);
    },
  );

  it('returns nothing when the selection touches no page', () => {
    const { selection } = fakeSelection([[[900, 900, 50, 14]]]);
    expect(selectionToMarkup(selection, new Map([['p1', pageAt(0, 0)]]))).toEqual([]);
  });

  it('ignores zero-size rectangles such as line breaks', () => {
    const { selection } = fakeSelection([[[10, 10, 0, 14], [10, 10, 40, 0]]]);
    expect(selectionToMarkup(selection, new Map([['p1', pageAt(0, 0)]]))).toEqual([]);
  });
});

describe('hasSelection', () => {
  it('is true only for a non-collapsed selection with a range', () => {
    expect(hasSelection(fakeSelection([[[0, 0, 5, 5]]]).selection)).toBe(true);
    expect(hasSelection(fakeSelection([[[0, 0, 5, 5]]], true).selection)).toBe(false);
    expect(hasSelection(fakeSelection([]).selection)).toBe(false);
    expect(hasSelection(null as unknown as Selection)).toBe(false);
  });
});

describe('applySelectionMarkup', () => {
  async function ready() {
    const t = setup();
    await t.store.addFiles([file('a.pdf')]);
    const [p1, p2] = t.store.getSnapshot().doc.pages.map((p) => p.id) as [string, string];
    const pages: PageRegistry = new Map([[p1, pageAt(0, 0)], [p2, pageAt(0, 420)]]);
    const annots = (id: string) => t.store.getSnapshot().doc.annotations[id] ?? [];
    return { ...t, p1, p2, pages, annots };
  }

  it('marks the selected text, clears the selection, and reports success', async () => {
    const { store, pages, p1, annots } = await ready();
    const { selection, removeAllRanges } = fakeSelection([[[20, 100, 90, 14]]]);
    expect(applySelectionMarkup(store, pages, 'highlight', selection)).toBe(true);
    expect(annots(p1)).toHaveLength(1);
    expect(annots(p1)[0]).toMatchObject({ type: 'highlight', origin: 'app', opacity: 0.5 });
    expect(removeAllRanges).toHaveBeenCalled();
  });

  it('does nothing, and leaves the selection alone, when there is nothing to mark', async () => {
    const { store, pages, annots, p1 } = await ready();
    const { selection, removeAllRanges } = fakeSelection([[[900, 900, 10, 10]]]);
    expect(applySelectionMarkup(store, pages, 'underline', selection)).toBe(false);
    expect(annots(p1)).toHaveLength(0);
    expect(removeAllRanges).not.toHaveBeenCalled();
  });

  it('marks a selection that spans pages as one undo step', async () => {
    const { store, pages, annots, p1, p2 } = await ready();
    const { selection } = fakeSelection([[[20, 350, 90, 14]], [[20, 440, 90, 14]]]);
    applySelectionMarkup(store, pages, 'strikeout', selection);
    expect(annots(p1)).toHaveLength(1);
    expect(annots(p2)).toHaveLength(1);
    expect(store.getSnapshot().undoLabel).toBe('Strike out text');
    store.undo();
    expect(annots(p1)).toHaveLength(0);
    expect(annots(p2)).toHaveLength(0);
  });

  it('labels each kind of markup for the undo menu', async () => {
    const { store, pages } = await ready();
    for (const [type, label] of [['highlight', 'Highlight text'], ['underline', 'Underline text'], ['strikeout', 'Strike out text']] as const) {
      applySelectionMarkup(store, pages, type, fakeSelection([[[20, 100, 90, 14]]]).selection);
      expect(store.getSnapshot().undoLabel).toBe(label);
    }
  });
});
