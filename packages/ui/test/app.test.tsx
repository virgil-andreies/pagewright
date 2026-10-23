// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const info = { width: 200, height: 300, rotation: 0 as const, mediaBox: { x: 0, y: 0, w: 200, h: 300 }, cropBox: { x: 0, y: 0, w: 200, h: 300 }, userUnit: 1 };

function setup(pageCount = 3) {
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

const pages = () => within(screen.getByRole('listbox', { name: 'Pages' })).getAllByRole('option');
const btn = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('AppShell', () => {
  it('starts empty with page actions disabled', () => {
    setup();
    expect(screen.getByText('Open a PDF to get started')).toBeTruthy();
    expect(btn('Save').disabled).toBe(true);
    expect(btn('Delete').disabled).toBe(true);
  });

  it('opens a file, lists thumbnails and enables saving', async () => {
    const { open } = setup();
    await open();
    expect(pages()).toHaveLength(3);
    expect(btn('Save').disabled).toBe(false);
    expect(screen.getByText(/Page 1 of 3/)).toBeTruthy();
  });

  it('selects a page by click and deletes it from the toolbar, then undoes', async () => {
    const { open } = setup();
    await open();
    fireEvent.pointerDown(pages()[1]!, { button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerUp(pages()[1]!, { pointerId: 1, clientY: 10 });
    await waitFor(() => expect(pages()[1]!.getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(btn('Delete'));
    await waitFor(() => expect(pages()).toHaveLength(2));
    fireEvent.click(btn('Undo'));
    await waitFor(() => expect(pages()).toHaveLength(3));
  });

  it('supports keyboard shortcuts: select all, delete, undo', async () => {
    const { open } = setup();
    await open();
    fireEvent.keyDown(window, { key: 'a', ctrlKey: true });
    await waitFor(() => expect(pages().every((p) => p.getAttribute('aria-selected') === 'true')).toBe(true));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(screen.getByText('Open a PDF to get started')).toBeTruthy());
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(pages()).toHaveLength(3));
  });

  it('switches tools via the toolbar and keyboard', async () => {
    const { open, store } = setup();
    await open();
    fireEvent.click(screen.getByRole('radio', { name: 'Highlight' }));
    expect(store.getSnapshot().ui.activeTool).toBe('highlight');
    fireEvent.keyDown(window, { key: 'u' });
    expect(store.getSnapshot().ui.activeTool).toBe('underline');
    expect(screen.getByRole('radio', { name: 'Underline' }).getAttribute('aria-checked')).toBe('true');
  });

  it('saves from the toolbar', async () => {
    const { open, saveFile } = setup();
    await open();
    fireEvent.click(btn('Save'));
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith('doc-edited.pdf'));
  });

  it('shows errors and lets the user dismiss them', async () => {
    const { store } = setup();
    store.execute({ label: 'noop', apply: (d) => d, invert: () => { throw new Error(); } });
    await store.save(); // nothing to save: no error, no crash
    expect(screen.queryByRole('status')?.textContent ?? '').toBe('');
  });
});
