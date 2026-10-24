// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STAMP_WIDTH, STAMP_PRESETS, stampLayout, stampPreset, type Annotation, type StampAnnot } from '@pagewright/core';
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
  const host = svg.parentElement!;
  const pageId = t.store.getSnapshot().doc.pages[0]!.id;
  const annots = () => (t.store.getSnapshot().doc.annotations[pageId] ?? []) as Annotation[];
  const stamps = () => annots().filter((a): a is StampAnnot => a.type === 'stamp');
  const tool = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
  const press = (x: number, y: number) => {
    fireEvent.pointerDown(host, { button: 0, pointerId: 1, ...px(x, y) });
    fireEvent.pointerUp(host, { pointerId: 1, ...px(x, y) });
  };
  const drag = (from: [number, number], to: [number, number], target: Element = host) => {
    fireEvent.pointerDown(target, { button: 0, pointerId: 1, ...px(...from) });
    fireEvent.pointerMove(host, { pointerId: 1, ...px(...to) });
    fireEvent.pointerUp(host, { pointerId: 1, ...px(...to) });
  };
  const picker = () => screen.getByLabelText('Stamp type') as HTMLSelectElement;
  return { ...t, svg, host, pageId, annots, stamps, tool, press, drag, picker };
}

const near = (a: number, b: number, d = 1e-6) => expect(a).toBeCloseTo(b, -Math.log10(d));

describe('placing a stamp', () => {
  it('offers the stamp types only while the Stamp tool is active', async () => {
    const t = await ready();
    expect(screen.queryByLabelText('Stamp type')).toBeNull();
    t.tool('Stamp');
    expect(t.picker().value).toBe('Approved');
    expect([...t.picker().options].map((o) => o.text)).toEqual(STAMP_PRESETS.map((p) => p.label));
    t.tool('Rectangle');
    expect(screen.queryByLabelText('Stamp type')).toBeNull();
  });

  it('puts the chosen stamp centred on the click, at the default width, in its colour', async () => {
    const t = await ready();
    t.tool('Stamp');
    fireEvent.change(t.picker(), { target: { value: 'Confidential' } });
    t.press(100, 150);
    const [a] = t.stamps();
    expect(t.stamps()).toHaveLength(1);
    expect(a!.payload).toEqual({ kind: 'preset', name: 'Confidential' });
    expect(a!.color).toEqual(stampPreset('Confidential')!.color);
    near(a!.rect.w, DEFAULT_STAMP_WIDTH);
    near(a!.rect.x + a!.rect.w / 2, 100, 1e-3);
    near(a!.rect.y + a!.rect.h / 2, 150, 1e-3);
    const l = stampLayout('CONFIDENTIAL');
    near(a!.rect.w / a!.rect.h, l.w / l.h, 1e-6);
  });

  it('draws the label and frame in the page', async () => {
    const t = await ready();
    t.tool('Stamp');
    t.press(100, 150);
    const g = t.svg.querySelector(`[data-annot-id="${t.stamps()[0]!.id}"]`)!;
    expect(g.querySelector('text')!.textContent).toBe('APPROVED');
    expect(g.querySelector('rect:not(.selection-outline)')).not.toBeNull();
  });

  it('selects the new stamp and goes back to the Select tool, so it can be adjusted at once', async () => {
    const t = await ready();
    t.tool('Stamp');
    t.press(100, 150);
    expect(t.store.getSnapshot().ui.activeTool).toBe('select');
    expect(t.store.getSnapshot().ui.selectedAnnot?.id).toBe(t.stamps()[0]!.id);
    expect(t.svg.querySelectorAll('[data-handle]')).toHaveLength(4);
  });

  it('places nothing until the button comes up, and is one undo step', async () => {
    const t = await ready();
    t.tool('Stamp');
    fireEvent.pointerDown(t.host, { button: 0, pointerId: 1, ...px(100, 150) });
    expect(t.stamps()).toHaveLength(0);
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(100, 150) });
    expect(t.stamps()).toHaveLength(1);
    t.store.undo();
    expect(t.stamps()).toHaveLength(0);
  });

  it('K chooses the Stamp tool', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 'k' });
    expect(t.store.getSnapshot().ui.activeTool).toBe('stamp');
  });

  it('remembers the chosen type for the next stamp', async () => {
    const t = await ready();
    t.tool('Stamp');
    fireEvent.change(t.picker(), { target: { value: 'Void' } });
    t.press(60, 250);
    t.tool('Stamp');
    expect(t.picker().value).toBe('Void');
    t.press(140, 100);
    expect(t.stamps().map((s) => (s.payload.kind === 'preset' ? s.payload.name : ''))).toEqual(['Void', 'Void']);
  });
});

