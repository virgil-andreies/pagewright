// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup } from './helpers';

/**
 * jsdom does no layout, so the window (the viewer) is given a width, and each page the width its style says.
 * The test pages are 200 pt wide: 266.7 px at 100%.
 */
const PAGE = (200 * 96) / 72;
let viewerWidth = 200;
const resizeCallbacks = new Set<() => void>();
const saved: { offset?: PropertyDescriptor; client?: PropertyDescriptor; ro?: unknown } = {};
beforeEach(() => {
  viewerWidth = 200;
  saved.offset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
  saved.client = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
  saved.ro = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) { return this.classList.contains('page-view') ? parseFloat(this.style.width) || 0 : 0; },
  });
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get(this: Element) { return this.classList.contains('viewer') ? viewerWidth : 0; },
  });
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private cb: () => void) {}
    observe() { resizeCallbacks.add(this.cb); }
    disconnect() { resizeCallbacks.delete(this.cb); }
  };
});
afterEach(() => {
  if (saved.offset) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', saved.offset);
  if (saved.client) Object.defineProperty(Element.prototype, 'clientWidth', saved.client);
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = saved.ro;
  resizeCallbacks.clear();
});
const resizeWindow = (w: number) => {
  viewerWidth = w;
  act(() => resizeCallbacks.forEach((cb) => cb()));
};

async function ready() {
  const t = setup();
  await t.open();
  const zoom = () => t.store.getSnapshot().ui.zoom;
  const btn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
  return { ...t, zoom, btn };
}

describe('fitting pages to the window', () => {
  it('shrinks pages that would be wider than the window, so a phone shows whole pages', async () => {
    const t = await ready();
    await waitFor(() => expect(t.zoom()).toBeCloseTo(200 / PAGE, 2));
    expect(t.store.getSnapshot().ui.zoomMode).toBe('auto');
  });

  it('leaves them at 100% when the window is wide enough', async () => {
    viewerWidth = 800;
    const t = await ready();
    await waitFor(() => expect(t.zoom()).toBe(1));
  });

  it('follows the window when it is resized or turned', async () => {
    const t = await ready();
    resizeWindow(150);
    expect(t.zoom()).toBeCloseTo(150 / PAGE, 2);
    resizeWindow(1600);
    expect(t.zoom()).toBe(1); // never above 100% on its own
  });

  it('Fit width fills the window even when that means more than 100%, and is shown as on', async () => {
    viewerWidth = 2 * PAGE;
    const t = await ready();
    // The page as wide as the window, give or take the pixel of slack that keeps a sideways scrollbar away.
    const fills = () => {
      const w = parseFloat(document.querySelector<HTMLElement>('.page-view')!.style.width);
      expect(w).toBeLessThanOrEqual(viewerWidth);
      expect(w).toBeGreaterThanOrEqual(viewerWidth - 3);
    };
    fireEvent.click(t.btn('Fit width'));
    await waitFor(() => expect(t.zoom()).toBeGreaterThan(1.9));
    fills();
    expect(t.btn('Fit width').getAttribute('aria-pressed')).toBe('true');
    resizeWindow(PAGE);
    fills();
  });

  it('a zoom chosen by hand stays as chosen, whatever the window does, until Fit width', async () => {
    const t = await ready();
    fireEvent.click(t.btn('Reset zoom')); // 100%
    expect(t.zoom()).toBe(1);
    expect(t.store.getSnapshot().ui.zoomMode).toBe('manual');
    resizeWindow(100);
    expect(t.zoom()).toBe(1);
    expect(t.btn('Fit width').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(t.btn('Fit width'));
    await waitFor(() => expect(t.zoom()).toBeCloseTo(100 / PAGE, 2));
    fireEvent.click(t.btn('Zoom in'));
    expect(t.store.getSnapshot().ui.zoomMode).toBe('manual');
  });
});
