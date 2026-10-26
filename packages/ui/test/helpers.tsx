import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import type { PdfRenderer, PdfWriter, RenderDoc, RenderOpts } from '@pagewright/engine';
import type { SourceAnnotation } from '@pagewright/core';
import type { PickedFile, Platform } from '@pagewright/platform';
import { AppShell, AppStore, type ImageLoader, type SignatureMaker } from '../src';

afterEach(cleanup);

// jsdom 25 has no PointerEvent; without it `button`/`clientY` are lost on pointer events.
if (!('PointerEvent' in window)) {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  (window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventPolyfill;
}

// jsdom has no canvas; the app only draws when a context exists.
HTMLCanvasElement.prototype.getContext = () => null;
Element.prototype.scrollIntoView = () => {};

export const info = { width: 200, height: 300, rotation: 0 as const, mediaBox: { x: 0, y: 0, w: 200, h: 300 }, cropBox: { x: 0, y: 0, w: 200, h: 300 }, userUnit: 1 };

export function setup(pageCount = 3, original: (pageIndex: number) => SourceAnnotation[] = () => [], signatureMaker?: SignatureMaker, imageLoader?: ImageLoader) {
  const secrets = new Map<string, unknown>();
  const renderPage = vi.fn(async (_index: number, _opts: RenderOpts, _signal?: AbortSignal) => {});
  const renderer: PdfRenderer = {
    open: async (s) =>
      ({
        sourceId: s.id, pageCount, destroy() {}, renderPage, getPageInfo: async () => info,
        getTextContent: async () => [], getExistingAnnotations: async () => [], renderTextLayer: async () => {},
        getSourceAnnotations: async (i: number) => original(i),
      }) satisfies RenderDoc,
  };
  const writer: PdfWriter = { save: vi.fn(async () => new Uint8Array([1])) };
  const saveFile = vi.fn(async (name: string) => ({ saved: true as const, name }));
  const openSaveTarget = vi.fn(async (name: string) => ({ write: async () => saveFile(name) }));
  let nextFile: PickedFile[] = [];
  const platform = {
    fs: { openSaveTarget, pickFiles: vi.fn(async () => nextFile), onOpenRequest: () => () => {} },
    device: { platform: 'web', memoryBudgetMB: 1000 },
    secure: { get: async (k: string) => secrets.get(k), set: async (k: string, v: unknown) => void secrets.set(k, JSON.parse(JSON.stringify(v))) },
    localData: { cleanUp: vi.fn(async () => {}), clearAll: vi.fn(async () => void secrets.clear()) },
  } as unknown as Platform;
  const restart = vi.fn();
  let n = 0;
  const store = new AppStore({ renderer, writer, platform, signatureMaker, imageLoader, restart, newId: () => `id${++n}` });
  const open = async () => {
    nextFile = [{ name: 'doc.pdf', size: 1, read: async () => new Uint8Array([1]) }];
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(store.getSnapshot().doc.pages).toHaveLength(pageCount));
  };
  render(<AppShell store={store} />);
  /** What the next file picker returns. */
  const pickNext = (files: PickedFile[]) => void (nextFile = files);
  return { store, open, renderPage, saveFile, writer, secrets, pickNext, platform, restart };
}

