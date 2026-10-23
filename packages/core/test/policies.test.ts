import { describe, expect, it } from 'vitest';
import {
  History, memorySource, addAnnotation, addSource, emptyDocument, preflight, reorderAnnotation, transformQuad, rectToQuad,
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
    expect(r.errors).toEqual([{ code: 'OutOfMemoryRisk', estimateMB: 3 }]);
  });
  it('notes dropped outlines on merge', () => {
    expect(preflight(docWith(src('a'), src('b')), opts).notices).toContain('OutlinesDropped');
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
