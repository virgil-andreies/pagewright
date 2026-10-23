import { describe, expect, it, vi } from 'vitest';
import type { Annotation, NoteAnnot } from '@pagewright/core';
import { annotationName, listThreads } from '../src/comments';
import type { AppStore } from '../src/store';
import { file, setup } from './store-helpers';

const quad = { p1: { x: 0, y: 10 }, p2: { x: 10, y: 10 }, p3: { x: 0, y: 0 }, p4: { x: 10, y: 0 } };

async function withHighlight() {
  const t = setup();
  await t.store.addFiles([file('a.pdf')]);
  const pageId = t.store.getSnapshot().doc.pages[0]!.id;
  const id = t.store.addMarkup('highlight', pageId, [quad])!;
  const annot = () => t.store.getSnapshot().doc.annotations[pageId]!.find((a) => a.id === id)!;
  return { ...t, pageId, id, annot };
}

const notesOn = (s: AppStore, pageId: string) =>
  (s.getSnapshot().doc.annotations[pageId] ?? []).filter((a): a is NoteAnnot => a.type === 'note');

describe('notes', () => {
  it('are created only when they have text; cancelling leaves nothing behind', async () => {
    const { store } = setup();
    await store.addFiles([file('a.pdf')]);
    const pageId = store.getSnapshot().doc.pages[0]!.id;
    store.beginNote(pageId, { x: 30, y: 40 });
    expect(store.getSnapshot().ui.draftNote).toEqual({ pageId, position: { x: 30, y: 40 } });
    expect(store.getSnapshot().ui.commentsOpen).toBe(true);
    expect(store.saveDraftNote('   ')).toBeUndefined();
    expect(store.getSnapshot().ui.draftNote).toBeDefined(); // still open for typing
    expect(notesOn(store, pageId)).toHaveLength(0);
    store.cancelDraftNote();
    expect(store.getSnapshot().ui.draftNote).toBeUndefined();
    expect(notesOn(store, pageId)).toHaveLength(0);
  });

  it('save the draft as a selected note with trimmed text, as one undo step', async () => {
    const { store } = setup();
    await store.addFiles([file('a.pdf')]);
    const pageId = store.getSnapshot().doc.pages[0]!.id;
    store.beginNote(pageId, { x: 30, y: 40 });
    const id = store.saveDraftNote('  Check this  ')!;
    expect(notesOn(store, pageId)[0]).toMatchObject({
      position: { x: 30, y: 40 }, icon: 'note', comment: { text: 'Check this', replies: [] },
    });
    expect(store.getSnapshot().ui.draftNote).toBeUndefined();
    expect(store.getSnapshot().ui.selectedAnnot).toEqual({ pageId, id });
    store.undo();
    expect(notesOn(store, pageId)).toHaveLength(0);
  });

  it('starting a second note replaces the first draft', async () => {
    const { store } = setup();
    await store.addFiles([file('a.pdf')]);
    const pageId = store.getSnapshot().doc.pages[0]!.id;
    store.beginNote(pageId, { x: 1, y: 1 });
    store.beginNote(pageId, { x: 9, y: 9 });
    expect(store.getSnapshot().ui.draftNote?.position).toEqual({ x: 9, y: 9 });
  });
});

describe('comments', () => {
  it('can be added, edited and cleared on any annotation, each undoable', async () => {
    const { store, pageId, id, annot } = await withHighlight();
    expect(annot().comment).toBeUndefined();
    store.setComment(pageId, id, ' First ');
    expect(annot().comment).toEqual({ text: 'First', replies: [] });
    store.setComment(pageId, id, 'Second');
    expect(annot().comment?.text).toBe('Second');
    store.setComment(pageId, id, '  ');
    expect('comment' in annot()).toBe(false);
    store.undo();
    expect(annot().comment?.text).toBe('Second');
    store.undo();
    expect(annot().comment?.text).toBe('First');
  });

  it('leave no undo step when the text did not change', async () => {
    const { store, pageId, id } = await withHighlight();
    store.setComment(pageId, id, 'Same');
    const doc = store.getSnapshot().doc;
    store.setComment(pageId, id, ' Same '); // same after trimming
    expect(store.getSnapshot().doc).toBe(doc);
    store.undo(); // reverts the one real change, not a phantom one
    expect(store.getSnapshot().doc.annotations[pageId]![0]!.comment).toBeUndefined();
  });

  it('ignore edits to annotations that do not exist', async () => {
    const { store, pageId } = await withHighlight();
    const doc = store.getSnapshot().doc;
    store.setComment(pageId, 'nope', 'x');
    store.addReply(pageId, 'nope', 'x');
    expect(store.getSnapshot().doc).toBe(doc);
  });
});

