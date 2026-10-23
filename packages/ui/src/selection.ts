import { mergeRectsIntoLines, viewRectToQuad, type PageGeometry, type PageId, type Quad, type Rect } from '@pagewright/core';
import type { AppStore, MarkupType } from './store';

/** What the selection code needs to know about a page that is on screen. */
export interface PageEntry {
  /** The element that covers the page, at the page's top-left corner. */
  host: HTMLElement;
  geometry: PageGeometry;
  /** CSS pixels per PDF point. */
  scale: number;
}

export type PageRegistry = Map<PageId, PageEntry>;

export interface PageMarkup {
  pageId: PageId;
  quads: Quad[];
}

const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, w: r.width, h: r.height });
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inside = (r: Rect, p: { x: number; y: number }) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/**
 * The selected text as highlight quads, grouped by page. The browser reports every text fragment of the
 * selection as a client rectangle; each is assigned to the page whose element contains it, tidied into one
 * rectangle per line, and mapped into PDF space with that page's own geometry. Selected text outside any
 * page (the toolbar, the comments panel) is ignored.
 */
export function selectionToMarkup(selection: Selection | null, pages: PageRegistry): PageMarkup[] {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return [];
  const rects: Rect[] = [];
  for (let i = 0; i < selection.rangeCount; i++) {
    for (const r of selection.getRangeAt(i).getClientRects()) rects.push(toRect(r));
  }

  const out: PageMarkup[] = [];
  for (const [pageId, { host, geometry, scale }] of pages) {
    const box = toRect(host.getBoundingClientRect());
    const mine = rects.filter((r) => inside(box, center(r))).map((r): Rect => ({ x: r.x - box.x, y: r.y - box.y, w: r.w, h: r.h }));
    const lines = mergeRectsIntoLines(mine);
    if (lines.length > 0) out.push({ pageId, quads: lines.map((l) => viewRectToQuad(geometry, scale, l)) });
  }
  return out;
}

/** Turns the current text selection into a markup annotation of `type`. Returns whether anything was marked. */
export function applySelectionMarkup(store: AppStore, pages: PageRegistry, type: MarkupType, selection = window.getSelection()): boolean {
  const marks = selectionToMarkup(selection, pages);
  if (marks.length === 0) return false;
  store.addMarkups(type, marks);
  selection?.removeAllRanges();
  return true;
}

export function hasSelection(selection = window.getSelection()): boolean {
  return !!selection && !selection.isCollapsed && selection.rangeCount > 0;
}
