import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import type { PdfRenderer, PdfWriter, RenderDoc } from '@pagewright/engine';
import type { PickedFile, Platform } from '@pagewright/platform';
import { AppShell, AppStore } from '../src';

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

export function setup(pageCount = 3) {
  const renderPage = vi.fn(async () => {});
  const renderer: PdfRenderer = {
    open: async (s) =>
      ({
        sourceId: s.id, pageCount, destroy() {}, renderPage, getPageInfo: async () => info,
        getTextContent: async () => [], getExistingAnnotations: async () => [],
      }) satisfies RenderDoc,
  };
  const writer: PdfWriter = { save: vi.fn(async () => new Uint8Array([1])) };
  const saveFile = vi.fn(async (name: string) => ({ saved: true as const, name }));
  const openSaveTarget = vi.fn(async (name: string) => ({ write: async () => saveFile(name) }));
  let nextFile: PickedFile[] = [];
  const platform = {
    fs: { openSaveTarget, pickFiles: vi.fn(async () => nextFile), onOpenRequest: () => () => {} },
    device: { platform: 'web', memoryBudgetMB: 1000 },
  } as unknown as Platform;
  let n = 0;
  const store = new AppStore({ renderer, writer, platform, newId: () => `id${++n}` });
  const open = async () => {
    nextFile = [{ name: 'doc.pdf', size: 1, read: async () => new Uint8Array([1]) }];
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(store.getSnapshot().doc.pages).toHaveLength(pageCount));
  };
  render(<AppShell store={store} />);
  return { store, open, renderPage, saveFile, writer };
}

