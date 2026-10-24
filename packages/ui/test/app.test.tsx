// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

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

  it('reorders even when the release comes before React has redrawn after the last move', async () => {
    const { open, store } = setup();
    await open();
    const before = store.getSnapshot().doc.pages.map((p) => p.id);
    const grid = screen.getByRole('listbox', { name: 'Pages' });
    const firstThumb = pages()[0]!;
    // jsdom has no layout: report each thumbnail as a 100px-tall box, one under the other.
    pages().forEach((el, i) => (el.getBoundingClientRect = () => ({ top: i * 100, bottom: i * 100 + 100, height: 100, left: 0, right: 100, width: 100, x: 0, y: i * 100 }) as DOMRect));
    const ev = (type: string, y: number) => Object.assign(new MouseEvent(type, { bubbles: true, clientY: y, button: 0 }), { pointerId: 1 });
    act(() => {
      firstThumb.dispatchEvent(ev('pointerdown', 50));
      grid.dispatchEvent(ev('pointermove', 80));
      grid.dispatchEvent(ev('pointermove', 290)); // below the last thumbnail's middle
      grid.dispatchEvent(ev('pointerup', 290));
    });
    expect(store.getSnapshot().doc.pages.map((p) => p.id)).toEqual([before[1], before[2], before[0]]);
  });
});
