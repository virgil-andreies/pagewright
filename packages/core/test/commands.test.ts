import { describe, expect, it } from 'vitest';
import {
  History,
  addAnnotation,
  addSource,
  deletePages,
  duplicatePages,
  emptyDocument,
  removeAnnotation,
  reorderPages,
  rotatePages,
  selectPages,
  setMetadata,
  splitEvery,
  updateAnnotation,
  type HighlightAnnot,
  type SourceDoc,
} from '../src';

let n = 0;
const ids = () => `id${++n}`;

function source(id: string, pageCount: number): SourceDoc {
  return { id, name: `${id}.pdf`, bytes: new Uint8Array(0), pageCount, isEncrypted: false, hasDigitalSignature: false };
}

function setup(counts: number[] = [3]) {
  const h = new History(emptyDocument());
  counts.forEach((c, i) => h.execute(addSource(source(`s${i}`, c), undefined, ids)));
  return h;
}

const order = (h: History) => h.current.pages.map((p) => `${p.sourceId}:${p.sourceIndex}`);

function highlight(pageId: string, id = ids()): HighlightAnnot {
  return {
    type: 'highlight', id, pageId, author: 'a', createdAt: 't', modifiedAt: 't',
    color: { r: 1, g: 1, b: 0, a: 1 }, opacity: 0.5, origin: 'app', quads: [],
  };
}

describe('Tier 1 commands', () => {
  it('merges sources in order and inserts at an index', () => {
    const h = setup([2, 2]);
    expect(order(h)).toEqual(['s0:0', 's0:1', 's1:0', 's1:1']);
    h.execute(addSource(source('s2', 1), 1, ids));
    expect(order(h)).toEqual(['s0:0', 's2:0', 's0:1', 's1:0', 's1:1']);
  });

  it('ignores adding the same source twice', () => {
    const h = setup([2]);
    h.execute(addSource(source('s0', 2), undefined, ids));
    expect(h.current.pages).toHaveLength(2);
  });

  it('reorders a selection to a new index, keeping relative order', () => {
    const h = setup([5]);
    const p = h.current.pages.map((x) => x.id);
    h.execute(reorderPages([p[3]!, p[1]!], 0));
    expect(order(h)).toEqual(['s0:1', 's0:3', 's0:0', 's0:2', 's0:4']);
    h.execute(reorderPages([p[1]!], 99));
    expect(order(h).at(-1)).toBe('s0:1');
  });

  it('deletes pages together with their annotations', () => {
    const h = setup([3]);
    const [a, b] = h.current.pages;
    h.execute(addAnnotation(highlight(a!.id)));
    h.execute(deletePages([a!.id]));
    expect(h.current.pages.map((p) => p.id)).toEqual(h.current.pages.filter((p) => p.id !== a!.id).map((p) => p.id));
    expect(h.current.annotations[a!.id]).toBeUndefined();
    expect(h.current.pages[0]!.id).toBe(b!.id);
  });

  it('duplicates pages after the original and clones annotations with new ids', () => {
    const h = setup([2]);
    const [a] = h.current.pages;
    const ann = highlight(a!.id);
    h.execute(addAnnotation(ann));
    h.execute(duplicatePages([a!.id], ids));
    expect(order(h)).toEqual(['s0:0', 's0:0', 's0:1']);
    const copy = h.current.pages[1]!;
    expect(copy.id).not.toBe(a!.id);
    const copied = h.current.annotations[copy.id]!;
    expect(copied).toHaveLength(1);
    expect(copied[0]!.id).not.toBe(ann.id);
    expect(copied[0]!.pageId).toBe(copy.id);
    expect(h.current.annotations[a!.id]).toHaveLength(1);
  });

  it('rotates cumulatively and wraps; rejects non-multiples of 90', () => {
    const h = setup([1]);
    const id = h.current.pages[0]!.id;
    h.execute(rotatePages([id], 90));
    h.execute(rotatePages([id], 270));
    expect(h.current.pages[0]!.rotation).toBe(0);
    h.execute(rotatePages([id], -90));
    expect(h.current.pages[0]!.rotation).toBe(270);
    expect(() => h.execute(rotatePages([id], 45))).toThrow(RangeError);
  });

  it('sets metadata', () => {
    const h = setup([1]);
    h.execute(setMetadata({ title: 'T', author: 'A' }));
    expect(h.current.metadata).toEqual({ title: 'T', author: 'A' });
  });

  it('extracts and splits', () => {
    const h = setup([2, 3]);
    const all = h.current.pages.map((p) => p.id);
    const ex = selectPages(h.current, [all[4]!, all[0]!]);
    expect(ex.pages.map((p) => p.id)).toEqual([all[0], all[4]]);
    expect(Object.keys(ex.sources).sort()).toEqual(['s0', 's1']);
    const parts = splitEvery(h.current, 2);
    expect(parts.map((d) => d.pages.length)).toEqual([2, 2, 1]);
    expect(Object.keys(parts[0]!.sources)).toEqual(['s0']);
    expect(() => splitEvery(h.current, 0)).toThrow(RangeError);
  });
});

describe('Tier 2 commands', () => {
  it('adds, updates and removes annotations', () => {
    const h = setup([1]);
    const pid = h.current.pages[0]!.id;
    const a = highlight(pid, 'A1');
    h.execute(addAnnotation(a));
    h.execute(addAnnotation(a)); // duplicate id ignored
    expect(h.current.annotations[pid]).toHaveLength(1);
    h.execute(updateAnnotation({ ...a, opacity: 0.9 }));
    expect(h.current.annotations[pid]![0]!.opacity).toBe(0.9);
    h.execute(removeAnnotation(pid, 'A1'));
    expect(h.current.annotations[pid]).toHaveLength(0);
  });

  it('rejects annotations for unknown pages', () => {
    const h = setup([1]);
    h.execute(addAnnotation(highlight('nope')));
    expect(h.current.annotations['nope']).toBeUndefined();
  });
});

describe('History', () => {
  it('undoes and redoes, restoring annotations on deleted pages', () => {
    const h = setup([2]);
    const [a] = h.current.pages;
    h.execute(addAnnotation(highlight(a!.id)));
    const before = h.current;
    h.execute(deletePages([a!.id]));
    h.undo();
    expect(h.current.pages).toEqual(before.pages);
    expect(h.current.annotations).toEqual(before.annotations);
    h.redo();
    expect(h.current.pages).toHaveLength(1);
    expect(h.canRedo).toBe(false);
  });

  it('clears redo on new commands, skips no-ops, and tracks dirty/markSaved', () => {
    const h = setup([2]);
    h.markSaved();
    expect(h.current.dirty).toBe(false);
    h.execute(deletePages(['unknown']));
    expect(h.current.dirty).toBe(false);
    expect(h.undoLabel).toBe('Add document');
    const id = h.current.pages[0]!.id;
    h.execute(rotatePages([id], 90));
    expect(h.current.dirty).toBe(true);
    h.undo();
    expect(h.canRedo).toBe(true);
    h.execute(rotatePages([id], 180));
    expect(h.canRedo).toBe(false);
  });

  it('notifies subscribers', () => {
    const h = setup([1]);
    let calls = 0;
    const off = h.subscribe(() => calls++);
    h.execute(rotatePages([h.current.pages[0]!.id], 90));
    h.undo();
    off();
    h.redo();
    expect(calls).toBe(2);
  });
});
