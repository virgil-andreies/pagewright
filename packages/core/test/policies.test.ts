import { describe, expect, it } from 'vitest';
import {
  History, SAVE_MEMORY_FACTOR, describeError, estimateSavePeakMB, maxSaveSourceMB, memorySource, addAnnotation, addSource, emptyDocument, preflight, reorderAnnotation, transformQuad, rectToQuad,
  type HighlightAnnot, type SourceDoc,
} from '../src';

const src = (id: string, o: Partial<SourceDoc> = {}): SourceDoc => ({
  id, name: id, data: memorySource(new Uint8Array(0)), pageCount: 1, isEncrypted: false, hasDigitalSignature: false, ...o,
});
const docWith = (...s: SourceDoc[]) => {
  const h = new History(emptyDocument());
  s.forEach((x, i) => h.execute(addSource(x, undefined, () => `p${i}`)));
  return h.current;
};
const opts = { memoryBudgetMB: 1 };

describe('preflight', () => {
  it('passes a clean doc', () => {
    expect(preflight(docWith(src('a')), opts)).toEqual({ errors: [], warnings: [], notices: [] });
  });
  it('blocks encrypted sources', () => {
    expect(preflight(docWith(src('a', { isEncrypted: true })), opts).errors).toEqual([{ code: 'EncryptedNotSupported' }]);
  });
  it('warns on signed sources', () => {
    const r = preflight(docWith(src('a', { hasDigitalSignature: true })), opts);
    expect(r.warnings).toEqual([{ code: 'SignedDocumentWarning' }]);
    expect(r.notices).toContain('SignaturesInvalidated');
  });
  it('refuses over the memory budget', () => {
    const r = preflight(docWith(src('a', { data: memorySource(new Uint8Array(3 * 1024 * 1024)) })), opts);
    expect(r.errors).toEqual([{ code: 'OutOfMemoryRisk', estimateMB: 14, budgetMB: 1 }]); // 3 MB x 4.5
  });
  it('counts image stamps toward the memory estimate, each picture once', () => {
    const bytes = new Uint8Array(2 * 1024 * 1024);
    const stamp = (id: string, b = bytes) => ({
      id, type: 'stamp' as const, pageId: 'p0', author: 'A', createdAt: '', modifiedAt: '', opacity: 1, origin: 'app' as const,
      color: { r: 0, g: 0, b: 0, a: 1 }, rect: { x: 0, y: 0, w: 10, h: 10 }, payload: { kind: 'image' as const, mime: 'image/png' as const, bytes: b },
    });
    const h = new History(docWith(src('a', { data: memorySource(new Uint8Array(1024 * 1024)) })));
    h.execute(addAnnotation(stamp('i1')));
    h.execute(addAnnotation(stamp('i2'))); // a duplicate: the same picture
    expect(preflight(h.current, opts).errors).toEqual([{ code: 'OutOfMemoryRisk', estimateMB: 14, budgetMB: 1 }]); // (1 + 2) MB x 4.5
    h.execute(addAnnotation(stamp('i3', new Uint8Array(2 * 1024 * 1024))));
    expect(preflight(h.current, opts).errors).toEqual([{ code: 'OutOfMemoryRisk', estimateMB: 23, budgetMB: 1 }]); // (1 + 2 + 2) MB x 4.5
  });
  it('notes dropped outlines on merge', () => {
    expect(preflight(docWith(src('a'), src('b')), opts).notices).toContain('OutlinesDropped');
  });
});

/** A source of the given size that costs no memory: only `size` is ever read by the guard. */
const sized = (mb: number) =>
  ({ kind: 'blob', blob: { size: mb * 1024 * 1024, slice: () => { throw new Error('unused'); }, arrayBuffer: async () => { throw new Error('unused'); } } }) as const;

describe('save memory guard', () => {
  it('estimates peak memory as a multiple of the source size', () => {
    expect(SAVE_MEMORY_FACTOR).toBe(4.5);
    expect(estimateSavePeakMB(100 * 1024 * 1024)).toBe(450);
    expect(maxSaveSourceMB(1000)).toBe(222);
  });

  it('accepts a document exactly at the limit and refuses one just over it', () => {
    const budget = 900; // allows 200 MB of sources
    expect(maxSaveSourceMB(budget)).toBe(200);
    expect(preflight(docWith(src('a', { data: sized(200) })), { memoryBudgetMB: budget }).errors).toEqual([]);
    expect(preflight(docWith(src('a', { data: sized(201) })), { memoryBudgetMB: budget }).errors).toEqual([
      { code: 'OutOfMemoryRisk', estimateMB: 905, budgetMB: 900 },
    ]);
  });

  it('counts all used sources together, but not ones that no longer contribute pages', () => {
    const doc = docWith(src('a', { data: sized(150) }), src('b', { data: sized(150) }));
    expect(preflight(doc, { memoryBudgetMB: 900 }).errors[0]?.code).toBe('OutOfMemoryRisk');
    const onlyA = { ...doc, pages: doc.pages.filter((p) => p.sourceId === 'a') };
    expect(preflight(onlyA, { memoryBudgetMB: 900 }).errors).toEqual([]);
  });

  it('lets the 299 MB test file save on a desktop budget but not on a phone budget', () => {
    const doc = docWith(src('a', { data: sized(299) }));
    expect(preflight(doc, { memoryBudgetMB: 2400 }).errors).toEqual([]);
    expect(preflight(doc, { memoryBudgetMB: 1000 }).errors[0]).toMatchObject({ code: 'OutOfMemoryRisk', estimateMB: 1346 });
  });

  it('explains the refusal with the numbers the user needs', () => {
    const { message, action } = describeError({ code: 'OutOfMemoryRisk', estimateMB: 1346, budgetMB: 1000 });
    expect(message).toContain('1346 MB');
    expect(message).toContain('1000 MB');
    expect(message).toContain('up to 222 MB');
    expect(message).toMatch(/still view/);
    expect(action).toBeTruthy();
  });
});

describe('reorderAnnotation', () => {
  it('changes z-order and undoes', () => {
    const h = new History(emptyDocument());
    h.execute(addSource(src('a'), undefined, () => 'page'));
    const mk = (id: string): HighlightAnnot => ({
      type: 'highlight', id, pageId: 'page', author: 'a', createdAt: 't', modifiedAt: 't',
      color: { r: 1, g: 1, b: 0, a: 1 }, opacity: 1, origin: 'app', quads: [],
    });
    ['x', 'y', 'z'].forEach((id) => h.execute(addAnnotation(mk(id))));
    const ids = () => h.current.annotations['page']!.map((a) => a.id);
    h.execute(reorderAnnotation('page', 'x', 99));
    expect(ids()).toEqual(['y', 'z', 'x']);
    h.undo();
    expect(ids()).toEqual(['x', 'y', 'z']);
  });
});

describe('transformQuad', () => {
  it('translates and scales', () => {
    const q = transformQuad(rectToQuad({ x: 0, y: 0, w: 1, h: 1 }), [2, 0, 0, 2, 10, 20]);
    expect(q.p4).toEqual({ x: 12, y: 20 });
    expect(q.p1).toEqual({ x: 10, y: 22 });
  });
});