describe('replies', () => {
  it('are added under the current author; blanks and replies to nothing are ignored', async () => {
    const { store, pageId, id, annot } = await withHighlight();
    store.addReply(pageId, id, 'orphan'); // no comment yet: nothing to reply to
    expect(annot().comment).toBeUndefined();
    store.setComment(pageId, id, 'Why?');
    store.setAuthor('Ada');
    store.addReply(pageId, id, 'Because.');
    store.addReply(pageId, id, '   ');
    const replies = annot().comment!.replies;
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ author: 'Ada', text: 'Because.' });
    expect(replies[0]!.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('can be edited and deleted one at a time', async () => {
    const { store, pageId, id, annot } = await withHighlight();
    store.setComment(pageId, id, 'Why?');
    store.addReply(pageId, id, 'one');
    store.addReply(pageId, id, 'two');
    const [r1, r2] = annot().comment!.replies;
    store.editReply(pageId, id, r1!.id, ' ONE ');
    expect(annot().comment!.replies.map((r) => r.text)).toEqual(['ONE', 'two']);
    store.editReply(pageId, id, r1!.id, '  '); // blank edits are ignored
    expect(annot().comment!.replies[0]!.text).toBe('ONE');
    store.deleteReply(pageId, id, r2!.id);
    expect(annot().comment!.replies.map((r) => r.text)).toEqual(['ONE']);
    store.undo();
    expect(annot().comment!.replies).toHaveLength(2);
  });

  it('go when the comment is removed or its text cleared', async () => {
    const { store, pageId, id, annot } = await withHighlight();
    store.setComment(pageId, id, 'Why?');
    store.addReply(pageId, id, 'x');
    store.removeComment(pageId, id);
    expect(annot().comment).toBeUndefined();
    store.setComment(pageId, id, 'Again');
    expect(annot().comment!.replies).toEqual([]);
  });

  it('survive editing the comment text', async () => {
    const { store, pageId, id, annot } = await withHighlight();
    store.setComment(pageId, id, 'Why?');
    store.addReply(pageId, id, 'x');
    store.setComment(pageId, id, 'Why exactly?');
    expect(annot().comment).toMatchObject({ text: 'Why exactly?', replies: [{ text: 'x' }] });
  });
});

describe('deleting and listing', () => {
  it('deleting an annotation removes its thread and clears the selection', async () => {
    const { store, pageId, id } = await withHighlight();
    store.setComment(pageId, id, 'x');
    store.selectAnnotation({ pageId, id });
    store.deleteAnnotation(pageId, id);
    expect(store.getSnapshot().doc.annotations[pageId]).toEqual([]);
    expect(store.getSnapshot().ui.selectedAnnot).toBeUndefined();
    expect(listThreads(store.getSnapshot().doc)).toEqual([]);
    store.undo();
    expect(listThreads(store.getSnapshot().doc)).toHaveLength(1);
  });

  it('lists threads page by page in the order they were added, including notes', async () => {
    const { store, pageId, id } = await withHighlight();
    const p2 = store.getSnapshot().doc.pages[1]!.id;
    store.beginNote(p2, { x: 1, y: 1 });
    const n = store.saveDraftNote('on page 2')!;
    store.setComment(pageId, id, 'on page 1');
    store.addMarkup('underline', pageId, [quad]); // no comment: not a thread
    expect(listThreads(store.getSnapshot().doc).map((t) => [t.pageIndex, t.annot.id])).toEqual([[0, id], [1, n]]);
  });

  it('follows pages when they are reordered or deleted', async () => {
    const { store, pageId, id } = await withHighlight();
    store.setComment(pageId, id, 'x');
    store.movePages(2, [pageId]);
    expect(listThreads(store.getSnapshot().doc)[0]!.pageIndex).toBe(2);
    store.deletePages([pageId]);
    expect(listThreads(store.getSnapshot().doc)).toEqual([]);
  });

  it('names annotations for display', () => {
    const base = { id: 'x', pageId: 'p', author: '', createdAt: '', modifiedAt: '', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, origin: 'app' as const };
    const names = (list: Annotation[]) => list.map(annotationName);
    expect(
      names([
        { ...base, type: 'highlight', quads: [] },
        { ...base, type: 'ink', strokes: [], width: 1 },
        { ...base, type: 'shape', shape: 'arrow', rect: { x: 0, y: 0, w: 0, h: 0 }, width: 1 },
        { ...base, type: 'shape', shape: 'ellipse', rect: { x: 0, y: 0, w: 0, h: 0 }, width: 1 },
        { ...base, type: 'note', position: { x: 0, y: 0 }, icon: 'note' },
      ]),
    ).toEqual(['Highlight', 'Drawing', 'Arrow', 'Ellipse', 'Note']);
  });
});

describe('author and panel', () => {
  it('remembers the author name, trims it, and loads it next session', async () => {
    const first = setup();
    first.store.setAuthor('  Ada Lovelace ');
    expect(first.store.getAuthor()).toBe('Ada Lovelace');
    expect(first.secrets.get('author')).toBe('Ada Lovelace');
    first.store.setAuthor('   '); // blank is ignored
    expect(first.store.getAuthor()).toBe('Ada Lovelace');

    const next = setup({ author: 'Grace' });
    await vi.waitFor(() => expect(next.store.getAuthor()).toBe('Grace'));
  });

  it('opens and closes the comments panel', () => {
    const { store } = setup();
    expect(store.getSnapshot().ui.commentsOpen).toBe(false);
    store.toggleComments();
    expect(store.getSnapshot().ui.commentsOpen).toBe(true);
    store.toggleComments(false);
    expect(store.getSnapshot().ui.commentsOpen).toBe(false);
  });
});
