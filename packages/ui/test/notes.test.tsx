// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NOTE_SIZE, pdfToViewport, type Annotation, type NoteAnnot } from '@pagewright/core';
import { setup } from './helpers';

/** Fake pages are 200 x 300 pt, shown at 96/72 px per point. */
const S = 96 / 72;
const px = (x: number, y: number) => ({ clientX: x * S, clientY: (300 - y) * S });

async function ready() {
  const t = setup();
  await t.open();
  const svg = await waitFor(() => {
    const el = document.querySelector<SVGSVGElement>('svg.overlay');
    if (!el) throw new Error('overlay not mounted');
    return el;
  });
  const pageId = t.store.getSnapshot().doc.pages[0]!.id;
  const annots = () => (t.store.getSnapshot().doc.annotations[pageId] ?? []) as Annotation[];
  const notes = () => annots().filter((a): a is NoteAnnot => a.type === 'note');
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(svg, { button: 0, pointerId: 1, ...px(x, y) });
    fireEvent.pointerUp(svg, { pointerId: 1, ...px(x, y) });
  };
  const write = (label: string, value: string, scope: HTMLElement | Document = document.body) =>
    fireEvent.change(within(scope as HTMLElement).getByLabelText(label), { target: { value } });
  /** Place a note on the page and give it text. */
  const addNote = (x: number, y: number, text: string) => {
    fireEvent.click(screen.getByRole('radio', { name: 'Note' }));
    click(x, y);
    write('Note text', text);
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
  };
  return { ...t, svg, pageId, annots, notes, click, write, addNote };
}

const threadOf = (id: string) => document.querySelector<HTMLElement>(`.thread[data-annot-id="${id}"]`)!;

