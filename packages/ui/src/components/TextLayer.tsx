import { useEffect, useRef } from 'react';
import type { PageRef } from '@pagewright/core';
import { useUi } from '../react';

/**
 * A transparent, selectable copy of the page's text, laid exactly over the rendered page (spec section 10:
 * canvas, text layer, annotation overlay). The browser does the selecting and copying; PDF.js positions the
 * text. It only takes mouse input while the Select or a markup tool is active (see the stylesheet), and it is
 * only built for pages near the viewport.
 */
export function TextLayer({ page, scale }: { page: PageRef; scale: number }) {
  const { store } = useUi();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const rd = store.getRenderDoc(page.sourceId);
    if (!el || !rd) return;
    const ac = new AbortController();
    rd.renderTextLayer(page.sourceIndex, { scale, extraRotation: page.rotation, container: el }, ac.signal).catch(() => {
      /* cancelled by a newer render, or a page without text */
    });
    return () => ac.abort();
  }, [store, page.sourceId, page.sourceIndex, page.rotation, scale]);

  // PDF.js's own viewer marks the layer while a selection drag is in progress so the drag does not stall in the
  // gaps between lines; the stylesheet relies on the same class.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => el.classList.add('selecting');
    const off = () => el.classList.remove('selecting');
    el.addEventListener('pointerdown', on);
    window.addEventListener('pointerup', off);
    window.addEventListener('blur', off);
    return () => {
      el.removeEventListener('pointerdown', on);
      window.removeEventListener('pointerup', off);
      window.removeEventListener('blur', off);
    };
  }, []);

  return <div ref={ref} className="textLayer" />;
}
