import { describe, expect, it } from 'vitest';
import {
  History, addAnnotation, addSource, batch, emptyDocument, memorySource, mergeRectsIntoLines, pdfToViewport, quadBounds,
  viewRectToQuad, type HighlightAnnot, type PageGeometry, type Rect,
} from '../src';

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe('mergeRectsIntoLines', () => {
  it('leaves a single rectangle alone', () => {
    expect(mergeRectsIntoLines([R(10, 10, 100, 12)])).toEqual([R(10, 10, 100, 12)]);
  });

  it('removes rectangles that a bigger one already covers (the browser reports elements and text both)', () => {
    const out = mergeRectsIntoLines([R(10, 10, 100, 12), R(10, 10, 100, 12), R(20, 10, 30, 12), R(10, 9, 100, 14)]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(R(10, 9, 100, 14));
  });

  it('joins fragments of one line that touch or are a space apart', () => {
    const out = mergeRectsIntoLines([R(10, 10, 40, 12), R(50, 10, 30, 12), R(83, 10, 20, 12)]);
    expect(out).toEqual([R(10, 10, 93, 12)]);
  });

  it('keeps separate pieces apart when the gap is wide', () => {
    const out = mergeRectsIntoLines([R(10, 10, 40, 12), R(200, 10, 40, 12)]);
    expect(out).toEqual([R(10, 10, 40, 12), R(200, 10, 40, 12)]);
  });

  it('keeps lines apart and returns them top to bottom, left to right', () => {
    const out = mergeRectsIntoLines([R(10, 50, 80, 12), R(10, 10, 80, 12), R(100, 30, 50, 12), R(10, 30, 60, 12)]);
    expect(out.map((r) => [r.x, r.y])).toEqual([[10, 10], [10, 30], [100, 30], [10, 50]]);
  });

  it('puts fragments of slightly different heights on one line (superscripts, mixed fonts)', () => {
    const out = mergeRectsIntoLines([R(10, 10, 40, 12), R(50, 8, 12, 9), R(62, 10, 30, 12)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.x).toBe(10);
    expect(out[0]!.w).toBe(82);
    expect(out[0]!.y).toBe(8);
  });

  it('does not merge two lines that merely touch', () => {
    expect(mergeRectsIntoLines([R(10, 10, 80, 12), R(10, 22, 80, 12)])).toHaveLength(2);
  });

  it('ignores zero-size noise such as line-break boxes', () => {
    expect(mergeRectsIntoLines([R(10, 10, 0, 12), R(10, 10, 50, 0), R(10, 10, 0.4, 12), R(20, 20, 50, 12)])).toEqual([R(20, 20, 50, 12)]);
  });

  it('returns nothing for nothing', () => {
    expect(mergeRectsIntoLines([])).toEqual([]);
  });

  it('does not change its input', () => {
    const input = [R(50, 10, 30, 12), R(10, 10, 40, 12)];
    const copy = JSON.parse(JSON.stringify(input));
    mergeRectsIntoLines(input);
    expect(input).toEqual(copy);
  });

  it('copes with a realistic selection: three lines reported with duplicates', () => {
    const line = (y: number, x1: number, x2: number) => [R(x1, y, x2 - x1, 12), R(x1, y - 1, x2 - x1, 14), R(x1, y, (x2 - x1) / 2, 12), R((x1 + x2) / 2, y, (x2 - x1) / 2, 12)];
    const out = mergeRectsIntoLines([...line(10, 40, 300), ...line(26, 20, 300), ...line(42, 20, 120)]);
    expect(out).toHaveLength(3);
    expect(out.map((r) => [r.x, r.w])).toEqual([[40, 260], [20, 280], [20, 100]]);
  });
});

describe('viewRectToQuad', () => {
  const crop = R(0, 0, 200, 300);
  const geometry = (intrinsic: 0 | 90 | 180 | 270, extra: 0 | 90 | 180 | 270, cropBox = crop): PageGeometry => ({
    cropBox, intrinsicRotation: intrinsic, extraRotation: extra, userUnit: 1,
  });

  it.each([
    [0, 0], [0, 90], [90, 0], [180, 90], [0, 270], [270, 90],
  ] as const)('maps a PDF box to the view and back to the same box (rotation %i + %i)', (intrinsic, extra) => {
    const g = geometry(intrinsic, extra, R(10, 20, 200, 300));
    const box = R(50, 100, 60, 25);
    const a = pdfToViewport(g, 1.5, { x: box.x, y: box.y });
    const b = pdfToViewport(g, 1.5, { x: box.x + box.w, y: box.y + box.h });
    const view = R(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const q = viewRectToQuad(g, 1.5, view);
    const back = quadBounds(q);
    expect(back.x).toBeCloseTo(box.x);
    expect(back.y).toBeCloseTo(box.y);
    expect(back.w).toBeCloseTo(box.w);
    expect(back.h).toBeCloseTo(box.h);
  });

  it('produces a quad in PDF corner order: top-left, top-right, bottom-left, bottom-right', () => {
    const q = viewRectToQuad(geometry(0, 0), 1, R(20, 30, 100, 10));
    expect(q.p1.x).toBeLessThan(q.p2.x);
    expect(q.p1.y).toBeGreaterThan(q.p3.y); // PDF y points up
    expect(q.p1.y).toBe(q.p2.y);
    expect(q.p3.y).toBe(q.p4.y);
  });

  it('accounts for the display scale', () => {
    const q = viewRectToQuad(geometry(0, 0), 2, R(40, 60, 200, 20));
    const b = quadBounds(q);
    expect(b.w).toBeCloseTo(100);
    expect(b.h).toBeCloseTo(10);
  });
});

describe('batch', () => {
  const hl = (id: string, pageId: string): HighlightAnnot => ({
    type: 'highlight', id, pageId, author: 'a', createdAt: 't', modifiedAt: 't', color: { r: 1, g: 1, b: 0, a: 1 }, opacity: 1, origin: 'app', quads: [],
  });
  const twoPages = () => {
    const h = new History(emptyDocument());
    let n = 0;
    h.execute(addSource({ id: 's', name: 's.pdf', data: memorySource(new Uint8Array(1)), pageCount: 2, isEncrypted: false, hasDigitalSignature: false }, undefined, () => `p${++n}`));
    return h;
  };

  it('applies every command as one undo step', () => {
    const h = twoPages();
    h.execute(batch('Highlight', [addAnnotation(hl('a', 'p1')), addAnnotation(hl('b', 'p2'))]));
    expect(h.current.annotations['p1']).toHaveLength(1);
    expect(h.current.annotations['p2']).toHaveLength(1);
    expect(h.undoLabel).toBe('Highlight');
    h.undo();
    expect(h.current.annotations['p1'] ?? []).toHaveLength(0);
    expect(h.current.annotations['p2'] ?? []).toHaveLength(0);
    h.redo();
    expect(h.current.annotations['p2']).toHaveLength(1);
  });

  it('leaves no undo step when nothing changed', () => {
    const h = twoPages();
    const before = h.current;
    h.execute(batch('Nothing', []));
    expect(h.current).toBe(before);
    h.execute(batch('Nothing', [addAnnotation(hl('a', 'missing-page'))]));
    expect(h.current).toBe(before);
  });
});
