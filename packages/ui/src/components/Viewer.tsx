import { useEffect, useRef } from 'react';
import { displaySize, type PageRef } from '@pagewright/core';
import { geometryOf, useNearViewport, usePageInfo, usePageRender, useSnapshot, useUi } from '../react';
import { AnnotationOverlay } from './AnnotationOverlay';

/** CSS pixels per PDF point at zoom 1 (96 dpi / 72). */
const BASE_SCALE = 96 / 72;

function PageView({ page, index }: { page: PageRef; index: number }) {
  const { ui } = useSnapshot();
  const info = usePageInfo(page);
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { near, visible } = useNearViewport(ref);
  const scale = ui.zoom * BASE_SCALE;
  const geometry = info ? geometryOf(page, info) : undefined;
  const size = geometry ? displaySize(geometry) : { w: 612, h: 792 };
  const width = Math.round(size.w * scale);
  const height = Math.round(size.h * scale);
  // Pages outside the window release their pixels (spec section 5.1): the canvas unmounts with `near`.
  usePageRender(canvasRef, page, scale, visible ? 'visible' : 'near', near && !!info);

  return (
    <div ref={ref} className="page-view" data-index={index} style={{ width, height }} aria-label={`Page ${index + 1}`}>
      {near && <canvas ref={canvasRef} />}
      {near && geometry && <AnnotationOverlay page={page} geometry={geometry} scale={scale} width={width} height={height} />}
    </div>
  );
}

export function Viewer() {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const scrollRef = useRef<HTMLDivElement>(null);
  const reported = useRef(0);

  // Scroll -> current page: the page crossing the vertical middle of the viewport.
  const onScroll = () => {
    const root = scrollRef.current;
    if (!root) return;
    const mid = root.getBoundingClientRect().top + root.clientHeight / 2;
    let found = 0;
    root.querySelectorAll<HTMLElement>('.page-view').forEach((el, i) => {
      if (el.getBoundingClientRect().top <= mid) found = i;
    });
    if (found !== ui.currentPage) {
      reported.current = found;
      store.setCurrentPage(found);
    }
  };

  // Current page -> scroll, but only when the change did not come from scrolling.
  useEffect(() => {
    if (reported.current === ui.currentPage) return;
    reported.current = ui.currentPage;
    scrollRef.current?.querySelectorAll<HTMLElement>('.page-view')[ui.currentPage]?.scrollIntoView({ block: 'start' });
  }, [ui.currentPage]);

  // Ctrl + wheel zooms.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      store.setZoom(store.getSnapshot().ui.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [store]);

  return (
    <div ref={scrollRef} className="viewer" onScroll={onScroll}>
      {doc.pages.map((p, i) => (
        <PageView key={p.id} page={p} index={i} />
      ))}
      {doc.pages.length === 0 && (
        <div className="empty-state">
          <p>Open a PDF to get started</p>
          <button onClick={() => void store.platform.fs.pickFiles({ multiple: true, accept: ['.pdf', 'application/pdf'] }).then((f) => store.addFiles(f))}>
            Open PDF
          </button>
          <p className="hint">or drop files anywhere in this window</p>
        </div>
      )}
    </div>
  );
}
