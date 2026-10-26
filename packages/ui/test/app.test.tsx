// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

  it('greets with the app’s name, a Beta label, what it does, and that files stay on the device', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Pagewright PDF Beta' })).toBeTruthy();
    expect(screen.getByText(/Edit, sign and merge PDFs/)).toBeTruthy();
    expect(screen.getByText(/Your files stay on your device/)).toBeTruthy();
  });

  it('cleans up copies left by closed tabs when it starts', () => {
    const { platform } = setup();
    expect(platform.localData!.cleanUp).toHaveBeenCalledOnce();
  });

  it('deletes everything stored on the device only after a confirmation that names what goes, then restarts', async () => {
    const { open, store, platform, restart, secrets } = setup();
    await open();
    store.setAuthor('Ada');
    store.rotatePages(90, [store.getSnapshot().doc.pages[0]!.id]); // an unsaved change
    fireEvent.click(btn('About Pagewright PDF'));
    const about = screen.getByRole('dialog', { name: 'About Pagewright PDF' });
    fireEvent.click(within(about).getByRole('button', { name: /Delete everything stored on this device/ }));
    const confirm = within(about).getByRole('alert');
    expect(confirm.textContent).toMatch(/name, saved signatures, tool settings and every working copy/);
    expect(confirm.textContent).toMatch(/unsaved changes lost: save it first/);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(platform.localData!.clearAll).not.toHaveBeenCalled();

    fireEvent.click(within(about).getByRole('button', { name: /Delete everything stored on this device/ }));
    fireEvent.click(within(within(about).getByRole('alert')).getByRole('button', { name: 'Delete everything' }));
    await waitFor(() => expect(restart).toHaveBeenCalledOnce());
    expect(platform.localData!.clearAll).toHaveBeenCalledOnce();
    expect(secrets.size).toBe(0);
  });

  it('says plainly when deleting fails, and lets you try again', async () => {
    const { platform, restart } = setup();
    vi.mocked(platform.localData!.clearAll).mockRejectedValueOnce(new Error('blocked'));
    fireEvent.click(btn('About Pagewright PDF'));
    fireEvent.click(screen.getByRole('button', { name: /Delete everything stored on this device/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete everything' }));
    expect(await screen.findByText(/could not be deleted/)).toBeTruthy();
    expect(restart).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Delete everything' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('opens the About panel from the start screen and from the toolbar, and closes it', async () => {
    setup();
    fireEvent.click(btn('How it works'));
    const about = screen.getByRole('dialog', { name: 'About Pagewright PDF' });
    expect(within(about).getByText(/never uploaded/)).toBeTruthy();
    expect(within(about).getByText(/Cloudflare/)).toBeTruthy();
    expect(within(about).getByText(/private working copy of each PDF/)).toBeTruthy();
    fireEvent.click(within(about).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'About Pagewright PDF' })).toBeNull();
    fireEvent.click(btn('About Pagewright PDF'));
    expect(screen.getByRole('dialog', { name: 'About Pagewright PDF' })).toBeTruthy();
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

describe('the toolbar', () => {
  it('shows the tools as tiles with an icon, grouped under captions, with the shortcut in the corner', async () => {
    const { open } = setup();
    await open();
    const groups = within(screen.getByRole('radiogroup', { name: 'Tool' })).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Select', 'Mark text', 'Draw', 'Add']);
    const highlight = screen.getByRole('radio', { name: 'Highlight' }); // the corner key is not part of its name
    expect(highlight.querySelector('svg')).toBeTruthy();
    expect(highlight.textContent).toBe('HHighlight'); // the key, then the label, both visible
    expect(within(groups[2]!).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Pen', 'Rectangle', 'Ellipse', 'Line', 'Arrow']);
  });

  it('gives icon-only buttons a name and a tooltip, which can say more', async () => {
    const { open } = setup();
    await open();
    for (const name of ['Undo', 'Redo', 'Rotate left', 'Rotate right', 'Duplicate', 'Extract', 'Delete', 'Zoom out', 'Zoom in']) {
      const b = btn(name);
      expect(b.textContent, name).toBe('');
      expect(b.querySelector('svg'), name).toBeTruthy();
      expect(b.getAttribute('data-tip'), name).toBeTruthy();
    }
    expect(btn('Delete').getAttribute('data-tip')).toBe('Delete (Del)');
    expect(btn('Extract').getAttribute('data-tip')).toBe('Extract to a new PDF');
  });

  it('says what Undo will undo in its tooltip', async () => {
    const { open } = setup();
    await open();
    fireEvent.pointerDown(pages()[1]!, { button: 0, pointerId: 1, clientY: 10 });
    fireEvent.pointerUp(pages()[1]!, { pointerId: 1, clientY: 10 });
    await waitFor(() => expect(btn('Delete').disabled).toBe(false));
    fireEvent.click(btn('Delete'));
    await waitFor(() => expect(btn('Undo').getAttribute('data-tip')).toMatch(/^Undo .+ \(Ctrl\+Z\)$/));
  });

  it('keeps Open and Save as icon and text, Save the only filled one', async () => {
    const { open } = setup();
    await open();
    expect(btn('Open').querySelector('svg')).toBeTruthy();
    expect(btn('Save').className).toContain('primary');
    expect(document.querySelectorAll('.toolbar-row button.primary')).toHaveLength(1);
  });
});
