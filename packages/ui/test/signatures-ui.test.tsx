// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SIGNATURE_WIDTH, type Annotation, type SignatureArt, type StampAnnot } from '@pagewright/core';
import { SIGNATURE_INKS, type SignatureMaker } from '../src';

const SIGNATURE_BLUE = SIGNATURE_INKS[1]!.color;
import { setup } from './helpers';

/** Fake pages are 200 x 300 pt, shown at 96/72 px per point. */
const S = 96 / 72;
const px = (x: number, y: number) => ({ clientX: x * S, clientY: (300 - y) * S });

const art = (n: number): SignatureArt => ({ w: 20 * n, h: 40, mode: 'fill', paths: [['M', 0, 0], ['L', 20 * n, 0], ['L', 20 * n, 40], ['Z']] });

/** Draws a rectangle 20 wide per character, a different height per style. '#' cannot be drawn by any style. */
function makeMaker(): SignatureMaker & { make: ReturnType<typeof vi.fn> } {
  return {
    fonts: [{ id: 'script', label: 'Script' }, { id: 'neat', label: 'Neat' }],
    make: vi.fn(async (text: string, fontId: string) => {
      if (fontId === 'neat' && text.includes('boom')) throw new Error('This style failed.');
      return { art: { ...art(text.trim().length), h: fontId === 'neat' ? 30 : 40 }, missing: [...new Set([...text].filter((c) => c === '#'))] };
    }),
  };
}

/** `null` means an app with no way to draw typed signatures. */
async function ready(maker: SignatureMaker | null = makeMaker()) {
  const t = setup(3, () => [], maker ?? undefined);
  await t.open();
  const svg = await waitFor(() => {
    const el = document.querySelector<SVGSVGElement>('svg.overlay');
    if (!el) throw new Error('overlay not mounted');
    return el;
  });
  const host = svg.parentElement!;
  const pageId = t.store.getSnapshot().doc.pages[0]!.id;
  const stamps = () => ((t.store.getSnapshot().doc.annotations[pageId] ?? []) as Annotation[]).filter((a): a is StampAnnot => a.type === 'stamp');
  const press = (x: number, y: number) => {
    fireEvent.pointerDown(host, { button: 0, pointerId: 1, ...px(x, y) });
    fireEvent.pointerUp(host, { pointerId: 1, ...px(x, y) });
  };
  const dialog = () => screen.getByRole('dialog', { name: 'Signatures', hidden: true });
  const type = (name: string) => fireEvent.change(within(dialog()).getByLabelText('Your name'), { target: { value: name } });
  const saveButton = () => within(dialog()).getByRole('button', { name: 'Save and use' }) as HTMLButtonElement;
  return { ...t, svg, host, pageId, stamps, press, dialog, type, saveButton };
}

/** Types a name, waits for the previews, and saves. */
async function makeOne(t: Awaited<ReturnType<typeof ready>>, name = 'Ada Lovelace') {
  t.type(name);
  await waitFor(() => expect(t.saveButton().disabled).toBe(false));
  fireEvent.click(t.saveButton());
  await waitFor(() => expect(t.store.getSnapshot().ui.signatureDialog).toBe(false));
}