describe('placing a note', () => {
  it('opens the panel with a composer and shows a ghost icon where the note will go', async () => {
    const t = await ready();
    expect(screen.queryByRole('complementary', { name: 'Comments' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Note' }));
    t.click(50, 150);
    expect(screen.getByRole('complementary', { name: 'Comments' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'New note on page 1' })).toBeTruthy();
    expect(screen.getByTestId('draft-note')).toBeTruthy();
    expect(t.notes()).toHaveLength(0);
  });

  it('creates the note when text is added: icon on the page, thread in the panel, count on the button', async () => {
    const t = await ready();
    t.addNote(50, 150, 'Check this figure');
    const [note] = t.notes();
    expect(note).toMatchObject({ icon: 'note', comment: { text: 'Check this figure' } });
    expect(note!.position.x).toBeCloseTo(50);
    expect(note!.position.y).toBeCloseTo(150);
    expect(t.svg.querySelector(`[data-annot-id="${note!.id}"]`)).not.toBeNull();
    expect(screen.queryByTestId('draft-note')).toBeNull();
    expect(within(threadOf(note!.id)).getByText('Check this figure')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Comments (1)' })).toBeTruthy();
  });

  it('does not create anything when the text is empty, and Add note stays disabled', async () => {
    const t = await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'Note' }));
    t.click(50, 150);
    expect((screen.getByRole('button', { name: 'Add note' }) as HTMLButtonElement).disabled).toBe(true);
    t.write('Note text', '   ');
    expect((screen.getByRole('button', { name: 'Add note' }) as HTMLButtonElement).disabled).toBe(true);
    expect(t.notes()).toHaveLength(0);
  });

  it('cancels with Escape or the Cancel button, leaving no note', async () => {
    const t = await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'Note' }));
    t.click(50, 150);
    t.write('Note text', 'draft');
    fireEvent.keyDown(screen.getByLabelText('Note text'), { key: 'Escape' });
    expect(t.store.getSnapshot().ui.draftNote).toBeUndefined();
    t.click(80, 150);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(t.store.getSnapshot().ui.draftNote).toBeUndefined();
    expect(t.notes()).toHaveLength(0);
  });

  it('submits with Ctrl+Enter', async () => {
    const t = await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'Note' }));
    t.click(50, 150);
    t.write('Note text', 'quick');
    fireEvent.keyDown(screen.getByLabelText('Note text'), { key: 'Enter', ctrlKey: true });
    expect(t.notes()).toHaveLength(1);
  });

  it('typing the tool shortcuts into the text box does not switch tools', async () => {
    const t = await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'Note' }));
    t.click(50, 150);
    fireEvent.keyDown(screen.getByLabelText('Note text'), { key: 'p' });
    fireEvent.keyDown(screen.getByLabelText('Note text'), { key: 'Delete' });
    expect(t.store.getSnapshot().ui.activeTool).toBe('note');
  });

  it('toggles the panel with the C key and the close button', async () => {
    await ready();
    fireEvent.keyDown(window, { key: 'c' });
    expect(screen.getByRole('complementary', { name: 'Comments' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close comments' }));
    expect(screen.queryByRole('complementary', { name: 'Comments' })).toBeNull();
  });
});

describe('selecting and moving notes', () => {
  it('selects a note by clicking its icon, and moves it by dragging', async () => {
    const t = await ready();
    t.addNote(50, 150, 'x');
    fireEvent.click(screen.getByRole('radio', { name: 'Select' }));
    const id = t.notes()[0]!.id;
    // The icon extends right and down from its position: its middle is 10pt in from the corner.
    t.click(60, 140);
    expect(t.store.getSnapshot().ui.selectedAnnot?.id).toBe(id);
    fireEvent.pointerDown(t.svg, { button: 0, pointerId: 1, ...px(60, 140) });
    fireEvent.pointerMove(t.svg, { pointerId: 1, ...px(90, 100) });
    fireEvent.pointerUp(t.svg, { pointerId: 1, ...px(90, 100) });
    expect(t.notes()[0]!.position.x).toBeCloseTo(80);
    expect(t.notes()[0]!.position.y).toBeCloseTo(110);
    t.store.undo();
    expect(t.notes()[0]!.position.x).toBeCloseTo(50);
  });

  it('does not select a note when clicking beside its icon', async () => {
    const t = await ready();
    t.addNote(50, 150, 'x');
    fireEvent.click(screen.getByRole('radio', { name: 'Select' }));
    t.click(50 + NOTE_SIZE + 20, 140);
    expect(t.store.getSnapshot().ui.selectedAnnot).toBeUndefined();
  });

  it('keeps the icon upright and hit-testable on screen when the page is rotated', async () => {
    const t = await ready();
    t.addNote(50, 150, 'x');
    t.store.rotatePages(90, [t.pageId]);
    const geometry = { cropBox: { x: 0, y: 0, w: 200, h: 300 }, intrinsicRotation: 0 as const, extraRotation: 90 as const, userUnit: 1 };
    const anchor = pdfToViewport(geometry, S, t.notes()[0]!.position);
    fireEvent.click(screen.getByRole('radio', { name: 'Select' }));
    const svg = await waitFor(() => document.querySelector<SVGSVGElement>('svg.overlay')!);
    const press = (dx: number, dy: number) => {
      fireEvent.pointerDown(svg, { button: 0, pointerId: 1, clientX: anchor.x + dx, clientY: anchor.y + dy });
      fireEvent.pointerUp(svg, { pointerId: 1, clientX: anchor.x + dx, clientY: anchor.y + dy });
    };
    press(NOTE_SIZE * S + 40, 5); // beside the icon on screen: miss
    expect(t.store.getSnapshot().ui.selectedAnnot).toBeUndefined();
    press((NOTE_SIZE * S) / 2, (NOTE_SIZE * S) / 2); // middle of the icon, drawn right and down of the anchor
    expect(t.store.getSnapshot().ui.selectedAnnot?.id).toBe(t.notes()[0]!.id);
  });
});

describe('comments panel', () => {
  it('offers to comment on a selected annotation that has none, and adds the comment', async () => {
    const t = await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'Rectangle' }));
    fireEvent.pointerDown(t.svg, { button: 0, pointerId: 1, ...px(20, 200) });
    fireEvent.pointerMove(t.svg, { pointerId: 1, ...px(120, 150) });
    fireEvent.pointerUp(t.svg, { pointerId: 1, ...px(120, 150) });
    fireEvent.click(screen.getByRole('radio', { name: 'Select' }));
    t.click(70, 200);
    fireEvent.keyDown(window, { key: 'c' });
    expect(screen.getByRole('heading', { name: 'Comment on this rectangle' })).toBeTruthy();
    t.write('Comment', 'Too small');
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    const id = t.annots()[0]!.id;
    expect(t.annots()[0]!.comment?.text).toBe('Too small');
    expect(within(threadOf(id)).getByText('Too small')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Comment on this rectangle' })).toBeNull();
  });

  it('adds, edits and deletes replies', async () => {
    const t = await ready();
    t.addNote(50, 150, 'Why?');
    const id = t.notes()[0]!.id;
    const thread = threadOf(id);

    t.write('Reply', 'Because.', thread);
    fireEvent.click(within(thread).getByRole('button', { name: 'Reply' }));
    expect(within(thread).getByText('Because.')).toBeTruthy();
    expect(t.notes()[0]!.comment!.replies).toHaveLength(1);

    const reply = thread.querySelector<HTMLElement>('.reply')!;
    fireEvent.click(within(reply).getByRole('button', { name: 'Edit' }));
    t.write('Edit reply', 'Because of X.', reply);
    fireEvent.click(within(reply).getByRole('button', { name: 'Save' }));
    expect(within(thread).getByText('Because of X.')).toBeTruthy();

    fireEvent.click(within(thread.querySelector<HTMLElement>('.reply')!).getByRole('button', { name: 'Delete' }));
    expect(t.notes()[0]!.comment!.replies).toHaveLength(0);
    expect(thread.querySelector('.reply')).toBeNull();
  });

  it('edits the comment text of a note in place', async () => {
    const t = await ready();
    t.addNote(50, 150, 'first');
    const thread = threadOf(t.notes()[0]!.id);
    fireEvent.click(within(thread).getAllByRole('button', { name: 'Edit' })[0]!);
    t.write('Edit comment', 'second', thread);
    fireEvent.click(within(thread).getByRole('button', { name: 'Save' }));
    expect(t.notes()[0]!.comment!.text).toBe('second');
  });

  it('deletes a note from its thread, and undo brings it back', async () => {
    const t = await ready();
    t.addNote(50, 150, 'gone soon');
    fireEvent.click(within(threadOf(t.notes()[0]!.id)).getByRole('button', { name: 'Delete note' }));
    expect(t.notes()).toHaveLength(0);
    expect(screen.queryByText('gone soon')).toBeNull();
    t.store.undo();
    expect(t.notes()).toHaveLength(1);
    expect(await screen.findByText('gone soon')).toBeTruthy();
  });

  it('removes a comment from a non-note annotation but keeps the annotation', async () => {
    const t = await ready();
    t.store.beginNote(t.pageId, { x: 5, y: 5 }); // just to open the panel state; replaced below
    t.store.cancelDraftNote();
    const id = t.store.addMarkup('highlight', t.pageId, [{ p1: { x: 0, y: 10 }, p2: { x: 10, y: 10 }, p3: { x: 0, y: 0 }, p4: { x: 10, y: 0 } }])!;
    t.store.setComment(t.pageId, id, 'about this');
    t.store.toggleComments(true);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove comment' }));
    expect(t.annots().map((a) => a.id)).toContain(id);
    expect(t.annots().find((a) => a.id === id)!.comment).toBeUndefined();
  });

  it('selects the annotation, switches to the Select tool and goes to its page when a thread is clicked', async () => {
    const t = await ready();
    t.addNote(50, 150, 'jump here');
    fireEvent.click(screen.getByRole('radio', { name: 'Rectangle' }));
    t.store.setCurrentPage(2);
    fireEvent.click(within(threadOf(t.notes()[0]!.id)).getByRole('button', { name: /Note on page 1/ }));
    expect(t.store.getSnapshot().ui.activeTool).toBe('select');
    expect(t.store.getSnapshot().ui.selectedAnnot?.id).toBe(t.notes()[0]!.id);
    expect(t.store.getSnapshot().ui.currentPage).toBe(0);
    expect(threadOf(t.notes()[0]!.id).classList.contains('selected')).toBe(true);
  });

  it('shows a hint when there are no comments', async () => {
    await ready();
    fireEvent.keyDown(window, { key: 'c' });
    expect(screen.getByText(/No comments yet/)).toBeTruthy();
  });

  it('lets the user change the name used on comments and replies', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'c' });
    const field = screen.getByLabelText('Commenting as') as HTMLInputElement;
    expect(field.value).toBe('You');
    fireEvent.change(field, { target: { value: 'Ada' } });
    fireEvent.blur(field);
    expect(t.store.getAuthor()).toBe('Ada');
    t.addNote(50, 150, 'signed');
    expect(t.notes()[0]!.author).toBe('Ada');
  });
});