describe('adjusting a stamp', () => {
  async function withStamp() {
    const t = await ready();
    t.tool('Stamp');
    t.press(100, 150);
    return t;
  }

  it('moves by dragging it, as one undo step', async () => {
    const t = await withStamp();
    const before = { ...t.stamps()[0]!.rect };
    t.drag([100, 150], [130, 120]);
    near(t.stamps()[0]!.rect.x, before.x + 30, 1e-3);
    near(t.stamps()[0]!.rect.y, before.y - 30, 1e-3);
    near(t.stamps()[0]!.rect.w, before.w);
    t.store.undo();
    expect(t.stamps()[0]!.rect).toEqual(before);
  });

  it('resizes from a corner, keeping its proportions and the opposite corner', async () => {
    const t = await withStamp();
    const before = { ...t.stamps()[0]!.rect };
    const handle = t.svg.querySelector('[data-handle="ne"]')!;
    t.drag([before.x + before.w, before.y + before.h], [before.x + before.w + 20, before.y + before.h + 20], handle);
    const after = t.stamps()[0]!.rect;
    expect(after.w).toBeGreaterThan(before.w);
    near(after.w / after.h, before.w / before.h, 1e-6);
    near(after.x, before.x, 1e-6);
    near(after.y, before.y, 1e-6);
    t.store.undo();
    expect(t.stamps()[0]!.rect).toEqual(before);
  });

  it('changes type from the picker when it is selected: new label and colour, one undo step', async () => {
    const t = await withStamp();
    expect(t.picker().value).toBe('Approved'); // shown in the Select tool because a stamp is selected
    fireEvent.change(t.picker(), { target: { value: 'NotApproved' } });
    const a = t.stamps()[0]!;
    expect(a.payload).toEqual({ kind: 'preset', name: 'NotApproved' });
    expect(a.color).toEqual(stampPreset('NotApproved')!.color);
    expect(t.svg.querySelector(`[data-annot-id="${a.id}"] text`)!.textContent).toBe('NOT APPROVED');
    t.store.undo();
    expect(t.stamps()[0]!.payload).toEqual({ kind: 'preset', name: 'Approved' });
    expect(t.stamps()).toHaveLength(1);
  });

  it('is deleted with the Delete key, and undo brings it back', async () => {
    const t = await withStamp();
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(t.stamps()).toHaveLength(0);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(t.stamps()).toHaveLength(1));
  });

  it('can be selected again by clicking it', async () => {
    const t = await withStamp();
    t.press(10, 10);
    expect(t.store.getSnapshot().ui.selectedAnnot).toBeUndefined();
    t.press(100, 150);
    expect(t.store.getSnapshot().ui.selectedAnnot?.id).toBe(t.stamps()[0]!.id);
  });

  it('can carry a comment like other annotations', async () => {
    const t = await withStamp();
    const a = t.stamps()[0]!;
    t.store.setComment(t.pageId, a.id, 'Signed off');
    expect(t.stamps()[0]!.comment?.text).toBe('Signed off');
  });
});

describe('stamps on a rotated page', () => {
  it('turn with the page', async () => {
    const t = await ready();
    t.tool('Stamp');
    t.press(100, 150);
    t.store.rotatePages(90, [t.pageId]);
    await waitFor(() => {
      const g = document.querySelector(`[data-annot-id="${t.stamps()[0]!.id}"] g`);
      expect(g?.getAttribute('transform')).toMatch(/rotate\(90\)/);
    });
  });
});