describe('the Sign tool and the dialog', () => {
  it('opens the dialog when there is no signature yet, and says what a visual signature is not', async () => {
    const t = await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'Sign' }));
    expect(t.dialog()).toBeTruthy();
    expect(within(t.dialog()).getByText(/not a digital signature/i)).toBeTruthy();
    expect(within(t.dialog()).getByText(/does not prove who signed/i)).toBeTruthy();
    expect(within(t.dialog()).getByText('No saved signatures yet.')).toBeTruthy();
  });

  it('G opens it too', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    expect(t.store.getSnapshot().ui.signatureDialog).toBe(true);
    expect(t.store.getSnapshot().ui.activeTool).toBe('signature');
  });

  it('cannot be saved until there is a name drawn', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    expect(t.saveButton().disabled).toBe(true);
    t.type('   ');
    expect(t.saveButton().disabled).toBe(true);
    t.type('Ada');
    await waitFor(() => expect(t.saveButton().disabled).toBe(false));
  });

  it('shows the name drawn in every style, side by side', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    t.type('Ada Lovelace');
    await waitFor(() => {
      expect(within(t.dialog()).getByRole('img', { name: 'Script preview' })).toBeTruthy();
      expect(within(t.dialog()).getByRole('img', { name: 'Neat preview' })).toBeTruthy();
    });
    expect(within(t.dialog()).getAllByRole('radio', { name: /Script|Neat/ })).toHaveLength(2);
  });

  it('starts with your name when you have told the app who you are', async () => {
    const t = await ready();
    t.store.setAuthor('Grace Hopper');
    fireEvent.keyDown(window, { key: 'g' });
    expect((within(t.dialog()).getByLabelText('Your name') as HTMLInputElement).value).toBe('Grace Hopper');
  });

  it('warns about characters a style cannot draw, and leaves them out', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    t.type('Ada #');
    expect(await within(t.dialog()).findByText(/cannot draw: #/)).toBeTruthy();
    expect(t.saveButton().disabled).toBe(false);
  });

  it('shows why a style failed and does not let it be saved', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.click(within(t.dialog()).getByRole('radio', { name: 'Neat' }));
    t.type('boom');
    expect(await within(t.dialog()).findByText('This style failed.')).toBeTruthy();
    expect(t.saveButton().disabled).toBe(true);
    fireEvent.click(within(t.dialog()).getByRole('radio', { name: 'Script' }));
    await waitFor(() => expect(t.saveButton().disabled).toBe(false));
  });

  it('closes with the Close button and with Escape', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.click(within(t.dialog()).getByRole('button', { name: 'Close' }));
    expect(t.store.getSnapshot().ui.signatureDialog).toBe(false);
    t.store.openSignatures();
    fireEvent(await waitFor(() => t.dialog()), new Event('cancel', { cancelable: true }));
    await waitFor(() => expect(t.store.getSnapshot().ui.signatureDialog).toBe(false));
  });

  it('says so, and does not break, when the app has no way to draw typed signatures', async () => {
    const t = await ready(null);
    fireEvent.keyDown(window, { key: 'g' });
    expect(within(t.dialog()).getByText('Typed signatures are not available here.')).toBeTruthy();
  });
});

describe('making and placing a signature', () => {
  it('Save and use keeps it on this device and selects the Sign tool', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    await makeOne(t);
    const ui = t.store.getSnapshot().ui;
    expect(ui.signatures).toHaveLength(1);
    expect(ui).toMatchObject({ activeTool: 'signature', activeSignature: ui.signatures[0]!.id });
    expect(t.secrets.get('signatures')).toHaveLength(1);
  });

  it('uses the chosen style and ink', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    fireEvent.click(within(t.dialog()).getByRole('radio', { name: 'Neat' }));
    fireEvent.click(within(t.dialog()).getByRole('radio', { name: 'Blue' }));
    await makeOne(t, 'Ada');
    const s = t.store.getSnapshot().ui.signatures[0]!;
    expect(s.art.h).toBe(30); // the "Neat" style
    expect(s.color).toMatchObject({ b: 0.6 });
  });

  it('clicking the page then places it centred, and selects it', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    await makeOne(t);
    t.press(100, 150);
    const [st] = t.stamps();
    expect(st!.payload.kind).toBe('signature');
    expect(st!.rect.w).toBe(DEFAULT_SIGNATURE_WIDTH);
    expect(st!.rect.x + st!.rect.w / 2).toBeCloseTo(100);
    expect(st!.rect.y + st!.rect.h / 2).toBeCloseTo(150);
    expect(t.store.getSnapshot().ui.activeTool).toBe('select');
    expect(t.store.getSnapshot().ui.selectedAnnot?.id).toBe(st!.id);
    expect(t.svg.querySelectorAll('[data-handle]')).toHaveLength(4);
  });

  it('is drawn as its artwork, in the ink colour, and turns with the page', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    await makeOne(t);
    t.press(100, 150);
    const w = art('Ada Lovelace'.length).w;
    const g = t.svg.querySelector(`[data-annot-id="${t.stamps()[0]!.id}"] g`)!;
    expect(g.querySelector('path')!.getAttribute('d')).toBe(`M0 0 L${w} 0 L${w} 40 L${w} 40 Z`.replace(` L${w} 40 L${w} 40`, ` L${w} 40`));
    expect(g.querySelector('path')!.getAttribute('fill')).toMatch(/^rgb\(/);
    t.store.rotatePages(90, [t.pageId]);
    await waitFor(() => expect(document.querySelector(`[data-annot-id="${t.stamps()[0]!.id}"] g`)?.getAttribute('transform')).toMatch(/rotate\(90\)/));
  });

  it('can be moved, resized keeping proportions, and deleted', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    await makeOne(t);
    t.press(100, 150);
    const before = { ...t.stamps()[0]!.rect };
    fireEvent.pointerDown(t.host, { button: 0, pointerId: 1, ...px(100, 150) });
    fireEvent.pointerMove(t.host, { pointerId: 1, ...px(130, 120) });
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(130, 120) });
    expect(t.stamps()[0]!.rect.x).toBeCloseTo(before.x + 30);

    const moved = { ...t.stamps()[0]!.rect };
    const handle = t.svg.querySelector('[data-handle="ne"]')!;
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, ...px(moved.x + moved.w, moved.y + moved.h) });
    fireEvent.pointerMove(t.host, { pointerId: 1, ...px(moved.x + moved.w + 40, moved.y + moved.h + 10) });
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(moved.x + moved.w + 40, moved.y + moved.h + 10) });
    const after = t.stamps()[0]!.rect;
    expect(after.w).toBeGreaterThan(moved.w);
    expect(after.w / after.h).toBeCloseTo(moved.w / moved.h, 6);

    fireEvent.keyDown(window, { key: 'Delete' });
    expect(t.stamps()).toHaveLength(0);
  });

  it('does not offer the stamp-type picker for a signature', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    await makeOne(t);
    t.press(100, 150);
    expect(screen.queryByLabelText('Stamp type')).toBeNull();
  });
});

