import { describe, expect, it } from 'vitest';
import {
  History, addSource, deletePages, duplicatePages, emptyDocument, idsToRemove, importedAnnotations, isImportedId, memorySource,
  parsePdfDate, pdfIdOf, removeImportedAnnotations, selectPages, type SourceAnnotation,
} from '../src';

const sa = (over: Partial<SourceAnnotation> & Pick<SourceAnnotation, 'id' | 'subtype'>): SourceAnnotation => ({
  rect: { x: 10, y: 20, w: 100, h: 30 }, ...over,
});

describe('parsePdfDate', () => {
  it('reads PDF dates, with or without the D: prefix and with partial precision', () => {
    expect(parsePdfDate('D:20261023095253Z')).toBe('2026-10-23T09:52:53Z');
    expect(parsePdfDate('20261023095253')).toBe('2026-10-23T09:52:53Z');
    expect(parsePdfDate('D:2026')).toBe('2026-01-01T00:00:00Z');
    expect(parsePdfDate("D:20260315120000+01'00'")).toBe('2026-03-15T12:00:00Z');
  });
  it('gives an empty string for anything unreadable', () => {
    for (const bad of [undefined, '', 'yesterday', 'D:abc', 'D:20261399999999']) expect(parsePdfDate(bad)).toBe('');
  });
});

describe('ids', () => {
  it('prefixes imported ids and strips the prefix again', () => {
    expect(isImportedId('pdf:20R')).toBe(true);
    expect(isImportedId('7f3c-uuid')).toBe(false);
    expect(pdfIdOf('pdf:20R')).toBe('20R');
    expect(pdfIdOf('7f3c-uuid')).toBe('7f3c-uuid');
  });
});

