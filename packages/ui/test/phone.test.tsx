// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THICKNESS_STEPS } from '../src/tool-style';
import { setup } from './helpers';

/** A stand-in for the browser's media queries: a phone-sized screen, which a test can turn sideways into a wide one. */
let phone = true;
const listeners = new Set<() => void>();
function resize(toPhone: boolean) {
  phone = toPhone;
  act(() => listeners.forEach((l) => l()));
}
beforeEach(() => {
  phone = true;
  listeners.clear();
  window.matchMedia = ((query: string) => ({
    get matches() { return query.includes('max-width: 720px') ? phone : false; },
    media: query,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  delete (window as Partial<Window>).matchMedia;
});

async function ready() {
  const t = setup();
  await t.open();
  const btn = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
  const more = () => {
    fireEvent.click(btn('More'));
    return screen.getByRole('dialog', { name: 'More' });
  };
  const pages = () => t.store.getSnapshot().doc.pages;
  return { ...t, btn, more, pages };
}

describe('the phone layout', () => {
  it('has a slim top bar, and the tools and their options in a dock at the bottom', async () => {
    const t = await ready();
    const top = screen.getByRole('toolbar', { name: 'Main' });
    expect(within(top).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Open', 'Save', 'Undo', 'Redo', 'Comments', 'More']);
    expect(screen.queryByRole('button', { name: 'Rotate left' })).toBeNull(); // page actions live in More
    const dock = document.querySelector('.phone-dock')!;
    expect(dock.compareDocumentPosition(document.querySelector('.body')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy(); // after the page
    expect(within(dock as HTMLElement).getAllByRole('radio')).toHaveLength(13);
    fireEvent.click(screen.getByRole('radio', { name: 'Pen' }));
    expect(t.store.getSnapshot().ui.activeTool).toBe('ink');
  });

  it('switches between the layouts when the screen is resized', async () => {
    await ready();
    expect(document.querySelector('.phone-dock')).not.toBeNull();
    resize(false);
    expect(document.querySelector('.phone-dock')).toBeNull();
    expect(screen.getByRole('button', { name: 'Rotate left' })).toBeTruthy(); // the desktop toolbar is back
    resize(true);
    expect(document.querySelector('.phone-dock')).not.toBeNull();
  });

  it('shows the page number over the page, with a dot for unsaved changes', async () => {
    const t = await ready();
    const pill = () => document.querySelector('.page-pill')!;
    expect(pill().textContent).toBe('1 / 3');
    act(() => t.store.rotatePages(90, [t.pages()[0]!.id]));
    expect(within(pill() as HTMLElement).getByRole('img', { name: 'unsaved changes' })).toBeTruthy();
  });

  it('opens the thickness slider from its chip, above the dock', async () => {
    const t = await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'Rectangle' }));
    fireEvent.click(t.btn('Thickness: 2 pt'));
    const pop = screen.getByRole('dialog', { name: 'Thickness' });
    fireEvent.change(within(pop).getByRole('slider', { name: 'Thickness' }), { target: { value: String(THICKNESS_STEPS.indexOf(5)) } });
    expect(t.store.getSnapshot().ui.drawStyle.width).toBe(5);
    expect(t.btn('Thickness: 5 pt')).toBeTruthy();
  });

  it('closes the thickness slider when anything else is touched, such as the page', async () => {
    const t = await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'Pen' }));
    fireEvent.click(t.btn('Thickness: 2 pt'));
    const slider = within(screen.getByRole('dialog', { name: 'Thickness' })).getByRole('slider');
    fireEvent.pointerDown(slider); // using it keeps it open
    expect(screen.getByRole('dialog', { name: 'Thickness' })).toBeTruthy();
    fireEvent.pointerDown(document.querySelector('.main')!);
    expect(screen.queryByRole('dialog', { name: 'Thickness' })).toBeNull();
  });

  it('greys out the chips for tools without colour or thickness', async () => {
    const t = await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'Stamp' }));
    expect(t.btn(/^Colour: /).disabled).toBe(true);
    expect(t.btn(/^Thickness: /).disabled).toBe(true);
    expect(screen.getByLabelText('Stamp type')).toBeTruthy(); // the tool's own control is there instead
  });
});

describe('the More panel', () => {
  it('applies page actions to the page on screen when none are selected', async () => {
    const t = await ready();
    const sheet = t.more();
    expect(within(sheet).getByText('This page')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Rotate right' }));
    expect(t.pages()[0]!.rotation).toBe(90);
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull(); // done: it closes
  });

  it('applies them to the selected pages when there are some', async () => {
    const t = await ready();
    const [, second, third] = t.pages().map((p) => p.id);
    act(() => {
      t.store.selectPage(second!);
      t.store.selectPage(third!, 'toggle');
    });
    const sheet = t.more();
    expect(within(sheet).getByText('2 selected pages')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Delete' }));
    expect(t.pages().map((p) => p.id)).not.toContain(second);
    expect(t.pages()).toHaveLength(1);
  });

  it('shows the status, zooms, and closes with Escape, its close button or a tap outside', async () => {
    const t = await ready();
    let sheet = t.more();
    expect(within(sheet).getByText(/Page 1 of 3/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Zoom in' }));
    expect(t.store.getSnapshot().ui.zoom).toBeCloseTo(1.25);
    sheet = screen.getByRole('dialog', { name: 'More' }); // zooming keeps it open
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull();
    t.more();
    fireEvent.click(t.btn('Close'));
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull();
    t.more();
    fireEvent.click(document.querySelector('.sheet-backdrop')!);
    expect(screen.queryByRole('dialog', { name: 'More' })).toBeNull();
  });

  it('puts focus in the panel when it opens', async () => {
    const t = await ready();
    const sheet = t.more();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
  });
});