describe('saved signatures', () => {
  async function withTwo() {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    await makeOne(t, 'Ada');
    fireEvent.click(screen.getByRole('button', { name: 'Signatures…' })); // as a person would, to make another
    await makeOne(t, 'Bob Byron');
    return t;
  }

  it('are listed in the dialog, newest last, with their pictures', async () => {
    const t = await withTwo();
    t.store.openSignatures();
    const items = within(await waitFor(() => t.dialog())).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.sig-name')!.textContent)).toEqual(['Ada', 'Bob Byron']);
    expect(within(t.dialog()).getByRole('img', { name: 'Signature of Ada' })).toBeTruthy();
  });

  it('the Sign tool lets you switch between them', async () => {
    const t = await withTwo();
    const picker = screen.getByLabelText('Signature', { selector: 'select' }) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.text)).toEqual(['Ada', 'Bob Byron']);
    const ada = t.store.getSnapshot().ui.signatures[0]!.id;
    fireEvent.change(picker, { target: { value: ada } });
    expect(t.store.getSnapshot().ui.activeSignature).toBe(ada);
  });

  it('Use chooses one and closes the dialog; Delete removes one', async () => {
    const t = await withTwo();
    t.store.openSignatures();
    fireEvent.click(within(await waitFor(() => t.dialog())).getByRole('button', { name: 'Use signature Ada' }));
    expect(t.store.getSnapshot().ui.signatureDialog).toBe(false);
    expect(t.store.getSnapshot().ui.activeSignature).toBe(t.store.getSnapshot().ui.signatures[0]!.id);
    t.store.openSignatures();
    fireEvent.click(within(await waitFor(() => t.dialog())).getByRole('button', { name: 'Delete signature Bob Byron' }));
    await waitFor(() => expect(t.store.getSnapshot().ui.signatures.map((s) => s.name)).toEqual(['Ada']));
    expect(t.secrets.get('signatures')).toHaveLength(1);
  });

  it('can be managed from the Sign tool with Signatures…', async () => {
    const t = await withTwo();
    fireEvent.click(screen.getByRole('button', { name: 'Signatures…' }));
    expect(await waitFor(() => t.dialog())).toBeTruthy();
  });

  it('the first placement tells you this is not a digital signature', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    await makeOne(t);
    t.press(100, 150);
    expect(await screen.findByText(/not a digital signature and does not prove who signed/)).toBeTruthy();
  });
});

