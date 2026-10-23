import { describe, expect, it, vi } from 'vitest';
import type { SourceAnnotation } from '@pagewright/core';
import { listThreads } from '../src/comments';
import { file, setup } from './store-helpers';

const quad = { p1: { x: 10, y: 120 }, p2: { x: 110, y: 120 }, p3: { x: 10, y: 100 }, p4: { x: 110, y: 100 } };

/** What "another tool" left in page 1 of the file: a commented highlight, a note with two replies, and a plain square. */
const original = (i: number): SourceAnnotation[] =>
  i !== 0
    ? []
    : [
        { id: '20R', subtype: 'Highlight', rect: { x: 10, y: 100, w: 100, h: 20 }, quads: [quad], contents: 'Check this', author: 'Ada', created: 'D:20260102030405Z' },
        { id: '26R', subtype: 'Text', rect: { x: 150, y: 250, w: 20, h: 20 }, contents: 'A note', author: 'Grace' },
        { id: '27R', subtype: 'Text', rect: { x: 150, y: 248, w: 22, h: 22 }, contents: 'First reply', author: 'Bob', inReplyTo: '26R', replyType: 'R' },
        { id: '28R', subtype: 'Text', rect: { x: 150, y: 248, w: 22, h: 22 }, contents: 'Second reply', author: 'Cy', inReplyTo: '26R', replyType: 'R' },
        { id: '30R', subtype: 'Square', rect: { x: 50, y: 20, w: 80, h: 40 } },
        { id: '31R', subtype: 'Link', rect: { x: 0, y: 0, w: 10, h: 10 } },
      ];

async function ready(opts: { original?: (i: number) => SourceAnnotation[] } = {}) {
  const t = setup({ original: opts.original ?? original });
  await t.store.addFiles([file('a.pdf')]);
  const [p1, p2, p3] = t.store.getSnapshot().doc.pages.map((p) => p.id) as [string, string, string];
  // The annotations are read in the background; wait for page 1's to arrive.
  await vi.waitFor(() => expect(t.store.getSnapshot().imported[p1]?.length ?? 0).toBeGreaterThan(0));
  const view = (pageId = p1) => t.store.getSnapshot().imported[pageId] ?? [];
  const removed = (pageId = p1) => t.store.getSnapshot().doc.removedImported[pageId];
  return { ...t, p1, p2, p3, view, removed };
}

describe('original annotations in the snapshot', () => {
  it('appear once read, in the editor’s types, marked as imported, with links and popups left out', async () => {
    const { view } = await ready();
    expect(view().map((a) => [a.id, a.type])).toEqual([['pdf:20R', 'highlight'], ['pdf:26R', 'note'], ['pdf:30R', 'shape']]);
    expect(view().every((a) => a.origin === 'imported')).toBe(true);
    expect(view()[0]).toMatchObject({ author: 'Ada', createdAt: '2026-01-02T03:04:05Z', comment: { text: 'Check this' } });
  });

  it('fold replies into the note they answer', async () => {
    const { view } = await ready();
    expect(view()[1]!.comment).toMatchObject({ text: 'A note', replies: [{ author: 'Bob', text: 'First reply' }, { author: 'Cy', text: 'Second reply' }] });
  });

  it('belong to the page they were read from, not to other pages', async () => {
    const { view, p2, p3 } = await ready();
    expect(view(p2)).toEqual([]);
    expect(view(p3)).toEqual([]);
  });

  it('tolerate a page whose annotations cannot be read', async () => {
    const t = setup({ original: (i) => { if (i === 1) throw new Error('corrupt page'); return i === 0 ? original(0) : []; } });
    await t.store.addFiles([file('a.pdf')]);
    const p1 = t.store.getSnapshot().doc.pages[0]!.id;
    await vi.waitFor(() => expect(t.store.getSnapshot().imported[p1]?.length ?? 0).toBeGreaterThan(0));
    expect(t.store.getSnapshot().ui.error).toBeUndefined();
  });

  it('return the same object when nothing changed, so the UI does not redraw for nothing', async () => {
    const { store } = await ready();
    expect(store.getSnapshot().imported).toBe(store.getSnapshot().imported);
    const before = store.getSnapshot().imported;
    store.setZoom(2); // UI-only change: the same imported view
    expect(store.getSnapshot().imported).toBe(before);
  });
});