describe('importedAnnotations', () => {
  const quad = { p1: { x: 0, y: 10 }, p2: { x: 10, y: 10 }, p3: { x: 0, y: 0 }, p4: { x: 10, y: 0 } };

  it('maps text markup to selectable highlights, underlines and strikeouts with their quads and comment', () => {
    const [h, u, s, sq] = importedAnnotations(
      [
        sa({ id: '1R', subtype: 'Highlight', quads: [quad], color: { r: 1, g: 0.9, b: 0 }, contents: 'Look', author: 'Ada', created: 'D:20260102030405Z' }),
        sa({ id: '2R', subtype: 'Underline', quads: [quad] }),
        sa({ id: '3R', subtype: 'StrikeOut', quads: [quad] }),
        sa({ id: '4R', subtype: 'Squiggly', quads: [quad] }),
      ],
      'p1',
    );
    expect(h).toMatchObject({ type: 'highlight', id: 'pdf:1R', pageId: 'p1', origin: 'imported', author: 'Ada', createdAt: '2026-01-02T03:04:05Z', comment: { text: 'Look', replies: [] } });
    expect(u).toMatchObject({ type: 'underline' });
    expect(s).toMatchObject({ type: 'strikeout' });
    expect(sq).toMatchObject({ type: 'underline' }); // closest thing we have
    expect('comment' in u!).toBe(false);
  });

  it('falls back to the rectangle when a markup annotation has no quads', () => {
    const [h] = importedAnnotations([sa({ id: '1R', subtype: 'Highlight' })], 'p');
    expect(h).toMatchObject({ type: 'highlight' });
    expect((h as { quads: unknown[] }).quads).toHaveLength(1);
  });

  it('maps ink, shapes and lines with their geometry and stroke width', () => {
    const list = importedAnnotations(
      [
        sa({ id: '1R', subtype: 'Ink', strokes: [[{ x: 0, y: 0 }, { x: 5, y: 5 }]], borderWidth: 3 }),
        sa({ id: '2R', subtype: 'Square', borderWidth: 2 }),
        sa({ id: '3R', subtype: 'Circle' }),
        sa({ id: '4R', subtype: 'Line', line: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }),
      ],
      'p',
    );
    expect(list[0]).toMatchObject({ type: 'ink', width: 3, strokes: [[{ x: 0, y: 0 }, { x: 5, y: 5 }]] });
    expect(list[1]).toMatchObject({ type: 'shape', shape: 'rect', width: 2 });
    expect(list[2]).toMatchObject({ type: 'shape', shape: 'ellipse', width: 1 }); // no width given: 1
    expect(list[3]).toMatchObject({ type: 'shape', shape: 'line', line: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
  });

  it('maps a Text annotation to a note hanging from the upper-left of its rectangle', () => {
    const [n] = importedAnnotations([sa({ id: '1R', subtype: 'Text', rect: { x: 480, y: 680, w: 20, h: 20 }, contents: 'Hi' })], 'p');
    expect(n).toMatchObject({ type: 'note', position: { x: 480, y: 700 }, comment: { text: 'Hi', replies: [] } });
  });

  it('gives a note a comment even when it has no text', () => {
    const [n] = importedAnnotations([sa({ id: '1R', subtype: 'Text' })], 'p');
    expect(n).toMatchObject({ type: 'note', comment: { text: '', replies: [] } });
  });

  it('maps free text with its text as the content', () => {
    const [t] = importedAnnotations([sa({ id: '1R', subtype: 'FreeText', contents: 'Typed elsewhere' })], 'p');
    expect(t).toMatchObject({ type: 'freetext', text: 'Typed elsewhere', origin: 'imported' });
  });

  it('folds replies into the comment of the annotation they answer, in order', () => {
    const list = importedAnnotations(
      [
        sa({ id: '1R', subtype: 'Text', contents: 'Why?', author: 'Ada' }),
        sa({ id: '2R', subtype: 'Text', contents: 'Because.', author: 'Bob', inReplyTo: '1R', replyType: 'R', created: 'D:20260105000000Z' }),
        sa({ id: '3R', subtype: 'Text', contents: 'Thanks', author: 'Cy', inReplyTo: '1R', replyType: 'R' }),
      ],
      'p',
    );
    expect(list).toHaveLength(1);
    expect(list[0]!.comment).toMatchObject({
      text: 'Why?',
      replies: [
        { id: 'pdf:2R', author: 'Bob', text: 'Because.', createdAt: '2026-01-05T00:00:00Z' },
        { id: 'pdf:3R', author: 'Cy', text: 'Thanks' },
      ],
    });
  });

  it('keeps a reply whose parent is missing as an annotation of its own instead of losing it', () => {
    const list = importedAnnotations([sa({ id: '2R', subtype: 'Text', contents: 'orphan', inReplyTo: '99R' })], 'p');
    expect(list).toHaveLength(1);
    expect(list[0]!.comment?.text).toBe('orphan');
  });

  it('leaves out links, form fields and popups, which are not something the user selects', () => {
    expect(importedAnnotations([sa({ id: '1R', subtype: 'Link' }), sa({ id: '2R', subtype: 'Widget' }), sa({ id: '3R', subtype: 'Popup' })], 'p')).toEqual([]);
  });

  it('gives other kinds (stamps, polygons) a selectable box so they can still be deleted', () => {
    const [stamp, poly] = importedAnnotations(
      [sa({ id: '1R', subtype: 'Stamp' }), sa({ id: '2R', subtype: 'Polygon', rect: { x: 5, y: 5, w: 0, h: 0 } })],
      'p',
    );
    expect(stamp).toMatchObject({ type: 'stamp', payload: { kind: 'preset', name: 'Stamp' }, rect: { w: 100, h: 30 } });
    expect(poly).toMatchObject({ type: 'stamp', payload: { name: 'Polygon' } });
    expect((poly as { rect: { w: number } }).rect.w).toBeGreaterThan(0); // never a zero-size box nobody can hit
  });

  it('uses "Unknown" for a missing author and keeps the order of the file', () => {
    const list = importedAnnotations([sa({ id: '5R', subtype: 'Highlight' }), sa({ id: '2R', subtype: 'Ink' })], 'p');
    expect(list.map((a) => a.id)).toEqual(['pdf:5R', 'pdf:2R']);
    expect(list[0]!.author).toBe('Unknown');
  });
});

describe('idsToRemove', () => {
  const list = [
    sa({ id: '1R', subtype: 'Text' }),
    sa({ id: '2R', subtype: 'Text', inReplyTo: '1R' }),
    sa({ id: '3R', subtype: 'Text', inReplyTo: '2R' }),
    sa({ id: '4R', subtype: 'Text' }),
  ];

  it('takes the annotation and every reply beneath it, including replies to replies', () => {
    expect(idsToRemove(list, 'pdf:1R').sort()).toEqual(['1R', '2R', '3R']);
  });
  it('takes only itself when nothing replies to it', () => {
    expect(idsToRemove(list, 'pdf:4R')).toEqual(['4R']);
    expect(idsToRemove(list, 'pdf:3R')).toEqual(['3R']);
  });
  it('terminates on a cycle of replies', () => {
    const cyc = [sa({ id: 'a', subtype: 'Text', inReplyTo: 'b' }), sa({ id: 'b', subtype: 'Text', inReplyTo: 'a' })];
    expect(idsToRemove(cyc, 'a').sort()).toEqual(['a', 'b']);
  });
});

describe('removeImportedAnnotations', () => {
  const source = (n: number) => ({ id: 's', name: 's.pdf', data: memorySource(new Uint8Array(1)), pageCount: n, isEncrypted: false, hasDigitalSignature: false });
  const make = () => {
    const h = new History(emptyDocument());
    let n = 0;
    h.execute(addSource(source(3), undefined, () => `p${++n}`));
    return h;
  };

  it('remembers the removed ids for the page, as one undoable step', () => {
    const h = make();
    h.execute(removeImportedAnnotations('p1', ['20R', '27R']));
    expect(h.current.removedImported).toEqual({ p1: ['20R', '27R'] });
    expect(h.undoLabel).toBe('Delete annotation');
    expect(h.current.dirty).toBe(true);
    h.undo();
    expect(h.current.removedImported).toEqual({});
    h.redo();
    expect(h.current.removedImported.p1).toEqual(['20R', '27R']);
  });

  it('adds to what is already removed, without duplicates', () => {
    const h = make();
    h.execute(removeImportedAnnotations('p1', ['20R']));
    h.execute(removeImportedAnnotations('p1', ['20R', '22R', '22R']));
    expect(h.current.removedImported.p1).toEqual(['20R', '22R']);
  });

  it('does nothing for a page that does not exist, or when everything is already removed', () => {
    const h = make();
    const before = h.current;
    h.execute(removeImportedAnnotations('nope', ['1R']));
    expect(h.current).toBe(before);
    h.execute(removeImportedAnnotations('p1', ['1R']));
    const afterOne = h.current;
    h.execute(removeImportedAnnotations('p1', ['1R']));
    expect(h.current).toBe(afterOne);
    h.execute(removeImportedAnnotations('p1', []));
    expect(h.current).toBe(afterOne);
  });

  it('is per page instance: a duplicate starts with the same removals, then goes its own way', () => {
    const h = make();
    h.execute(removeImportedAnnotations('p1', ['20R']));
    let n = 100;
    h.execute(duplicatePages(['p1'], () => `c${++n}`));
    const copy = h.current.pages[1]!.id;
    expect(h.current.removedImported[copy]).toEqual(['20R']);
    h.execute(removeImportedAnnotations(copy, ['22R']));
    expect(h.current.removedImported.p1).toEqual(['20R']);
    expect(h.current.removedImported[copy]).toEqual(['20R', '22R']);
  });

  it('is forgotten when the page is deleted, and brought back with it by undo', () => {
    const h = make();
    h.execute(removeImportedAnnotations('p2', ['5R']));
    h.execute(deletePages(['p2']));
    expect(h.current.removedImported).toEqual({});
    h.undo();
    expect(h.current.removedImported).toEqual({ p2: ['5R'] });
  });

  it('is carried into an extract of just those pages', () => {
    const h = make();
    h.execute(removeImportedAnnotations('p1', ['1R']));
    h.execute(removeImportedAnnotations('p3', ['3R']));
    expect(selectPages(h.current, ['p3']).removedImported).toEqual({ p3: ['3R'] });
    expect(selectPages(h.current, ['p2']).removedImported).toEqual({});
  });
});