describe('drawing a signature', () => {
  /** jsdom has no layout: show the pad as 560 x 180 so client coordinates are pad units. */
  const pad = (t: Awaited<ReturnType<typeof ready>>) => {
    fireEvent.click(within(t.dialog()).getByRole('radio', { name: 'Draw' }));
    const el = within(t.dialog()).getByRole('img', { name: 'Signature pad' }) as unknown as SVGSVGElement;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 560, bottom: 180, width: 560, height: 180, x: 0, y: 0 }) as DOMRect;
    return el;
  };
  const ev = (type: string, x: number, y: number) => Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }), { pointerId: 1 });
  const stroke = (el: Element, pts: [number, number][]) => {
    act(() => {
      el.dispatchEvent(ev('pointerdown', ...pts[0]!));
      for (const p of pts.slice(1)) el.dispatchEvent(ev('pointermove', ...p));
      el.dispatchEvent(ev('pointerup', ...pts.at(-1)!));
    });
  };

  it('cannot be saved until something is drawn, and the name is optional', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    const el = pad(t);
    expect(t.saveButton().disabled).toBe(true);
    stroke(el, [[20, 100], [100, 40], [200, 120]]);
    expect(t.saveButton().disabled).toBe(false);
  });

  it('keeps a stroke even when the pen is released in the same moment as the last move', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    const el = pad(t);
    stroke(el, [[20, 100], [100, 40], [300, 120]]); // all events inside a single act: React has not redrawn
    fireEvent.click(t.saveButton());
    await waitFor(() => expect(t.store.getSnapshot().ui.signatures).toHaveLength(1));
    const art = t.store.getSnapshot().ui.signatures[0]!.art;
    expect(art.mode).toBe('stroke');
    expect(art.w).toBeGreaterThan(270); // the whole stretch, up to x = 300
  });

  it('undoes the last stroke only, and clears all', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    const el = pad(t);
    const drawn = () => el.querySelectorAll('path').length;
    stroke(el, [[20, 100], [100, 40], [200, 120]]);
    stroke(el, [[220, 100], [300, 40], [400, 120]]);
    expect(drawn()).toBe(2);
    fireEvent.click(within(t.dialog()).getByRole('button', { name: 'Undo stroke' }));
    expect(drawn()).toBe(1);
    expect(t.saveButton().disabled).toBe(false);
    stroke(el, [[220, 100], [300, 40], [400, 120]]);
    fireEvent.click(within(t.dialog()).getByRole('button', { name: 'Clear' }));
    expect(drawn()).toBe(0);
    expect(t.saveButton().disabled).toBe(true);
    expect((within(t.dialog()).getByRole('button', { name: 'Undo stroke' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves, closes and places the drawn signature on the page', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    const el = pad(t);
    stroke(el, [[20, 100], [100, 40], [300, 120]]);
    fireEvent.change(within(t.dialog()).getByLabelText(/Name \(optional/), { target: { value: 'My mark' } });
    fireEvent.click(within(t.dialog()).getByRole('radio', { name: 'Blue' }));
    fireEvent.click(t.saveButton());
    await waitFor(() => expect(t.store.getSnapshot().ui.signatureDialog).toBe(false));
    expect(t.store.getSnapshot().ui.signatures[0]).toMatchObject({ name: 'My mark', color: SIGNATURE_BLUE });
    t.press(100, 150);
    expect(t.stamps()).toHaveLength(1);
    expect(t.stamps()[0]!.payload).toMatchObject({ kind: 'signature', art: { mode: 'stroke' } });
  });

  it('lists a drawn signature among the saved ones as a picture', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'g' });
    const el = pad(t);
    stroke(el, [[20, 100], [100, 40], [300, 120]]);
    fireEvent.click(t.saveButton());
    await waitFor(() => expect(t.store.getSnapshot().ui.signatures).toHaveLength(1));
    await waitFor(() => expect(t.store.getSnapshot().ui.signatureDialog).toBe(false));
    act(() => t.store.openSignatures());
    expect(within(t.dialog()).getByRole('img', { name: 'Signature of Drawn signature' })).toBeTruthy();
  });

  it('works in an app that cannot type signatures', async () => {
    const t = await ready(null);
    act(() => t.store.openSignatures());
    expect(within(t.dialog()).getByText('Typed signatures are not available here.')).toBeTruthy();
    const el = pad(t);
    stroke(el, [[20, 100], [100, 40], [300, 120]]);
    expect(t.saveButton().disabled).toBe(false);
  });
});
