import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { displaySize, type PageRef } from '@pagewright/core';
import { geometryOf, usePageInfo, usePageRender, useNearViewport, useSnapshot, useUi } from '../react';

const THUMB_WIDTH = 120;

function Thumbnail({ page, index, selected, current }: { page: PageRef; index: number; selected: boolean; current: boolean }) {
  const info = usePageInfo(page);
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { near, visible } = useNearViewport(ref, 300);
  const size = info ? displaySize(geometryOf(page, info)) : { w: 3, h: 4 };
  const scale = THUMB_WIDTH / size.w;
  usePageRender(canvasRef, page, scale, visible ? 'near' : 'thumbnail', near && !!info);

  return (
    <div
      ref={ref}
      className={`thumb${selected ? ' selected' : ''}${current ? ' current' : ''}`}
      data-page-id={page.id}
      data-index={index}
      role="option"
      aria-selected={selected}
      aria-label={`Page ${index + 1}`}
    >
      <div className="thumb-frame" style={{ width: THUMB_WIDTH, height: Math.round(THUMB_WIDTH * (size.h / size.w)) }}>
        <canvas ref={canvasRef} />
      </div>
      <span className="thumb-label">{index + 1}</span>
    </div>
  );
}

interface DragState {
  pageId: string;
  startY: number;
  active: boolean;
  /** Index among the pages that stay put (the position the moved pages will start at). */
  dropIndex: number;
}

export function PageGrid() {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const movingIds = (pageId: string) => (ui.selection.has(pageId) ? [...ui.selection] : [pageId]);

  const dropIndexFor = (clientY: number, moving: Set<string>): number => {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('.thumb') ?? [])];
    let n = 0;
    for (const el of items) {
      if (moving.has(el.dataset.pageId ?? '')) continue;
      const r = el.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) n++;
    }
    return n;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.thumb');
    if (!el?.dataset.pageId) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ pageId: el.dataset.pageId, startY: e.clientY, active: false, dropIndex: 0 });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const active = drag.active || Math.abs(e.clientY - drag.startY) > 6;
    if (!active) return;
    setDrag({ ...drag, active, dropIndex: dropIndexFor(e.clientY, new Set(movingIds(drag.pageId))) });
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag(null);
    if (drag.active) {
      store.movePages(drag.dropIndex, movingIds(drag.pageId)); // one command per gesture
    } else {
      store.selectPage(drag.pageId, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
    }
  };

  // Where the insertion line goes, expressed as an index into the full list.
  let lineBefore: string | undefined;
  let lineAtEnd = false;
  if (drag?.active) {
    const moving = new Set(movingIds(drag.pageId));
    const rest = doc.pages.filter((p) => !moving.has(p.id));
    lineBefore = rest[drag.dropIndex]?.id;
    lineAtEnd = lineBefore === undefined;
  }

  return (
    <div
      ref={listRef}
      className={`page-grid${drag?.active ? ' dragging' : ''}`}
      role="listbox"
      aria-multiselectable="true"
      aria-label="Pages"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      {doc.pages.map((p, i) => (
        <div key={p.id} className="thumb-slot">
          {lineBefore === p.id && <div className="drop-line" />}
          <Thumbnail page={p} index={i} selected={ui.selection.has(p.id)} current={ui.currentPage === i} />
        </div>
      ))}
      {lineAtEnd && <div className="drop-line" />}
      {doc.pages.length === 0 && <p className="empty-hint">No pages yet</p>}
    </div>
  );
}
