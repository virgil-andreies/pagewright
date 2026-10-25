// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Annotation, ShapeAnnot } from '@pagewright/core';
import { DEFAULT_TOOL_STYLES, PALETTE, readSavedStyles } from '../src/tool-style';
import { setup } from './helpers';

/** Fake pages are 200 x 300 pt, shown at 96/72 px per point. */
const S = 96 / 72;
const px = (x: number, y: number) => ({ clientX: x * S, clientY: (300 - y) * S });
const named = (n: string) => PALETTE.find((p) => p.name === n)!.color;
const quad = { p1: { x: 10, y: 120 }, p2: { x: 90, y: 120 }, p3: { x: 10, y: 100 }, p4: { x: 90, y: 100 } };

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
  const tool = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
  const drag = (a: [number, number], b: [number, number]) => {
    fireEvent.pointerDown(host, { button: 0, pointerId: 1, ...px(...a) });
    fireEvent.pointerMove(host, { pointerId: 1, ...px(...b) });
    fireEvent.pointerUp(host, { pointerId: 1, ...px(...b) });
  };
  const fillButton = () => screen.queryByRole('button', { name: /^Fill: / }) as HTMLButtonElement | null;
  const pickFill = (name: string) => {
    fireEvent.click(fillButton()!);
    const pal = screen.getByRole('dialog', { name: 'Fill colours' });
    fireEvent.click(within(pal).getByRole('button', { name }));
  };
  const opacity = () => screen.queryByRole('slider', { name: 'Opacity' }) as HTMLInputElement | null;
  const setOpacity = (percent: number) => fireEvent.change(opacity()!, { target: { value: String(percent) } });
  return { ...t, pageId, annots, tool, drag, fillButton, pickFill, opacity, setOpacity };
}

describe('fill', () => {
  it('is offered for rectangles and ellipses, starting with none', async () => {
    const t = await ready();
    t.tool('Rectangle');
    expect(t.fillButton()!.getAttribute('aria-label')).toBe('Fill: None');
    t.tool('Ellipse');
    expect(t.fillButton()).toBeTruthy();
    for (const name of ['Pen', 'Line', 'Arrow', 'Highlight', 'Text', 'Stamp']) {
      t.tool(name);
      expect(t.fillButton(), name).toBeNull();
    }
  });

  it('fills new shapes, and each shape tool keeps its own fill', async () => {
    const t = await ready();
    t.tool('Rectangle');
    t.pickFill('Yellow');
    expect(t.fillButton()!.getAttribute('aria-label')).toBe('Fill: Yellow');
    t.drag([20, 200], [120, 150]);
    expect((t.annots()[0] as ShapeAnnot).fill).toEqual(named('Yellow'));
    t.tool('Ellipse');
    expect(t.fillButton()!.getAttribute('aria-label')).toBe('Fill: None');
    t.drag([20, 120], [120, 60]);
    expect((t.annots()[1] as ShapeAnnot).fill).toBeUndefined();
    t.tool('Rectangle');
    expect(t.fillButton()!.getAttribute('aria-label')).toBe('Fill: Yellow');
  });

  it('can be taken away again with No fill', async () => {
    const t = await ready();
    t.tool('Rectangle');
    t.pickFill('Teal');
    fireEvent.click(t.fillButton()!);
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Fill colours' })).getByRole('button', { name: 'No fill' }));
    t.drag([20, 200], [120, 150]);
    expect('fill' in (t.annots()[0] as ShapeAnnot)).toBe(false);
  });

  it('changes a selected shape’s fill as one undo step, leaving the tool’s own fill alone', async () => {
    const t = await ready();
    t.tool('Rectangle');
    t.drag([20, 200], [120, 150]);
    t.tool('Select');
    t.drag([70, 200], [70, 200]);
    expect(t.fillButton()!.getAttribute('aria-label')).toBe('Fill: None');
    t.pickFill('Pink');
    expect((t.annots()[0] as ShapeAnnot).fill).toEqual(named('Pink'));
    act(() => t.store.undo());
    expect((t.annots()[0] as ShapeAnnot).fill).toBeUndefined();
    t.tool('Rectangle');
    expect(t.fillButton()!.getAttribute('aria-label')).toBe('Fill: None');
  });
});

describe('opacity', () => {
  it('starts at 50% for highlights and 100% for the rest, and is not offered for notes, text boxes or stamps', async () => {
    const t = await ready();
    t.tool('Highlight');
    expect(t.opacity()!.getAttribute('aria-valuetext')).toBe('50%');
    for (const name of ['Underline', 'Pen', 'Rectangle', 'Arrow']) {
      t.tool(name);
      expect(t.opacity()!.getAttribute('aria-valuetext'), name).toBe('100%');
    }
    for (const name of ['Note', 'Text', 'Stamp', 'Select']) {
      t.tool(name);
      expect(t.opacity(), name).toBeNull();
    }
  });

  it('makes new marks and drawings that transparent, per tool', async () => {
    const t = await ready();
    t.tool('Highlight');
    t.setOpacity(30);
    act(() => void t.store.addMarkup('highlight', t.pageId, [quad]));
    act(() => void t.store.addMarkup('underline', t.pageId, [quad]));
    expect(t.annots().map((a) => a.opacity)).toEqual([0.3, 1]);
    t.tool('Rectangle');
    t.setOpacity(60);
    t.drag([20, 200], [120, 150]);
    expect(t.annots()[2]!.opacity).toBe(0.6);
  });

  it('previews while dragged and changes a selection once, when let go', async () => {
    const t = await ready();
    let id = '';
    act(() => void (id = t.store.addMarkup('highlight', t.pageId, [quad])!));
    t.tool('Select');
    act(() => t.store.selectAnnotation({ pageId: t.pageId, id }));
    for (const v of [45, 40, 35]) fireEvent.input(t.opacity()!, { target: { value: String(v) } });
    expect(screen.getByText('35%')).toBeTruthy();
    expect(t.annots()[0]!.opacity).toBe(DEFAULT_TOOL_STYLES.highlight.opacity);
    t.setOpacity(35);
    expect(t.annots()[0]!.opacity).toBe(0.35);
    act(() => t.store.undo());
    expect(t.annots()[0]!.opacity).toBe(0.5);
  });

  it('is kept on the device with the rest of a tool’s style, and old saves without it still load', () => {
    const saved = readSavedStyles({
      toolStyles: {
        highlight: { color: { r: 1, g: 0.9, b: 0, a: 1 }, width: 2, opacity: 0.3 },
        rect: { color: { r: 1, g: 0, b: 0, a: 1 }, width: 2, opacity: 0.8, fill: { r: 0, g: 0, b: 1, a: 1 } },
        ink: { color: { r: 0, g: 0, b: 0, a: 1 }, width: 2 }, // saved before transparency existed
        line: { color: { r: 0, g: 0, b: 0, a: 1 }, width: 2, opacity: 7, fill: { r: 0, g: 0, b: 1, a: 1 } }, // nonsense, and lines have no fill
      },
      recentColors: [],
    })!;
    expect(saved.toolStyles.highlight!.opacity).toBe(0.3);
    expect(saved.toolStyles.rect!.fill).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(saved.toolStyles.ink!.opacity).toBe(1);
    expect(saved.toolStyles.line!.opacity).toBe(1);
    expect(saved.toolStyles.line!.fill).toBeUndefined();
  });
});
