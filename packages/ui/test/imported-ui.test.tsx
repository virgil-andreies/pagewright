// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SourceAnnotation } from '@pagewright/core';
import { setup } from './helpers';

/** Fake pages are 200 x 300 pt, shown at 96/72 px per point. */
const S = 96 / 72;
const px = (x: number, y: number) => ({ clientX: x * S, clientY: (300 - y) * S });

const original = (i: number): SourceAnnotation[] =>
  i !== 0
    ? []
    : [
        {
          id: '20R', subtype: 'Highlight', rect: { x: 20, y: 150, w: 100, h: 20 }, contents: 'Why is this here?', author: 'Ada',
          quads: [{ p1: { x: 20, y: 170 }, p2: { x: 120, y: 170 }, p3: { x: 20, y: 150 }, p4: { x: 120, y: 150 } }],
        },
        { id: '26R', subtype: 'Text', rect: { x: 150, y: 250, w: 20, h: 20 }, contents: 'A note', author: 'Grace' },
        { id: '27R', subtype: 'Text', rect: { x: 150, y: 248, w: 22, h: 22 }, contents: 'A reply', author: 'Bob', inReplyTo: '26R', replyType: 'R' },
        { id: '30R', subtype: 'Square', rect: { x: 30, y: 40, w: 80, h: 40 } },
      ];

async function ready() {
  const t = setup(3, original);
  await t.open();
  const svg = await waitFor(() => {
    const el = document.querySelector<SVGSVGElement>('svg.overlay');
    if (!el) throw new Error('overlay not mounted');
    return el;
  });
  const pageId = t.store.getSnapshot().doc.pages[0]!.id;
  await waitFor(() => expect(t.store.getSnapshot().imported[pageId]?.length ?? 0).toBeGreaterThan(0));
  const host = svg.parentElement!;
  const press = (x: number, y: number) => {
    fireEvent.pointerDown(host, { button: 0, pointerId: 1, ...px(x, y) });
    fireEvent.pointerUp(host, { pointerId: 1, ...px(x, y) });
  };
  const selected = () => t.store.getSnapshot().ui.selectedAnnot?.id;
  const removed = () => t.store.getSnapshot().doc.removedImported[pageId];
  const lastRender = () => t.renderPage.mock.calls.at(-1)?.[1];
  return { ...t, svg, host, pageId, press, selected, removed, lastRender };
}

describe('selecting original annotations', () => {
  it('clicking on one selects it and outlines it, without drawing it a second time', async () => {
    const t = await ready();
    t.press(60, 160); // on the highlight
    expect(t.selected()).toBe('pdf:20R');
    expect(t.svg.querySelectorAll('g.annot.selected')).toHaveLength(1);
    expect(t.svg.querySelector('g.annot.selected polygon')).toBeNull(); // PDF.js already draws it in the page image
    expect(t.svg.querySelector('g.annot.selected .selection-outline')).not.toBeNull();
  });

  it('selects the other kinds too: a shape outline, and a note by its icon', async () => {
    const t = await ready();
    t.press(30, 60); // left edge of the square
    expect(t.selected()).toBe('pdf:30R');
    t.press(160, 260); // inside the note icon, which hangs right and down from (150, 270)
    expect(t.selected()).toBe('pdf:26R');
  });

  it('clicking empty page clears the selection', async () => {
    const t = await ready();
    t.press(60, 160);
    t.press(180, 20);
    expect(t.selected()).toBeUndefined();
  });

  it('offers no handles and cannot be dragged: it belongs to the original file', async () => {
    const t = await ready();
    t.press(30, 60);
    expect(t.svg.querySelector('[data-handle]')).toBeNull();
    const before = t.store.getSnapshot().doc;
    fireEvent.pointerDown(t.host, { button: 0, pointerId: 1, ...px(30, 60) });
    fireEvent.pointerMove(t.host, { pointerId: 1, ...px(80, 120) });
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(80, 120) });
    expect(t.store.getSnapshot().doc).toBe(before);
  });

  it('what is drawn on top wins when the two overlap', async () => {
    const t = await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'Rectangle' }));
    fireEvent.pointerDown(t.host, { button: 0, pointerId: 1, ...px(25, 175) });
    fireEvent.pointerMove(t.host, { pointerId: 1, ...px(115, 145) });
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(115, 145) });
    fireEvent.click(screen.getByRole('radio', { name: 'Select' }));
    t.press(25, 160); // the left edge of the new rectangle lies inside the highlight
    expect(t.selected()).toBe(t.store.getSnapshot().doc.annotations[t.pageId]![0]!.id);
  });
});