describe('selecting and deleting an original annotation', () => {
  it('can be selected like any annotation', async () => {
    const { store, p1 } = await ready();
    store.selectAnnotation({ pageId: p1, id: 'pdf:20R' });
    expect(store.getSnapshot().ui.selectedAnnot).toEqual({ pageId: p1, id: 'pdf:20R' });
  });

  it('is removed from the view and remembered for the save, as one undoable step', async () => {
    const { store, p1, view, removed } = await ready();
    store.selectAnnotation({ pageId: p1, id: 'pdf:20R' });
    store.deleteSelectedAnnotation();
    expect(view().map((a) => a.id)).toEqual(['pdf:26R', 'pdf:30R']);
    expect(removed()).toEqual(['20R']);
    expect(store.getSnapshot().ui.selectedAnnot).toBeUndefined();
    expect(store.getSnapshot().undoLabel).toBe('Delete annotation');
    expect(store.getSnapshot().doc.dirty).toBe(true);
    store.undo();
    expect(view().map((a) => a.id)).toEqual(['pdf:20R', 'pdf:26R', 'pdf:30R']);
    expect(removed()).toBeUndefined();
    store.redo();
    expect(removed()).toEqual(['20R']);
  });

  it('takes the replies with it, so no orphaned thread is saved', async () => {
    const { store, p1, view, removed } = await ready();
    store.deleteAnnotation(p1, 'pdf:26R');
    expect([...removed()!].sort()).toEqual(['26R', '27R', '28R']);
    expect(view().map((a) => a.id)).toEqual(['pdf:20R', 'pdf:30R']);
  });

  it('is cleared from the selection when it disappears', async () => {
    const { store, p1 } = await ready();
    store.selectAnnotation({ pageId: p1, id: 'pdf:30R' });
    store.deleteAnnotation(p1, 'pdf:30R');
    expect(store.getSnapshot().ui.selectedAnnot).toBeUndefined();
  });

  it('comes back with undo, without being selected again', async () => {
    const { store, p1 } = await ready();
    store.deleteAnnotation(p1, 'pdf:30R');
    store.undo();
    expect(store.getSnapshot().ui.selectedAnnot).toBeUndefined();
  });

  it('does nothing for an id that is not there, or one that was already deleted', async () => {
    const { store, p1 } = await ready();
    const doc = store.getSnapshot().doc;
    store.deleteAnnotation(p1, 'pdf:999R');
    expect(store.getSnapshot().doc).toBe(doc);
    store.deleteAnnotation(p1, 'pdf:30R');
    const after = store.getSnapshot().doc;
    store.deleteAnnotation(p1, 'pdf:30R');
    expect(store.getSnapshot().doc).toBe(after);
  });

  it('cannot be edited, replied to or recommented: they belong to the original file', async () => {
    const { store, p1, view } = await ready();
    const before = store.getSnapshot().doc;
    store.setComment(p1, 'pdf:20R', 'changed');
    store.addReply(p1, 'pdf:26R', 'hello');
    store.removeComment(p1, 'pdf:20R');
    store.editReply(p1, 'pdf:26R', 'pdf:27R', 'x');
    store.deleteReply(p1, 'pdf:26R', 'pdf:27R');
    expect(store.getSnapshot().doc).toBe(before);
    expect(view()[0]!.comment!.text).toBe('Check this');
    expect(view()[1]!.comment!.replies).toHaveLength(2);
  });
});

describe('original annotations and page operations', () => {
  it('a duplicated page starts with the same deletions, then each page goes its own way', async () => {
    const { store, p1, view, removed } = await ready();
    store.deleteAnnotation(p1, 'pdf:30R');
    store.duplicatePages([p1]);
    const copy = store.getSnapshot().doc.pages[1]!.id;
    expect(removed(copy)).toEqual(['30R']);
    expect(view(copy).map((a) => a.id)).toEqual(['pdf:20R', 'pdf:26R']);
    store.deleteAnnotation(copy, 'pdf:20R');
    expect(view(copy).map((a) => a.id)).toEqual(['pdf:26R']);
    expect(view(p1).map((a) => a.id)).toEqual(['pdf:20R', 'pdf:26R']); // the first page is untouched
  });

  it('the annotations follow their page when pages are moved', async () => {
    const { store, p1, view } = await ready();
    store.movePages(2, [p1]);
    expect(store.getSnapshot().doc.pages[2]!.id).toBe(p1);
    expect(view(p1).map((a) => a.id)).toEqual(['pdf:20R', 'pdf:26R', 'pdf:30R']);
  });

  it('deleting the page forgets the deletions and clears a selection inside it', async () => {
    const { store, p1 } = await ready();
    store.deleteAnnotation(p1, 'pdf:30R');
    store.selectAnnotation({ pageId: p1, id: 'pdf:20R' });
    store.deletePages([p1]);
    expect(store.getSnapshot().doc.removedImported[p1]).toBeUndefined();
    expect(store.getSnapshot().ui.selectedAnnot).toBeUndefined();
    expect(store.getSnapshot().imported[p1]).toBeUndefined();
    store.undo();
    expect(store.getSnapshot().doc.removedImported[p1]).toEqual(['30R']);
    expect(store.getSnapshot().imported[p1]!.map((a) => a.id)).toEqual(['pdf:20R', 'pdf:26R']);
  });

  it('are listed in the comments with the ones made here, originals first', async () => {
    const { store, p1 } = await ready();
    store.beginNote(p1, { x: 5, y: 5 });
    const mine = store.saveDraftNote('my note')!;
    const threads = listThreads(store.getSnapshot().doc, store.getSnapshot().imported);
    // the square and the highlight without a comment: only the highlight (has a comment) and the notes are threads
    expect(threads.map((t) => t.annot.id)).toEqual(['pdf:20R', 'pdf:26R', mine]);
    expect(threads.every((t) => t.pageIndex === 0)).toBe(true);
  });

  it('count only what is left after deleting', async () => {
    const { store, p1 } = await ready();
    store.deleteAnnotation(p1, 'pdf:26R');
    expect(listThreads(store.getSnapshot().doc, store.getSnapshot().imported).map((t) => t.annot.id)).toEqual(['pdf:20R']);
  });
});
