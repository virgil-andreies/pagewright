import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { PageGeometry, PageRef } from '@pagewright/core';
import { RenderCancelled, type PageInfo, type Priority, type RenderQueue } from '@pagewright/engine';
import type { PageRegistry } from './selection';
import type { AppStore, Snapshot } from './store';

export interface UiContextValue {
  store: AppStore;
  queue: RenderQueue;
  /** The pages currently on screen, so a text selection can be mapped back onto them. */
  pages: PageRegistry;
}

export const UiContext = createContext<UiContextValue | null>(null);

export function useUi(): UiContextValue {
  const v = useContext(UiContext);
  if (!v) throw new Error('UiContext is missing: wrap the app in <PagewrightProvider>');
  return v;
}

export function useSnapshot(): Snapshot {
  const { store } = useUi();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

/** Intrinsic page info is immutable per (source, index), so cache it for the session. */
const infoCache = new WeakMap<object, Map<number, Promise<PageInfo>>>();

export function usePageInfo(page: PageRef): PageInfo | undefined {
  const { store } = useUi();
  const [info, setInfo] = useState<PageInfo>();
  useEffect(() => {
    const rd = store.getRenderDoc(page.sourceId);
    if (!rd) return;
    let perDoc = infoCache.get(rd);
    if (!perDoc) infoCache.set(rd, (perDoc = new Map()));
    let p = perDoc.get(page.sourceIndex);
    if (!p) perDoc.set(page.sourceIndex, (p = rd.getPageInfo(page.sourceIndex)));
    let live = true;
    p.then((i) => live && setInfo(i), () => {});
    return () => {
      live = false;
    };
  }, [store, page.sourceId, page.sourceIndex]);
  return info;
}

export function geometryOf(page: PageRef, info: PageInfo): PageGeometry {
  return { cropBox: info.cropBox, intrinsicRotation: info.rotation, extraRotation: page.rotation, userUnit: info.userUnit };
}

/**
 * Renders `page` into `canvasRef` through the shared queue. `scale` is CSS pixels per point; the canvas
 * backing store is multiplied by devicePixelRatio. Re-renders when scale, rotation or priority changes,
 * and cancels in-flight work on unmount.
 */
export function usePageRender(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  page: PageRef,
  scale: number,
  priority: Priority,
  enabled = true,
): { rendered: boolean; error?: Error } {
  const { store, queue } = useUi();
  const [state, setState] = useState<{ rendered: boolean; error?: Error }>({ rendered: false });
  const priorityRef = useRef(priority);
  priorityRef.current = priority;

  useEffect(() => {
    const canvas = canvasRef.current;
    const rd = store.getRenderDoc(page.sourceId);
    if (!enabled || !canvas || !rd) return;
    const ac = new AbortController();
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    // Render into a detached canvas, then blit, so a re-render never shows a blank flash.
    const buffer = document.createElement('canvas');
    queue
      .enqueue(
        {
          key: `${page.id}@${page.rotation}x${scale.toFixed(3)}`,
          priority: priorityRef.current,
          run: (signal) =>
            rd.renderPage(page.sourceIndex, { scale: scale * dpr, extraRotation: page.rotation, withAnnotations: 'source', target: buffer }, signal),
        },
        ac.signal,
      )
      .then(() => {
        canvas.width = buffer.width;
        canvas.height = buffer.height;
        canvas.style.width = `${buffer.width / dpr}px`;
        canvas.style.height = `${buffer.height / dpr}px`;
        canvas.getContext('2d')?.drawImage(buffer, 0, 0);
        setState({ rendered: true });
      })
      .catch((e: unknown) => {
        if (!(e instanceof RenderCancelled)) setState({ rendered: false, error: e as Error });
      });
    return () => ac.abort();
  }, [store, queue, canvasRef, page.id, page.sourceId, page.sourceIndex, page.rotation, scale, enabled]);

  return state;
}

/** True once the element has come within `margin` px of the scroll viewport. */
export function useNearViewport(ref: RefObject<Element | null>, margin = 600): { near: boolean; visible: boolean } {
  const [s, setS] = useState({ near: false, visible: false });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setS({ near: true, visible: true });
      return;
    }
    const near = new IntersectionObserver(([e]) => e && setS((p) => ({ ...p, near: e.isIntersecting })), { rootMargin: `${margin}px` });
    const vis = new IntersectionObserver(([e]) => e && setS((p) => ({ ...p, visible: e.isIntersecting })));
    near.observe(el);
    vis.observe(el);
    return () => {
      near.disconnect();
      vis.disconnect();
    };
  }, [ref, margin]);
  return s;
}