describe('pressing on marked-up text', () => {
  // The highlight sits over real text, so a press on it may be the start of selecting that text.
  it('a click selects the highlight (it comes up without having moved)', async () => {
    const t = await ready();
    fireEvent.pointerDown(t.host, { button: 0, pointerId: 1, ...px(60, 160) });
    expect(t.selected()).toBeUndefined(); // not decided until the button comes up
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(61, 160) });
    expect(t.selected()).toBe('pdf:20R');
  });

  it('a drag is a text selection: the highlight is not selected, grabbed or moved', async () => {
    const t = await ready();
    const before = t.store.getSnapshot().doc;
    fireEvent.pointerDown(t.host, { button: 0, pointerId: 1, ...px(40, 160) });
    fireEvent.pointerMove(t.host, { pointerId: 1, ...px(100, 160) });
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(100, 160) });
    expect(t.selected()).toBeUndefined();
    expect(t.store.getSnapshot().doc).toBe(before);
  });

  it('does not select the highlight when text was selected by the press', async () => {
    const t = await ready();
    fireEvent.pointerDown(t.host, { button: 0, pointerId: 1, ...px(60, 160) });
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('.toolbar')!); // the browser now holds a real selection
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(60, 160) });
    expect(t.selected()).toBeUndefined();
    window.getSelection()!.removeAllRanges();
  });

  it('a highlight made here is the same: it is selected by a click and never dragged away from its text', async () => {
    const t = await ready();
    const id = t.store.addMarkups('highlight', [{ pageId: t.pageId, quads: [{ p1: { x: 20, y: 220 }, p2: { x: 120, y: 220 }, p3: { x: 20, y: 200 }, p4: { x: 120, y: 200 } }] }])[0]!;
    const quadsBefore = JSON.stringify(t.store.getSnapshot().doc.annotations[t.pageId]![0]);
    fireEvent.pointerDown(t.host, { button: 0, pointerId: 1, ...px(60, 210) });
    fireEvent.pointerMove(t.host, { pointerId: 1, ...px(60, 150) });
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(60, 150) });
    expect(JSON.stringify(t.store.getSnapshot().doc.annotations[t.pageId]![0])).toBe(quadsBefore);
    t.press(60, 210);
    expect(t.selected()).toBe(id);
  });

  it('a click on empty page still clears the selection, and shapes can still be grabbed immediately', async () => {
    const t = await ready();
    t.press(60, 160);
    expect(t.selected()).toBe('pdf:20R');
    fireEvent.pointerDown(t.host, { button: 0, pointerId: 1, ...px(30, 60) }); // the square: not text markup
    expect(t.selected()).toBe('pdf:30R'); // selected at once, as before
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(30, 60) });
    t.press(190, 10);
    expect(t.selected()).toBeUndefined();
  });
});

describe('deleting an original annotation', () => {
  it('Delete removes it, takes its replies, and has the page image redrawn without them', async () => {
    const t = await ready();
    t.press(160, 260); // the note
    fireEvent.keyDown(window, { key: 'Delete' });
    expect([...t.removed()!].sort()).toEqual(['26R', '27R']);
    expect(t.selected()).toBeUndefined();
    expect(t.svg.querySelector('g.annot.selected')).toBeNull();
    // The image is rendered again, asking PDF.js to leave the deleted annotations out.
    await waitFor(() => expect([...(t.lastRender()?.hideAnnotations ?? [])].sort()).toEqual(['26R', '27R']));
  });

  it('is one undo step, and undo draws it back', async () => {
    const t = await ready();
    t.press(30, 60);
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(t.lastRender()?.hideAnnotations).toEqual(['30R']));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(t.removed()).toBeUndefined();
    await waitFor(() => expect(t.lastRender()?.hideAnnotations).toBeUndefined());
  });

  it('does not touch the images of pages that were not changed', async () => {
    const t = await ready();
    t.renderPage.mockClear();
    t.press(30, 60);
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(t.renderPage).toHaveBeenCalled());
    // every re-render is for page 1 (source index 0): the others have nothing hidden
    const hidden = t.renderPage.mock.calls.filter((c) => c[1].hideAnnotations?.length);
    expect(hidden.every((c) => c[0] === 0)).toBe(true);
  });
});

describe('original annotations in the comments panel', () => {
  async function withPanel() {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'c' });
    return t;
  }
  const thread = (id: string) => document.querySelector<HTMLElement>(`.thread[data-annot-id="${id}"]`)!;

  it('are listed with their author and text, marked as from the original file, and counted', async () => {
    await withPanel();
    expect(within(thread('pdf:20R')).getByText('Why is this here?')).toBeTruthy();
    expect(within(thread('pdf:20R')).getByText('Ada')).toBeTruthy();
    expect(within(thread('pdf:20R')).getByText(/from the original file/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Comments (2)' })).toBeTruthy(); // the highlight (has a comment) and the note
  });

  it('show their replies, read-only', async () => {
    await withPanel();
    const t = thread('pdf:26R');
    expect(within(t).getByText('A reply')).toBeTruthy();
    expect(within(t).getByText('Bob')).toBeTruthy();
    expect(within(t).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(t).queryByLabelText('Reply')).toBeNull();
    expect(within(t).queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('can be deleted from their thread, with the replies', async () => {
    const t = await withPanel();
    fireEvent.click(within(thread('pdf:26R')).getByRole('button', { name: 'Delete note' }));
    expect([...t.removed()!].sort()).toEqual(['26R', '27R']);
    await waitFor(() => expect(document.querySelector('.thread[data-annot-id="pdf:26R"]')).toBeNull());
    expect(screen.getByRole('button', { name: 'Comments (1)' })).toBeTruthy();
  });

  it('a highlight thread offers Delete annotation, not Edit or Remove comment', async () => {
    await withPanel();
    const t = thread('pdf:20R');
    expect(within(t).getByRole('button', { name: 'Delete annotation' })).toBeTruthy();
    expect(within(t).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(t).queryByRole('button', { name: 'Remove comment' })).toBeNull();
  });

  it('clicking a thread selects the annotation on the page', async () => {
    const t = await withPanel();
    fireEvent.click(within(thread('pdf:20R')).getByRole('button', { name: /Highlight on page 1/ }));
    expect(t.selected()).toBe('pdf:20R');
    expect(thread('pdf:20R').classList.contains('selected')).toBe(true);
  });

  it('selecting an original annotation does not offer to add a comment to it', async () => {
    const t = await withPanel();
    t.press(30, 60); // the square has no comment
    expect(screen.queryByRole('heading', { name: /Comment on this/ })).toBeNull();
  });
});
